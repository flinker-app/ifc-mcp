import { createPythonExecutor } from "./python-runtime.js";

// The sandboxed frame supplies trusted runtime assets before running user code.
// The Worker inherits its frame's policy, so browser networking is also blocked
// if Python reaches JavaScript APIs or starts a nested Worker.
self.addEventListener("message", ({ data, ports: [port] }) => {
  // Subsequent calls use a private port supplied by the iframe.
  const send = port.postMessage.bind(port);
  const { binaries, lock, wheel, sources, input } = data;
  const runtimeUrl = "https://ifc-mcp.invalid/";
  const assets = new Map(binaries.map(([name, bytes]) => [new URL(name, runtimeUrl).href, bytes]));
  self.fetch = async resource => {
    const url = String(resource instanceof Request ? resource.url : resource);
    const bytes = assets.get(url);
    if (!bytes) throw new TypeError("Python sandbox blocks network access.");
    return new Response(bytes, { headers: { "Content-Type": url.endsWith(".wasm")
      ? "application/wasm" : "application/octet-stream" } });
  };
  const execute = createPythonExecutor({
    loadPyodide: options => self.loadPyodide({ ...options, lockFileContents: lock,
      indexURL: runtimeUrl, packageBaseUrl: runtimeUrl }),
    loadWheel: async () => new Uint8Array(await wheel.arrayBuffer()),
    loadSources: () => sources,
    installPackages: py => py.loadPackage(lock.ifcMcpPackages),
  });
  async function run({ code, files, options }) {
    try {
      const reader = new FileReaderSync();
      const attachments = files.map(({ name, blob }) => ({
        name, size: blob.size,
        readInto(buffer, offset, length, position) {
          const bytes = new Uint8Array(reader.readAsArrayBuffer(blob.slice(position, position + length)));
          buffer.set(bytes, offset);
          return bytes.length;
        },
      }));
      const onProgress = progress => send({ progress });
      send({ output: await execute(code, attachments, { ...options, onProgress }) });
    } catch (error) {
      send({ error: error?.message || String(error), stderr: error?.stderr || "" });
    }
  }
  port.onmessageerror = () => send({ error: "Could not read Python worker input." });
  port.onmessage = ({ data }) => run(data);
  run(input);
}, { once: true });
