import { createPythonExecutor } from "./python-runtime.js";

// The sandboxed frame supplies trusted runtime assets before running user code.
// The Worker inherits its frame's policy, so browser networking is also blocked
// if Python reaches JavaScript APIs or starts a nested Worker.
self.addEventListener("message", async ({ data }) => {
  const { binaries, lock, wheel, sources, code, files, options } = data;
  const runtimeUrl = "https://ifc-mcp.invalid/";
  const assets = new Map(binaries.map(([name, bytes]) => [new URL(name, runtimeUrl).href, bytes]));
  self.fetch = async resource => {
    const url = String(resource instanceof Request ? resource.url : resource);
    const bytes = assets.get(url);
    if (!bytes) throw new TypeError("Python sandbox blocks network access.");
    return new Response(bytes, { headers: { "Content-Type": url.endsWith(".wasm")
      ? "application/wasm" : "application/octet-stream" } });
  };
  try {
    const execute = createPythonExecutor({
      loadPyodide: options => self.loadPyodide({ ...options, lockFileContents: lock,
        indexURL: runtimeUrl, packageBaseUrl: runtimeUrl }),
      loadWheel: async () => new Uint8Array(await wheel.arrayBuffer()),
      loadSources: () => sources,
      installPackages: py => py.loadPackage(lock.ifcMcpPackages),
    });
    const reader = new FileReaderSync();
    const attachments = files.map(({ name, blob }) => ({
      name, size: blob.size,
      readInto(buffer, offset, length, position) {
        const bytes = new Uint8Array(reader.readAsArrayBuffer(blob.slice(position, position + length)));
        buffer.set(bytes, offset);
        return bytes.length;
      },
    }));
    const onProgress = progress => self.postMessage({ progress });
    self.postMessage({ output: await execute(code, attachments, { ...options, onProgress }) });
  } catch (error) {
    self.postMessage({ error: error.message || String(error), stderr: error.stderr || "" });
  }
}, { once: true });
