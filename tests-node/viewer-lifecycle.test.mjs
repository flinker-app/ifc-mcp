import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { httpFetch, viewerFetch, viewerHeaders } from "./fixtures/viewer-http.mjs";

import { DEFAULT_VIEWER_PORT } from "../src-node/constants.js";
import { getDownload } from "../src-node/downloads.js";
import { toolResultText } from "../src-node/tool-results.js";
import {
  clearViewer, createDownloadUrl, ensureViewerServer, openViewer, stopViewerServer,
} from "../src-node/viewer.js";

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

test("busy default port falls back outside npm test and concurrent calls share one viewer", async t => {
  t.after(stopViewerServer);
  // Another application may already hold 8765 on the developer's machine.
  const blocker = http.createServer((_request, response) => response.end("other application"));
  await listen(blocker, DEFAULT_VIEWER_PORT).catch(error => {
    if (error.code !== "EADDRINUSE") throw error;
  });
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  const previousLifecycle = process.env.npm_lifecycle_event;
  process.env.npm_lifecycle_event = "start";
  t.after(() => {
    if (previousLifecycle === undefined) delete process.env.npm_lifecycle_event;
    else process.env.npm_lifecycle_event = previousLifecycle;
  });
  const createServer = http.createServer;
  let attempts = 0;
  t.mock.method(http, "createServer", (...args) => { attempts++; return createServer(...args); });

  const [port, opened, first, second, repeatedPort] = await Promise.all([
    ensureViewerServer(), openViewer(),
    createDownloadUrl({ name: "first.ifc", bytes: Buffer.from("first IFC") }),
    createDownloadUrl({ name: "second.csv", bytes: Buffer.from("report") }),
    ensureViewerServer(),
  ]);
  assert.notEqual(port, DEFAULT_VIEWER_PORT);
  assert.equal(repeatedPort, port);
  assert.equal(attempts, 2, "One failed default bind and one successful fallback are sufficient");
  const { url } = opened.structuredContent;
  const origin = `http://127.0.0.1:${port}`;
  assert.equal(new URL(url).origin, origin);
  assert.equal(new URL(first.url).origin, origin);
  assert.equal(new URL(second.url).origin, origin);
  assert.equal(await (await httpFetch(first.url)).text(), "first IFC");
  assert.equal(await (await httpFetch(second.url)).text(), "report");
  const html = await (await httpFetch(url)).text();
  assert.match(html, /from "https:\/\/cdn\.flinker\.app\/ifc-viewer\/v4\.0\.31\/ifc-viewer\.es\.js"/);
  assert.match(html, /<bim-grid id="ifc-viewer"><\/bim-grid>/);
  assert.equal((await clearViewer()).structuredContent.url, url);
  assert.equal(await ensureViewerServer(), port);
  assert.equal(attempts, 2);
});

test("non-conflict startup errors are reported and a later call can retry", async t => {
  t.after(stopViewerServer);
  const createServer = http.createServer;
  let attempts = 0;
  const mock = t.mock.method(http, "createServer", (...args) => {
    attempts++;
    const server = createServer(...args);
    server.listen = () => {
      queueMicrotask(() => server.emit("error", Object.assign(new Error("Permission denied"), { code: "EACCES" })));
      return server;
    };
    return server;
  });
  await assert.rejects(ensureViewerServer(), error => {
    assert.match(error.message, /Could not start local IFC viewer.*Permission denied/);
    assert.equal(error.cause.code, "EACCES");
    return true;
  });
  assert.equal(attempts, 1, "Errors other than EADDRINUSE must not cause a fallback");
  mock.mock.restore();
  const port = await ensureViewerServer();
  assert.equal((await httpFetch(`http://127.0.0.1:${port}/health`)).status, 200);
});

test("shutdown releases pending requests, downloads and the port", async t => {
  t.after(stopViewerServer);
  const download = await createDownloadUrl({ name: "report.csv", bytes: Buffer.from("report") });
  const { url } = (await openViewer()).structuredContent;
  await viewerFetch(url, "/state", { method: "POST", headers: { Origin: new URL(url).origin }, body: "{}" });
  const pending = clearViewer();
  for (let i = 0; i < 100; i++) {
    if ((await (await viewerFetch(url, "/state")).json()).request_id) break;
    if (i === 99) assert.fail("No viewer request became pending");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await Promise.all([stopViewerServer(), stopViewerServer()]);
  assert.match(toolResultText(await pending), /IFC viewer stopped/);
  assert.equal(getDownload(download.id), null);
  const replacement = http.createServer();
  await listen(replacement, Number(new URL(url).port));
  await new Promise(resolve => replacement.close(resolve));
  assert.equal((await openViewer()).structuredContent.model_count, 0);
});

test("shutdown waits for startup and refuses new requests while closing", async t => {
  t.after(stopViewerServer);
  const starting = ensureViewerServer();
  const stopping = stopViewerServer();
  await assert.rejects(ensureViewerServer(), /shutting down/);
  const port = await starting;
  await stopping;
  const replacement = http.createServer();
  await listen(replacement, port);
  await new Promise(resolve => replacement.close(resolve));
});

test("a failed fallback rejects all startup waiters and permits a fresh attempt", async t => {
  t.after(stopViewerServer);
  const createServer = http.createServer;
  let attempts = 0;
  const mock = t.mock.method(http, "createServer", (...args) => {
    const server = createServer(...args);
    const code = ++attempts === 1 ? "EADDRINUSE" : "EACCES";
    server.listen = () => { queueMicrotask(() => server.emit("error", Object.assign(new Error(code), { code }))); return server; };
    return server;
  });
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => ensureViewerServer()));
  assert.equal(attempts, 2);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    assert.equal(result.reason.cause.code, "EACCES");
  }
  mock.mock.restore();
  assert.equal((await httpFetch(`http://127.0.0.1:${await ensureViewerServer()}/health`)).status, 200);
});

test("shutdown lets an active download finish without truncating its bytes", async t => {
  t.after(stopViewerServer);
  const bytes = Buffer.alloc(8 * 1024 * 1024, 0x5a);
  const file = await createDownloadUrl({ name: "large.ifc", bytes });
  const request = http.get(file.url);
  request.on("error", () => {});
  const [response] = await once(request, "response");
  const chunks = [];
  const downloaded = new Promise((resolve, reject) => {
    response.on("data", chunk => chunks.push(chunk));
    response.once("end", () => resolve(Buffer.concat(chunks)));
    response.once("error", reject);
  });
  response.pause();
  const stopping = stopViewerServer();
  await new Promise(resolve => setImmediate(resolve));
  response.resume();
  assert.deepEqual(await downloaded, bytes);
  await stopping;
});

test("shutdown forcibly closes an unfinished HTTP request after its grace period", { timeout: 15_000 }, async t => {
  t.after(stopViewerServer);
  const createServer = http.createServer;
  let server;
  t.mock.method(http, "createServer", (...args) => {
    server = createServer(...args);
    return server;
  });
  const { url } = (await openViewer()).structuredContent;
  const received = once(server, "request", { signal: AbortSignal.timeout(5000) });
  const request = http.request(new URL("/state", url), { method: "POST", agent: false,
    headers: viewerHeaders(url, { Origin: new URL(url).origin, "Content-Length": "100" }) });
  request.on("error", () => {});
  t.after(() => request.destroy());
  request.write("{");
  const [incoming] = await received;
  assert.equal(incoming.url, "/state");
  assert.equal(incoming.complete, false);
  const socketClosed = new Promise(resolve => incoming.socket.once("close", resolve));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let stopped = false;
  const stopping = stopViewerServer().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(4999);
  assert.equal(stopped, false);
  t.mock.timers.tick(1);
  await Promise.all([stopping, socketClosed]);
  t.mock.timers.reset();
  assert.equal(stopped, true);
});

for (const method of ["stdin EOF", "handle close", "SIGTERM", "SIGINT"]) {
  test(`MCP ${method} closes the HTTP server even when the host process stays alive`, { timeout: 15_000 }, async t => {
    const script = `
      import { main } from './src-node/server.js';
      import { openViewer } from './src-node/viewer.js';
      const handle = await main();
      const viewer = await openViewer();
      setInterval(() => {}, 1000);
      process.on('message', async method => {
        if (method === 'handle close') await handle.close();
        if (method === 'SIGTERM' || method === 'SIGINT') process.emit(method);
      });
      process.send(viewer.structuredContent.url);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: new URL("../", import.meta.url), stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true,
    });
    t.after(() => { child.kill(); });
    const [url] = await once(child, "message");
    assert.equal((await httpFetch(new URL("/health", url))).status, 200);
    if (method === "stdin EOF") child.stdin.end();
    else child.send(method);
    let released = false;
    for (let i = 0; i < 100; i++) {
      const replacement = http.createServer();
      try {
        await listen(replacement, Number(new URL(url).port));
        await new Promise(resolve => replacement.close(resolve));
        released = true;
        break;
      } catch (error) {
        if (error.code !== "EADDRINUSE") throw error;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    assert.equal(released, true, "MCP shutdown must release its HTTP listener");
    assert.equal(child.exitCode, null, "Cleanup must work independently of process exit");
  });
}
