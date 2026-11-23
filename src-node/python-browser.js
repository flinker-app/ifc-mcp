import { IFCOPENSHELL_BUILD } from "./constants.js";
import { verifyWheel } from "./python-assets.js";
import { normalizePythonOptions } from "./python-environment.js";
import { abortable } from "./operations.js";

const sandboxSource = `<!doctype html>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<script>
  addEventListener("message", event => {
    if (event.source !== parent || event.ports.length !== 1) return;
    const port = event.ports[0];
    const { scripts, ...input } = event.data;
    const url = URL.createObjectURL(new Blob(scripts, { type: "text/javascript" }));
    const worker = new Worker(url);
    worker.onmessage = event => port.postMessage(event.data);
    worker.onerror = event => port.postMessage({ error: event.message || "Python worker failed" });
    worker.postMessage(input);
  }, { once: true });
</script>`;

let active;
export const acceptsFileBlobs = true;

async function asset(name, format, signal) {
  const response = await fetch(new URL(name, import.meta.url), { credentials: "same-origin", signal });
  if (!response.ok) throw new Error(`Could not load Python runtime asset ${name}: ${response.status}`);
  return response[format]();
}

async function loadAssets(signal) {
  const [lock, scripts, wheel, sources] = await Promise.all([
    asset("./python/runtime/pyodide-lock.json", "json", signal),
    Promise.all(["pyodide.asm.js", "pyodide.js"].map(name => asset(`./python/runtime/${name}`, "text", signal))
      .concat(asset("./python-worker-browser.js", "text", signal))),
    asset("./python/ifcopenshell.whl", "blob", signal).then(async blob => {
      await verifyWheel(await blob.arrayBuffer(), { sha256: IFCOPENSHELL_BUILD.packagedSha256 });
      return blob;
    }),
    Promise.all(["display.py", "execution.py", "ifcopenshell_compat.py"].map(async name =>
      [name, await asset(`./python/${name}`, "text", signal)])),
  ]);
  const names = ["pyodide.asm.wasm", "python_stdlib.zip", ...Object.values(lock.packages).map(item => item.file_name)];
  const binaries = await Promise.all(names.map(async name => [name, await asset(`./python/runtime/${name}`, "blob", signal)]));
  return { lock, scripts: scripts.map(script => `${script}\n`), wheel, sources: Object.fromEntries(sources), binaries };
}

export async function runPythonInWorker(code, files = [], options = {}) {
  if (active) throw new Error("The previous Python call is still running. Wait for it to finish.");
  options.signal?.throwIfAborted();
  const operation = new AbortController();
  const normalized = normalizePythonOptions(options);
  active = operation;
  const onAbort = () => operation.abort(options.signal.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let frame;
  let channel;
  let startupTimer;
  try {
    const assets = await loadAssets(operation.signal);
    operation.signal.throwIfAborted();
    frame = document.createElement("iframe");
    frame.hidden = true;
    frame.setAttribute("sandbox", "allow-scripts");
    frame.srcdoc = sandboxSource;
    channel = new MessageChannel();
    const result = new Promise((resolve, reject) => {
      startupTimer = setTimeout(() => reject(new Error("Could not start the browser Python sandbox.")), 15_000);
      channel.port1.onmessage = ({ data }) => {
        clearTimeout(startupTimer);
        if (!data || typeof data !== "object") {
          reject(new Error("Invalid Python sandbox message."));
          return;
        }
        if (data.progress) options.onProgress?.(data.progress);
        else if (data.error) reject(Object.assign(new Error(data.error), { stderr: data.stderr }));
        else {
          const output = data.output;
          if (!output || !Array.isArray(output.files)) {
            reject(new Error("Invalid Python sandbox output."));
            return;
          }
          // Accept output bytes from Python, never URLs or callbacks supplied by the worker.
          resolve({ result: output.result, stdout: output.stdout, stderr: output.stderr,
            files: output.files.filter(file => file && typeof file.path === "string" && file.blob instanceof Blob)
              .map(({ path, blob }) => ({ path, blob })) });
        }
      };
      channel.port1.onmessageerror = () => reject(new Error("Could not read Python sandbox output."));
      frame.onload = () => {
        frame.onload = null;
        frame.contentWindow?.postMessage({ ...assets, code, files, options: normalized }, "*", [channel.port2]);
      };
      document.body.append(frame);
    });
    return await abortable(result, operation.signal);
  } finally {
    operation.abort();
    clearTimeout(startupTimer);
    frame?.remove();
    channel?.port1.close();
    channel?.port2.close();
    options.signal?.removeEventListener("abort", onAbort);
    if (active === operation) active = undefined;
  }
}

export function closePythonRuntime() {
  active?.abort(new Error("Python runtime closed"));
}
