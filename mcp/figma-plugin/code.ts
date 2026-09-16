// Figma Font Handler — Plugin Sandbox (code.ts)
//
// Runs inside Figma's plugin sandbox, where the *locally installed* fonts of the
// machine are available. Receives commands from ui.html via postMessage, executes
// them against the Figma Plugin API, and posts the results back.

figma.showUI(__html__, { visible: true, width: 300, height: 112, title: "Figma Font Handler" });

// ── Types ───────────────────────────────────────────────

type Scope = "selection" | "page" | "document";

interface FontUsage {
  family: string;
  style: string;
  count: number;
  missing: boolean;
  sampleNodeIds: string[];
}

type CommandResult = { success: true; data?: unknown } | { success: false; error: string };

// ── Helpers ─────────────────────────────────────────────

function fontKey(font: FontName): string {
  return font.family + " :: " + font.style;
}

/** Collect text nodes for a scope. "document" needs every page loaded first. */
async function collectTextNodes(scope: Scope, nodeIds?: string[]): Promise<TextNode[]> {
  if (nodeIds && nodeIds.length > 0) {
    const nodes: TextNode[] = [];
    for (const id of nodeIds) {
      const node = await figma.getNodeByIdAsync(id);
      if (!node) continue;
      if (node.type === "TEXT") {
        nodes.push(node);
      } else if ("findAllWithCriteria" in node) {
        const found = (node as ChildrenMixin & SceneNode).findAllWithCriteria({ types: ["TEXT"] });
        for (const t of found) nodes.push(t as TextNode);
      }
    }
    return nodes;
  }

  if (scope === "document") {
    await figma.loadAllPagesAsync();
    return figma.root.findAllWithCriteria({ types: ["TEXT"] }) as TextNode[];
  }

  if (scope === "selection") {
    const nodes: TextNode[] = [];
    for (const node of figma.currentPage.selection) {
      if (node.type === "TEXT") {
        nodes.push(node);
      } else if ("findAllWithCriteria" in node) {
        const found = (node as ChildrenMixin & SceneNode).findAllWithCriteria({ types: ["TEXT"] });
        for (const t of found) nodes.push(t as TextNode);
      }
    }
    return nodes;
  }

  return figma.currentPage.findAllWithCriteria({ types: ["TEXT"] }) as TextNode[];
}

/** Every distinct font used by a node — one entry per styled segment. */
function fontsOfNode(node: TextNode): FontName[] {
  if (node.fontName !== figma.mixed) return [node.fontName as FontName];
  const segments = node.getStyledTextSegments(["fontName"]);
  return segments.map((s) => s.fontName);
}

/** Try to load a font; never throws. */
async function tryLoadFont(font: FontName): Promise<boolean> {
  try {
    await figma.loadFontAsync(font);
    return true;
  } catch (_) {
    return false;
  }
}

/** Load every font a node uses, so its characters can be edited. */
async function loadNodeFonts(node: TextNode): Promise<string[]> {
  const failed: string[] = [];
  for (const font of fontsOfNode(node)) {
    const ok = await tryLoadFont(font);
    if (!ok) failed.push(font.family + " " + font.style);
  }
  return failed;
}

let availableFontsCache: FontName[] | null = null;

async function availableFonts(): Promise<FontName[]> {
  if (!availableFontsCache) {
    const fonts = await figma.listAvailableFontsAsync();
    availableFontsCache = fonts.map((f) => f.fontName);
  }
  return availableFontsCache;
}

async function stylesOfFamily(family: string): Promise<string[]> {
  const fonts = await availableFonts();
  const styles: string[] = [];
  for (const font of fonts) {
    if (font.family.toLowerCase() === family.toLowerCase()) styles.push(font.style);
  }
  return styles;
}

/**
 * Resolve the style to use in a target family.
 * Keeps the original style when the target family has it (Bold → Bold), so a
 * family swap does not flatten a carefully weighted layout to a single weight.
 */
async function resolveStyle(targetFamily: string, wantedStyle: string, fallbackStyle?: string): Promise<string | null> {
  const styles = await stylesOfFamily(targetFamily);
  if (styles.length === 0) return null;

  const exact = styles.filter((s) => s.toLowerCase() === wantedStyle.toLowerCase())[0];
  if (exact) return exact;

  if (fallbackStyle) {
    const fb = styles.filter((s) => s.toLowerCase() === fallbackStyle.toLowerCase())[0];
    if (fb) return fb;
  }

  const regular = styles.filter((s) => s.toLowerCase() === "regular")[0];
  return regular || styles[0];
}

/** Apply a font to a whole text node, or only to the segments matching `only`. */
async function applyFont(node: TextNode, target: FontName, only?: FontName): Promise<void> {
  if (!only) {
    node.fontName = target;
    return;
  }

  if (node.fontName !== figma.mixed) {
    const current = node.fontName as FontName;
    if (fontKey(current) === fontKey(only)) node.fontName = target;
    return;
  }

  const segments = node.getStyledTextSegments(["fontName"]);
  for (const segment of segments) {
    if (fontKey(segment.fontName) === fontKey(only)) {
      node.setRangeFontName(segment.start, segment.end, target);
    }
  }
}

// ── Command Handlers ────────────────────────────────────

async function listFonts(params: Record<string, unknown>): Promise<CommandResult> {
  const filter = ((params.filter as string) || "").toLowerCase();
  const limit = (params.limit as number) || 200;

  const fonts = await availableFonts();
  const families: Record<string, string[]> = {};
  for (const font of fonts) {
    if (filter && font.family.toLowerCase().indexOf(filter) === -1) continue;
    if (!families[font.family]) families[font.family] = [];
    families[font.family].push(font.style);
  }

  const names = Object.keys(families).sort();
  const total = names.length;
  const page = names.slice(0, limit);

  return {
    success: true,
    data: {
      totalFamilies: total,
      returned: page.length,
      truncated: total > page.length,
      families: page.map((name) => ({ family: name, styles: families[name] })),
    },
  };
}

async function auditFonts(params: Record<string, unknown>): Promise<CommandResult> {
  const scope = (params.scope as Scope) || "page";
  const nodes = await collectTextNodes(scope, params.nodeIds as string[] | undefined);

  const usage: Record<string, FontUsage> = {};
  for (const node of nodes) {
    const isMissing = node.hasMissingFont;
    for (const font of fontsOfNode(node)) {
      const key = fontKey(font);
      if (!usage[key]) {
        usage[key] = { family: font.family, style: font.style, count: 0, missing: isMissing, sampleNodeIds: [] };
      }
      usage[key].count++;
      if (isMissing) usage[key].missing = true;
      if (usage[key].sampleNodeIds.length < 5) usage[key].sampleNodeIds.push(node.id);
    }
  }

  const fonts = Object.keys(usage)
    .map((key) => usage[key])
    .sort((a, b) => b.count - a.count);

  // A font can be listed as present but still refuse to load (broken install).
  for (const entry of fonts) {
    if (!entry.missing) {
      const ok = await tryLoadFont({ family: entry.family, style: entry.style });
      if (!ok) entry.missing = true;
    }
  }

  return {
    success: true,
    data: {
      scope: scope,
      textNodes: nodes.length,
      fonts: fonts,
      missingFonts: fonts.filter((f) => f.missing).map((f) => f.family + " " + f.style),
    },
  };
}

async function setFont(params: Record<string, unknown>): Promise<CommandResult> {
  const family = params.family as string;
  if (!family) return { success: false, error: "No family provided" };

  const scope = (params.scope as Scope) || "selection";
  const nodes = await collectTextNodes(scope, params.nodeIds as string[] | undefined);
  if (nodes.length === 0) return { success: false, error: "No text nodes found for the given scope" };

  const requestedStyle = (params.style as string) || "";
  const keepStyles = requestedStyle === "";

  let changed = 0;
  const errors: string[] = [];

  for (const node of nodes) {
    try {
      if (keepStyles) {
        // Map every segment onto the same style in the new family.
        const segments =
          node.fontName === figma.mixed
            ? node.getStyledTextSegments(["fontName"])
            : [{ start: 0, end: node.characters.length, fontName: node.fontName as FontName }];

        for (const segment of segments) {
          const style = await resolveStyle(family, segment.fontName.style);
          if (!style) {
            errors.push("Font family not available: " + family);
            continue;
          }
          const target = { family: family, style: style };
          const loaded = await tryLoadFont(target);
          if (!loaded) {
            errors.push("Could not load " + family + " " + style);
            continue;
          }
          if (node.fontName !== figma.mixed) {
            node.fontName = target;
          } else {
            node.setRangeFontName(segment.start, segment.end, target);
          }
        }
        changed++;
      } else {
        const style = await resolveStyle(family, requestedStyle);
        if (!style) return { success: false, error: "Font family not available: " + family };
        const target = { family: family, style: style };
        const loaded = await tryLoadFont(target);
        if (!loaded) return { success: false, error: "Could not load " + family + " " + style };
        node.fontName = target;
        changed++;
      }
    } catch (err: any) {
      errors.push(node.name + ": " + (err.message || String(err)));
    }
  }

  return { success: true, data: { changed: changed, textNodes: nodes.length, errors: errors } };
}

async function replaceFont(params: Record<string, unknown>): Promise<CommandResult> {
  const fromFamily = params.fromFamily as string;
  const toFamily = params.toFamily as string;
  if (!fromFamily || !toFamily) return { success: false, error: "fromFamily and toFamily are required" };

  const fromStyle = (params.fromStyle as string) || "";
  const toStyle = (params.toStyle as string) || "";
  const scope = (params.scope as Scope) || "document";
  const nodes = await collectTextNodes(scope, params.nodeIds as string[] | undefined);

  let changed = 0;
  let segmentsChanged = 0;
  const errors: string[] = [];
  const mapping: Record<string, string> = {};

  for (const node of nodes) {
    let touched = false;
    try {
      for (const font of fontsOfNode(node)) {
        if (font.family.toLowerCase() !== fromFamily.toLowerCase()) continue;
        if (fromStyle && font.style.toLowerCase() !== fromStyle.toLowerCase()) continue;

        const style = await resolveStyle(toFamily, toStyle || font.style, toStyle);
        if (!style) return { success: false, error: "Target font family not available: " + toFamily };

        const target = { family: toFamily, style: style };
        const loaded = await tryLoadFont(target);
        if (!loaded) {
          errors.push("Could not load " + toFamily + " " + style);
          continue;
        }

        await applyFont(node, target, font);
        mapping[font.family + " " + font.style] = target.family + " " + target.style;
        segmentsChanged++;
        touched = true;
      }
      if (touched) changed++;
    } catch (err: any) {
      errors.push(node.name + ": " + (err.message || String(err)));
    }
  }

  return {
    success: true,
    data: { nodesChanged: changed, segmentsChanged: segmentsChanged, mapping: mapping, errors: errors },
  };
}

async function setText(params: Record<string, unknown>): Promise<CommandResult> {
  const nodeId = params.nodeId as string;
  const text = params.text as string;
  if (!nodeId) return { success: false, error: "nodeId is required" };
  if (typeof text !== "string") return { success: false, error: "text is required" };

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) return { success: false, error: "Node not found: " + nodeId };
  if (node.type !== "TEXT") return { success: false, error: "Node is not a text node: " + node.type };

  const textNode = node as TextNode;

  // An explicit font wins; otherwise keep what the node already uses.
  if (params.family) {
    const family = params.family as string;
    const style = await resolveStyle(family, (params.style as string) || "Regular");
    if (!style) return { success: false, error: "Font family not available: " + family };
    const target = { family: family, style: style };
    const loaded = await tryLoadFont(target);
    if (!loaded) return { success: false, error: "Could not load " + family + " " + style };
    textNode.fontName = target;
  } else {
    const failed = await loadNodeFonts(textNode);
    if (failed.length > 0) {
      return {
        success: false,
        error:
          "Missing font(s) on this node: " +
          failed.join(", ") +
          ". Install the font, or pass family/style to replace it while setting the text.",
      };
    }
  }

  textNode.characters = text;
  const font = textNode.fontName === figma.mixed ? null : (textNode.fontName as FontName);

  return {
    success: true,
    data: {
      id: textNode.id,
      name: textNode.name,
      characters: textNode.characters,
      font: font ? font.family + " " + font.style : "mixed",
    },
  };
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function execute(params: Record<string, unknown>): Promise<CommandResult> {
  const code = params.code as string;
  if (!code) return { success: false, error: "No code provided" };
  const fn = new AsyncFunction("figma", "loadFont", "collectTextNodes", "fontsOfNode", "resolveStyle", code);
  const result = await fn(
    figma,
    (family: string, style: string) => figma.loadFontAsync({ family: family, style: style || "Regular" }),
    collectTextNodes,
    fontsOfNode,
    resolveStyle
  );
  return { success: true, data: result };
}

async function handleCommand(cmd: string, params: Record<string, unknown>): Promise<CommandResult> {
  try {
    switch (cmd) {
      case "list_fonts":
        return await listFonts(params);
      case "audit_fonts":
        return await auditFonts(params);
      case "set_font":
        return await setFont(params);
      case "replace_font":
        return await replaceFont(params);
      case "set_text":
        return await setText(params);
      case "execute":
        return await execute(params);
      default:
        return { success: false, error: "Unknown command: " + cmd };
    }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}

// ── Message relay ───────────────────────────────────────

figma.ui.onmessage = async (msg: { id?: string; command?: string; params?: Record<string, unknown>; type?: string }) => {
  // The UI asks for a font count on start, so the panel shows at a glance that
  // the locally installed fonts are visible to the plugin.
  if (msg.type === "ui-ready") {
    const fonts = await availableFonts();
    const families: Record<string, true> = {};
    for (const font of fonts) families[font.family] = true;
    figma.ui.postMessage({ type: "font-count", families: Object.keys(families).length });
    return;
  }

  if (!msg.id || !msg.command) return;
  const result = await handleCommand(msg.command, msg.params || {});
  figma.ui.postMessage({ id: msg.id, ...result });
};
