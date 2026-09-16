import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../src-node/server.js";
import { createIfcMcpHost } from "../src-node/browser.js";
import { createIfcMcpToolHost } from "../src-node/tool-host.js";
import { executeIfcPython } from "../src-node/python-runner.js";
import { pythonToolResult, toolResultText } from "../src-node/tool-results.js";
import { syncServerMetadata } from "../scripts/sync-server-metadata.mjs";

const packageInfo = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
const inputs = {
  "run-python": { files: [], code: "print(1)" }, "open-ifc-viewer": {},
  "show-ifc-file": { file_path: "model.ifc" }, "clear-ifc-viewer": {},
  "set-bcf-view": { bcf_path: "view.bcfzip" },
};

test("registry identity is derived from package.json", async () => {
  await syncServerMetadata({ check: true });
});

for (const version of ["2025-11-25", "2026-07-28"]) {
  test(`${version}: discovery, schemas, invalid inputs and output parity`, async () => {
    let calls = 0;
    let output = { content: [{ type: "text", text: "ready" }] };
    const viewer = Object.fromEntries(Object.keys(inputs).map(name => [name, () => { calls++; return output; }]));
    const browser = createIfcMcpHost({ viewer });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createServer({ viewer }), { transport: serverTransport });
    const client = new Client({ name: "protocol-test", version: "1" }, {
      versionNegotiation: { mode: version === "2025-11-25" ? "legacy" : { pin: version } },
    });
    try {
      await client.connect(clientTransport);
      assert.equal(client.getServerVersion().version, packageInfo.version);
      if (version === "2026-07-28") {
        const discovery = await client.discover();
        assert.ok(discovery.supportedVersions.includes(version));
      }
      assert.deepEqual((await client.listTools()).tools, browser.tools);
      for (const [name, input] of Object.entries(inputs)) {
        assert.equal(browser.tools.find(tool => tool.name === name).inputSchema.additionalProperties, false);
        const args = { ...input, unsupported: true };
        const nodeResult = await client.callTool({ name, arguments: args });
        const browserResult = await browser.handleToolCall({ name, input: args });
        assert.equal(nodeResult.isError, true);
        assert.deepEqual(nodeResult.content, browserResult.content);
        assert.match(toolResultText(nodeResult), /unsupported/);
      }
      assert.equal(calls, 0, "Invalid input must never reach a handler");
      for (const call of [
        () => client.callTool({ name: "not-a-tool", arguments: {} }),
        () => browser.handleToolCall({ name: "not-a-tool", input: {} }),
      ]) await assert.rejects(call, error => error.code === -32602);
      for (const invalid of [{ content: "bad" }, { content: [{ type: "image" }] }, { content: [], isError: "no" }]) {
        output = invalid;
        const nodeResult = await client.callTool({ name: "open-ifc-viewer", arguments: {} });
        const browserResult = await browser.handleToolCall({ name: "open-ifc-viewer" });
        assert.equal(nodeResult.isError, true);
        assert.deepEqual(nodeResult.content, browserResult.content);
      }
    } finally { await client.close(); await server.close(); }
  });

  test(`${version}: MCP cancellation reaches the handler`, { timeout: 2000 }, async () => {
    let started;
    let stopped;
    const ready = new Promise(resolve => { started = resolve; });
    const cancelled = new Promise(resolve => { stopped = resolve; });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createServer({ viewer: {
      "open-ifc-viewer": (_input, { signal }) => new Promise(resolve => {
        signal.addEventListener("abort", () => { stopped(); resolve("stopped"); }, { once: true });
        started();
      }),
    } }), { transport: serverTransport });
    const client = new Client({ name: "cancellation-test", version: "1" }, {
      versionNegotiation: { mode: version === "2025-11-25" ? "legacy" : { pin: version } },
    });
    try {
      await client.connect(clientTransport);
      const controller = new AbortController();
      const result = client.callTool({ name: "open-ifc-viewer", arguments: {} }, { signal: controller.signal });
      const rejection = assert.rejects(result);
      await ready;
      controller.abort();
      await rejection;
      await cancelled;
    } finally { await client.close(); await server.close(); }
  });
}

test("timeouts bound waiting and concurrency until an uncooperative handler finishes", async () => {
  let finish;
  let signal;
  const host = createIfcMcpToolHost({ timeoutMs: 25, maxConcurrentCalls: 1, handlers: {
    "open-ifc-viewer": (_input, request) => {
      signal = request.signal;
      return new Promise(resolve => { finish = resolve; });
    },
  } });
  const pending = host.callTool("open-ifc-viewer");
  assert.match(toolResultText(await host.callTool("open-ifc-viewer")), /Too many/);
  assert.match(toolResultText(await pending), /exceeded/);
  assert.equal(signal.aborted, true);
  assert.match(toolResultText(await host.callTool("open-ifc-viewer")), /Too many/);
  finish("finished");
  await new Promise(resolve => setImmediate(resolve));
  const next = host.callTool("open-ifc-viewer");
  finish("recovered");
  assert.equal(toolResultText(await next), "recovered");
});

test("caller cancellation stops waiting and prevents work after a pending onCall", async () => {
  let release;
  let calls = 0;
  const controller = new AbortController();
  const host = createIfcMcpHost({
    onCall: () => new Promise(resolve => { release = resolve; }),
    viewer: { "open-ifc-viewer": () => { calls++; return "opened"; } },
  });
  const pending = host.handleToolCall({ name: "open-ifc-viewer" }, { signal: controller.signal });
  controller.abort(new Error("Cancelled by caller"));
  assert.match(toolResultText(await pending), /Cancelled by caller/);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
});

test("Node reuses the SDK and forwards cancellation without overlapping execution", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ifc-cancel-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sdkPath = path.join(root, "sdk.mjs");
  await fs.writeFile(sdkPath, `
    export let calls = 0;
    export let signal;
    let started;
    export let finish;
    export const ready = new Promise(resolve => { started = resolve; });
    export async function runPythonInWorker(code, files, options) {
      calls++;
      signal = options.signal;
      if (code === 'busy') return new Promise(resolve => { finish = resolve; started(); });
      return { stdout: 'recovered', files: [] };
    }`);
  const sdkUrl = pathToFileURL(sdkPath).href;
  const sdk = await import(sdkUrl);
  const controller = new AbortController();
  const pending = executeIfcPython({ code: "busy", sdkUrl, signal: controller.signal });
  await sdk.ready;
  assert.equal(sdk.signal, controller.signal);
  controller.abort(new Error("Stop busy Python"));
  const overlapping = await executeIfcPython({ code: "next", sdkUrl });
  assert.equal(overlapping.ok, false);
  assert.match(overlapping.stderr, /still running/);
  assert.equal(sdk.calls, 1);
  sdk.finish({ stdout: "late result", files: [] });
  const cancelled = await pending;
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.stderr, /Stop busy Python/);
  assert.equal((await executeIfcPython({ code: "next", sdkUrl })).stdout, "recovered");
  assert.equal(sdk.calls, 2);
});

test("truncation preserves a standard Python error result", () => {
  const result = pythonToolResult({ isError: true, content: [{ type: "text", text: "x".repeat(30000) }] });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.output_truncated, true);
});
