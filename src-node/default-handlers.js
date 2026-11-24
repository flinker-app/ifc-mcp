import { executeIfcPython } from "./python-runner.js";
import { clearViewer, loadIfcFile, openViewer, openPythonFilePicker, setViewerBcfState } from "./viewer.js";
import { createIfcMcpToolHandlers } from "./host-handlers.js";
import { consumePythonFileHandoffs, getApprovedPythonFile } from "./approved-python-files.js";
import { describePythonFileHandoff } from "./python-file-handoff.js";
import { toolResult } from "./tool-results.js";

export function createDefaultIfcMcpToolHandlers(fileHandoffEntry, runtime) {
  return createIfcMcpToolHandlers({
    "run-python": async ({ code, files, signal }) => {
      const attachments = files.map(getApprovedPythonFile);
      if (attachments.some(file => !file)) {
        const { file_picker_url } = await openPythonFilePicker();
        const missing = files.flatMap((file, index) => attachments[index] ? [] : [{ file, index }]);
        const file_handoff = fileHandoffEntry && missing.every(({ file }) => !file.startsWith("ifc-file:"))
          ? describePythonFileHandoff(fileHandoffEntry, file_picker_url, missing)
          : undefined;
        let message = "Select the IFC files at file_picker_url, then pass their tool_path IDs in files.";
        if (file_handoff) {
          message = "Run the file handoff in your local terminal under its current permissions. Use the command and args, or the shell command for your terminal. Do not request broader permissions for the handoff. Retry run-python with the returned single-use tool_path IDs, replacing the entries at file_indices in order. If the handoff is unavailable, offer file_picker_url as an optional fallback.";
        } else if (fileHandoffEntry) {
          message = "A file ID expired or was already used. Pass the original local paths to start a new handoff, or select the files at file_picker_url.";
        }
        return toolResult({ ok: false, message, file_handoff, file_picker_url });
      }
      signal?.throwIfAborted();
      const releaseHandoffs = consumePythonFileHandoffs(attachments);
      try {
        return await executeIfcPython({ code, attachments, runtime, signal });
      } finally {
        await releaseHandoffs();
      }
    },
    "open-ifc-viewer": openViewer,
    "show-ifc-file": (filePath, { signal }) => loadIfcFile({ filePath, signal }),
    "clear-ifc-viewer": clearViewer,
    "set-bcf-view": (bcfPath, { signal }) => setViewerBcfState({ bcfPath, signal }),
  });
}
