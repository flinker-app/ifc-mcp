import { IFC_MCP_TOOL_NAMES } from "./tool-definitions.js";
import { pythonToolResult } from "./tool-results.js";

export function createIfcMcpHostHandlers({
  viewer = null,
  python = null,
} = {}) {
  const supplied = { ...python, ...viewer };
  return Object.fromEntries(IFC_MCP_TOOL_NAMES
    .filter(name => typeof supplied[name] === "function")
    .map(name => [name, supplied[name]]));
}

// Tool parameter mapping is shared by the Node and browser runtimes.
export function createIfcMcpToolHandlers(operations) {
  const handlers = {
    "run-python": operations["run-python"] && (async ({ code, files }, request) => publicPythonResult(await operations["run-python"]({ code, files, signal: request.signal }))),
    "open-ifc-viewer": operations["open-ifc-viewer"] && ((_args, request) => operations["open-ifc-viewer"](request)),
    "show-ifc-file": operations["show-ifc-file"] && (({ file_path }, request) => operations["show-ifc-file"](file_path, request)),
    "clear-ifc-viewer": operations["clear-ifc-viewer"] && ((_args, request) => operations["clear-ifc-viewer"](request)),
    "set-bcf-view": operations["set-bcf-view"] && (({ bcf_path }, request) => operations["set-bcf-view"](bcf_path, request)),
  };
  return createIfcMcpHostHandlers({ viewer: handlers });
}

export function publicPythonResult(value) {
  if (value && typeof value === "object" && "content" in value) return pythonToolResult(value);
  return pythonToolResult({
    ok: Boolean(value?.ok),
    result: value?.result ?? null,
    stdout: value?.stdout || "",
    stderr: value?.stderr || "",
    saved_files: Array.isArray(value?.saved_files) ? value.saved_files : [],
    uploaded_files: Array.isArray(value?.uploaded_files) ? value.uploaded_files : [],
  });
}
