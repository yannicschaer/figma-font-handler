// Runs the built plugin sandbox bundle against a mock Figma API.
// Verifies the font logic without needing Figma open: npm run build && npm test
import fs from "fs";
import vm from "vm";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, "../mcp/dist/figma-plugin/code.js"), "utf-8");
const MIXED = Symbol("mixed");

// Fonts "installed" on this machine — Proxima Nova deliberately absent.
const AVAILABLE = [
  { fontName: { family: "Inter", style: "Regular" } },
  { fontName: { family: "Inter", style: "Bold" } },
  { fontName: { family: "Inter", style: "Semi Bold" } },
  { fontName: { family: "Arial", style: "Regular" } },
];

function textNode(id, name, fontName, characters, segments) {
  return {
    id, name, type: "TEXT", characters,
    fontName,
    hasMissingFont: false,
    getStyledTextSegments() { return segments || []; },
    setRangeFontName(start, end, font) {
      this._ranges = this._ranges || [];
      this._ranges.push({ start, end, font });
      const seg = (segments || []).find((s) => s.start === start && s.end === end);
      if (seg) seg.fontName = font;
    },
  };
}

const nodeA = textNode("A", "Headline", { family: "Proxima Nova", style: "Regular" }, "Hello");
nodeA.hasMissingFont = true;

const nodeB = textNode("B", "Mixed", MIXED, "Bold and normal", [
  { start: 0, end: 4, fontName: { family: "Proxima Nova", style: "Bold" } },
  { start: 4, end: 15, fontName: { family: "Proxima Nova", style: "Regular" } },
]);
nodeB.hasMissingFont = true;

const nodeC = textNode("C", "Body", { family: "Inter", style: "Regular" }, "Untouched");

const ALL = [nodeA, nodeB, nodeC];
let uiHandler = null;
const uiMessages = [];

const figma = {
  mixed: MIXED,
  showUI() {},
  ui: {
    set onmessage(fn) { uiHandler = fn; },
    postMessage(msg) { uiMessages.push(msg); },
  },
  async listAvailableFontsAsync() { return AVAILABLE; },
  async loadFontAsync(font) {
    const hit = AVAILABLE.some((f) => f.fontName.family === font.family && f.fontName.style === font.style);
    if (!hit) throw new Error(`Cannot load font ${font.family} ${font.style}`);
  },
  async getNodeByIdAsync(id) { return ALL.find((n) => n.id === id) || null; },
  async loadAllPagesAsync() {},
  currentPage: { selection: [nodeA], findAllWithCriteria: () => ALL },
  root: { findAllWithCriteria: () => ALL },
};

vm.createContext(globalThis);
globalThis.figma = figma;
globalThis.__html__ = "<html></html>";
vm.runInThisContext(code);

async function call(command, params) {
  uiMessages.length = 0;
  await uiHandler({ id: "t1", command, params });
  return uiMessages.find((m) => m.id === "t1");
}

function check(label, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  → " + JSON.stringify(detail)}`);
  if (!cond) process.exitCode = 1;
}

const audit = await call("audit_fonts", { scope: "document" });
check("audit lists each family + style combination", audit.data.fonts.length === 3, audit.data.fonts);
check("audit flags Proxima Nova as missing",
  audit.data.missingFonts.some((f) => f.startsWith("Proxima Nova")), audit.data.missingFonts);
check("audit does not flag Inter",
  !audit.data.missingFonts.some((f) => f.startsWith("Inter")), audit.data.missingFonts);

const rep = await call("replace_font", { fromFamily: "Proxima Nova", toFamily: "Inter", scope: "document" });
check("replace touched 2 nodes", rep.data.nodesChanged === 2, rep.data);
check("A is now Inter Regular",
  nodeA.fontName.family === "Inter" && nodeA.fontName.style === "Regular", nodeA.fontName);
check("B Bold segment mapped to Inter Bold",
  nodeB._ranges.some((r) => r.start === 0 && r.font.family === "Inter" && r.font.style === "Bold"), nodeB._ranges);
check("B Regular segment mapped to Inter Regular",
  nodeB._ranges.some((r) => r.start === 4 && r.font.family === "Inter" && r.font.style === "Regular"), nodeB._ranges);
check("C untouched", nodeC.fontName.family === "Inter" && !nodeC._ranges, nodeC.fontName);

const missingTarget = await call("replace_font", { fromFamily: "Inter", toFamily: "Nonexistent Font", scope: "document" });
check("unknown target family errors", missingTarget.success === false, missingTarget);

const setText = await call("set_text", { nodeId: "C", text: "New copy" });
check("set_text writes characters", nodeC.characters === "New copy", nodeC.characters);

nodeA.fontName = { family: "Proxima Nova", style: "Regular" };
const setTextMissing = await call("set_text", { nodeId: "A", text: "nope" });
check("set_text refuses on missing font", setTextMissing.success === false, setTextMissing);
check("set_text error names the font",
  String(setTextMissing.error).includes("Proxima Nova"), setTextMissing.error);

const setTextFix = await call("set_text", { nodeId: "A", text: "fixed", family: "Inter", style: "Bold" });
check("set_text with family swaps font and writes",
  setTextFix.success === true && nodeA.characters === "fixed" && nodeA.fontName.style === "Bold", setTextFix);

const fonts = await call("list_fonts", { filter: "int" });
check("list_fonts filters", fonts.data.families.length === 1 && fonts.data.families[0].family === "Inter", fonts.data);
check("list_fonts groups styles", fonts.data.families[0].styles.length === 3, fonts.data.families[0]);

const setFont = await call("set_font", { family: "Arial", scope: "selection" });
check("set_font on selection keeps style mapping",
  nodeA.fontName.family === "Arial" && nodeA.fontName.style === "Regular", nodeA.fontName);

const unknown = await call("bogus_command", {});
check("unknown command errors", unknown.success === false, unknown);
