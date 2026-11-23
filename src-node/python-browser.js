import { createPythonWorkerClient } from "./python-worker-client.js";

// Serve the worker and python/ assets beside browser.js when deploying a browser bundle.
const client = createPythonWorkerClient(() => new Worker(new URL("./python-worker-browser.js", import.meta.url), { type: "module" }));
export const runPythonInWorker = client.runPythonInWorker;
export const closePythonRuntime = client.dispose;
