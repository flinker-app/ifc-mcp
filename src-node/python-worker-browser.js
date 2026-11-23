import { IFCOPENSHELL_BUILD, PYODIDE_INDEX_URL } from "./constants.js";
import { downloadWheel } from "./python-assets.js";
import { createPythonExecutor } from "./python-runtime.js";

const execute = createPythonExecutor({
  loadPyodide: async options => {
    const { loadPyodide } = await import(/* @vite-ignore */ `${PYODIDE_INDEX_URL}pyodide.mjs`);
    return loadPyodide({ ...options, indexURL: PYODIDE_INDEX_URL });
  },
  // The upstream build bucket has no browser CORS headers. Serve the verified
  // wheel packaged beside this worker, using the same pinned checksum as Node.
  loadWheel: () => downloadWheel({ ...IFCOPENSHELL_BUILD,
    sha256: IFCOPENSHELL_BUILD.packagedSha256,
    url: new URL("./python/ifcopenshell.whl", import.meta.url).href }),
  loadSources: async () => Object.fromEntries(await Promise.all(
    ["display.py", "execution.py", "ifcopenshell_compat.py"].map(async name => {
      const response = await fetch(new URL(`./python/${name}`, import.meta.url));
      if (!response.ok) throw new Error(`Could not load Python helper ${name}: ${response.status}`);
      return [name, await response.text()];
    }))),
});
self.addEventListener("message", async ({ data: { id, code, files, options } }) => {
  try {
    const onProgress = progress => self.postMessage({ ...progress, id, type: "progress" });
    self.postMessage({ id, output: await execute(code, files, { ...options, onProgress }) });
  } catch (error) {
    self.postMessage({ id, error: { message: error.message || String(error), stdout: error.stdout || "", stderr: error.stderr || "", fatal: Boolean(error.pyodide_fatal_error) } });
  }
});
