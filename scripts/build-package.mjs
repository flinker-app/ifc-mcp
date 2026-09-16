import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, transform } from "esbuild";
import { syncServerMetadata } from "./sync-server-metadata.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(root, "dist");
const viewerSource = path.join(root, "src-node", "static", "viewer.html");
const viewerTarget = path.join(dist, "static", "viewer.html");
const external = [
  "@modelcontextprotocol/server",
  "@modelcontextprotocol/server/*",
  "@modelcontextprotocol/core",
  "fast-xml-parser",
  "jszip",
  "zod",
  "zod/*",
];

await syncServerMetadata();
if ((await fs.lstat(dist).catch(error => { if (error.code !== "ENOENT") throw error; }))?.isSymbolicLink()) {
  throw new Error(`Refusing to replace a linked build directory: ${dist}`);
}
await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(path.dirname(viewerTarget), { recursive: true });
await fs.copyFile(path.join(root, "src-node", "tool-results.d.ts"), path.join(dist, "tool-results.d.ts"));

await build({
  entryPoints: {
    "ifc-mcp": path.join(root, "bin", "ifc-mcp.js"),
    server: path.join(root, "src-node", "server.js"),
  },
  outdir: dist,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  external,
});

await build({
  entryPoints: {
    browser: path.join(root, "src-node", "browser.js"),
    "tool-results": path.join(root, "src-node", "tool-results.js"),
  },
  outdir: dist,
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: false,
  legalComments: "none",
});

await fs.writeFile(viewerTarget, await minifyViewerHtml(await fs.readFile(viewerSource, "utf8")));

async function minifyViewerHtml(html) {
  const scriptMatch = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
  let minified = html;

  if (scriptMatch) {
    const script = await transform(scriptMatch[1], {
      loader: "js",
      minify: true,
      target: "es2022",
      legalComments: "none",
    });
    minified = minified.replace(scriptMatch[0], `<script type="module">${script.code.trim()}</script>`);
  }

  if (styleMatch) {
    const css = styleMatch[1]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\s+/g, " ")
      .replace(/\s*([{}:;,>])\s*/g, "$1")
      .trim();
    minified = minified.replace(styleMatch[0], `<style>${css}</style>`);
  }

  return minified
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ")
    .trim();
}
