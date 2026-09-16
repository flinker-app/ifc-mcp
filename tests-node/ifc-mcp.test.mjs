import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import vm from "node:vm";
import { createServer } from "node:http";

import { createBcfBytes, createBcfFile, readBcfTopics } from "../src-node/bcf.js";
import { configureDesktopViewer } from "../src-node/desktop-viewer.js";
import { toolResult, toolError, toolResultText, bcfToolResult } from "../src-node/tool-results.js";
import { executeIfcPython } from "../src-node/python-runner.js";
import {
  clearViewer,
  createDownloadUrl,
  loadIfcFile,
  openViewer,
  resetViewerForTests,
  setViewerBcfState,
} from "../src-node/viewer.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a failed SDK download does not poison later Python calls", async t => {
  let downloads = 0;
  const server = createServer((_request, response) => {
    response.writeHead(++downloads === 1 ? 503 : 200);
    response.end('let calls = 0; export async function runPythonInWorker() { return { stdout: String(++calls), files: [] }; }');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const args = { code: "print(1)", files: [], sdkUrl: `http://127.0.0.1:${server.address().port}/sdk.js` };
  const failed = await executeIfcPython(args);
  assert.equal(failed.ok, false);
  assert.match(failed.stderr, /503/);
  assert.equal(downloads, 1, "The failed call must not be silently retried");
  const recovered = await executeIfcPython(args);
  assert.equal(recovered.ok, true, recovered.stderr);
  assert.equal(recovered.stdout, "1");
  assert.equal((await executeIfcPython(args)).stdout, "2");
  assert.equal(downloads, 2, "Successful SDK initialization should stay cached");
});

test("run Python executes generated code once", async () => {
  const fixture = await sampleIfcFixture();
  const executed = await executeIfcPython({
    code: `
print("done")
import ifcopenshell
import ifcopenshell.util.element as element_util

model = ifcopenshell.open("sample.ifc")
result = {
    "schema": model.schema,
    "walls": [
        {"GlobalId": wall.GlobalId, "Name": wall.Name, "psets": element_util.get_psets(wall)}
        for wall in model.by_type("IfcWall")
    ],
}
`,
    files: [fixture.path],
    workingDirectory: fixture.root,
    sdkUrl: await fakeCopilotSdkUrl(fixture.root),
  });

  assert.equal(executed.ok, true);
  assert.equal(executed.runner, "node_copilot_cdn");
  assert.equal(executed.result.schema, "IFC4");
  assert.equal(executed.result.walls[0].GlobalId, fixture.wallGuid);
  assert.equal(executed.result.walls[0].psets.Pset_WallCommon.FireRating, "EI60");
  assert.deepEqual(executed.uploaded_files.map((file) => file.name), ["sample.ifc"]);
  assert.equal(executed.uploaded_files[0].path, fixture.path);
  assert.equal(executed.stdout, "done\n");
});

test("run Python reports errors", async () => {
  const fixture = await sampleIfcFixture();
  const executed = await executeIfcPython({
    code: 'raise RuntimeError("boom")',
    files: [fixture.path],
    workingDirectory: fixture.root,
    sdkUrl: await fakeCopilotSdkUrl(fixture.root),
  });

  assert.equal(executed.ok, false);
  assert.match(executed.stderr, /RuntimeError: boom/);
});

test("run Python saves SDK output files", async () => {
  resetViewerForTests();
  const fixture = await sampleIfcFixture();
  const executed = await executeIfcPython({
    code: 'result = {"make_saved_file": True}  # make_saved_file',
    files: [fixture.path],
    workingDirectory: fixture.root,
    sdkUrl: await fakeCopilotSdkUrl(fixture.root),
  });

  assert.equal(executed.ok, true);
  assert.equal(executed.saved_files[0].name, "report.csv");
  assert.equal("output_path" in executed.saved_files[0], false);
  assert.equal(executed.saved_files[0].type, "text/csv");
  assert.match(executed.saved_files[0].url, /^http:\/\/127\.0\.0\.1:\d+\/downloads\//);

  const response = await fetch(executed.saved_files[0].url);
  assert.equal(response.ok, true);
  assert.match(response.headers.get("content-disposition") || "", /attachment/);
  assert.equal(await response.text(), "name,value\nwall,1\n");
});

test("run Python works without an IFC file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ifc-mcp-node-"));
  const executed = await executeIfcPython({
    code: 'print("ok")',
    workingDirectory: root,
    sdkUrl: await fakeCopilotSdkUrl(root),
  });

  assert.equal(executed.ok, true);
  assert.equal(executed.uploaded_files.length, 0);
  assert.equal(executed.stderr, "");
});

test("BCF round trip", async () => {
  const fixture = await sampleIfcFixture();
  const output = path.join(fixture.root, "viewpoint.bcfzip");
  const created = await createBcfFile({
    outputPath: output,
    title: "Review Wall A",
    selectedGlobalIds: [fixture.wallGuid],
    isolatedGlobalIds: [fixture.wallGuid],
    ifcPath: fixture.path,
  });

  assert.equal(created.output_path, output);
  const parsed = await readBcfTopics(output);
  assert.equal(parsed.topic_count, 1);
  assert.equal(parsed.topics[0].title, "Review Wall A");
  assert.deepEqual(parsed.topics[0].viewpoints[0].selected_global_ids, [fixture.wallGuid]);
  assert.equal(parsed.topics[0].viewpoints[0].visibility_default, "false");
  assert.deepEqual(parsed.topics[0].viewpoints[0].visibility_exceptions, [fixture.wallGuid]);
});

test("viewer uses one stable URL and serves multiple IFC models", async () => {
  resetViewerForTests();
  const fixture = await sampleIfcFixture();
  const secondModel = path.join(fixture.root, "second sample.ifc");
  await fs.copyFile(fixture.path, secondModel);

  const openedEmpty = (await openViewer()).structuredContent;
  assert.equal(openedEmpty.opened_viewer, true);
  assert.equal(openedEmpty.model_count, 0);

  const opened = (await loadIfcFile({ filePath: fixture.path })).structuredContent;
  const url = new URL(opened.url);
  const base = `${url.protocol}//${url.host}`;

  assert.equal(opened.url, `${url.protocol}//${url.host}`);
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(Number(url.port) > 0);
  assert.equal(url.pathname, "/");
  assert.equal(url.search, "");
  assert.equal("session" in opened, false);
  assert.equal("vscode_simple_browser_command_uri" in opened, false);
  assert.equal("vscode_simple_browser_instruction" in opened, false);
  assert.match(opened.viewer_instruction, /browser or webview/);
  assert.equal(opened.loaded_ifc_file, false, "No connected viewer confirmed loading");
  assert.equal(opened.model_count, 1);

  const metadata = await jsonFrom(`${base}/metadata`);
  assert.equal(metadata.model_count, 1);
  assert.equal(metadata.models[0].filename, "sample.ifc");
  assert.equal(metadata.has_bcf, false);

  const modelBytes = Buffer.from(await (await fetch(`${base}/models/${metadata.models[0].id}`)).arrayBuffer());
  assert.equal(modelBytes.subarray(0, 10).toString("utf8"), "ISO-10303-");

  const openedSecond = (await loadIfcFile({ filePath: secondModel })).structuredContent;
  assert.equal(openedSecond.url, opened.url);
  assert.equal(openedSecond.model_count, 2);
  assert.deepEqual(
    openedSecond.models.map((model) => model.filename),
    ["sample.ifc", "second sample.ifc"],
  );

  const updated = await setViewerBcfState({
    selectedGlobalIds: [fixture.wallGuid],
    isolatedGlobalIds: [fixture.wallGuid],
    coloredComponents: [{ color: "#FF0000", global_ids: [fixture.wallGuid] }],
  });
  assert.equal(updated.isError, true);
  assert.match(toolResultText(updated), /No browser viewer is connected/);

  const reopened = (await loadIfcFile({ filePath: fixture.path })).structuredContent;
  assert.equal(reopened.url, opened.url);
  assert.equal(reopened.model_count, 2);
  assert.equal(reopened.added_model, false);

  const state = await jsonFrom(`${base}/state`);
  assert.equal(state.has_bcf, true);
  assert.equal(state.bcf_version, 1);
  assert.ok(state.bcf_topic_guid);

  const bcfBytes = Buffer.from(await (await fetch(`${base}/bcf`)).arrayBuffer());
  assert.equal(bcfBytes.subarray(0, 2).toString("utf8"), "PK");

  const cleared = (await clearViewer()).structuredContent;
  assert.equal(cleared.url, opened.url);
  assert.equal(cleared.cleared_viewer, Boolean(cleared.desktop_viewer));
  assert.equal(cleared.model_count, 0);
  assert.deepEqual(cleared.models, []);
  assert.equal(cleared.has_bcf, false);
  assert.equal(cleared.bcf_topic_guid, null);

  const clearedState = await jsonFrom(`${base}/state`);
  assert.equal(clearedState.model_count, 0);
  assert.deepEqual(clearedState.models, []);
  assert.equal(clearedState.has_bcf, false);
});

test("browser viewer waits for long loads and returns load, BCF and clear results", async t => {
  resetViewerForTests();
  const realSetTimeout = setTimeout;
  const fixture = await sampleIfcFixture();
  const opened = (await loadIfcFile({ filePath: fixture.path })).structuredContent;
  let poll;
  let report = bcfToolResult({ application: "applied", issues: [{ severity: "warning", message: "Removed #." }] });
  let failure = false;
  let selection;
  let loseReply = false;
  let bcfAdds = 0;
  let clears = 0;
  const script = (await fs.readFile(path.join(repoRoot, "src-node/static/viewer.html"), "utf8"))
    .match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^\s*import .*;$/gm, "");
  try {
    await vm.runInNewContext(`(async () => { ${script} })()`, {
      toolResult, toolError, bcfToolResult,
      IfcViewer: class {
        ready = Promise.resolve();
        async add(name) {
          if (!name.endsWith(".bcfzip")) return;
          bcfAdds++;
          if (failure) throw new Error("BCF failed");
          return report;
        }
        async clear() { clears++; }
        async select() { return selection; }
      },
      fetch: (url, options = {}) => {
        if (loseReply && options.body && JSON.parse(options.body).id) {
          loseReply = false;
          throw new Error("Temporary connection loss");
        }
        return fetch(new URL(url, opened.url), {
          ...options, headers: { ...options.headers, Origin: opened.url },
        });
      },
      window: { setInterval(callback) { poll = callback; } },
      document: {}, console: { warn() {}, error(error) { throw error; } }, Uint8Array,
    });
    assert.equal(typeof poll, "function");
    async function requestState() {
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await (await fetch(`${opened.url}/state`)).json();
        if (state.request_id) return state;
        await new Promise((resolve) => realSetTimeout(resolve, 10));
      }
      throw new Error("No pending viewer request.");
    }
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const loading = loadIfcFile({ filePath: fixture.path });
    await requestState();
    let settled = false;
    void loading.then(() => { settled = true; });
    t.mock.timers.tick(120_000);
    await new Promise(resolve => realSetTimeout(resolve, 0));
    assert.equal(settled, false, "A large IFC must keep loading beyond one minute");
    t.mock.timers.reset();
    await poll();
    assert.equal((await loading).isError, false);

    const applying = setViewerBcfState({ selectedGlobalIds: [fixture.wallGuid] });
    await requestState();
    loseReply = true;
    await poll();
    await poll();
    assert.deepEqual((await applying), report);
    assert.equal(bcfAdds, 1, "A lost reply must not apply the BCF twice.");

    report = { loaded: true, application: "not-applied", issues: [{ severity: "warning", message: "Import warning." }] };
    selection = { application: "applied", issues: [] };
    const selecting = setViewerBcfState({ selectedGlobalIds: [fixture.wallGuid] });
    await requestState();
    await poll();
    const selected = await selecting;
    assert.equal(selected.isError, false);
    assert.match(toolResultText(selected), /BCF applied\.\nWarning: Import warning\./);
    selection = undefined;

    failure = true;
    report = toolError("BCF failed");
    const failing = setViewerBcfState({ selectedGlobalIds: [fixture.wallGuid] });
    await requestState();
    await poll();
    const failed = await failing;
    assert.equal(failed.isError, true);
    assert.deepEqual(failed, report);

    report = undefined;
    const failingWithoutReport = setViewerBcfState({ selectedGlobalIds: [fixture.wallGuid] });
    await requestState();
    await poll();
    assert.deepEqual(await failingWithoutReport, toolError("BCF failed"));

    failure = false;
    const legacy = setViewerBcfState({ selectedGlobalIds: [fixture.wallGuid] });
    await requestState();
    await poll();
    const unconfirmed = await legacy;
    assert.equal(unconfirmed.isError, true);
    assert.match(toolResultText(unconfirmed), /could not be confirmed/);

    const superseded = loadIfcFile({ filePath: fixture.path });
    await requestState();
    const clearing = clearViewer();
    assert.match(toolResultText(await superseded), /superseded/);
    await poll();
    assert.equal((await clearing).isError, false);
    assert.equal(clears, 1);
  } finally {
    resetViewerForTests();
  }
});

test("viewer validates acknowledgements and releases cancelled requests", async () => {
  resetViewerForTests();
  const opened = (await openViewer()).structuredContent;
  const exchange = message => fetch(`${opened.url}/state`, {
    method: "POST", headers: { Origin: opened.url, "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
  await exchange({});
  const controller = new AbortController();
  const pending = clearViewer({ signal: controller.signal });
  let state;
  for (let i = 0; i < 100; i++) {
    state = await jsonFrom(`${opened.url}/state`);
    if (state.request_id) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(state.request_id);
  for (const result of [{ content: "invalid" }, { content: [{ type: "image" }] }, { success: true }]) {
    assert.equal((await exchange({ id: state.request_id, result })).status, 400);
    assert.equal((await jsonFrom(`${opened.url}/state`)).request_id, state.request_id);
  }
  controller.abort(new Error("Stop viewer wait"));
  assert.match(toolResultText(await pending), /Stop viewer wait/);
  assert.equal((await jsonFrom(`${opened.url}/state`)).request_id, null);
  assert.equal((await exchange({ id: state.request_id, result: toolResult("late") })).status, 409);
  // The development viewer must serve helpers that can load without a bundler.
  const source = await (await fetch(`${opened.url}/tool-results.js`)).text();
  const helper = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  assert.deepEqual(helper.toolResult("ready"), toolResult("ready"));
});

test("viewer can load a generated IFC download URL", async () => {
  resetViewerForTests();
  const fixture = await sampleIfcFixture();
  const ifcBytes = await fs.readFile(fixture.path);
  const download = await createDownloadUrl({
    name: "generated-model.ifc",
    bytes: ifcBytes,
    type: "application/octet-stream",
  });

  const opened = (await loadIfcFile({ filePath: download.url })).structuredContent;
  const base = opened.url;

  assert.equal(opened.loaded_ifc_file, false, "No connected viewer confirmed loading");
  assert.equal(opened.active_model_path, download.url);
  assert.equal(opened.active_model_filename, "generated-model.ifc");
  assert.equal(opened.model_count, 1);
  assert.equal(opened.models[0].filename, "generated-model.ifc");

  const servedBytes = Buffer.from(await (await fetch(`${base}/models/${opened.models[0].id}`)).arrayBuffer());
  assert.equal(servedBytes.subarray(0, 10).toString("utf8"), "ISO-10303-");

  const openedAgain = (await loadIfcFile({ filePath: `${download.url}?ignored=true` })).structuredContent;
  assert.equal(openedAgain.model_count, 1);
  assert.equal(openedAgain.added_model, false);
});

test("viewer can apply a generated BCF download URL", async () => {
  resetViewerForTests();
  const fixture = await sampleIfcFixture();
  const opened = (await loadIfcFile({ filePath: fixture.path })).structuredContent;
  const created = await createBcfBytes({
    title: "Generated BCF",
    selectedGlobalIds: [fixture.wallGuid],
    isolatedGlobalIds: [fixture.wallGuid],
    ifcFilename: path.basename(fixture.path),
  });
  const download = await createDownloadUrl({
    name: "generated-view.bcfzip",
    bytes: created.bytes,
    type: "application/octet-stream",
  });

  const updated = await setViewerBcfState({ bcfPath: download.url });

  assert.equal(updated.isError, true);
  assert.match(toolResultText(updated), /No browser viewer is connected/);

  const state = await jsonFrom(`${opened.url}/state`);
  assert.equal(state.bcf_filename, "generated-view.bcfzip");
  assert.equal(state.bcf_metadata.source_path, new URL(download.url).origin + new URL(download.url).pathname);
  assert.equal(state.bcf_topic_guid, created.metadata.topic_guid);

  const bcfBytes = Buffer.from(await (await fetch(`${opened.url}/bcf`)).arrayBuffer());
  assert.equal(bcfBytes.subarray(0, 2).toString("utf8"), "PK");
});

test("desktop viewer mode launches the configured app for viewer tools", async () => {
  resetViewerForTests();
  const fixture = await sampleIfcFixture();
  const created = await createBcfBytes({
    title: "Desktop BCF",
    selectedGlobalIds: [fixture.wallGuid],
    isolatedGlobalIds: [fixture.wallGuid],
    ifcFilename: path.basename(fixture.path),
  });
  const bcfPath = path.join(fixture.root, "desktop-view.bcfzip");
  await fs.writeFile(bcfPath, created.bytes);

  const logPath = path.join(fixture.root, "desktop-launches.ndjson");
  const launcherPath = path.join(fixture.root, "desktop-launcher.mjs");
  await fs.writeFile(
    launcherPath,
    `
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
`,
  );

  configureDesktopViewer({
    exePath: process.execPath,
    argsPrefix: [launcherPath],
    clearArg: "--ifc-mcp-clear-viewer",
    spawnEnv: process.env,
  });

  try {
    const opened = (await openViewer()).structuredContent;
    assert.equal(opened.desktop_viewer, true);
    assert.equal(opened.opened_viewer, true);
    assert.equal(opened.url, null);

    const loaded = (await loadIfcFile({ filePath: fixture.path })).structuredContent;
    assert.equal(loaded.desktop_viewer, true);
    assert.equal(loaded.loaded_ifc_file, true);
    assert.deepEqual(loaded.desktop_file_paths, [fixture.path]);

    const updated = await setViewerBcfState({ bcfPath });
    assert.equal(updated.isError, true);
    assert.match(toolResultText(updated), /could not be confirmed/);

    const cleared = (await clearViewer()).structuredContent;
    assert.equal(cleared.desktop_viewer, true);
    assert.equal(cleared.cleared_viewer, Boolean(cleared.desktop_viewer));

    const launches = await waitForLaunches(logPath, 4);
    assertLaunchesInclude(launches, [
      [],
      [fixture.path],
      [fixture.path, bcfPath],
      ["--ifc-mcp-clear-viewer"],
    ]);
  } finally {
    configureDesktopViewer(null);
    resetViewerForTests();
  }
});

async function sampleIfcFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ifc-mcp-node-"));
  const source = path.join(repoRoot, "examples", "sample.ifc");
  const target = path.join(root, "sample.ifc");
  await fs.copyFile(source, target);
  return {
    root,
    path: target,
    wallGuid: "0000000000000000000005",
  };
}

async function fakeCopilotSdkUrl(root) {
  const sdk = path.join(root, "fake-copilot-sdk.mjs");
  await fs.writeFile(
    sdk,
    `
function resultForPython() {
  return {
    schema: "IFC4",
    walls: [
      {
        GlobalId: "0000000000000000000005",
        Name: "Wall A",
        psets: { Pset_WallCommon: { FireRating: "EI60" } },
      },
    ],
  };
}

export async function runPythonInWorker(python) {
  python = String(python || "");
  if (python.includes('raise RuntimeError("boom")')) {
    throw { error: "RuntimeError: boom", stdout: "", stderr: "" };
  }

  const files = [];
  if (python.includes("make_saved_file")) {
    files.push({
      path: "/home/pyodide/report.csv",
      blob: new Blob(["name,value\\nwall,1\\n"], { type: "text/csv" }),
    });
  }

  return {
    result: { result: resultForPython(python) },
    files,
    displays: [],
    displayFiles: [],
    stdout: python.includes('print("done")') ? "done\\n" : "",
    stderr: "",
  };
}
`,
    "utf8",
  );
  return pathToFileURL(sdk).href;
}

async function jsonFrom(url) {
  const response = await fetch(url);
  assert.equal(response.ok, true);
  return response.json();
}

async function waitForLaunches(logPath, expectedCount) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    try {
      const lines = (await fs.readFile(logPath, "utf8")).trim().split(/\r?\n/).filter(Boolean);
      if (lines.length >= expectedCount) {
        return lines.map((line) => JSON.parse(line));
      }
    } catch {
      // Wait for the detached test launcher to write its first line.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${expectedCount} desktop launches.`);
}

function assertLaunchesInclude(launches, expectedArgsList) {
  const remaining = launches.map((launch) => JSON.stringify(launch.args));
  for (const expectedArgs of expectedArgsList) {
    const expected = JSON.stringify(expectedArgs);
    const index = remaining.indexOf(expected);
    assert.notEqual(index, -1, `Missing desktop launch args: ${expected}`);
    remaining.splice(index, 1);
  }
}
