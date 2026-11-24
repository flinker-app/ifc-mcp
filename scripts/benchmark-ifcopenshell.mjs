import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { IFCOPENSHELL_BUILD, PYODIDE_VERSION } from "../src-node/constants.js";
import { createNodePythonExecutor } from "../src-node/python-node-environment.js";
import { readBenchmarkSource } from "./benchmark-source.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const benchmarkPaths = ["scripts/benchmark-ifcopenshell.mjs", "scripts/benchmark-source.mjs"];
const baseline = {
  version: "0.8.5", revision: "release",
  url: "https://ifcopenshell.github.io/wasm-wheels/ifcopenshell-0.8.5-cp313-cp313-pyodide_2025_0_wasm32.whl",
  sha256: "fbebb7a7144277be213d156ed9b77de30de1d92b0b2b0c815e4a07555bfb929c",
};

if (isMainThread && process.argv[2] === "--memory") {
  const { benchmarkMemory } = await import("./benchmark-memory.mjs");
  await benchmarkMemory(repository, process.argv.slice(3));
} else if (isMainThread && process.argv[2] !== "--parser") {
  const { benchmarkBrowser } = await import("./benchmark-browser.mjs");
  const toolOnly = process.argv[2] === "--browser";
  await benchmarkBrowser(repository, process.argv.slice(toolOnly ? 3 : 2), { toolOnly });
} else if (isMainThread) {
  const source = await readBenchmarkSource(repository, benchmarkPaths);
  const files = process.argv.slice(3).map(file => path.resolve(file));
  if (!files.length) files.push(path.resolve("examples/sample.ifc"));
  const repeats = Number(process.env.IFC_BENCHMARK_REPEATS || 7);
  assert.ok(Number.isInteger(repeats) && repeats >= 3, "IFC_BENCHMARK_REPEATS must be at least 3");
  const runs = [];
  for (const build of [baseline, IFCOPENSHELL_BUILD]) {
    console.log(`Benchmarking IfcOpenShell ${build.version} (${repeats} measured opens per file)...`);
    runs.push(await new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { build, files, repeats } });
      let received = false;
      worker.on("message", result => { received = true; resolve(result); });
      worker.on("error", reject);
      worker.on("exit", code => { if (!received) reject(new Error(`Benchmark worker exited (${code})`)); });
    }));
  }
  const comparison = runs[0].files.map((old, i) => {
    const current = runs[1].files[i];
    assert.equal(current.sha256, old.sha256, "Both builds must open the same IFC bytes");
    assert.equal(current.entity_count, old.entity_count, "Builds must parse the same entities");
    assert.equal(current.wall_count, old.wall_count, "Builds must return the same wall count");
    return {
      file: old.file, sha256: old.sha256, size_bytes: old.size_bytes, entity_count: old.entity_count,
      baseline_open_ms: old.median_open_ms, current_open_ms: current.median_open_ms,
      eager_speedup: old.median_open_ms / current.median_open_ms,
      current_lazy_open_ms: current.median_lazy_open_ms,
      lazy_speedup: current.median_lazy_open_ms ? old.median_open_ms / current.median_lazy_open_ms : null,
    };
  });
  const completedSource = await readBenchmarkSource(repository, benchmarkPaths);
  assert.deepEqual(completedSource, source, "Repository source changed during the benchmark");
  const report = { measured_at: new Date().toISOString(), source, node: process.version,
    platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model,
    pyodide: PYODIDE_VERSION, repeats,
    method: "Sequential isolated workers; same Pyodide and dependency set; warm-up followed by repeated opens in the WASM filesystem; eager timings exclude by_type and file transfer; lazy timings measure opening only, before attribute access.",
    baseline, current: IFCOPENSHELL_BUILD, runs, comparison };
  await fs.mkdir(".ifc-mcp", { recursive: true });
  await fs.writeFile(".ifc-mcp/ifcopenshell-benchmark.json", JSON.stringify(report, null, 2) + "\n");
  console.table(comparison.map(row => ({ file: path.basename(row.file), MB: (row.size_bytes / 1e6).toFixed(2),
    "0.8.5 ms": row.baseline_open_ms.toFixed(2), [`${IFCOPENSHELL_BUILD.version} ms`]: row.current_open_ms.toFixed(2),
    "eager speedup": row.eager_speedup.toFixed(2) + "x", "lazy speedup": row.lazy_speedup?.toFixed(2) + "x" })));
  console.log(`Source ${source.ref} at ${source.revision}${source.modified ? " with local changes" : ""}`);
  console.log("Raw measurements: .ifc-mcp/ifcopenshell-benchmark.json");
} else {
  const { build, files, repeats } = workerData;
  const execute = createNodePythonExecutor(build);
  const output = [];
  const start = performance.now();
  // Initialize separately so startup, downloads and imports are not counted.
  const initialized = await execute("pass");
  assert.equal(initialized.result.runtimeStatus, "completed", initialized.stderr);
  const startup_ms = performance.now() - start;
  for (const file of files) {
    const bytes = await fs.readFile(file);
    const measured = await execute(`
import gc, ifcopenshell, inspect, statistics, time
name = "benchmark.ifc"
model = ifcopenshell.open(name)
entity_count, wall_count = len(list(model)), len(model.by_type("IfcWall"))
del model
samples = []
for _ in range(${repeats}):
    gc.collect()
    start = time.perf_counter()
    model = ifcopenshell.open(name)
    samples.append((time.perf_counter() - start) * 1000)
    del model
lazy_samples = []
if "lazy" in inspect.signature(ifcopenshell.open).parameters:
    for _ in range(${repeats}):
        gc.collect()
        start = time.perf_counter()
        model = ifcopenshell.open(name, lazy=True)
        lazy_samples.append((time.perf_counter() - start) * 1000)
        del model
result = {"entity_count": entity_count, "wall_count": wall_count, "open_ms": samples,
          "median_open_ms": statistics.median(samples), "lazy_open_ms": lazy_samples,
          "median_lazy_open_ms": statistics.median(lazy_samples) if lazy_samples else None}
`, [{ name: "benchmark.ifc", buffer: bytes }]);
    assert.equal(measured.result.runtimeStatus, "completed", measured.stderr);
    output.push({ file, sha256: createHash("sha256").update(bytes).digest("hex"),
      size_bytes: bytes.byteLength, ...measured.result.result });
  }
  parentPort.postMessage({ build, startup_ms, files: output });
}
