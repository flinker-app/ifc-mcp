import { executeIfcPython } from "./python-runner.js";
import { clearViewer, loadIfcFile, openViewer, setViewerBcfState } from "./viewer.js";
import { createIfcMcpToolHandlers } from "./host-handlers.js";

export function createDefaultIfcMcpToolHandlers() {
  return createIfcMcpToolHandlers({
    "run-python": executeIfcPython,
    "open-ifc-viewer": openViewer,
    "show-ifc-file": (filePath, { signal }) => loadIfcFile({ filePath, signal }),
    "clear-ifc-viewer": clearViewer,
    "set-bcf-view": (bcfPath, { signal }) => setViewerBcfState({ bcfPath, signal }),
  });
}
