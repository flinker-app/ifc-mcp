import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this check through npm run test:installed.");
const { values: { browser, tarball } } = parseArgs({
  options: { browser: { type: "boolean" }, tarball: { type: "string" } },
});
const temp = await fs.realpath(os.tmpdir());
const target = await fs.mkdtemp(path.join(temp, "ifc-mcp-package-test-"));

try {
  const packagePath = tarball ? path.resolve(tarball) : await pack(target);
  await run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", packagePath], { cwd: target });
  const dist = path.join(target, "node_modules", "ifc-mcp", "dist");
  await run("--test", ["--test-name-pattern=the desktop Python sandbox", "tests-node/mcp-tools.test.mjs"], {
    cwd: root, env: { ...process.env, IFC_MCP_TEST_BIN: path.join(dist, "ifc-mcp.js") },
  });
  if (browser) {
    await run("node_modules/@playwright/test/cli.js", ["test", "tests-browser/native-clash.spec.mjs"], {
      cwd: root, env: { ...process.env, IFC_MCP_TEST_DIST: dist },
    });
  }
} finally {
  await fs.rm(target, { recursive: true, force: true, maxRetries: 4 });
}

async function pack(target) {
  await run(npm, ["pack", "--ignore-scripts", "--pack-destination", target], { cwd: root });
  const name = (await fs.readdir(target)).find(name => name.endsWith(".tgz"));
  if (!name) throw new Error("Could not find the IFC MCP tarball.");
  return path.join(target, name);
}

function run(script, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { ...options, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`${script} exited with ${code}.`)));
  });
}
