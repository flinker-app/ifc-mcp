import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import JSZip from "jszip";
import { loadPyodide } from "pyodide";
import { IFCOPENSHELL_BUILD, PYODIDE_VERSION } from "./constants.js";
import { downloadWheel, verifyWheel } from "./python-assets.js";
import { createPythonExecutor } from "./python-runtime.js";

const cache = path.join(os.tmpdir(), "ifc-mcp-python", PYODIDE_VERSION);

export async function loadNodePythonWheel(build = IFCOPENSHELL_BUILD) {
  const upstream = () => loadCachedWheel(build.sha256, () => downloadWheel(build));
  if (!build.packagedSha256) return upstream();
  try {
    const bytes = await fs.readFile(new URL("./python/ifcopenshell.whl", import.meta.url));
    return await verifyWheel(new Uint8Array(bytes), { sha256: build.packagedSha256 });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return loadCachedWheel(build.packagedSha256, async () => {
    const bytes = await assembleNativeWheel(await upstream(), build.version);
    return verifyWheel(bytes, { sha256: build.packagedSha256 });
  });
}

async function loadCachedWheel(sha256, fetchBytes) {
  await fs.mkdir(cache, { recursive: true });
  const target = path.join(cache, `${sha256}.whl`);
  try {
    return await verifyWheel(new Uint8Array(await fs.readFile(target)), { sha256 });
  } catch (error) {
    if (error.code !== "ENOENT" && !error.message.includes("checksum mismatch")) throw error;
  }
  const bytes = await fetchBytes();
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return bytes;
}

async function assembleNativeWheel(upstream, version) {
  const wheel = await JSZip.loadAsync(upstream);
  const pluginName = "ifcopenshell_geometry_tree_opencascade_trianglebvh.so";
  const plugin = await fs.readFile(new URL(`../vendor/ifcopenshell/${pluginName}`, import.meta.url));
  const pluginPath = `ifcopenshell/${pluginName}`;
  const recordPath = `ifcopenshell-${version}.dist-info/RECORD`;
  const record = await wheel.file(recordPath).async("string");
  const digest = createHash("sha256").update(plugin).digest("base64url");
  const rows = record.split("\n").map(row => row.startsWith(pluginPath + ",")
    ? `${pluginPath},sha256=${digest},${plugin.length}` : row);
  for (const [name, content] of [[pluginPath, plugin], [recordPath, rows.join("\n")]]) {
    const { date, unixPermissions } = wheel.file(name);
    wheel.file(name, content, { date, unixPermissions, createFolders: false });
  }
  return wheel.generateAsync({ type: "uint8array", platform: "UNIX", compression: "DEFLATE" });
}

export function createNodePythonExecutor(build = IFCOPENSHELL_BUILD) {
  return createPythonExecutor({
    build,
    loadPyodide: async options => {
      await fs.mkdir(cache, { recursive: true });
      return loadPyodide({ ...options, packageCacheDir: cache });
    },
    loadWheel: () => loadNodePythonWheel(build),
    loadSources: async () => Object.fromEntries(await Promise.all(
      ["display.py", "execution.py", "ifcopenshell_compat.py"].map(async name =>
        [name, await fs.readFile(new URL(`./python/${name}`, import.meta.url), "utf8")]))),
  });
}
