# figma-font-handler

MCP server + Figma plugin that exposes the machine's locally installed fonts to an AI assistant.

## Architecture

- `mcp/src/mcp-server.ts` — MCP server (stdio). Owns a WebSocket bridge on `:3056`, forwards each tool call to the plugin, resolves on its reply.
- `mcp/figma-plugin/code.ts` — plugin sandbox. All font logic lives here; it is the only place with access to locally installed fonts.
- `manifest.json` (repo root) — the only manifest. `main`/`ui` point into `mcp/dist/figma-plugin/`, so users import from the root and never pick a source folder without `code.js`.
- `mcp/figma-plugin/ui.html` — the WebSocket client. The sandbox cannot open sockets, so every message is relayed through the UI iframe.

Adding a tool means touching both sides: a `server.tool(...)` in the server and a `case` in `handleCommand`.

## Gotchas

- **Port 3056** is hardcoded in three places: `mcp-server.ts`, root `manifest.json` (`allowedDomains`), `ui.html`. Change all three or the plugin silently fails to connect.
- **`documentAccess: dynamic-page`** — `scope: "document"` must `await figma.loadAllPagesAsync()` before searching `figma.root`.
- **Mixed fonts** — `node.fontName` is `figma.mixed` when a node has several fonts. Use `getStyledTextSegments(["fontName"])` and `setRangeFontName`, never assume a single font.
- **Never let one node break a batch** — a text node can be locked by its main component or carry a font that will not load. Catch per node and report in `errors`.
- **Missing fonts** can be replaced without loading the old font; only the target font needs `loadFontAsync`.

## Verify

`npm test` runs the built sandbox bundle against a mock Figma API — no Figma needed, but it only covers `mcp/dist/figma-plugin/code.js`, so `npm run build` first.
