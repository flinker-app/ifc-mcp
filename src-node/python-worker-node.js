import fs from "node:fs/promises";
import { readSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createPythonExecutor } from "./python-runtime.js";

const root = new URL("./python/", import.meta.url);
const runtime = new URL("./runtime/", root);
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const read = name => fs.readFile(new URL(name, root));
const sourceNames = ["display.py", "execution.py", "ifcopenshell_compat.py"];
const lock = JSON.parse(await read("runtime/pyodide-lock.json"));
const { loadPyodide } = await import(new URL("pyodide.mjs", runtime));
const execute = createPythonExecutor({
  loadPyodide: settings => loadPyodide({ ...settings, indexURL: fileURLToPath(runtime),
    lockFileContents: lock, packageBaseUrl: fileURLToPath(runtime) }),
  loadWheel: async () => new Uint8Array(await read("ifcopenshell.whl")),
  loadSources: async () => Object.fromEntries(await Promise.all(sourceNames.map(async name => [name, (await read(name)).toString("utf8")]))),
  installPackages: py => py.loadPackage(lock.ifcMcpPackages, { messageCallback: () => {}, errorCallback: () => {} }),
});

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  try {
    const output = await run(JSON.parse(line));
    send({ output });
  } catch (error) {
    send({ error: error?.message || String(error) });
    break;
  }
}

async function run({ code, files, options, directory }) {
  const handles = [];
  try {
    const attachments = [];
    for (const { name } of files) {
      const handle = await fs.open(new URL(`./${directory}/${attachments.length}`, import.meta.url), "r");
      handles.push(handle);
      attachments.push({ name, size: (await handle.stat()).size,
        readInto: (buffer, offset, length, position) => readSync(handle.fd, buffer, offset, length, position) });
    }
    const output = await execute(code, attachments, { ...options, onProgress: progress => send({ progress }) });
    output.files = await Promise.all(output.files.map(async ({ path, blob }) => ({
      path, type: blob.type, bytes: Buffer.from(await blob.arrayBuffer()).toString("base64"),
    })));
    return output;
  } finally {
    await Promise.all(handles.map(handle => handle.close()));
  }
}
