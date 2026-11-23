import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PYODIDE_INDEX_URL, PYODIDE_VERSION } from "../src-node/constants.js";
import { PYODIDE_PACKAGES } from "../src-node/python-runtime.js";

const upstream = new URL("../node_modules/pyodide/", import.meta.url);
const cache = path.join(os.tmpdir(), "ifc-mcp-python", PYODIDE_VERSION);
const baseFiles = ["pyodide.js", "pyodide.mjs", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip"];

export async function buildPythonRuntime(target) {
  const { info, packages } = JSON.parse(await fs.readFile(new URL("pyodide-lock.json", upstream), "utf8"));
  const extra = JSON.parse(await fs.readFile(new URL("./python-wheels.json", import.meta.url), "utf8"));
  const sources = new Map();
  for (const [name, [url, sha256, dependencies, imports]] of Object.entries(extra)) {
    const fileName = new URL(url).pathname.split("/").at(-1);
    packages[name] = { name, file_name: fileName, version: fileName.split("-")[1], sha256,
      install_dir: "site", package_type: "package", imports,
      depends: dependencies.filter(dependency => dependency !== "ifcopenshell") };
    sources.set(name, url);
  }
  const selected = {};
  function add(name) {
    const normalized = name.replaceAll("_", "-");
    if (selected[normalized]) return;
    const entry = packages[normalized];
    if (!entry) throw new Error(`Missing Python package in lockfile: ${name}`);
    selected[normalized] = entry;
    entry.depends.forEach(add);
  }
  const ifcMcpPackages = [...Object.keys(extra), "pytest", "pyparsing", "python-dateutil"];
  [...PYODIDE_PACKAGES, ...ifcMcpPackages].forEach(add);

  await fs.mkdir(target, { recursive: true });
  await Promise.all([
    ...baseFiles.map(name => fs.copyFile(new URL(name, upstream), path.join(target, name))),
    ...Object.entries(selected).map(async ([name, entry]) => {
      const url = sources.get(name) ?? new URL(entry.file_name, PYODIDE_INDEX_URL);
      const bytes = await loadPackage(entry, url);
      await fs.writeFile(path.join(target, entry.file_name), bytes);
    }),
  ]);
  await fs.writeFile(path.join(target, "pyodide-lock.json"), JSON.stringify({ info, packages: selected, ifcMcpPackages }));
}

async function loadPackage({ file_name: name, sha256 }, url) {
  const verify = bytes => createHash("sha256").update(bytes).digest("hex") === sha256;
  const cached = await fs.readFile(path.join(cache, name)).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
  if (cached && verify(cached)) return cached;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Could not download Python package ${name}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!verify(bytes)) throw new Error(`Python package checksum mismatch: ${name}`);
  return bytes;
}
