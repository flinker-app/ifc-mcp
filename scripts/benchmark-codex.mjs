import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { toolResultText } from "../src-node/tool-results.js";

function codexExecutable() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  if (process.platform !== "win32") return "codex";
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const native = path.join(process.env.APPDATA ?? "", "npm/node_modules/@openai/codex/node_modules",
    `@openai/codex-win32-${process.arch}/vendor/${arch}-pc-windows-msvc/bin/codex.exe`);
  if (existsSync(native)) return native;
  try { return execFileSync("where.exe", ["codex.exe"], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/)[0]; }
  catch { throw new Error("Install Codex CLI or set CODEX_BIN to its executable, then sign in with codex login."); }
}

export async function startCodexBenchmark({ directory, model, effort, tools, callTool, signal }) {
  const config = await fs.readFile(path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml"), "utf8")
    .catch(error => { if (error.code !== "ENOENT") throw error; return ""; });
  const args = ["app-server", "--listen", "stdio://", "-c", 'web_search="disabled"'];
  for (const name of ["shell_tool", "plugins", "apps", "browser_use", "browser_use_external", "computer_use", "image_generation", "multi_agent"]) {
    args.push("-c", `features.${name}=false`);
  }
  for (const match of config.matchAll(/^\s*\[mcp_servers\.("(?:[^"\\]|\\.)*"|'[^']*'|[\w-]+)\]\s*(?:#.*)?$/gm)) {
    args.push("-c", `mcp_servers.${match[1]}.enabled=false`);
  }

  const child = spawn(codexExecutable(), args, { cwd: directory, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 0;
  let active, threadId, failure;
  let stderr = "";
  let closing = false;
  const exited = new Promise(resolve => child.once("close", resolve));

  function fail(error) {
    failure ??= error;
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
    active?.reject(failure);
    active = undefined;
  }

  const send = message => child.stdin.write(JSON.stringify(message) + "\n");
  function request(method, params) {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  }

  child.stderr.setEncoding("utf8").on("data", chunk => { stderr = (stderr + chunk).slice(-3000); });
  child.on("error", fail);
  child.stdin.on("error", error => { if (!closing) fail(error); });
  child.on("close", code => {
    if (!closing) fail(new Error(`Codex app server closed (${code}). ${stderr.trim()}`));
  });
  const abort = () => { fail(signal.reason); child.kill(); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();

  lines.on("line", async line => {
    if (closing || failure) return;
    try {
      const { method, id, params, result, error } = JSON.parse(line);
      if (method && id !== undefined) {
        if (method !== "item/tool/call") {
          send({ id, error: { code: -32601, message: "Only the IFC benchmark tool is available." } });
          return;
        }
        const output = await callTool(params.tool, params.arguments);
        send({ id, result: { success: !output.isError, contentItems: [{ type: "inputText", text: toolResultText(output) }] } });
      } else if (id !== undefined) {
        const waiting = pending.get(id);
        pending.delete(id);
        if (error) waiting?.reject(new Error(error.message));
        else waiting?.resolve(result);
      } else if (method === "item/completed") {
        const { item } = params;
        assert.ok(["userMessage", "agentMessage", "reasoning", "dynamicToolCall", "plan", "contextCompaction"].includes(item.type),
          `Agent used an external tool (${item.type})`);
        if (active && item.type === "agentMessage" && item.phase !== "commentary") active.answer = item.text;
      } else if (method === "model/rerouted") {
        fail(new Error(`Codex changed the model from ${params.fromModel} to ${params.toModel}`));
      } else if (method === "turn/completed" && active) {
        if (params.turn.status !== "completed") {
          fail(new Error(params.turn.error?.message ?? `Codex turn ${params.turn.status}`));
          return;
        }
        assert.ok(active.answer?.trim(), "Agent returned no final answer");
        active.resolve({ answer: active.answer, elapsed_ms: performance.now() - active.started });
        active = undefined;
      }
    } catch (error) { fail(error); }
  });

  async function close() {
    closing = true;
    signal.removeEventListener("abort", abort);
    lines.close();
    child.stdin.end();
    const force = setTimeout(() => child.kill(), 1000);
    try { await exited; }
    finally { clearTimeout(force); }
  }

  try {
    await request("initialize", { clientInfo: { name: "ifc_mcp_benchmark", version: "1.0" }, capabilities: { experimentalApi: true } });
    send({ method: "initialized", params: {} });
    const started = await request("thread/start", { model, cwd: directory, ephemeral: true,
      approvalPolicy: "never", sandbox: "read-only", allowProviderModelFallback: false,
      dynamicTools: tools.map(({ name, description, inputSchema }) => ({ type: "function", name, description, inputSchema })) });
    threadId = started.thread.id;
    const inventory = await request("mcpServerStatus/list", { threadId, limit: 100 });
    assert.ok(inventory.data.every(server => !Object.keys(server.tools ?? {}).length && !server.resources?.length && !server.resourceTemplates?.length),
      "Unrelated MCP tools are available to the benchmark agent");
    return {
      model: started.model,
      async ask(text) {
        const completed = new Promise((resolve, reject) => { active = { resolve, reject, started: performance.now() }; });
        const [, answer] = await Promise.all([request("turn/start", { threadId, effort, input: [{ type: "text", text }] }), completed]);
        return answer;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
