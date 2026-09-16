import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { createIfcMcpHost } from "../src-node/browser.js";
import { bcfToolResult, toolError, toolResultText, pythonToolResult } from "../src-node/tool-results.js";
import { executeIfcPython } from "../src-node/python-runner.js";

// Opt-in live evals: no model judge, extra system prompt, or Python repair wrapper.
const MODEL = "gpt-5.6-luna";
const tools = createIfcMcpHost().tools.map(({ name, description, inputSchema }) =>
  ({ type: "function", name, description, parameters: inputSchema, strict: false }));
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", parseTagValue: false, parseAttributeValue: false });
const asArray = value => value == null ? [] : Array.isArray(value) ? value : [value];
const fixture = await fs.readFile(new URL("./fixtures/prompt-model.ifc", import.meta.url), "utf8");
const guids = type => [...fixture.matchAll(new RegExp(`=IFC${type}\\('([^']+)'`, "g"))].map(match => match[1]);
const windows = guids("WINDOW"), walls = guids("WALL"), allGuids = new Set([...windows, ...walls]);
const sameIds = (actual, expected) => assert.deepEqual([...new Set(actual)].sort(), [...expected].sort());
const refs = value => asArray(value).map(component => component.IfcGuid);
const colors = view => asArray(view.Components?.Coloring?.Color);
const coloredIds = view => colors(view).flatMap(color => refs(color.Components?.Component ?? color.Component));
const visibleIds = view => {
  const visibility = view.Components?.Visibility;
  if (visibility === undefined) return [...allGuids];
  const exceptions = new Set(refs(visibility.Exceptions?.Component));
  const defaultVisible = ["true", "1"].includes(visibility.DefaultVisibility);
  return [...allGuids].filter(guid => defaultVisible !== exceptions.has(guid));
};
const latestView = run => { assert.ok(run.views.length, "No BCF was applied"); return run.views.at(-1); };
const checkColor = run => {
  const view = latestView(run);
  sameIds(coloredIds(view), windows);
  sameIds(visibleIds(view), allGuids);
};
const cases = [
  { id: "count-followup", prompts: ["How many windows are there?", "Select all of them."], maxPython: 2,
    check(run) { assert.match(run.answers[0], /\b2\b|\btwo\b/i); sameIds(refs(latestView(run).Components?.Selection?.Component), windows); sameIds(visibleIds(latestView(run)), allGuids); } },
  { id: "color", prompts: ["color all windows"], maxPython: 2, check: checkColor },
  { id: "color-by-size", prompts: ["Color all windows by their size, a distinct color for each different width and height. Keep the other elements visible."], maxPython: 2,
    check(run) { checkColor(run); assert.equal(new Set(colors(latestView(run)).map(color => color.Color)).size, 2); assert.ok(colors(latestView(run)).every(color => refs(color.Components?.Component ?? color.Component).length === 1)); } },
  { id: "isolate", prompts: ["Show only the walls."], maxPython: 2,
    check(run) { sameIds(visibleIds(latestView(run)), walls); } },
  { id: "hide", prompts: ["Hide the windows and keep everything else visible."], maxPython: 2,
    check(run) { sameIds(visibleIds(latestView(run)), walls); } },
  { id: "no-ifc", files: [], prompts: ["Use Python to calculate the SHA-256 of the UTF-8 text IFC MCP and show the hex digest."], maxPython: 1,
    check(run) { assert.ok(run.answers[0].includes(createHash("sha256").update("IFC MCP").digest("hex"))); assert.equal(run.calls.filter(call => call.name === "run-python").length, 1); } },
  { id: "unrelated-python", prompts: ["Use Python to calculate 37 * 29. This calculation doesn't need the model."], maxPython: 1,
    check(run) { assert.match(run.answers[0], /1[,. ]?073/); assert.ok(run.calls.filter(call => call.name === "run-python").every(call => !call.input.files?.length)); } },
  { id: "property-export", prompts: ["Export a CSV listing each wall's GlobalId, name and fire rating."], maxPython: 2,
    async check(run) { const csv = [...run.artifacts.values()].find(file => /\.csv$/i.test(file.name)); assert.ok(csv, "No CSV generated"); const text = await fs.readFile(csv.path, "utf8"); assert.ok(text.includes(walls[0])); assert.ok(text.includes("EI60")); } },
  { id: "empty-class", prompts: ["How many doors are in this model?"], maxPython: 1,
    check(run) { assert.match(run.answers[0], /\b0\b|\bno doors\b|\bzero\b/i); assert.equal(run.views.length, 0); } },
  { id: "multiple-models", files: ["Architecture A.ifc", "Architecture B.ifc"], prompts: ["Count the windows in each model and give the combined total."], maxPython: 2,
    check(run) { assert.match(run.answers[0], /\b4\b|\bfour\b/i); const attached = new Set(run.calls.flatMap(call => call.input.files ?? [])); sameIds(attached, run.names); } },
  { id: "missing-dimensions", missingDimensions: true, prompts: ["Export the windows' GlobalId, OverallWidth and OverallHeight to CSV. Leave missing dimensions blank."], maxPython: 2,
    async check(run) { const csv = [...run.artifacts.values()].find(file => /\.csv$/i.test(file.name)); assert.ok(csv, "No CSV generated"); const text = await fs.readFile(csv.path, "utf8"); windows.forEach(guid => assert.ok(text.includes(guid))); assert.ok(!text.includes("None")); } },
  { id: "changed-model-context", prompts: ["Count the windows.", "Now color the windows in the currently available file blue."], changeFile: true, maxPython: 3, check: checkColor },
  { id: "feedback", feedback: true, prompts: ["Color all windows yellow."], maxPython: 2,
    check(run) { checkColor(run); assert.match(run.answers[0], /partial|could not|couldn't|unresolved|missing|not found|warning/i); } },
  { id: "german-property-color", prompts: ["Färbe alle Wände nach ihrer Feuerwiderstandsklasse. Die übrigen Bauteile sollen sichtbar bleiben."], maxPython: 2,
    check(run) { sameIds(coloredIds(latestView(run)), walls); sameIds(visibleIds(latestView(run)), allGuids); } },
  { id: "empty-selection", prompts: ["Select all doors."], maxPython: 1,
    check(run) { assert.match(run.answers[0], /\b0\b|\bno doors\b|\bzero\b/i); assert.equal(run.views.length, 0); } },
  { id: "edit-ifc", prompts: ["Save a new IFC with the project name changed to Harbor Annex. Give me a download; leave the current view alone."], maxPython: 2,
    async check(run) { const file = [...run.artifacts.values()].find(file => /\.ifc$/i.test(file.name)); assert.ok(file, "No modified IFC generated"); assert.match(await fs.readFile(file.path, "utf8"), /IFCPROJECT\([^\n]*'Harbor Annex'/); assert.ok(run.calls.every(call => !["show-ifc-file", "clear-ifc-viewer", "set-bcf-view"].includes(call.name))); } },
  { id: "units", prompts: ["Calculate each window's width × height in square metres and give the total."], maxPython: 2,
    check(run) { for (const area of ["1[.,]08", "2[.,]16", "3[.,]24"]) assert.match(run.answers[0], new RegExp(`\\b${area}\\b`)); } },
  { id: "color-missing-dimensions", missingDimensions: true, prompts: ["Color all windows by size. Keep the other elements visible."], maxPython: 2,
    check(run) { checkColor(run); assert.equal(new Set(colors(latestView(run)).map(color => color.Color)).size, 2); } },
  { id: "units-missing-dimensions", missingDimensions: true, prompts: ["Calculate each window's width × height in square metres and give the total."], maxPython: 2,
    check(run) { assert.match(run.answers[0], /\b1[.,]08\b/);
      // Either measure the missing dimensions from geometry or clearly report a partial total.
      if (/\b3[.,]24\b/.test(run.answers[0])) assert.match(run.answers[0], /\b2[.,]16\b/);
      else assert.match(run.answers[0], /missing|unknown|unavailable|not (?:available|specified|provided|set)|cannot|could not/i);
    } },
  { id: "ifczip-count", files: ["Architecture.ifczip"], zipped: true, prompts: ["How many windows are there?"], maxPython: 1,
    check(run) { assert.match(run.answers[0], /\b2\b|\btwo\b/i); } },
];

async function modelResponse(endpoint, apiKey, body, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
      if (!attempt && (response.status === 429 || response.status >= 500)) { await response.body?.cancel(); continue; }
      return response;
    } catch (error) { if (attempt || signal.aborted) throw error; }
  }
}

test("Luna prompting with real IFC Python execution", { timeout: 1_800_000 }, async t => {
  const apiKey = process.env.OPENAI_API_KEY;
  assert.ok(apiKey, "Set OPENAI_API_KEY and optionally OPENAI_BASE_URL; this opt-in suite makes live Luna calls.");
  const endpoint = `${(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "")}/responses`;
  const root = path.resolve(".ifc-mcp/evals", new Date().toISOString().replace(/[:.]/g, "-"));
  await fs.mkdir(root, { recursive: true });
  const results = [];
  const repeat = Number(process.env.IFC_EVAL_REPEAT || 1);
  assert.ok(Number.isInteger(repeat) && repeat >= 1 && repeat <= 10);
  const chosen = cases.filter(entry => !process.env.IFC_EVAL_FILTER || new RegExp(process.env.IFC_EVAL_FILTER).test(entry.id));
  assert.ok(chosen.length, "No eval cases match IFC_EVAL_FILTER");
  t.diagnostic(`Model: ${MODEL}, reasoning: high. Traces: ${root}`);
  for (let repetition = 1; repetition <= repeat; repetition++) for (const entry of chosen) {
    await t.test(`${entry.id} #${repetition}`, { timeout: 180_000 }, async caseTest => {
      const started = performance.now();
      const dir = path.join(root, `${entry.id}-${repetition}`);
      await fs.mkdir(dir, { recursive: true });
      const run = { id: entry.id, repetition, names: entry.files ?? [repetition % 2 ? "Type 3.ifc" : "Büro Süd.ifc"], calls: [], answers: [], views: [], artifacts: new Map(), usage: { input_tokens: 0, output_tokens: 0 }, modelCalls: 0 };
      const inputs = new Map();
      const loaded = new Set(run.names);
      let executedPython = false;
      async function addInput(name) {
        const filename = path.join(dir, name);
        const content = entry.missingDimensions ? fixture.replace(/,1200\.,1800\.,/g, ",$,$,") : fixture;
        await fs.writeFile(filename, entry.zipped ? await new JSZip().file("model.ifc", content).generateAsync({ type: "uint8array" }) : content);
        inputs.set(name, filename);
      }
      for (const name of run.names) await addInput(name);
      const resolve = reference => {
        const generated = [...run.artifacts.values()].find(file => [file.name, file.url, file.path].includes(reference));
        const filename = inputs.get(reference) ?? generated?.path;
        assert.ok(filename, `Browser-local file not found: ${reference}`);
        return filename;
      };
      const host = createIfcMcpHost({
        python: { "run-python": async ({ code, files }) => {
          const paths = files.map(resolve);
          executedPython = true;
          const output = await executeIfcPython({ code, files: paths });
          for (const file of output.saved_files ?? []) {
            const downloaded = await fetch(file.url);
            assert.equal(downloaded.status, 200);
            const filename = path.join(dir, path.basename(file.name));
            await fs.writeFile(filename, new Uint8Array(await downloaded.arrayBuffer()));
            run.artifacts.set(file.name, { ...file, path: filename });
          }
          // Same textual fields exposed by the browser copilot; no source IFC bytes.
          return pythonToolResult({ ok: output.ok, stdout: output.stdout, stderr: output.stderr, result: output.result,
            uploaded_files: (output.uploaded_files ?? []).map(({ name }) => ({ name })),
            saved_files: (output.saved_files ?? []).map(({ name, url, size_bytes, type }) => ({ name, url, size_bytes, type })) });
        } },
        viewer: {
          "open-ifc-viewer": async () => ({ viewer_open: true, viewer_location: "current browser", available_files: [...inputs.keys()] }),
          "show-ifc-file": async ({ file_path }) => { resolve(file_path); loaded.add(file_path); return { loaded_ifc_file: true, active_model_path: file_path }; },
          "clear-ifc-viewer": async () => { loaded.clear(); return { cleared_viewer: true }; },
          "set-bcf-view": async ({ bcf_path }) => {
            // An artifact validator represents the viewer here; no rendering is simulated.
            const zip = await JSZip.loadAsync(await fs.readFile(resolve(bcf_path)));
            const report = { application: "applied", status: "ok", issues: [], summary: "BCF applied." };
            const viewpoints = Object.values(zip.files).filter(file => file.name.endsWith(".bcfv"));
            assert.ok(viewpoints.length, "BCF has no viewpoint");
            for (const file of viewpoints) {
              const view = parser.parse(await file.async("string")).VisualizationInfo;
              assert.ok(view?.Guid, "BCF viewpoint has no Guid");
              const camera = view.PerspectiveCamera ?? view.OrthogonalCamera;
              assert.ok(camera, "BCF viewpoint is missing its camera");
              for (const vector of [camera.CameraViewPoint, camera.CameraDirection, camera.CameraUpVector]) {
                assert.ok(["X", "Y", "Z"].every(axis => vector?.[axis] !== undefined && Number.isFinite(Number(vector[axis]))), "Invalid BCF camera coordinates");
              }
              for (const group of colors(view)) { assert.match(group.Color, /^[0-9a-f]{6}([0-9a-f]{2})?$/i); assert.ok(refs(group.Components?.Component ?? group.Component).length, "Color group has no components"); }
              const referenced = [...coloredIds(view), ...refs(view.Components?.Selection?.Component), ...refs(view.Components?.Visibility?.Exceptions?.Component)];
              assert.ok(referenced.every(guid => allGuids.has(guid)), "BCF references unknown components");
              run.views.push(view);
            }
            if (entry.feedback) Object.assign(report, { application: "partial", status: "warning", summary: "BCF partly applied.",
              issues: [{ severity: "warning", code: "components-not-found", message: "One component could not be resolved in the viewer." }] });
            return bcfToolResult(report);
          },
        },
      });
      const items = [];
      try {
        for (const [index, message] of entry.prompts.entries()) {
          if (entry.changeFile && index) { inputs.clear(); loaded.clear(); run.names = ["Replacement model.ifc"]; await addInput(run.names[0]); loaded.add(run.names[0]); }
          items.push({ role: "user", content: JSON.stringify({ message, browser_local_files: [...inputs.keys()], viewer_loaded_files: [...loaded], viewer_location: "current browser" }) });
          for (let turn = 0; turn < 8; turn++) {
            const response = await modelResponse(endpoint, apiKey,
              { model: MODEL, reasoning: { effort: "high" }, input: items, tools, parallel_tool_calls: false, store: false, include: ["reasoning.encrypted_content"], max_output_tokens: 8000 }, caseTest.signal);
            assert.equal(response.status, 200, `Model HTTP ${response.status}: ${(await response.clone().text()).slice(0, 500)}`);
            const answer = await response.json();
            assert.equal(answer.status, "completed", "Model did not complete its response");
            assert.ok(answer.model.startsWith(MODEL), `Unexpected model: ${answer.model}`);
            run.modelCalls++;
            for (const key of Object.keys(run.usage)) run.usage[key] += answer.usage?.[key] ?? 0;
            items.push(...answer.output);
            const calls = answer.output.filter(item => item.type === "function_call");
            if (!calls.length) { run.answers.push(answer.output.flatMap(item => item.content ?? []).map(part => part.text ?? "").join("\n")); break; }
            for (const call of calls) {
              const input = JSON.parse(call.arguments);
              const time = performance.now();
              let output;
              executedPython = false;
              try { output = await host.handleToolCall({ name: call.name, input }); }
              catch (error) { output = toolError(error); }
              run.calls.push({ name: call.name, input, output, executedPython, seconds: (performance.now() - time) / 1000 });
              items.push({ type: "function_call_output", call_id: call.call_id, output: toolResultText(output) });
            }
          }
        }
        assert.equal(run.answers.length, entry.prompts.length, "Agent did not finish within eight turns");
        await entry.check(run);
        run.correctOutcome = true;
        const errors = run.calls.filter(call => call.output.isError === true && !(entry.feedback && call.name === "set-bcf-view"));
        assert.deepEqual(errors.map(call => ({ tool: call.name, files: call.input.files, error: toolResultText(call.output) })), [], "Avoidable tool failures (even if later recovered)");
        assert.ok(run.calls.filter(call => call.name === "run-python").length <= entry.maxPython, `Too many Python calls: ${run.calls.filter(call => call.name === "run-python").length} > ${entry.maxPython}`);
        assert.ok(run.calls.length <= entry.maxPython + entry.prompts.length + 1, "Too many tool round trips");
        run.passed = true;
      } catch (error) { run.passed = false; run.failure = error.message; throw error; }
      finally {
        run.seconds = (performance.now() - started) / 1000;
        const trace = { ...run, artifacts: [...run.artifacts.values()], model: MODEL, reasoning: "high", toolDefinitions: tools };
        await fs.writeFile(path.join(dir, "trace.json"), JSON.stringify(trace, null, 2));
        results.push({ id: entry.id, repetition, passed: run.passed, correctOutcome: run.correctOutcome === true,
          toolCalls: run.calls.length, pythonCalls: run.calls.filter(call => call.name === "run-python").length,
          pythonSeconds: run.calls.filter(call => call.executedPython).reduce((sum, call) => sum + call.seconds, 0),
          pythonErrors: run.calls.filter(call => call.executedPython && call.output.isError === true).length,
          toolErrors: run.calls.filter(call => call.output.isError === true && !(entry.feedback && call.name === "set-bcf-view")).length,
          modelCalls: run.modelCalls, seconds: run.seconds, usage: run.usage, failure: run.failure });
        await fs.writeFile(path.join(root, "results.json"), JSON.stringify(results, null, 2));
        t.diagnostic(`${entry.id}: ${run.passed ? "PASS" : "FAIL"}, ${results.at(-1).pythonCalls} Python calls, ${results.at(-1).pythonErrors} Python errors, ${run.seconds.toFixed(1)}s`);
      }
    });
  }
});
