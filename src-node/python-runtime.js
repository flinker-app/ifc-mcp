// This module runs inside the platform worker. It owns initialization, the
// virtual filesystem, per-call namespaces, result conversion and file capture.
import { IFCOPENSHELL_BUILD } from "./constants.js";

const OUT_DIR = "/home/pyodide";

export function createPythonExecutor({ loadPyodide, loadWheel, loadSources, build = IFCOPENSHELL_BUILD }) {
  let ready;
  async function initialize() {
    const py = await loadPyodide({ stdout: () => {}, stderr: () => {} });
    await py.loadPackage(["micropip", "numpy", "pandas", "matplotlib", "shapely", "typing-extensions"], {
      messageCallback: () => {}, errorCallback: () => {},
    });
    const sitePackages = py.runPython('import site; site.getsitepackages()[0]');
    py.unpackArchive(await loadWheel(), "zip", { extractDir: sitePackages });
    const moduleDirectory = `${sitePackages}/ifcopenshell`;
    // IfcOpenShell needs its core registry and OpenCascade symbols shared.
    // Load these two globally, in order. Keep the other plugins scoped so
    // their identical metadata entry-point names do not shadow each other.
    const wrapper = py.FS.readdir(moduleDirectory).find(name => name.startsWith("_ifcopenshell_wrapper") && name.endsWith(".so"));
    for (const name of [wrapper, "ifcopenshell_geometry_kernel_opencascade.so"].filter(name => name && py.FS.analyzePath(`${moduleDirectory}/${name}`).exists)) {
      await py._module.loadDynamicLibrary(`${moduleDirectory}/${name}`, {
        global: true, nodelete: true, allowUndefined: true, loadAsync: true,
      });
    }
    await py.runPythonAsync(`
import micropip
await micropip.install(["lark==1.2.2", "isodate==0.7.2", "python-dateutil", "pyparsing", "bcf-client==${build.version.startsWith("0.9") ? "0.9.0" : "0.8.5"}", "ifcclash==${build.version.startsWith("0.9") ? "0.9.0" : "0.8.5"}", "plotly==5.24.1", "pytest==8.3.5"])
import ifcopenshell, ifcopenshell.geom, ifcopenshell.validate, importlib.metadata
assert importlib.metadata.version("ifcopenshell") == ${JSON.stringify(build.version)}
# Some official nightly wheels leave a packaging placeholder in __init__.py.
# Use the version from the checksum-verified wheel's metadata in that case.
if ifcopenshell.version == "0.0.0":
    ifcopenshell.__version__ = ifcopenshell.version = importlib.metadata.version("ifcopenshell")
# WASM cannot use dladdr() to discover the native module's directory.
if hasattr(ifcopenshell, "set_plugin_search_paths"):
    import os
    ifcopenshell.set_plugin_search_paths([os.path.dirname(ifcopenshell.__file__)])
import matplotlib; matplotlib.use("Agg")
`);
    const sources = await loadSources();
    const helpers = "/opt/ifc-mcp";
    py.FS.mkdirTree(helpers);
    for (const [name, source] of Object.entries(sources)) py.FS.writeFile(`${helpers}/${name}`, source);
    await py.runPythonAsync(`
import sys
sys.path.insert(0, "/opt/ifc-mcp")
import ifcopenshell_compat
ifcopenshell_compat.install()
# Preserve the package-level imports exposed by run-python. IfcClash defines
# these classes in its ifcclash submodule.
import ifcclash
from ifcclash import ifcclash as clash_api
for name in ("Clasher", "ClashSettings", "ClashResult", "ClashSet", "ClashSource"):
    setattr(ifcclash, name, getattr(clash_api, name))
`);
    await py.runPythonAsync(sources["display.py"]);
    await py.runPythonAsync(sources["execution.py"]);
    return py;
  }

  return async (code, attachments = [], options = {}) => {
    options.onProgress?.({ stage: "loading-runtime", message: "Loading Python runtime" });
    if (!ready) ready = initialize().catch(error => { ready = undefined; throw error; });
    const py = await ready;
    py.runPython("_ifc_mcp_reset_files()");
    const names = new Set();
    const before = new Map();
    for (const [index, attachment] of attachments.entries()) {
      const name = String(attachment.name || `input-${index + 1}.ifc`).replace(/\\/g, "/").split("/").pop();
      if (!name || name === "." || name === ".." || name.includes("\0")) throw new Error("Invalid Python input filename");
      if (names.has(name)) throw new Error(`Duplicate Python input filename: ${name}`);
      names.add(name);
      py.FS.writeFile(`${OUT_DIR}/${name}`, new Uint8Array(attachment.buffer));
      before.set(`${OUT_DIR}/${name}`, new Uint8Array(attachment.buffer));
    }
    try {
      options.onProgress?.({ stage: "running-code", message: "Running Python code" });
      py.globals.set("_ifc_mcp_code", String(code));
      py.globals.set("_ifc_mcp_options", JSON.stringify(options));
      const output = JSON.parse(await py.runPythonAsync("await _ifc_mcp_execute(_ifc_mcp_code, _ifc_mcp_options)"));
      const files = [];
      const captured = snapshot(py.FS);
      // 'grab' is an internal runtime option, for explicit files outside cwd.
      for (const item of options.grab || []) {
        const filePath = item.startsWith("/") ? item : `${OUT_DIR}/${item}`;
        if (!captured.has(filePath)) captured.set(filePath, py.FS.readFile(filePath));
      }
      for (const [filePath, bytes] of captured) {
        const original = before.get(filePath);
        if (original && equalBytes(original, bytes)) continue;
        files.push({ path: filePath, blob: new Blob([bytes], { type: mimeType(filePath) }) });
      }
      // MCP consumers receive rich displays as downloadable artifacts, too.
      // Large staged payloads are already included in the filesystem snapshot.
      for (const [index, display] of (output.displays || []).entries()) {
        const artifact = displayArtifact(display, index + 1);
        if (artifact) files.push(artifact);
      }
      options.onProgress?.({ stage: "complete", message: "Python complete" });
      return { result: { runtimeStatus: output.runtimeStatus, result: output.result },
        stdout: output.stdout, stderr: output.stderr, files, displays: output.displays };
    } finally {
      py.globals.delete("_ifc_mcp_code");
      py.globals.delete("_ifc_mcp_options");
      py.runPython("_ifc_mcp_reset_files()");
    }
  };
}

function snapshot(fs) {
  const files = new Map();
  function visit(directory) {
    for (const name of fs.readdir(directory)) {
      if (name === "." || name === ".." || name === "__pycache__") continue;
      const filePath = `${directory}/${name}`;
      const stat = fs.lstat(filePath);
      if (fs.isDir(stat.mode)) visit(filePath);
      else if (fs.isFile(stat.mode)) files.set(filePath, fs.readFile(filePath));
    }
  }
  visit(OUT_DIR);
  return files;
}

function equalBytes(first, second) {
  if (first.length !== second.length) return false;
  for (let index = 0; index < first.length; index++) if (first[index] !== second[index]) return false;
  return true;
}

function mimeType(name) {
  const extension = name.split(".").pop().toLowerCase();
  return ({ csv: "text/csv", json: "application/json", txt: "text/plain", html: "text/html",
    svg: "image/svg+xml", png: "image/png", pdf: "application/pdf", zip: "application/zip",
    bcf: "application/zip", bcfzip: "application/zip", ifczip: "application/zip", ifc: "application/x-step" })[extension]
    || "application/octet-stream";
}

function displayArtifact(display, index) {
  const formats = [
    ["image/svg+xml", "svg"], ["image/png", "png"], ["image/jpeg", "jpg"],
    ["text/html", "html"], ["application/vnd.plotly.v1+json", "json"], ["text/markdown", "md"],
  ];
  for (const [type, extension] of formats) {
    const value = display.data?.[type];
    if (value?.__assistant_display_ref__) return null;
    if (typeof value !== "string") continue;
    const bytes = type === "image/png" || type === "image/jpeg"
      ? Uint8Array.from(atob(value), char => char.charCodeAt(0)) : value;
    return { path: `${OUT_DIR}/.assistant-display/display-${index}.${extension}`, blob: new Blob([bytes], { type }) };
  }
  return null;
}
