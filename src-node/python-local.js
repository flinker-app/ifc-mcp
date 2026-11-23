import { Worker } from "node:worker_threads";
import { createPythonWorkerClient } from "./python-worker-client.js";

const client = createPythonWorkerClient(() => new Worker(new URL("./python-worker-node.js", import.meta.url), { type: "module" }));
export const runPythonInWorker = client.runPythonInWorker;
export const closePythonRuntime = client.dispose;
