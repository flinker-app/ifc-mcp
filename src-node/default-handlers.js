import { executeIfcPython } from "./python-runner.js";
import { clearViewer, loadIfcFile, openViewer, setViewerBcfState } from "./viewer.js";

export function createDefaultIfcMcpToolHandlers() {
  return {
    "run-python": async ({
      code,
      files = [],
      timeout_seconds = 120,
    }) => {
      const executed = await executeIfcPython({
        code,
        files,
        timeoutSeconds: timeout_seconds,
      });
      return publicPythonResult(executed);
    },

    "open-ifc-viewer": async () => openViewer(),

    "show-ifc-file": async ({ file_path }) =>
      loadIfcFile({
        filePath: file_path,
      }),

    "clear-ifc-viewer": async () => clearViewer(),

    "set-bcf-view": async ({ bcf_path }) =>
      setViewerBcfState({
        bcfPath: bcf_path,
      }),
  };
}

export function publicPythonResult(value) {
  return {
    ok: Boolean(value?.ok),
    result: value?.result ?? null,
    stdout: value?.stdout || "",
    stderr: value?.stderr || "",
    saved_files: Array.isArray(value?.saved_files) ? value.saved_files : [],
    uploaded_files: Array.isArray(value?.uploaded_files) ? value.uploaded_files : [],
  };
}
