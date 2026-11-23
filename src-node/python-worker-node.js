import fs from "node:fs/promises";
import { readSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPythonExecutor } from "./python-runtime.js";

const root = new URL("./python/", import.meta.url);
const runtime = new URL("./runtime/", root);
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const read = name => fs.readFile(new URL(name, root));
const sourceNames = ["display.py", "execution.py", "ifcopenshell_compat.py"];
const openFiles = [];

try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { code, files, options } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const attachments = [];
  for (const { name } of files) {
    const handle = await fs.open(new URL(`./inputs/${attachments.length}`, import.meta.url), "r");
    openFiles.push(handle);
    attachments.push({ name, size: (await handle.stat()).size, handle });
  }
  const lock = JSON.parse(await read("runtime/pyodide-lock.json"));
  const { loadPyodide } = await import(new URL("pyodide.mjs", runtime));
  const execute = createPythonExecutor({
    loadPyodide: settings => loadPyodide({ ...settings, indexURL: fileURLToPath(runtime),
      lockFileContents: lock, packageBaseUrl: fileURLToPath(runtime) }),
    loadWheel: async () => new Uint8Array(await read("ifcopenshell.whl")),
    loadSources: async () => Object.fromEntries(await Promise.all(sourceNames.map(async name => [name, (await read(name)).toString("utf8")]))),
    installPackages: py => py.loadPackage(lock.ifcMcpPackages, { messageCallback: () => {}, errorCallback: () => {} }),
  });
  const output = await execute(code, attachments.map(({ name, size, handle }) => ({
    name, size, readInto: (buffer, offset, length, position) => readSync(handle.fd, buffer, offset, length, position),
  })), {
    ...options, onProgress: progress => send({ progress }),
  });
  output.files = await Promise.all(output.files.map(async ({ path, blob }) => ({
    path, type: blob.type, bytes: Buffer.from(await blob.arrayBuffer()).toString("base64"),
  })));
  send({ output });
} catch (error) {
  send({ error: error?.message || String(error) });
} finally {
  await Promise.all(openFiles.map(file => file.close()));
}
