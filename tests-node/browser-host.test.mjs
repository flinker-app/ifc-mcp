import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";

import { createIfcMcpHost, toolResultText } from "../src-node/browser.js";
import { toolResult, bcfToolResult, pythonToolResult } from "../src-node/tool-results.js";

test("browser host maps viewer callbacks to IFC MCP tools", async () => {
  const calls = [];
  const host = createIfcMcpHost({
    viewer: {
      "show-ifc-file": async ({ file_path }) => {
        calls.push(["show-ifc-file", file_path]);
        return { loaded_ifc_file: true, active_model_path: file_path };
      },
      "set-bcf-view": async ({ bcf_path }) => {
        calls.push(["set-bcf-view", bcf_path]);
        return { applied_to_open_viewer: true, applied_bcf_path: bcf_path };
      },
      "clear-ifc-viewer": async () => {
        calls.push(["clear-ifc-viewer"]);
        return { cleared_viewer: true };
      },
    },
  });

  const toolNames = host.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("show-ifc-file"));
  assert.ok(toolNames.includes("set-bcf-view"));
  assert.ok(toolNames.includes("clear-ifc-viewer"));

  const loaded = await host.handleToolCall({
    id: "load-1",
    name: "show-ifc-file",
    input: { file_path: "model.ifc" },
  });
  assert.deepEqual(loaded, toolResult({ loaded_ifc_file: true, active_model_path: "model.ifc" }));

  const applied = await host.handleToolCall({
    id: "bcf-1",
    name: "set-bcf-view",
    input: { bcf_path: "viewpoint.bcfzip" },
  });
  assert.deepEqual(applied, toolResult({ applied_to_open_viewer: true, applied_bcf_path: "viewpoint.bcfzip" }));

  const cleared = await host.handleToolCall({
    id: "clear-1",
    name: "clear-ifc-viewer",
    input: {},
  });
  assert.deepEqual(cleared, toolResult({ cleared_viewer: true }));

  assert.deepEqual(calls, [
    ["show-ifc-file", "model.ifc"],
    ["set-bcf-view", "viewpoint.bcfzip"],
    ["clear-ifc-viewer"],
  ]);
});

test("browser host validates MCP tool arguments", async () => {
  const host = createIfcMcpHost({
    viewer: {
      "set-bcf-view": async () => {
        return { applied_to_open_viewer: true };
      },
    },
  });

  await assertToolError(
    async () => await host.handleToolCall({ name: "set-bcf-view", input: {} }),
    /bcf_path|Invalid input|expected string/i,
  );
});

test("Python requires an explicit file list without requiring an IFC input", async () => {
  const received = [];
  const host = createIfcMcpHost({ python: {
    "run-python": async input => { received.push(input); return { ok: true }; },
  } });
  assert.deepEqual(Object.keys(host.tools.find(tool => tool.name === "run-python").inputSchema.properties), ["files", "code"]);
  await assertToolError(async () => await host.handleToolCall({ name: "run-python", input: { code: "print(1)" } }), /files/);
  assert.equal(received.length, 0, "Invalid arguments must not start Python");
  for (const files of [[], ["Büro Süd.ifc"], ["A.ifc", "B.ifc"]]) {
    await host.handleToolCall({ name: "run-python", input: { files, code: "print(1)" } });
    assert.deepEqual(received.at(-1).files, files);
  }
});

const call = async (host, name, input = {}) => await host.handleToolCall({ name, input });
async function assertToolError(action, pattern) {
  const result = await action();
  assert.equal(result.isError, true);
  assert.match(toolResultText(result), pattern);
}

test("browser runtime creates distinct request IDs across hosts without requiring WebCrypto", async t => {
  for (const [name, crypto] of [["without WebCrypto", undefined], ["without randomUUID", {}], ["with WebCrypto", webcrypto]]) {
    await t.test(name, async t => {
      const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: crypto });
      t.after(() => {
        if (original) Object.defineProperty(globalThis, "crypto", original);
        else delete globalThis.crypto;
      });
      t.mock.method(Date, "now", () => 0);
      t.mock.method(Math, "random", () => 0.5);
      const requestIds = [];
      const loadPython = async () => ({
        runPythonInWorker: async (code, files, { requestId }) => {
          requestIds.push(requestId);
          return { stdout: "done" };
        },
      });
      const first = createIfcMcpHost({ files: new Map(), loadPython });
      const second = createIfcMcpHost({ files: new Map(), loadPython });
      for (const host of [first, second, first, second]) {
        const result = await call(host, "run-python", { files: [], code: "print('done')" });
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.stdout, "done");
      }
      assert.ok(requestIds.every(id => typeof id === "string" && id.length > 0));
      assert.equal(new Set(requestIds).size, 4, "Calls from different hosts must not share request IDs, even in the same millisecond");
    });
  }
});

test("managed viewer callbacks use MCP names and receive resolved browser files", async () => {
  const calls = [];
  const viewer = {
    "open-ifc-viewer": async () => { calls.push("open"); },
    "show-ifc-file": async (name, bytes) => { calls.push([name, [...bytes]]); },
    "clear-ifc-viewer": async () => { calls.push("clear"); },
  };
  const host = createIfcMcpHost({ viewer, files: new Map([
    ["browser://model.ifc", { name: "model.ifc", source: new Blob([new Uint8Array([1, 2])]) }],
  ]) });
  assert.ok(Object.keys(viewer).every(name => host.tools.some(tool => tool.name === name)));
  assert.equal((await call(host, "open-ifc-viewer")).structuredContent.viewer_open, true);
  assert.deepEqual(await call(host, "show-ifc-file", { file_path: "browser://model.ifc" }),
    toolResult({ loaded_ifc_file: true, active_model_path: "browser://model.ifc" }));
  assert.deepEqual(await call(host, "clear-ifc-viewer"), toolResult({ cleared_viewer: true }));
  assert.deepEqual(calls, ["open", ["model.ifc", [1, 2]], "clear"]);
});

test("managed viewer callbacks preserve MCP error results for every viewer tool", async () => {
  const failure = toolResult("Viewer operation failed.", true);
  const viewer = Object.fromEntries(["open-ifc-viewer", "show-ifc-file", "clear-ifc-viewer", "set-bcf-view"]
    .map(name => [name, async () => failure]));
  const host = createIfcMcpHost({ viewer, files: new Map([["local", { name: "local", bytes: new Uint8Array([1]) }]]) });
  for (const [name, input] of [["open-ifc-viewer", {}], ["show-ifc-file", { file_path: "local" }],
    ["clear-ifc-viewer", {}], ["set-bcf-view", { bcf_path: "local" }]]) {
    assert.equal(await call(host, name, input), failure);
  }
});

test("browser runtime transfers only requested file copies and reads the current file map", async t => {
  const bytes = new Uint8Array([99, 1, 2, 99]).subarray(1, 3);
  const files = new Map([["model.ifc", { name: "model.ifc", bytes }]]);
  const received = [];
  const host = createIfcMcpHost({ files, viewer: {}, loadPython: async () => ({
    runPythonInWorker: async (code, attachments) => {
      received.push({ code, attachments: structuredClone(attachments, { transfer: attachments.map(file => file.buffer) }) });
      return { stdout: "done", result: { runtimeStatus: "completed", result: { count: 2 } } };
    },
  }) });
  t.after(() => host.clearFiles());
  const result = await call(host, "run-python", { files: ["model.ifc"], code: "inspect" });
  assert.deepEqual([...new Uint8Array(received[0].attachments[0].buffer)], [1, 2]);
  assert.deepEqual([...bytes], [1, 2], "Worker transfer must not detach the original model");
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent, { stdout: "done", stderr: "", result: { count: 2 }, saved_files: [], uploaded_files: [{ name: "model.ifc" }] });
  files.set("Büro.ifc", { name: "Büro.ifc", source: new Blob(["IFC"]) });
  assert.deepEqual((await call(host, "open-ifc-viewer")).structuredContent.available_files, ["model.ifc", "Büro.ifc"]);
  await call(host, "run-python", { files: ["Büro.ifc"], code: "inspect" });
  assert.equal(new TextDecoder().decode(received[1].attachments[0].buffer), "IFC");
  await call(host, "run-python", { files: [], code: "print(1)" });
  assert.deepEqual(received[2].attachments, [], "Previously used files must not be mounted implicitly");
});

test("browser runtime reuses generated downloads by name, path and URL and releases replaced files", async t => {
  let contents = "first";
  const applied = [];
  const host = createIfcMcpHost({ files: new Map(), viewer: {
    "set-bcf-view": async (name, bytes) => { applied.push([name, new TextDecoder().decode(bytes)]); return { status: "ok", application: "applied" }; },
  }, loadPython: async () => ({ runPythonInWorker: async () => ({
    files: [{ path: "/home/pyodide/view.bcfzip", blob: new Blob([contents], { type: "application/zip" }) }],
  }) }) });
  t.after(() => host.clearFiles());
  const generated = await call(host, "run-python", { files: [], code: "create" });
  const url = generated.structuredContent.saved_files[0].url;
  assert.equal(await (await fetch(url)).text(), "first");
  for (const reference of ["view.bcfzip", "/home/pyodide/view.bcfzip", url]) {
    assert.equal((await call(host, "set-bcf-view", { bcf_path: reference })).isError, false);
  }
  assert.deepEqual(applied, Array(3).fill(["view.bcfzip", "first"]));
  const other = createIfcMcpHost({ files: new Map(), viewer: { "set-bcf-view": async () => assert.fail("Wrong host") } });
  await assertToolError(() => call(other, "set-bcf-view", { bcf_path: url }), /Browser-local file not found/);
  contents = "second";
  await call(host, "run-python", { files: [url], code: "update" });
  assert.equal(host.getGeneratedFiles().length, 1);
  await assert.rejects(() => fetch(url));
  const replacement = host.getGeneratedFiles()[0].url;
  assert.equal(await (await fetch(replacement)).text(), "second");
  host.clearFiles();
  assert.deepEqual(host.getGeneratedFiles(), []);
  await assert.rejects(() => fetch(replacement));
  await assertToolError(() => call(host, "set-bcf-view", { bcf_path: "view.bcfzip" }), /Browser-local file not found/);
});

test("browser runtime rejects missing inputs before loading Python and never fetches file references", async t => {
  let loads = 0;
  const network = t.mock.method(globalThis, "fetch", () => assert.fail("Files must stay local"));
  const host = createIfcMcpHost({ files: new Map([["missing.ifc", { name: "missing.ifc" }]]),
    viewer: { "show-ifc-file": () => assert.fail("Invalid file must not reach the viewer") },
    loadPython: async () => { loads++; return {}; },
  });
  await assertToolError(() => call(host, "run-python", { files: ["https://example.com/model.ifc"], code: "inspect" }), /Browser-local file not found/);
  await assertToolError(() => call(host, "run-python", { files: ["missing.ifc"], code: "inspect" }), /contents are unavailable/);
  await assertToolError(() => call(host, "run-python", { code: "inspect" }), /files/);
  await assertToolError(() => call(host, "show-ifc-file", { file_path: "https://example.com/model.ifc" }), /Browser-local file not found/);
  assert.equal(loads, 0);
  assert.equal(network.mock.callCount(), 0);
});

test("browser runtime preserves BCF outcomes and errors without claiming unconfirmed success", async () => {
  let report;
  const host = createIfcMcpHost({ files: new Map([["view.bcf", { name: "view.bcf", bytes: new Uint8Array([1]) }]]),
    viewer: { "set-bcf-view": async () => { if (report instanceof Error) throw report; return report; } },
  });
  for (const [status, application, ok] of [
    ["ok", "applied", true, true], ["warning", "applied", true, true],
    ["warning", "partial", false, true], ["ok", "pending", false, false], ["error", "failed", false, false],
  ]) {
    report = { status, application, issues: [{ message: "detail" }] };
    const result = await call(host, "set-bcf-view", { bcf_path: "view.bcf" });
    assert.equal(result.isError, !ok);
    assert.deepEqual(result, bcfToolResult(report));
  }
  report = undefined;
  assert.equal((await call(host, "set-bcf-view", { bcf_path: "view.bcf" })).isError, true);
  report = Object.assign(new Error("Broken archive"), { report: { status: "error" } });
  await assertToolError(() => call(host, "set-bcf-view", { bcf_path: "view.bcf" }), /Broken archive/);
});

test("browser runtime prevents overlapping Python and recovers after worker and SDK failures", async () => {
  let execute;
  let loadError;
  const host = createIfcMcpHost({ files: new Map(), loadPython: async () => {
    if (loadError) throw loadError;
    return { runPythonInWorker: (...args) => execute(...args) };
  } });
  let reject;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  execute = () => new Promise((_, fail) => { reject = fail; started(); });
  const pending = call(host, "run-python", { files: [], code: "wait" });
  await ready;
  await assertToolError(() => call(host, "run-python", { files: [], code: "overlap" }), /still running/);
  reject(new Error("worker failed"));
  await assertToolError(() => pending, /worker failed/);
  loadError = new Error("SDK unavailable");
  await assertToolError(() => call(host, "run-python", { files: [], code: "retry" }), /SDK unavailable/);
  loadError = null;
  execute = async () => ({ stdout: "recovered", result: { runtimeStatus: "error" } });
  const result = await call(host, "run-python", { files: [], code: "retry" });
  assert.equal(result.isError, true, "Python failure status must survive result formatting");
  assert.equal(result.structuredContent.stdout, "recovered");
});

test("existing custom tool handlers can override the browser defaults", async () => {
  const host = createIfcMcpHost({ files: new Map(), python: {
    "run-python": async () => ({ custom: true }),
  }, loadPython: () => assert.fail("Custom handler must take precedence") });
  assert.deepEqual(await call(host, "run-python", { files: [], code: "custom" }), toolResult({ custom: true }));
});

test("browser hosts reuse the SDK and discard cancelled results without overlapping it", async () => {
  let finish;
  let started;
  let receivedSignal;
  let calls = 0;
  const ready = new Promise(resolve => { started = resolve; });
  const sdk = { runPythonInWorker: async (code, files, { signal }) => {
    calls++;
    receivedSignal = signal;
    if (code === "busy") return new Promise(resolve => { finish = resolve; started(); });
    return { stdout: "reused", files: [] };
  } };
  const host = createIfcMcpHost({ files: new Map(), loadPython: async () => sdk });
  const other = createIfcMcpHost({ files: new Map(), loadPython: async () => sdk });
  const controller = new AbortController();
  const pending = host.handleToolCall({ name: "run-python", input: { files: [], code: "busy" } }, { signal: controller.signal });
  await ready;
  controller.abort(new Error("Stop waiting"));
  assert.match(toolResultText(await pending), /Stop waiting/);
  assert.equal(receivedSignal.aborted, true);
  await assertToolError(() => call(other, "run-python", { files: [], code: "overlap" }), /still running/);
  assert.equal(calls, 1);
  const blob = new Blob(["late"]);
  const url = URL.createObjectURL(blob);
  finish({ files: [{ name: "late.csv", blob, url }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(host.getGeneratedFiles(), []);
  await assert.rejects(() => fetch(url));
  assert.equal((await call(other, "run-python", { files: [], code: "next" })).structuredContent.stdout, "reused");
  assert.equal(calls, 2);
});

test("browser tool text excludes binary and raw IFC while preserving bounded intermediate results", () => {
  const text = toolResultText(pythonToolResult({ stdout: "ISO-10303-21;PRIVATE", result: {
    xml: "<ifcxml>PRIVATE</ifcxml>", bytes: [1], data: new Uint8Array([1]), blob: new Blob(["PRIVATE"]),
    count: 10,
  }, saved_files: [{ name: "result.bcfzip", url: "blob:local" }] }));
  assert.doesNotMatch(text, /PRIVATE|"bytes"|"blob"|"data"/);
  assert.equal(JSON.parse(text).result.count, 10);
  assert.equal(JSON.parse(text).saved_files[0].url, "blob:local");
  assert.equal(JSON.parse(toolResultText(pythonToolResult({ stdout: "x".repeat(30_000) }))).output_truncated, true);
});
