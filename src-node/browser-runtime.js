import { DEFAULT_COPILOT_SDK_URL } from "./constants.js";
import { createIfcMcpToolHandlers } from "./host-handlers.js";
import { bcfToolResult } from "./tool-results.js";

let requestSequence = 0;
const runningSdks = new WeakSet();

function createRequestId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  // Worker correlation IDs are not security tokens. Share the counter across hosts.
  return `ifc-mcp-${Date.now().toString(36)}-${(++requestSequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// Files and generated downloads belong to this browser host, never an HTTP server.
export function createIfcMcpBrowserRuntime({ files, viewer,
  loadPython = () => import(/* @vite-ignore */ DEFAULT_COPILOT_SDK_URL),
}) {
  const generated = new Map();
  let running = false;

  async function resolveFile(reference) {
    const saved = Array.from(generated.values()).find(({ file, path }) =>
      reference === file.url || reference === file.name || reference === path);
    if (saved) return { name: saved.file.name, bytes: new Uint8Array(await saved.blob.arrayBuffer()) };
    const input = files.get(reference);
    if (!input) throw new Error(`Browser-local file not found: ${reference}`);
    const source = input.bytes ?? input.source;
    if (!source) throw new Error(`File contents are unavailable: ${reference}`);
    return { name: input.name, bytes: source instanceof Blob
      ? new Uint8Array(await source.arrayBuffer()) : new Uint8Array(source) };
  }

  async function runPython({ code, files: references, signal }) {
    signal?.throwIfAborted();
    if (running) throw new Error("The previous Python call is still running. Wait or reload the page.");
    running = true;
    let activeSdk;
    let output;
    try {
      const inputs = await Promise.all(references.map(resolveFile));
      // Transfer copies to the local worker so the viewer keeps its original bytes.
      const attachments = inputs.map(({ name, bytes }) => ({ name, buffer: bytes.buffer }));
      const sdk = await loadPython();
      signal?.throwIfAborted();
      if (runningSdks.has(sdk)) throw new Error("The previous Python call is still running. Wait for it to finish.");
      runningSdks.add(sdk);
      activeSdk = sdk;
      output = await sdk.runPythonInWorker(code, attachments, { requestId: createRequestId(), signal });
      signal?.throwIfAborted();
      const savedFiles = [];
      for (const item of output.files ?? []) {
        const name = String(item.name || item.path).replace(/\\/g, "/").split("/").pop();
        const blob = item.blob;
        if (!(blob instanceof Blob)) continue;
        const previous = generated.get(name);
        if (previous) URL.revokeObjectURL(previous.file.url);
        const file = { name, size: blob.size, mimeType: blob.type, url: item.url || URL.createObjectURL(blob) };
        generated.set(name, { file, blob, path: item.path || name });
        savedFiles.push(file);
      }
      for (const item of output.displayFiles ?? []) if (item.url) URL.revokeObjectURL(item.url);
      const raw = output.result;
      return {
        ok: raw?.runtimeStatus !== "error",
        stdout: output.stdout || "", stderr: output.stderr || "",
        result: raw?.result ?? raw ?? null,
        saved_files: savedFiles.map(file => ({ name: file.name, url: file.url, size_bytes: file.size, type: file.mimeType })),
        uploaded_files: inputs.map(({ name }) => ({ name })),
      };
    } finally {
      if (activeSdk) runningSdks.delete(activeSdk);
      if (signal?.aborted) {
        for (const item of [...(output?.files ?? []), ...(output?.displayFiles ?? [])]) {
          if (item.url) URL.revokeObjectURL(item.url);
        }
      }
      running = false;
    }
  }

  return {
    handlers: createIfcMcpToolHandlers({
      "run-python": runPython,
      "open-ifc-viewer": viewer && (async request => {
        return await viewer["open-ifc-viewer"]?.(request)
          ?? { viewer_open: true, viewer_location: "current browser", available_files: [...files.keys()] };
      }),
      "show-ifc-file": viewer?.["show-ifc-file"] && (async (reference, request) => {
        const file = await resolveFile(reference);
        request.signal?.throwIfAborted();
        return await viewer["show-ifc-file"](file.name, file.bytes, request)
          ?? { loaded_ifc_file: true, active_model_path: reference };
      }),
      "clear-ifc-viewer": viewer?.["clear-ifc-viewer"] && (async request => {
        return await viewer["clear-ifc-viewer"](request) ?? { cleared_viewer: true };
      }),
      "set-bcf-view": viewer?.["set-bcf-view"] && (async (reference, request) => {
        const file = await resolveFile(reference);
        request.signal?.throwIfAborted();
        return bcfToolResult(await viewer["set-bcf-view"](file.name, file.bytes, request));
      }),
    }),
    getGeneratedFiles: () => Array.from(generated.values(), ({ file }) => file),
    clearFiles() {
      for (const { file } of generated.values()) URL.revokeObjectURL(file.url);
      generated.clear();
    },
  };
}
