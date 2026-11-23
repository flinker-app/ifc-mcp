import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { readBenchmarkSource } from "../scripts/benchmark-source.mjs";

const exec = promisify(execFile);

test("benchmark provenance records the ref and source changes and ignores local results", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ifc-benchmark-source-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => exec("git", args, { cwd: root, windowsHide: true });
  const readSource = () => readBenchmarkSource(root, ["benchmark.mjs"]);

  await fs.writeFile(path.join(root, "benchmark.mjs"), "export const repeats = 3;\n");
  await fs.writeFile(path.join(root, ".gitignore"), "/evals/\n");
  await git("init", "-b", "benchmark");
  await git("add", ".");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "-m", "Fixture");
  const clean = await readSource();
  assert.equal(clean.ref, "benchmark");
  assert.equal(clean.modified, false);

  await fs.mkdir(path.join(root, "evals"));
  await fs.writeFile(path.join(root, "evals", "previous.json"), "[]");
  assert.deepEqual(await readSource(), clean);

  await fs.writeFile(path.join(root, "benchmark.mjs"), "export const repeats = 5;\n");
  const edited = await readSource();
  assert.equal(edited.modified, true);
  assert.equal(edited.revision, clean.revision);
  assert.notEqual(edited.fingerprint, clean.fingerprint);

  await fs.mkdir(path.join(root, "vendor"));
  const plugin = path.join(root, "vendor", "new-plugin.so");
  await fs.writeFile(plugin, Buffer.from([0, 1]));
  const added = await readSource();
  assert.notEqual(added.fingerprint, edited.fingerprint);
  assert.deepEqual(await readSource(), added);
  await fs.writeFile(plugin, Buffer.from([0, 2]));
  assert.notEqual((await readSource()).fingerprint, added.fingerprint);
});
