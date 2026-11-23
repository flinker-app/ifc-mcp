import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { runPythonInWorker, closePythonRuntime } from "../src-node/python-local.js";
import { downloadWheel } from "../src-node/python-assets.js";
import { createPythonExecutor } from "../src-node/python-runtime.js";

test("wheel downloads recover after failure and reject incorrect bytes", async t => {
  let requests = 0;
  const bytes = new TextEncoder().encode("verified wheel fixture");
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
  const server = createServer((_req, response) => {
    response.writeHead(++requests === 1 ? 503 : 200);
    response.end(bytes);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const build = { url: `http://127.0.0.1:${server.address().port}`, sha256: hash };
  await assert.rejects(downloadWheel(build), /503/);
  assert.deepEqual(await downloadWheel(build), bytes);
  await assert.rejects(downloadWheel({ ...build, sha256: "0".repeat(64) }), /checksum mismatch/);
});

test("failed Python initialization can be retried", async () => {
  let attempts = 0;
  const execute = createPythonExecutor({ loadPyodide() { throw new Error(`initialization ${++attempts}`); } });
  await assert.rejects(execute("pass"), /initialization 1/);
  await assert.rejects(execute("pass"), /initialization 2/);
});

test("desktop Python reads ranges of a large input from disk", { timeout: 180_000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ifc-mcp-large-input-"));
  const localPath = path.join(dir, "large.ifc");
  t.after(async () => {
    closePythonRuntime();
    await fs.unlink(localPath);
    await fs.rmdir(dir);
  });
  const size = 256 * 1024 * 1024;
  const file = await fs.open(localPath, "wx");
  try {
    await file.write("BEGIN", 0);
    await file.write("END", size - 3);
  } finally { await file.close(); }
  const measure = "from js import process\nresult = process.memoryUsage().arrayBuffers";
  const baseline = await runPythonInWorker(measure);
  assert.equal(baseline.result.runtimeStatus, "completed", baseline.stderr);
  const memoryCode = `
import os
with open('large.ifc', 'rb') as model:
    assert os.fstat(model.fileno()).st_size == ${size}
    assert model.read(5) == b'BEGIN'
    model.seek(-3, 2)
    assert model.read() == b'END'
${measure}
`;
  const output = await runPythonInWorker(memoryCode, [{ name: "large.ifc", localPath }]);
  assert.equal(output.result.runtimeStatus, "completed", output.stderr);
  const addedBytes = output.result.result - baseline.result.result;
  assert.ok(addedBytes < size / 2, `Input added ${addedBytes} bytes of ArrayBuffers`);
  assert.deepEqual(output.files, []);
});

test("real local Python environment supports the pinned IfcOpenShell build", { timeout: 480_000 }, async t => {
  t.after(closePythonRuntime);
  const run = async (code, files = [], options) => {
    const output = await runPythonInWorker(code, files, options);
    assert.equal(output.result.runtimeStatus, "completed", output.stderr);
    return output;
  };
  await t.test("package imports, version metadata, result aliases and top-level await", async () => {
    const output = await run(`
import ifcopenshell, ifcopenshell.api, ifcopenshell.geom, ifcopenshell.validate
import numpy, pandas, matplotlib, shapely, bcf.v3.bcfxml, ifcclash, plotly, pytest
import asyncio, importlib.metadata
await asyncio.sleep(0)
__assistant_result__ = {"version": importlib.metadata.version("ifcopenshell"), "runtime_version": ifcopenshell.version, "array": numpy.array([1, 2])}
print("ready", end="")
`);
    assert.deepEqual(output.result.result, { version: "0.9.1", runtime_version: "0.9.1", array: [1, 2] });
    assert.equal(output.stdout, "ready");
    assert.equal((await run("6 * 7")).result.result, 42);
  });
  await t.test("environment restoration, script filenames and fresh namespaces", async () => {
    const output = await run('import os; secret = 7; result = [os.environ["IFC_TEST_VALUE"], __file__]', [], {
      env: { IFC_TEST_VALUE: 42 }, scriptFileName: "calculation.py",
    });
    assert.deepEqual(output.result.result, ["42", "/home/pyodide/calculation.py"]);
    assert.ok(output.files.some(file => file.path.endsWith("calculation.py")));
    const clean = await run('import os; result = ["secret" in globals(), os.environ.get("IFC_TEST_VALUE"), os.path.exists("calculation.py")]');
    assert.deepEqual(clean.result.result, [false, null, false]);
    await assert.rejects(runPythonInWorker("pass", [], { env: { "not-valid": "value" } }), /Invalid Python environment/);
  });
  await t.test("nested output, modified inputs, Unicode names, and explicit grab", async () => {
    const input = { name: "Büro Süd.ifc", buffer: new TextEncoder().encode("original").buffer };
    const output = await run(`
from pathlib import Path
Path("reports").mkdir()
Path("reports/report.csv").write_text("name,value\\nwall,1\\n")
Path("Büro Süd.ifc").write_text("modified")
Path("/tmp/grab.txt").write_text("explicit")
`, [input], { grab: ["/tmp/grab.txt"] });
    assert.deepEqual(output.files.map(file => file.path).sort(), ["/home/pyodide/Büro Süd.ifc", "/home/pyodide/reports/report.csv", "/tmp/grab.txt"].sort());
    assert.equal(await output.files.find(file => file.path.endsWith("report.csv")).blob.text(), "name,value\nwall,1\n");
    assert.equal(new TextDecoder().decode(input.buffer), "original");
    assert.deepEqual((await run('import os; result = [os.path.exists("reports"), os.path.exists("Büro Süd.ifc")]')).result.result, [false, false]);
  });
  await t.test("HTML, images, matplotlib and large rich display payloads", async () => {
    const output = await run(`
from IPython.display import HTML, Image, display
import matplotlib.pyplot as plt
display(HTML("<b>hello</b>"))
fig, ax = plt.subplots()
ax.plot([0, 1], [0, 1])
display(fig)
display(HTML("<p>" + "x" * (1024 * 1024 + 1) + "</p>"))
`);
    assert.ok(output.displays.some(item => item.data["text/html"] === "<b>hello</b>"));
    assert.ok(output.displays.some(item => item.data["image/png"]));
    assert.ok(output.files.some(file => file.path.includes(".assistant-display")));
    assert.ok(output.files.some(file => file.blob.type === "image/png"));
    assert.equal(await output.files.find(file => file.path.endsWith("display-1.html")).blob.text(), "<b>hello</b>");
  });
  await t.test("tracebacks and files survive a Python error, and the next call recovers", async () => {
    const output = await runPythonInWorker('print("before failure"); open("partial.txt", "w").write("saved"); raise RuntimeError("boom")');
    assert.equal(output.result.runtimeStatus, "error");
    assert.equal(output.stdout, "before failure\n");
    assert.match(output.stderr, /RuntimeError: boom/);
    assert.ok(output.files.some(file => file.path.endsWith("partial.txt")));
    assert.equal((await run("result = 42")).result.result, 42);
  });
  await t.test("upstream IfcClash measures intersections, collisions and surface clearance", async () => {
    const code = await fs.readFile(new URL("./fixtures/geometry-regression.py", import.meta.url), "utf8");
    const output = await run(code);
    assert.equal(output.result.result.clasher, "ifcclash.ifcclash");
    assert.ok(Math.abs(output.result.result.clearance_metres - 0.03) < 1e-6);
  });
  await t.test("IFC schemas, property queries, editing, IFCZIP, lazy access and shape generation", async () => {
    const code = await fs.readFile(new URL("./fixtures/runtime-core.py", import.meta.url), "utf8");
    const bytes = await fs.readFile(new URL("./fixtures/prompt-model.ifc", import.meta.url));
    const output = await run(code, [{ name: "model.ifc", buffer: bytes }]);
    assert.equal(output.result.result.version, "0.9.1");
    assert.equal(output.result.result.ifczip_round_trip, true);
    assert.ok(output.result.result.geometry_triangles > 0);
  });
  await t.test("cancelling a busy WASM worker stops it and allows a new call", async () => {
    const controller = new AbortController();
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const pending = runPythonInWorker("while True: pass", [], {
      signal: controller.signal,
      onProgress: progress => { if (progress.stage === "running-code") started(); },
    });
    await ready;
    await assert.rejects(runPythonInWorker("pass"), /still running/);
    controller.abort(new Error("Stop Python"));
    await assert.rejects(pending, /Stop Python/);
    assert.equal((await run("result = 42")).result.result, 42);
  });
});
