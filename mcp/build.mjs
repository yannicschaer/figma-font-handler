import * as esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

// Bundle the MCP server (Node, stdio)
const serverBuild = {
  entryPoints: [path.join(__dirname, "src/mcp-server.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: path.join(__dirname, "dist/mcp-server.mjs"),
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: true,
};

// Bundle the Figma plugin sandbox code
const pluginBuild = {
  entryPoints: [path.join(__dirname, "figma-plugin/code.ts")],
  bundle: true,
  platform: "browser",
  target: "es2017",
  format: "iife",
  outfile: path.join(__dirname, "dist/figma-plugin/code.js"),
  sourcemap: false,
};

// The manifest lives in the repo root and points into dist/, so there is exactly
// one manifest to import — no source/dist mix-up.
function copyPluginFiles() {
  const pluginDist = path.join(__dirname, "dist/figma-plugin");
  fs.mkdirSync(pluginDist, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "figma-plugin/ui.html"), path.join(pluginDist, "ui.html"));
  console.log("Copied plugin UI");
}

async function build() {
  if (watch) {
    const serverCtx = await esbuild.context(serverBuild);
    const pluginCtx = await esbuild.context(pluginBuild);
    await serverCtx.watch();
    await pluginCtx.watch();
    copyPluginFiles();
    console.log("Watching for changes...");
  } else {
    await esbuild.build(serverBuild);
    await esbuild.build(pluginBuild);
    copyPluginFiles();
    fs.chmodSync(path.join(__dirname, "dist/mcp-server.mjs"), 0o755);
    console.log("Build complete");
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
