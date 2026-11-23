#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { attachPythonFiles } from "../src-node/python-file-handoff.js";
import { main } from "../src-node/server.js";

async function cli() {
  const [command, request, ...rest] = process.argv.slice(2);
  if (command === "attach") {
    if (!request || rest.length) throw new Error("Expected the file handoff request returned by IFC MCP.");
    console.log(JSON.stringify({ files: await attachPythonFiles(request) }));
    return;
  }
  await main({ fileHandoffEntry: fileURLToPath(import.meta.url) });
}

cli().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
