// Figma Font Handler — MCP Server
//
// Bridges an MCP client (Claude Code, Cursor, …) over stdio to the Figma plugin
// over a WebSocket on :3056. The plugin runs inside Figma Desktop, which is the
// only place where the fonts installed on this machine are actually available.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer, WebSocket } from "ws";
import { execSync } from "child_process";
import { z } from "zod";

const WS_PORT = 3056;
const WS_RETRY_MS = 2000;
// The plugin retries every 3s, so one full cycle plus headroom.
const RECLAIM_WAIT_MS = 7000;
const COMMAND_TIMEOUT_MS = 60_000;

const NOT_CONNECTED =
  "Figma plugin is not connected. In Figma Desktop, open your file and run " +
  "Plugins > Development > Figma Font Handler, then try again.";

// ── WebSocket bridge to the Figma plugin ─────────────────

let figmaSocket: WebSocket | null = null;
let wssActive = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const pendingRequests = new Map<
  string,
  { resolve: (val: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

function killStaleProcess(): void {
  try {
    const pids = execSync(`lsof -ti :${WS_PORT}`, { encoding: "utf-8" }).trim().split("\n");
    const myPid = process.pid.toString();
    for (const pid of pids) {
      if (pid && pid !== myPid) {
        try {
          const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: "utf-8" }).trim();
          if (cmd.includes("mcp-server")) {
            process.kill(parseInt(pid, 10), "SIGTERM");
            console.error(`[figma-font-handler] Killed stale process ${pid}`);
          }
        } catch {}
      }
    }
  } catch {
    // Nothing on the port — that's fine.
  }
}

function startWebSocketServer(isFirstAttempt = true): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (wssActive) return;

  // Only reclaim the port on the first attempt — killing on every retry would let
  // concurrent sessions shoot each other down in a loop.
  if (isFirstAttempt) killStaleProcess();

  const wss = new WebSocketServer({ port: WS_PORT });

  wss.on("listening", () => {
    wssActive = true;
    console.error(`[figma-font-handler] WebSocket bridge listening on ws://localhost:${WS_PORT}`);
  });

  wss.on("close", () => {
    wssActive = false;
  });

  wss.on("connection", (ws) => {
    console.error("[figma-font-handler] Figma plugin connected");
    figmaSocket = ws;

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const pending = pendingRequests.get(msg.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingRequests.delete(msg.id);
        if (msg.success) pending.resolve(msg.data);
        else pending.reject(new Error(msg.error || "Unknown plugin error"));
      } catch (e) {
        console.error("[figma-font-handler] Failed to parse plugin message:", e);
      }
    });

    ws.on("close", () => {
      console.error("[figma-font-handler] Figma plugin disconnected");
      if (figmaSocket === ws) figmaSocket = null;
      for (const [id, pending] of pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Figma plugin disconnected"));
        pendingRequests.delete(id);
      }
    });
  });

  wss.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      // Another session holds the port. Wait for it to free up instead of giving
      // up — otherwise this process stays alive with no bridge at all.
      console.error(`[figma-font-handler] Port ${WS_PORT} in use — retrying in ${WS_RETRY_MS}ms`);
      wssActive = false;
      try {
        wss.close();
      } catch {}
      retryTimer = setTimeout(() => startWebSocketServer(false), WS_RETRY_MS);
      return;
    }
    console.error("[figma-font-handler] WebSocket server error:", err.message);
  });
}

let requestIdCounter = 0;

function isPluginConnected(): boolean {
  return !!figmaSocket && figmaSocket.readyState === WebSocket.OPEN;
}

/**
 * Claim the bridge for this session before running a command.
 *
 * With several MCP clients open, whichever one started first owns the port —
 * even if it never touches Figma. Reclaiming on demand means the session that is
 * actually working gets the bridge; the plugin re-attaches on its own within 3s.
 */
async function ensurePluginConnected(): Promise<void> {
  if (isPluginConnected()) return;

  if (!wssActive) {
    console.error(`[figma-font-handler] No bridge — reclaiming port ${WS_PORT}`);
    startWebSocketServer(true);
  }

  const deadline = Date.now() + RECLAIM_WAIT_MS;
  while (Date.now() < deadline) {
    if (isPluginConnected()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function sendToPlugin(command: string, params: Record<string, unknown>): Promise<unknown> {
  await ensurePluginConnected();

  return new Promise((resolve, reject) => {
    if (!isPluginConnected()) {
      reject(new Error(NOT_CONNECTED));
      return;
    }

    const id = `req_${++requestIdCounter}`;
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Command '${command}' timed out after ${COMMAND_TIMEOUT_MS / 1000}s`));
    }, COMMAND_TIMEOUT_MS);

    pendingRequests.set(id, { resolve, reject, timer });
    figmaSocket!.send(JSON.stringify({ id, command, params }));
  });
}

// ── MCP Server ───────────────────────────────────────────

const server = new McpServer({ name: "figma-fonts", version: "1.0.0" });

function textResult(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) ?? "OK" }] };
}

function errorResult(err: any) {
  return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
}

async function run(command: string, params: Record<string, unknown>) {
  try {
    return textResult(await sendToPlugin(command, params));
  } catch (err: any) {
    return errorResult(err);
  }
}

const scope = z
  .enum(["selection", "page", "document"])
  .describe("Which text nodes to act on: the current selection, the current page, or the whole file");

server.tool(
  "list_fonts",
  "List the font families available to Figma on this machine, including locally installed fonts that cloud tooling cannot see. Use this to confirm the exact family and style names before setting a font.",
  {
    filter: z.string().optional().describe("Only return families containing this text (case-insensitive)"),
    limit: z.number().int().positive().optional().describe("Max families to return (default 200)"),
  },
  async (params) => run("list_fonts", params as Record<string, unknown>)
);

server.tool(
  "audit_fonts",
  "Report every font used by the text nodes in scope: family, style, how often it is used, and whether it is missing or fails to load. Run this first when text is not editable or a file shows missing-font warnings.",
  {
    scope: scope.optional().describe("Default: page"),
    nodeIds: z.array(z.string()).optional().describe("Restrict to these nodes (and their text descendants)"),
  },
  async (params) => run("audit_fonts", params as Record<string, unknown>)
);

server.tool(
  "set_font",
  "Set the font family on text nodes in scope. Leave style empty to keep each node's own weight and map it onto the same style in the new family (Bold stays Bold).",
  {
    family: z.string().describe("Target font family, exactly as reported by list_fonts"),
    style: z.string().optional().describe("Target style, e.g. Regular, Medium, Bold. Omit to preserve existing styles"),
    scope: scope.optional().describe("Default: selection"),
    nodeIds: z.array(z.string()).optional().describe("Restrict to these nodes (and their text descendants)"),
  },
  async (params) => run("set_font", params as Record<string, unknown>)
);

server.tool(
  "replace_font",
  "Swap one font family for another across the file, style by style. This is the fix for missing fonts: replace the font nobody has with one that is installed, without flattening the weights.",
  {
    fromFamily: z.string().describe("Font family to replace"),
    fromStyle: z.string().optional().describe("Only replace this style. Omit to replace every style of the family"),
    toFamily: z.string().describe("Replacement font family"),
    toStyle: z.string().optional().describe("Force this style. Omit to keep each original style where the target family has it"),
    scope: scope.optional().describe("Default: document"),
    nodeIds: z.array(z.string()).optional().describe("Restrict to these nodes (and their text descendants)"),
  },
  async (params) => run("replace_font", params as Record<string, unknown>)
);

server.tool(
  "set_text",
  "Write text into a text node, loading its font first. Works with locally installed fonts that cloud-based Figma tooling cannot write. Pass family/style to change the font in the same step.",
  {
    nodeId: z.string().describe("ID of the text node"),
    text: z.string().describe("New text content"),
    family: z.string().optional().describe("Font family to apply while setting the text"),
    style: z.string().optional().describe("Font style to apply (default Regular when family is given)"),
  },
  async (params) => run("set_text", params as Record<string, unknown>)
);

server.tool(
  "execute",
  `Run JavaScript in the Figma plugin sandbox — the escape hatch for anything the font tools do not cover. The code is the body of an async function with these in scope:
  - figma — the Figma Plugin API global
  - loadFont(family, style?) — shorthand for figma.loadFontAsync()
  - collectTextNodes(scope, nodeIds?) — text nodes for "selection" | "page" | "document"
  - fontsOfNode(textNode) — every font used by a node, one entry per styled segment
  - resolveStyle(family, wantedStyle, fallbackStyle?) — closest available style in a family

Return a value and it is sent back as the tool result.`,
  { code: z.string().describe("JavaScript code to execute (body of an async function)") },
  async (params) => run("execute", params as Record<string, unknown>)
);

// ── Start ────────────────────────────────────────────────

async function main() {
  startWebSocketServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[figma-font-handler] MCP server running on stdio");
}

main().catch((err) => {
  console.error("[figma-font-handler] Fatal:", err);
  process.exit(1);
});
