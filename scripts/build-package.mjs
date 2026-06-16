import fs from "node:fs/promises";
import path from "node:path";

import { build, transform } from "esbuild";

const root = process.cwd();
const dist = path.join(root, "dist");
const viewerSource = path.join(root, "src-node", "static", "viewer.html");
const viewerTarget = path.join(dist, "static", "viewer.html");
const external = [
  "@modelcontextprotocol/sdk",
  "@modelcontextprotocol/sdk/*",
  "fast-xml-parser",
  "jszip",
  "zod",
  "zod/*",
];

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(path.dirname(viewerTarget), { recursive: true });

await build({
  entryPoints: [path.join(root, "bin", "ifc-mcp.js")],
  outfile: path.join(dist, "ifc-mcp.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18.20",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  external,
});

await build({
  entryPoints: [path.join(root, "src-node", "server.js")],
  outfile: path.join(dist, "server.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18.20",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  external,
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
