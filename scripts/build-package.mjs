import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { build, transform } from "esbuild";
import { syncServerMetadata } from "./sync-server-metadata.mjs";
import { buildPythonRuntime } from "./build-python-runtime.mjs";
import { loadNodePythonWheel } from "../src-node/python-node-environment.js";

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
  "pyodide",
];

await syncServerMetadata();
if ((await fs.lstat(dist).catch(error => { if (error.code !== "ENOENT") throw error; }))?.isSymbolicLink()) {
  throw new Error(`Refusing to replace a linked build directory: ${dist}`);
}
await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(path.dirname(viewerTarget), { recursive: true });
await fs.copyFile(path.join(root, "src-node", "tool-results.d.ts"), path.join(dist, "tool-results.d.ts"));
await fs.cp(path.join(root, "src-node", "python"), path.join(dist, "python"), {
  recursive: true,
  filter: source => path.basename(source) !== "__pycache__" && path.extname(source) !== ".pyc",
});
await fs.writeFile(path.join(dist, "python", "ifcopenshell.whl"), await loadNodePythonWheel());
await buildPythonRuntime(path.join(dist, "python", "runtime"));

const launchers = path.join(dist, "sandbox");
await fs.mkdir(launchers);
if (process.env.IFC_MCP_SANDBOX_ARTIFACTS) {
  for (const name of await fs.readdir(process.env.IFC_MCP_SANDBOX_ARTIFACTS)) {
    if (!/^(windows\.exe|linux-(?:x64|arm64)(?:\.(?:copyright|license))?)$/.test(name)) continue;
    const target = path.join(launchers, name);
    await fs.copyFile(path.join(process.env.IFC_MCP_SANDBOX_ARTIFACTS, name), target);
    if (name === "linux-x64" || name === "linux-arm64") await fs.chmod(target, 0o755);
  }
}
if (process.platform === "win32") {
  const binary = path.join(launchers, "windows.exe");
  const compiler = path.join(process.env.SystemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  await promisify(execFile)(compiler, ["/nologo", "/optimize+", `/out:${binary}`, path.join(root, "scripts", "WindowsPythonSandbox.cs")]);
}
if (process.platform === "linux" && ["x64", "arm64"].includes(process.arch)) {
  const binary = path.join(launchers, `linux-${process.arch}`);
  const artifactExists = await fs.stat(binary).then(() => true, error => {
    if (error.code !== "ENOENT") throw error;
    return false;
  });
  if (!artifactExists) {
    const { stdout } = await promisify(execFile)("gcc", ["-dumpmachine"]);
    await promisify(execFile)("musl-gcc", ["-static", "-O2", "-Wall", "-Wextra", "-Werror", "-std=c17",
      "-idirafter", "/usr/include", "-idirafter", `/usr/include/${stdout.trim()}`,
      path.join(root, "scripts", "linux-python-sandbox.c"), "-o", binary]);
    await fs.copyFile("/usr/share/doc/musl/copyright", `${binary}.copyright`);
  }
}

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
  entryPoints: [path.join(root, "src-node", "python-worker-node.js")],
  outdir: dist,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
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

await build({
  entryPoints: [path.join(root, "src-node", "python-worker-browser.js")],
  outdir: dist,
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  minify: true,
  legalComments: "none",
});

await fs.writeFile(viewerTarget, await minifyViewerHtml(await fs.readFile(viewerSource, "utf8")));
await fs.copyFile(path.join(root, "src-node", "static", "python-files.html"), path.join(dist, "static", "python-files.html"));

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
