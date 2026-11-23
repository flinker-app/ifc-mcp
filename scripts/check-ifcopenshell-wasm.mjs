import fs from "node:fs/promises";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { IFCOPENSHELL_BUILD } from "../src-node/constants.js";
import { createNodePythonExecutor } from "../src-node/python-node-environment.js";

// Verify the supported runtime, including native IfcClash geometry checks.
if (isMainThread) {
  const build = IFCOPENSHELL_BUILD;
  const checks = [];
  for (const check of ["core", "clashes"]) {
    console.log(`Checking ${build.version} ${build.revision}: ${check}`);
    checks.push(await new Promise(resolve => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { build, check } });
      let received = false;
      worker.on("message", output => { received = true; resolve({ check, ...output }); });
      worker.on("error", error => { received = true; resolve({ check, ok: false, error: error.message }); });
      worker.on("exit", code => { if (!received) resolve({ check, ok: false, error: `Worker exited (${code})` }); });
    }));
  }
  const report = { measured_at: new Date().toISOString(), build, checks };
  await fs.mkdir(".ifc-mcp", { recursive: true });
  const file = ".ifc-mcp/wasm-compatibility-current.json";
  await fs.writeFile(file, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (checks.some(check => !check.ok)) process.exitCode = 1;
} else {
  const { build, check } = workerData;
  const execute = createNodePythonExecutor(build);
  const readFixture = name => fs.readFile(new URL(`../tests-node/fixtures/${name}`, import.meta.url), "utf8");
  try {
    let code;
    const files = [];
    if (check === "clashes") {
      code = await readFixture("geometry-regression.py");
    } else {
      code = await readFixture("runtime-core.py");
      files.push({ name: "model.ifc", buffer: await fs.readFile(new URL("../tests-node/fixtures/prompt-model.ifc", import.meta.url)) });
    }
    const output = await execute(code, files);
    parentPort.postMessage({ ok: output.result.runtimeStatus === "completed",
      result: output.result.result,
      ...(output.result.runtimeStatus === "error" ? { error: output.stderr } : {}) });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error.message || String(error) });
  }
}
