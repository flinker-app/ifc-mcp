export const IFC_SUFFIXES = [".ifc", ".ifczip"];
export const BCF_SUFFIXES = [".bcf", ".bcfzip"];

// Keep Pyodide on the Python 3.13 / Emscripten 2025 ABI used by this wheel.
export const PYODIDE_VERSION = "0.28.3";
export const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
export const IFCOPENSHELL_BUILD = Object.freeze({
  version: "0.9.1",
  revision: "a963c38",
  url: "https://s3.amazonaws.com/ifcopenshell-builds/ifcopenshell-0.9.1%2Ba963c38-cp313-cp313-pyemscripten_2025_0_wasm32.whl",
  sha256: "e3af4c9c7ef5504729488fd7d375ab9edd35abee0507758eabb7020922e49284",
  packagedSha256: "aedd30d015bc133c530c2399274322b7ddb1ff6c3de2386ea548867809fe8922",
});
export const DEFAULT_MAX_OUTPUT_CHARS = 200_000;
export const DEFAULT_VIEWER_PORT = 8765;
export const DEFAULT_VIEWER_URL = `http://127.0.0.1:${DEFAULT_VIEWER_PORT}`;
