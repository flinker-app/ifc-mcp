import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { httpFetch, viewerFetch, viewerHeaders } from "./fixtures/viewer-http.mjs";
import { createBcfBytes } from "../src-node/bcf.js";
import { clearViewer, createDownloadUrl, loadIfcFile, openViewer, setViewerBcfState, stopViewerServer } from "../src-node/viewer.js";
import { toolResult } from "../src-node/tool-results.js";

const readState = async url => (await viewerFetch(url, "/state")).json();
const postState = (url, body, origin = url) => viewerFetch(url, "/state", {
  method: "POST", headers: { ...(origin === null ? {} : { Origin: new URL(origin).origin }) }, body,
  signal: AbortSignal.timeout(3000),
});

async function pendingRequest(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await readState(url);
    if (state.request_id) return state.request_id;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("No viewer request became pending");
}

test("viewer state and files require the current session token", async t => {
  t.after(stopViewerServer);
  const { url } = (await openViewer()).structuredContent;
  const filePath = fileURLToPath(new URL("./fixtures/prompt-model.ifc", import.meta.url));
  const loaded = (await loadIfcFile({ filePath })).structuredContent;
  const modelPath = `/models/${loaded.models[0].id}`;

  for (const pathname of ["/metadata", "/state", modelPath, "/bcf"]) {
    const anonymous = await httpFetch(new URL(pathname, url));
    assert.equal(anonymous.status, 403);
    assert.equal(anonymous.headers.get("cache-control"), "no-store");
    const invalid = await viewerFetch(url, pathname, {
      headers: { "X-IFC-Viewer-Token": "x".repeat(43) },
    });
    assert.equal(invalid.status, 403);
  }
  assert.equal((await viewerFetch(url, modelPath)).status, 200);
  const invalidHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(new URL("/metadata", url), {
      headers: viewerHeaders(url, { Host: "unrelated.example" }),
    }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.once("error", reject);
  });
  assert.equal(invalidHostStatus, 403);
  assert.equal((await viewerFetch(url, "/metadata", { headers: { Origin: "https://unrelated.example" } })).status, 403);
  assert.equal((await viewerFetch(url, "/metadata", { method: "POST" })).status, 405);
  const unauthorizedPost = await httpFetch(new URL("/state", url), {
    method: "POST", headers: { Origin: new URL(url).origin }, body: "{}",
  });
  assert.equal(unauthorizedPost.status, 403);
  assert.deepEqual(await (await httpFetch(new URL("/health", url))).json(), { ok: true });

  const download = await createDownloadUrl({ name: "model.ifc", bytes: Buffer.from("export") });
  assert.equal(new URL(download.url).hash, "");
  assert.equal(await (await httpFetch(download.url)).text(), "export");

  await stopViewerServer();
  const next = (await openViewer()).structuredContent.url;
  assert.notEqual(new URL(next).hash, new URL(url).hash);
  assert.equal((await viewerFetch(next, "/state", {
    headers: { "X-IFC-Viewer-Token": new URL(url).hash.slice(1) },
  })).status, 403);
  assert.equal((await viewerFetch(next, "/state")).status, 200);
});

test("malformed, foreign and oversized viewer replies cannot complete a pending action", async t => {
  t.after(stopViewerServer);
  const { url } = (await openViewer()).structuredContent;
  await postState(url, "{}");
  const pending = clearViewer();
  const id = await pendingRequest(url);
  for (const [body, origin, status] of [
    ["{}", null, 403], ["{}", "https://unrelated.example", 403],
    ["{", url, 400], ["null", url, 400], ["[]", url, 400],
    [" ".repeat(65537), url, 413],
    [JSON.stringify({ id: "stale", result: toolResult("incorrect") }), url, 409],
  ]) {
    assert.equal((await postState(url, body, origin)).status, status);
    assert.equal((await readState(url)).request_id, id);
  }
  assert.equal((await postState(url, JSON.stringify({ id, result: toolResult("confirmed") }))).status, 200);
  assert.equal((await pending).structuredContent.cleared_viewer, true);
});

test("BCF viewer replies accept an inline screenshot and retain the text size limit", async t => {
  t.after(stopViewerServer);
  const { url } = (await openViewer()).structuredContent;
  const post = message => postState(url, JSON.stringify(message));
  await post({});
  const filePath = fileURLToPath(new URL("./fixtures/prompt-model.ifc", import.meta.url));
  const loaded = loadIfcFile({ filePath });
  assert.equal((await post({ id: await pendingRequest(url), result: toolResult("confirmed") })).status, 200);
  assert.equal((await loaded).isError, false);

  const { bytes } = await createBcfBytes({ title: "Screenshot transfer" });
  const download = await createDownloadUrl({ name: "view.bcfzip", bytes });
  const applied = setViewerBcfState({ bcfPath: download.url });
  const id = await pendingRequest(url);
  assert.equal((await post({ id, result: toolResult(" ".repeat(64 * 1024)) })).status, 413);
  const screenshot = { type: "image", mimeType: "image/png", data: Buffer.alloc(96 * 1024).toString("base64") };
  const result = { isError: false, content: [{ type: "text", text: "BCF applied." }, screenshot] };
  assert.equal((await post({ id, result })).status, 200);
  assert.deepEqual(await applied, result);
});
