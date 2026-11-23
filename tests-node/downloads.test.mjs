import assert from "node:assert/strict";
import test from "node:test";
import { addDownload, clearDownloads, getDownload } from "../src-node/downloads.js";
import { createDownloadUrl, stopViewerServer } from "../src-node/viewer.js";

test("downloads expire exactly at their advertised deadline", t => {
  t.after(clearDownloads);
  let time = 1_800_000_000_000;
  t.mock.method(Date, "now", () => time);
  const file = addDownload({ name: "report.csv", bytes: Buffer.from("report") });
  time = Date.parse(file.expires_at) - 1;
  assert.equal(getDownload(file.id).bytes.toString(), "report");
  time++;
  assert.equal(getDownload(file.id), null);
  assert.equal(getDownload("unknown"), null);
});

test("download storage copies inputs and distinguishes repeated filenames", t => {
  t.after(clearDownloads);
  const input = Buffer.from("original");
  const first = addDownload({ name: "model.ifc", bytes: input });
  input.fill(0);
  const second = addDownload({ name: "model.ifc", bytes: Buffer.from("replacement") });
  assert.notEqual(first.id, second.id);
  assert.equal(getDownload(first.id).bytes.toString(), "original");
  assert.equal(getDownload(second.id).bytes.toString(), "replacement");
});

test("oversized files are rejected without evicting existing downloads", t => {
  t.after(clearDownloads);
  const existing = addDownload({ name: "small.csv", bytes: Buffer.from("keep") });
  assert.throws(() => addDownload({ name: "too-large.ifc", bytes: Buffer.alloc(25 * 1024 * 1024 + 1) }), /too large/);
  assert.equal(getDownload(existing.id).bytes.toString(), "keep");
});

test("download storage evicts the oldest file when its total limit is reached", t => {
  t.after(clearDownloads);
  let time = Date.now();
  t.mock.method(Date, "now", () => time++);
  const chunk = Buffer.alloc(25 * 1024 * 1024);
  const files = Array.from({ length: 5 }, (_, i) => addDownload({ name: `${i}.ifc`, bytes: chunk }));
  assert.equal(getDownload(files[0].id), null);
  for (const file of files.slice(1)) assert.equal(getDownload(file.id).bytes.length, chunk.length);
});

test("HTTP downloads expire, preserve bytes and cannot inject response headers", async t => {
  t.after(stopViewerServer);
  let time = Date.now();
  t.mock.method(Date, "now", () => time);
  const file = await createDownloadUrl({ name: "../report\r\nX-Injected: yes.csv", type: "text/plain\r\nX-Injected: yes", bytes: Buffer.from([0, 127, 255]) });
  const response = await fetch(file.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-injected"), null);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0, 127, 255]));
  time = Date.parse(file.expires_at);
  assert.equal((await fetch(file.url)).status, 404);
});
