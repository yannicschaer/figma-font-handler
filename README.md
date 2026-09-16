# Figma Font Handler

[![CI](https://github.com/yannicschaer/figma-font-handler/actions/workflows/ci.yml/badge.svg)](https://github.com/yannicschaer/figma-font-handler/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-8A2BE2)](https://modelcontextprotocol.io)

Gives your AI assistant access to the fonts installed on **your** machine — so it can write text in Figma with your brand typeface instead of failing on it.

## The problem

Cloud-based Figma tooling only knows the fonts Figma hosts and the ones shared in your org. Your licensed brand font — Proxima Nova, GT Walsheim, whatever the client bought — is installed locally, so the agent cannot load it. Text edits fail, or land in the wrong typeface.

Figma Desktop *can* see those fonts. This plugin runs inside it and hands that access to your agent.

```
AI assistant  ←MCP→  local server  ←WebSocket :3056→  Figma plugin  ←Plugin API→  your file
```

Nothing leaves your machine. The bridge is localhost only.

## What you get

| Tool | What it does |
|---|---|
| `list_fonts` | Every font family available locally, with its real style names |
| `audit_fonts` | Which fonts a selection, page or file uses — and which are missing or broken |
| `set_font` | Change the family on text nodes, keeping each node's weight (Bold stays Bold) |
| `replace_font` | Swap one family for another across the file, style by style — the missing-font fix |
| `set_text` | Write text into a node, loading its font first |
| `execute` | Run JavaScript in the plugin sandbox for anything else |

## Setup

Needs [Node.js](https://nodejs.org) 20+ and **Figma Desktop** (the browser has no access to your local fonts).

**1. Build it**

```bash
git clone https://github.com/yannicschaer/figma-font-handler.git
cd figma-font-handler
npm install && npm run build
```

**2. Load the plugin in Figma Desktop**

Open any file → **Plugins → Development → Import plugin from manifest…** → pick `mcp/dist/figma-plugin/manifest.json` from this folder.

**3. Connect your assistant**

Claude Code:

```bash
claude mcp add figma-fonts -- node /absolute/path/to/figma-font-handler/mcp/dist/mcp-server.mjs
```

Cursor, Claude Desktop, or any other MCP client — add this to the MCP config:

```json
{
  "mcpServers": {
    "figma-fonts": {
      "command": "node",
      "args": ["/absolute/path/to/figma-font-handler/mcp/dist/mcp-server.mjs"]
    }
  }
}
```

**4. Run it**

In Figma: **Plugins → Development → Figma Font Handler**. The panel shows `Connected` and how many font families it can see. Leave it open while you work.

## Using it

Plain requests are enough once the plugin is running:

- *"Which fonts does this page use? Anything missing?"*
- *"Replace Proxima Nova with Inter everywhere, keep the weights."*
- *"Set the headline to 'Sommer 2026' in GT Walsheim Medium."*
- *"List every font family here that starts with Helvetica."*

Text nodes are addressed by their Figma node ID. Your assistant gets those from `audit_fonts`, from a Figma link (`?node-id=...`), or from the official Figma MCP server if you have it connected — this handler is built to sit alongside it, not replace it.

## Troubleshooting

**"Figma plugin is not connected"** — the plugin window is closed, or you are in the browser. Open the file in Figma Desktop and run the plugin. It reconnects on its own within three seconds.

**A font is listed but will not load** — Figma caches its font list. Quit Figma Desktop completely and reopen it after installing a font. `audit_fonts` reports any font that is listed but fails to load.

**Weights collapse to Regular after a replace** — the target family does not carry that weight. `replace_font` falls back to Regular, and the `mapping` in the result shows exactly what went where.

**Port 3056 in use** — another copy of the server is running. It reclaims the port on its own; if not, quit the other MCP client. To change the port, edit it in both `mcp/src/mcp-server.ts` and `mcp/figma-plugin/{manifest.json,ui.html}`, then rebuild.

**Text in an instance will not change** — it is locked by the main component. The error names the node; fix it in the component.

## Development

```bash
npm run dev        # rebuild on change
npm test           # font logic against a mock Figma API, no Figma needed
npm run typecheck
```

After changing plugin code, reload it in Figma: **Plugins → Development → Hot reload plugin**.

## Credits

Derived from [figma-slides-mcp](https://github.com/Strand-AI/figma-slides-mcp) by Strand AI (MIT) — the MCP ↔ WebSocket ↔ plugin bridge comes from there. The font tooling is new.

MIT licensed. Built by [Yannic Schär](https://yannic.design).
