import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

test("packaged browser Python runs native IfcClash with only the selected files and no network", async ({ page }) => {
  test.setTimeout(240_000);
  const assets = new Set(["browser.js", "python-worker-browser.js", "python/ifcopenshell.whl",
    "python/execution.py", "python/display.py", "python/ifcopenshell_compat.py"]);
  const dist = process.env.IFC_MCP_TEST_DIST || fileURLToPath(new URL("../dist/", import.meta.url));
  const runtimeNames = new Set(await fs.readdir(path.join(dist, "python/runtime")));
  let unexpectedRequests = 0;
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
    try {
      const bytes = await fs.readFile(path.join(dist, name));
      response.writeHead(200, { "Content-Type": name.endsWith(".js") ? "text/javascript" : "application/octet-stream" }).end(bytes);
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
assert await js_eval(${JSON.stringify(`new Promise(resolve => {
  const source = 'fetch(' + JSON.stringify(${JSON.stringify(`${origin}/private.ifc`)}) + ').then(() => postMessage(false), () => postMessage(true))';
  const worker = new Worker(URL.createObjectURL(new Blob([source], {type: 'text/javascript'})));
  worker.onmessage = ({data}) => { worker.terminate(); resolve(data); };
  worker.onerror = () => { worker.terminate(); resolve(false); };
})`)})
`;
    const out = await page.evaluate(async ({ code, selected }) => {
      const { createIfcMcpHost } = await import("/browser.js");
      const attachment = new File([selected], "approved.ifc");
      // The default browser path must pass a File through to the sandbox.
      attachment.arrayBuffer = () => { throw new Error("The whole input was read into memory"); };
      const host = createIfcMcpHost({ files: new Map([["approved", { name: attachment.name, source: attachment }]]), timeoutMs: 210_000 });
      const result = await host.handleToolCall({ name: "run-python", arguments: { code, files: ["approved"] } });
      const report = host.getGeneratedFiles().find(file => file.name === "report.csv");
      return { result, report: report ? await (await fetch(report.url)).text() : null,
        original: await attachment.text(), frames: document.querySelectorAll("iframe").length };
    }, { code: `${geometry}\n${probe}`, selected });
    expect(out.result.isError, JSON.stringify(out.result.content)).toBe(false);
    expect(out.result.structuredContent.result.clasher).toBe("ifcclash.ifcclash");
    expect(out.result.structuredContent.result.clearance_metres).toBeCloseTo(0.03, 6);
    expect(out.report).toBe("walls\n1\n");
    expect(out.original).toBe(selected);
    expect(out.frames).toBe(0);
    expect(unexpectedRequests).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
