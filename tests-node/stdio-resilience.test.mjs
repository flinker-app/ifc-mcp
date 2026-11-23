import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { httpFetch, viewerFetch } from "./fixtures/viewer-http.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const encode = message => `${JSON.stringify(message)}\n`;
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw-wire-test", version: "1" },
} };

async function bounded(promise, ms = 10_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("MCP subprocess did not respond")), ms); })]);
  } finally { clearTimeout(timer); }
}

function rawMcp(t) {
  const child = spawn(process.execPath, ["bin/ifc-mcp.js"], { cwd: repoRoot, stdio: "pipe", windowsHide: true });
  const messages = new Map();
  const waiting = new Map();
  const invalidOutput = [];
  let buffer = "";
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8192); });
  child.stdout.on("data", chunk => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line);
        assert.equal(message.jsonrpc, "2.0");
        messages.set(message.id, message);
        waiting.get(message.id)?.(message);
        waiting.delete(message.id);
      } catch { invalidOutput.push(line); }
    }
  });
  child.stdout.once("end", () => { if (buffer.trim()) invalidOutput.push(buffer); });
  const exited = new Promise((resolve, reject) => { child.once("close", (code, signal) => resolve({ code, signal })); child.once("error", reject); });
  const close = async () => {
    child.stdin.end();
    try { return await bounded(exited); }
    catch (error) { child.kill(); await exited; throw new Error(`${error.message}\n${stderr}`, { cause: error }); }
  };
  t.after(close);
  return {
    child, messages, invalidOutput, close,
    send: message => child.stdin.write(encode(message)),
    response: id => bounded(messages.has(id) ? Promise.resolve(messages.get(id)) : new Promise(resolve => waiting.set(id, resolve))),
    async connect() {
      this.send(initialize);
      assert.ok((await this.response(1)).result.serverInfo);
      this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    },
    async call(id, name, args = {}) {
      this.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
      return (await this.response(id)).result;
    },
  };
}

async function assertPortReleased(url) {
  const replacement = http.createServer();
  await new Promise((resolve, reject) => {
    replacement.once("error", reject);
    replacement.listen(Number(new URL(url).port), "127.0.0.1", resolve);
  });
  await new Promise(resolve => replacement.close(resolve));
}

test("real stdio accepts fragmented and batched messages, recovers from bad JSON and keeps stdout clean", async t => {
  const mcp = rawMcp(t);
  const opening = encode(initialize);
  mcp.child.stdin.write(`not JSON\n${opening.slice(0, 23)}`);
  await new Promise(resolve => setImmediate(resolve));
  mcp.child.stdin.write(opening.slice(23) + encode({ jsonrpc: "2.0", method: "notifications/initialized" })
    + encode({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + encode({ jsonrpc: "2.0", id: 3, method: "ping" }));
  assert.ok((await mcp.response(1)).result.serverInfo);
  assert.ok((await mcp.response(2)).result.tools.some(tool => tool.name === "open-ifc-viewer"));
  assert.deepEqual((await mcp.response(3)).result, {});
  assert.equal((await mcp.call(4, "open-ifc-viewer", { unsupported: true })).isError, true);
  assert.equal((await mcp.call(5, "open-ifc-viewer")).isError, false);
  assert.deepEqual(mcp.invalidOutput, []);
  assert.equal((await mcp.close()).code, 0);
});

test("stdin EOF cancels a pending viewer call and releases its port without a late response", async t => {
  const mcp = rawMcp(t);
  await mcp.connect();
  const { url } = (await mcp.call(2, "open-ifc-viewer")).structuredContent;
  await viewerFetch(url, "/state", { method: "POST", headers: { Origin: new URL(url).origin }, body: "{}" });
  mcp.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "clear-ifc-viewer", arguments: {} } });
  let pending = false;
  for (let i = 0; i < 100; i++) {
    if ((await (await viewerFetch(url, "/state")).json()).request_id) { pending = true; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(pending, true);
  assert.equal((await mcp.close()).code, 0);
  assert.equal(mcp.messages.has(3), false, "A disconnected client must not receive a late tool response");
  assert.deepEqual(mcp.invalidOutput, []);
  await assertPortReleased(url);
});

test("two real MCP processes keep their ports and model state isolated", async t => {
  const first = rawMcp(t);
  const second = rawMcp(t);
  await Promise.all([first.connect(), second.connect()]);
  const [a, b] = await Promise.all([first.call(2, "open-ifc-viewer"), second.call(2, "open-ifc-viewer")]);
  const firstUrl = a.structuredContent.url;
  const secondUrl = b.structuredContent.url;
  assert.notEqual(firstUrl, secondUrl);
  await first.call(3, "show-ifc-file", { file_path: path.join(repoRoot, "examples", "sample.ifc") });
  assert.equal((await (await viewerFetch(firstUrl, "/metadata")).json()).model_count, 1);
  assert.equal((await (await viewerFetch(secondUrl, "/metadata")).json()).model_count, 0);
  const foreign = await second.call(3, "show-ifc-file", { file_path: new URL("/downloads/foreign", firstUrl).href });
  assert.equal(foreign.isError, true);
  assert.match(foreign.content[0].text, /this running IFC MCP server/);
  await first.close();
  await assertPortReleased(firstUrl);
  assert.equal((await httpFetch(new URL("/health", secondUrl))).status, 200);
  assert.deepEqual(first.invalidOutput, []);
  assert.deepEqual(second.invalidOutput, []);
});
