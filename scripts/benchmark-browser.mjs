import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { chromium } from "@playwright/test";
import { readBenchmarkSource } from "./benchmark-source.mjs";

const exec = promisify(execFile);
const buildPaths = ["scripts/build-package.mjs", "scripts/build-python-runtime.mjs", "scripts/python-wheels.json"];
const benchmarkPaths = [...buildPaths, "scripts/benchmark-ifcopenshell.mjs",
  "scripts/benchmark-browser.mjs", "scripts/benchmark-source.mjs"];
const benchmarkQuestions = [
  { id: "window-count", question: "How many windows are in this model?" },
  { id: "wall-schedule", question: "Export a CSV listing each wall's GlobalId, name and fire rating. Verify the CSV and tell me how many walls it contains." },
];

export async function benchmarkBrowser(repository, args, { toolOnly }) {
  const budgetOption = toolOnly ? "max-repeat-ms" : "max-answer-ms";
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    baseline: { type: "string" },
    [budgetOption]: { type: "string" },
    ...(toolOnly ? {} : { model: { type: "string", default: "gpt-5.6-luna" }, effort: { type: "string", default: "medium" } }),
  } });
  const repeats = toolOnly ? Number(process.env.IFC_BENCHMARK_REPEATS || 3) : null;
  assert.ok(!toolOnly || (Number.isInteger(repeats) && repeats >= 2), "IFC_BENCHMARK_REPEATS must be at least 2");
  const budget = values[budgetOption] === undefined ? null : Number(values[budgetOption]);
  assert.ok(budget === null || (Number.isFinite(budget) && budget > 0), `--${budgetOption} must be positive`);
  assert.ok(toolOnly || !positionals.length, "The question benchmark uses its own IFC fixture. Use --browser for other models.");
  const files = toolOnly
    ? (positionals.length ? positionals.map(file => path.resolve(file)) : [path.join(repository, "examples/sample.ifc")])
    : [path.join(repository, "tests-node/fixtures/prompt-model.ifc")];
  const models = await Promise.all(files.map(async file => {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return { file, size_bytes: (await fs.stat(file)).size, sha256: hash.digest("hex") };
  }));
  const sourcePaths = toolOnly ? benchmarkPaths : [...benchmarkPaths, "scripts/benchmark-codex.mjs"];
  const checkouts = [{ label: "current", root: repository, sourcePaths }];
  if (values.baseline) checkouts.unshift({ label: "baseline", root: path.resolve(values.baseline), sourcePaths: buildPaths });

  const runs = [];
  const browser = await chromium.launch();
  const chromiumVersion = browser.version();
  try {
    for (const { label, root, sourcePaths } of checkouts) {
      const source = await readBenchmarkSource(root, sourcePaths);
      console.log(`Building ${label} ${source.revision.slice(0, 7)}`);
      await exec(process.execPath, ["scripts/build-package.mjs"], { cwd: root, windowsHide: true });
      const measurements = await withCheckoutServer(path.join(root, "dist"), async origin => toolOnly
        ? measureToolCalls(browser, origin, models, label, repeats, budget)
        : measureQuestions(browser, origin, models[0], label, values, budget));
      assert.deepEqual(await readBenchmarkSource(root, sourcePaths), source, "Benchmark source changed during the run");
      runs.push({ label, source, measurements });
    }
  } finally {
    await browser.close();
  }

  if (toolOnly && runs.length === 2) {
    for (const [index, { result, file }] of runs[0].measurements.entries()) {
      assert.deepEqual(runs[1].measurements[index].result, result, `Both checkouts must return the same counts for ${file}`);
    }
  }
  const reportName = `.ifc-mcp/ifcopenshell-${toolOnly ? "browser" : "agent"}-benchmark.json`;
  const settings = toolOnly ? {
    repeats, max_repeat_ms: budget,
    method: "Fresh Chromium context per model and checkout. The first sample starts before importing the browser SDK. All samples end when the browser host returns the full run-python result. Repeat calls start immediately in the same host. Browser launch, page navigation, and file selection occur before timing.",
  } : {
    model: values.model, effort: values.effort, fixture: models[0], max_answer_ms: budget,
    method: "Wall time from sending each question to completion of the final Codex answer. Includes model round trips, reasoning, and all real tool calls through the packaged Chromium host. Both questions share the same conversation and browser session per checkout. Agent and browser setup and answer validation occur outside the measured interval.",
  };
  const report = { measured_at: new Date().toISOString(), node: process.version, chromium: chromiumVersion,
    platform: `${process.platform} ${process.arch}`, cpu: os.cpus()[0]?.model, ...settings, runs };
  const target = path.join(repository, reportName);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(report, null, 2) + "\n");
  console.table(runs.flatMap(({ label, measurements }) => measurements.map(item => ({
    checkout: label,
    ...(toolOnly ? {
      model: path.basename(item.file),
      "first call ms": item.first_call_ms.toFixed(0),
      "repeat calls ms": item.repeat_calls_ms.map(ms => ms.toFixed(0)).join(", "),
      "slowest repeat ms": item.slowest_repeat_ms.toFixed(0),
      "total ms": item.total_ms.toFixed(0),
    } : {
      question: item.id,
      "answer s": (item.elapsed_ms / 1000).toFixed(2),
      "tool calls": item.calls.length,
      "tool time s": (item.calls.reduce((sum, call) => sum + call.elapsed_ms, 0) / 1000).toFixed(2),
    }),
    ...(budget === null ? {} : { budget: item.budget_met ? "pass" : "over budget" }),
  }))));
  console.log(`Raw measurements saved in ${reportName}`);
  if (runs.at(-1).measurements.some(item => item.budget_met === false)) {
    console.error(`A current ${toolOnly ? "repeat call" : "answer"} exceeded the ${budget} ms budget.`);
    process.exitCode = 1;
  }
}

async function withCheckoutServer(dist, measure) {
  const server = createServer(async (request, response) => {
    const name = request.url.slice(1);
    if (!name) {
      return response.writeHead(200, { "Content-Type": "text/html" }).end('<!doctype html><input type="file">');
    }
    if (!/^(?:browser\.js|python-worker-browser\.js|python\/(?:runtime\/)?[\w][\w.+-]*)$/.test(name)) {
      return response.writeHead(404).end();
    }
    try {
      const bytes = await fs.readFile(path.join(dist, name));
      const type = /\.m?js$/.test(name) ? "text/javascript" : "application/octet-stream";
      response.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=3600" }).end(bytes);
    } catch (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try { return await measure(origin); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function withModelPage(browser, origin, model, measure) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(origin);
    await page.locator('input[type="file"]').setInputFiles(model.file);
    return await measure(page);
  } finally {
    await context.close();
  }
}

async function measureToolCalls(browser, origin, models, label, repeats, budget) {
  const measurements = [];
  for (const model of models) {
    console.log(`Benchmarking ${label} ${path.basename(model.file)} with one first call and ${repeats} repeats`);
    const calls = await withModelPage(browser, origin, model, page => page.evaluate(async repeats => {
      const file = document.querySelector("input").files[0];
      const code = `
import ifcopenshell
model = ifcopenshell.open(${JSON.stringify(file.name)})
__assistant_result__ = {"entities": sum(1 for _ in model), "walls": len(model.by_type("IfcWall"))}
`;
      let host;
      const calls = [];
      for (let index = 0; index <= repeats; index++) {
        const start = performance.now();
        if (!host) {
          const { createIfcMcpHost } = await import("/browser.js");
          host = createIfcMcpHost({ files: new Map([["model", { name: file.name, source: file }]]) });
        }
        const output = await host.handleToolCall({ name: "run-python", arguments: { code, files: ["model"] } });
        const elapsed_ms = performance.now() - start;
        if (output.isError) throw new Error(`Call ${index + 1} for ${file.name} failed: ${JSON.stringify(output.content)}`);
        calls.push({ elapsed_ms, result: output.structuredContent?.result });
      }
      return calls;
    }, repeats));
    const [{ result, elapsed_ms: first_call_ms }, ...repeatCalls] = calls;
    assert.ok(Number.isInteger(result?.entities) && Number.isInteger(result?.walls), `Expected IFC counts for ${model.file}`);
    for (const call of repeatCalls) assert.deepEqual(call.result, result, `IFC counts changed between calls for ${model.file}`);
    const repeat_calls_ms = repeatCalls.map(call => call.elapsed_ms);
    const slowest_repeat_ms = Math.max(...repeat_calls_ms);
    measurements.push({ ...model, result, first_call_ms, repeat_calls_ms, slowest_repeat_ms,
      total_ms: calls.reduce((sum, call) => sum + call.elapsed_ms, 0),
      budget_met: budget === null ? null : slowest_repeat_ms <= budget });
  }
  return measurements;
}

async function measureQuestions(browser, origin, model, label, { model: modelName, effort }, budget) {
  const { startCodexBenchmark } = await import("./benchmark-codex.mjs");
  const temp = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temp, "ifc-agent-benchmark-"));
  try {
    return await withModelPage(browser, origin, model, async page => {
      const { tools, filename } = await page.evaluate(async () => {
        const { createIfcMcpHost } = await import("/browser.js");
        const file = document.querySelector("input").files[0];
        window.benchmarkHost = createIfcMcpHost({ files: new Map([[file.name, { name: file.name, source: file }]]) });
        return { tools: window.benchmarkHost.tools.filter(tool => tool.name === "run-python"), filename: file.name };
      });
      const measurements = [];
      let calls;
      const agent = await startCodexBenchmark({ directory, model: modelName, effort, tools, signal: AbortSignal.timeout(600_000),
        async callTool(name, args) {
          const start = performance.now();
          const output = await page.evaluate(toolCall => window.benchmarkHost.handleToolCall(toolCall), { name, arguments: args });
          calls.push({ name, elapsed_ms: performance.now() - start, is_error: output.isError === true });
          return output;
        },
      });
      try {
        for (const { id, question } of benchmarkQuestions) {
          console.log(`Asking ${label} ${agent.model ?? modelName} the ${id} question`);
          calls = [];
          const answer = await agent.ask(JSON.stringify({ message: question, browser_local_files: [filename],
            viewer_loaded_files: [filename], viewer_location: "current browser" }));
          assert.ok(calls.some(call => call.name === "run-python" && !call.is_error), `No successful browser Python call for ${id}`);
          if (id === "window-count") {
            assert.match(answer.answer, /\b(?:2|two)\b/i);
          } else {
            const csv = await page.evaluate(async () => {
              const file = window.benchmarkHost.getGeneratedFiles().find(file => /\.csv$/i.test(file.name));
              return file ? (await fetch(file.url)).text() : null;
            });
            assert.ok(csv?.includes("3lQHBUIlv7RBx0sJZdXaqc") && csv.includes("IfcWall0") && csv.includes("EI60"),
              "Expected the wall schedule CSV to contain the fixture wall and its fire rating");
            assert.match(answer.answer, /\b(?:1|one|single)\b/i);
          }
          measurements.push({ id, question, ...answer, calls, model: agent.model ?? modelName,
            budget_met: budget === null ? null : answer.elapsed_ms <= budget });
        }
      } finally {
        await agent.close();
      }
      return measurements;
    });
  } finally {
    const resolved = await fs.realpath(directory);
    assert.equal(path.dirname(resolved), temp, "Benchmark temp directory escaped the temp root");
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
