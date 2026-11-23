import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { readBenchmarkSource } from "./benchmark-source.mjs";
import { sampleResources, summarizeResources } from "./benchmark-resources.mjs";

const exec = promisify(execFile);
const MiB = 1024 ** 2;
const marker = "IFC_MCP_BENCHMARK_RESULT=";
const reportName = ".ifc-mcp/ifcopenshell-memory-benchmark.json";
const benchmarkPaths = ["scripts/benchmark-ifcopenshell.mjs", "scripts/benchmark-memory.mjs",
  "scripts/benchmark-resources.mjs", "scripts/benchmark-resources-windows.ps1",
  "scripts/benchmark-source.mjs", "scripts/build-package.mjs", "scripts/build-python-runtime.mjs",
  "scripts/python-wheels.json", "scripts/WindowsPythonSandbox.cs"];

export async function benchmarkMemory(branch, [baseline, ...models]) {
  assert.ok(baseline, "Usage: npm run benchmark:ifcopenshell -- --memory <baseline checkout> [model.ifc ...]");
  baseline = path.resolve(baseline);
  const sizeMiB = Number(process.env.IFC_BENCHMARK_MEMORY_MIB || 256);
  assert.ok(Number.isSafeInteger(sizeMiB) && sizeMiB > 0, "IFC_BENCHMARK_MEMORY_MIB must be a positive integer");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "ifc-mcp-memory-benchmark-"));
  const handoff = path.join(temp, "handoff.ifc");
  try {
    const size = sizeMiB * MiB;
    assert.ok(Number.isSafeInteger(size));
    const file = await fs.open(handoff, "wx");
    try {
      await file.write("BEGIN", 0);
      await file.write("END", size - 3);
    } finally { await file.close(); }

    const range = { name: "Range read", file: handoff, expected: size, code: `
import json
from pathlib import Path
with open('handoff.ifc', 'rb') as model:
    assert model.read(5) == b'BEGIN'
    model.seek(-3, 2)
    assert model.read() == b'END'
print('${marker}' + json.dumps(Path('handoff.ifc').stat().st_size))
` };
    const parses = (models.length ? models.map(file => path.resolve(file)) : [path.join(branch, "examples/sample.ifc")])
      .map(file => ({ name: `Parse ${path.basename(file)}`, file, code: `
import ifcopenshell, json
model = ifcopenshell.open(${JSON.stringify(path.basename(file))})
print('${marker}' + json.dumps({'entities': sum(1 for _ in model), 'walls': len(model.by_type('IfcWall'))}))
` }));
    const workloads = await Promise.all([range, ...parses].map(async workload => {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(workload.file)) hash.update(chunk);
      return { ...workload, size_bytes: (await fs.stat(workload.file)).size, sha256: hash.digest("hex") };
    }));
    const checkouts = [
      { label: "main", root: baseline, paths: ["scripts/build-package.mjs"] },
      { label: "branch", root: branch, paths: benchmarkPaths },
    ];
    const runs = [];
    for (const checkout of checkouts) {
      const source = await readBenchmarkSource(checkout.root, checkout.paths);
      await exec(process.execPath, ["scripts/build-package.mjs"], { cwd: checkout.root, windowsHide: true });
      const measurements = [];
      for (const workload of workloads) {
        console.log(`${checkout.label} ${source.revision.slice(0, 7)} · ${workload.name} · ${(workload.size_bytes / MiB).toFixed(2)} MiB`);
        const measurement = await measure(checkout.root, workload);
        measurements.push(measurement);
        console.log(measurement.error || `${(measurement.elapsed_ms / 1000).toFixed(2)} s, ${Math.round(measurement.peak_rss_bytes / MiB)} MiB peak RSS`);
      }
      assert.deepEqual(await readBenchmarkSource(checkout.root, checkout.paths), source,
        "Benchmark source changed during the run");
      runs.push({ label: checkout.label, source, measurements });
    }
    const comparison = runs[0].measurements.map((main, index) => {
      const current = runs[1].measurements[index];
      const same_result = !main.error && !current.error && JSON.stringify(main.result) === JSON.stringify(current.result);
      return { workload: main.name, size_bytes: main.size_bytes, sha256: main.sha256,
        main_peak_rss_bytes: main.peak_rss_bytes, branch_peak_rss_bytes: current.peak_rss_bytes,
        difference_bytes: current.peak_rss_bytes - main.peak_rss_bytes, same_result };
    });
    const report = { measured_at: new Date().toISOString(), node: process.version, platform: `${process.platform} ${process.arch}`,
      cpu: os.cpus()[0]?.model, logical_cpus: os.cpus().length, system_memory_bytes: os.totalmem(),
      method: "Sequential fresh MCP sessions, from connect through file handoff and Python result. Includes the server, its descendants and the terminal handoff process. Peaks are sampled. Average utilization and memory are weighted by the measured interval durations. CPU is a share of all logical processors. RSS is summed across processes and can count shared pages more than once. Windows GPU percent is the busiest engine used by the measured processes, with shared and dedicated memory reported separately. Null indicates an unavailable counter.",
      runs, comparison };
    const target = path.join(branch, reportName);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(report, null, 2) + "\n");
    console.table(runs.flatMap(({ label, measurements }) => measurements.map(item => ({ workload: item.name, revision: label,
      "time s": (item.elapsed_ms / 1000).toFixed(2), "RSS MiB avg/peak": metricPair(item, "rss_bytes", MiB),
      "CPU % avg/peak": metricPair(item, "cpu_percent"), "GPU % avg/peak": metricPair(item, "gpu_percent"),
      status: item.error ? "failed" : "ok" }))));
    console.log(`Raw measurements saved in ${reportName}`);
    if (comparison.some(item => !item.same_result)) process.exitCode = 1;
  } finally {
    await fs.unlink(handoff).catch(error => { if (error.code !== "ENOENT") throw error; });
    await fs.rmdir(temp);
  }
}

async function measure(root, workload) {
  const client = new Client({ name: "ifc-mcp-memory-benchmark", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/ifc-mcp.js"], cwd: root, stderr: "pipe" });
  let phase = "startup";
  const samples = [];
  const sampler = sampleResources(process.pid, sample => samples.push({ ...sample, phase }));
  let parsed, error, elapsed;
  try {
    await sampler.ready;
    const start = performance.now();
    try {
      await client.connect(transport);
      phase = "request";
      const run = files => client.callTool({ name: "run-python", arguments: { files, code: workload.code } },
        { timeout: 300_000, maxTotalTimeout: 360_000 });
      let result = await run([workload.file]);
      const { file_handoff, file_picker_url } = result.structuredContent ?? {};
      if (file_handoff) {
        phase = "handoff";
        const { stdout } = await exec(file_handoff.command, file_handoff.args, { cwd: root, windowsHide: true });
        const { files } = JSON.parse(stdout);
        assert.equal(files[0].size_bytes, workload.size_bytes);
        phase = "execution";
        result = await run([files[0].tool_path]);
      } else if (file_picker_url || /Select the IFC files/.test(result.content?.[0]?.text ?? "")) {
        const picker = file_picker_url ?? (await client.callTool({ name: "open-ifc-viewer", arguments: {} })).structuredContent.file_picker_url;
        phase = "handoff";
        const file = await approve(picker, workload);
        phase = "execution";
        result = await run([file]);
      }
      assert.equal(result.isError, false, JSON.stringify(result.content));
      const line = result.structuredContent?.stdout?.split(/\r?\n/).find(line => line.startsWith(marker));
      assert.ok(line, `Python did not report a result for ${workload.name}`);
      parsed = JSON.parse(line.slice(marker.length));
      if (workload.expected !== undefined) assert.equal(parsed, workload.expected);
      else assert.ok(Number.isInteger(parsed.entities) && Number.isInteger(parsed.walls));
    } catch (failure) {
      error = String(failure.message || failure).slice(0, 1000);
    } finally { elapsed = performance.now() - start; }
  } finally {
    try { await sampler.stop(); }
    finally { await client.close(); }
  }
  assert.ok(samples.some(sample => sample.rss_bytes > 0), "No process resource samples were collected");
  return { name: workload.name, size_bytes: workload.size_bytes, sha256: workload.sha256, elapsed_ms: elapsed,
    result: parsed, error, ...summarizeResources(samples), samples };
}

function metricPair(item, name, scale = 1) {
  return [item[`average_${name}`], item[`peak_${name}`]].map(value => value == null ? "n/a" : (value / scale).toFixed(2)).join(" / ");
}

async function approve(pickerLink, { file, size_bytes }) {
  const picker = new URL(pickerLink);
  const response = await fetch(new URL("/python-files/approved", picker), {
    method: "POST", duplex: "half", body: createReadStream(file),
    headers: { Origin: picker.origin, "X-IFC-Python-File-Token": picker.hash.slice(1),
      "X-IFC-File-Name": encodeURIComponent(path.basename(file)), "Content-Length": String(size_bytes) },
  });
  const data = await response.json();
  assert.equal(response.status, 201, JSON.stringify(data));
  assert.equal(data.file.size_bytes, size_bytes);
  return data.file.tool_path;
}
