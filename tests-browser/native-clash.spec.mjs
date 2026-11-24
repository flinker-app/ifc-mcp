import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

test("packaged browser Python reuses a network-blocked worker within each host session", async ({ page }) => {
  test.setTimeout(240_000);
  const assets = new Set(["browser.js", "python-worker-browser.js", "python/ifcopenshell.whl",
    "python/execution.py", "python/display.py", "python/ifcopenshell_compat.py"]);
  const dist = process.env.IFC_MCP_TEST_DIST || fileURLToPath(new URL("../dist/", import.meta.url));
  const runtimeNames = new Set(await fs.readdir(path.join(dist, "python/runtime")));
  let unexpectedRequests = 0;
  let pythonAssetRequests = 0;
  const server = http.createServer(async (request, response) => {
    const name = request.url.slice(1);
    if (!name) return response.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html>");
    if (name === "private.ifc") {
      unexpectedRequests++;
      return response.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" }).end("private model");
    }
    if (!assets.has(name) && !(name.startsWith("python/runtime/") && runtimeNames.has(name.slice("python/runtime/".length)))) {
      return response.writeHead(404).end();
    }
    if (name !== "browser.js") pythonAssetRequests++;
    try {
      const bytes = await fs.readFile(path.join(dist, name));
      response.writeHead(200, { "Cache-Control": "no-store",
        "Content-Type": name.endsWith(".js") ? "text/javascript" : "application/octet-stream" }).end(bytes);
    } catch (error) {
      response.writeHead(500).end(error.message);
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(origin);
    const geometry = await fs.readFile(new URL("../tests-node/fixtures/geometry-regression.py", import.meta.url), "utf8");
    const selected = await fs.readFile(new URL("./fixtures/wall.ifc", import.meta.url), "utf8");
    const probe = `
from pathlib import Path
from js import eval as js_eval, origin
from ifcopenshell import open as open_ifc

assert len(open_ifc('approved.ifc').by_type('IfcWall')) == 1
assert not Path('private.ifc').exists()
assert origin == 'null'
Path('report.csv').write_text('walls\\n1\\n')
Path('approved.ifc').write_text('changed copy')
Path('/tmp/ifc-mcp-test-marker').touch()
assert await js_eval(${JSON.stringify(`new Promise(resolve => {
  const source = 'fetch(' + JSON.stringify(${JSON.stringify(`${origin}/private.ifc`)}) + ').then(() => postMessage(false), () => postMessage(true))';
  const worker = new Worker(URL.createObjectURL(new Blob([source], {type: 'text/javascript'})));
  worker.onmessage = ({data}) => { worker.terminate(); resolve(data); };
  worker.onerror = () => { worker.terminate(); resolve(false); };
})`)})
`;
    const first = await page.evaluate(async ({ code, selected }) => {
      const { createIfcMcpHost } = await import("/browser.js");
      const attachment = new File([selected], "approved.ifc");
      // The default browser path must pass a File through to the sandbox.
      attachment.arrayBuffer = () => { throw new Error("The whole input was read into memory"); };
      const host = createIfcMcpHost({ files: new Map([["approved", { name: attachment.name, source: attachment }]]), timeoutMs: 210_000 });
      window.testHost = host;
      const result = await host.handleToolCall({ name: "run-python", arguments: { code, files: ["approved"] } });
      const report = host.getGeneratedFiles().find(file => file.name === "report.csv");
      window.testFrame = document.querySelector("iframe");
      return { result, report: report ? await (await fetch(report.url)).text() : null,
        original: await attachment.text(), sandboxes: [...document.querySelectorAll("iframe")].map(frame => frame.getAttribute("sandbox")) };
    }, { code: `${geometry}\n${probe}`, selected });
    expect(first.result.isError, JSON.stringify(first.result.content)).toBe(false);
    expect(first.result.structuredContent.result.clasher).toBe("ifcclash.ifcclash");
    expect(first.result.structuredContent.result.clearance_metres).toBeCloseTo(0.03, 6);
    expect(first.report).toBe("walls\n1\n");
    expect(first.original).toBe(selected);
    expect(first.sandboxes).toEqual(["allow-scripts"]);
    const initialRequests = pythonAssetRequests;
    expect(initialRequests).toBeGreaterThan(0);

    const repeats = await page.evaluate(async () => {
      const code = `
from pathlib import Path
from js import origin

assert origin == 'null'
assert not Path('approved.ifc').exists()
assert not Path('report.csv').exists()
assert Path('/tmp/ifc-mcp-test-marker').exists()
print('same session')
`;
      const results = [];
      for (let i = 0; i < 2; i++) {
        results.push(await window.testHost.handleToolCall({ name: "run-python", arguments: { files: [], code } }));
      }
      return { results, sameFrame: window.testFrame === document.querySelector("iframe"),
        frames: document.querySelectorAll("iframe").length };
    });
    for (const result of repeats.results) {
      expect(result.isError, JSON.stringify(result.content)).toBe(false);
      expect(result.structuredContent.stdout).toBe("same session\n");
    }
    expect(repeats.sameFrame).toBe(true);
    expect(repeats.frames).toBe(1);
    expect(pythonAssetRequests).toBe(initialRequests);
    expect(unexpectedRequests).toBe(0);

    const cleanSession = `
from pathlib import Path
from js import origin

assert origin == 'null'
assert not Path('/tmp/ifc-mcp-test-marker').exists()
print('new session')
`;
    const other = await page.evaluate(async code => {
      const { createIfcMcpHost } = await import("/browser.js");
      const host = createIfcMcpHost({ files: new Map() });
      const result = await host.handleToolCall({ name: "run-python", arguments: { files: [], code } });
      const frames = document.querySelectorAll("iframe").length;
      host.resetPythonSession();
      return { result, frames, originalFrameIntact: window.testFrame.isConnected };
    }, cleanSession);
    expect(other.result.isError, JSON.stringify(other.result.content)).toBe(false);
    expect(other.result.structuredContent.stdout).toBe("new session\n");
    expect(other.frames).toBe(2);
    expect(other.originalFrameIntact).toBe(true);
    await expect(page.locator("iframe")).toHaveCount(1);

    const running = page.waitForEvent("console", message => message.text() === "IFC MCP cancellation test running");
    await page.evaluate(() => {
      const controller = new AbortController();
      window.cancelPython = () => controller.abort(new Error("Cancelled by test"));
      window.pendingPython = window.testHost.handleToolCall({ name: "run-python", arguments: { files: [], code: `
from js import console
console.info('IFC MCP cancellation test running')
while True:
    pass
` } }, { signal: controller.signal });
    });
    await running;
    const cancelled = await page.evaluate(() => {
      window.cancelPython();
      return window.pendingPython;
    });
    expect(cancelled.isError).toBe(true);
    expect(cancelled.content[0].text).toContain("Cancelled by test");
    await expect(page.locator("iframe")).toHaveCount(0);

    const restarted = await page.evaluate(code =>
      window.testHost.handleToolCall({ name: "run-python", arguments: { files: [], code } }), cleanSession);
    expect(restarted.isError, JSON.stringify(restarted.content)).toBe(false);
    expect(restarted.structuredContent.stdout).toBe("new session\n");
    await expect(page.locator("iframe")).toHaveCount(1);

    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await expect(page.locator("iframe")).toHaveCount(0);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
