import fs from "node:fs/promises";
import http from "node:http";
import { test, expect } from "@playwright/test";

test("packaged browser run-python uses native IfcClash", async ({ page }) => {
  test.setTimeout(240_000);
  const assets = new Set(["browser.js", "python-worker-browser.js", "python/ifcopenshell.whl",
    "python/execution.py", "python/display.py", "python/ifcopenshell_compat.py"]);
  const server = http.createServer(async (request, response) => {
    const name = request.url.slice(1);
    if (!name) return response.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html>");
    if (!assets.has(name)) return response.writeHead(404).end();
    try {
      const bytes = await fs.readFile(new URL(`../dist/${name}`, import.meta.url));
      response.writeHead(200, { "Content-Type": name.endsWith(".js") ? "text/javascript" : "application/octet-stream" }).end(bytes);
    } catch (error) {
      response.writeHead(500).end(error.message);
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const code = await fs.readFile(new URL("../tests-node/fixtures/geometry-regression.py", import.meta.url), "utf8");
    const out = await page.evaluate(async code => {
      const { createIfcMcpHost } = await import("/browser.js");
      const host = createIfcMcpHost({ files: new Map(), timeoutMs: 210_000 });
      return host.handleToolCall({ name: "run-python", arguments: { code, files: [] } });
    }, code);
    expect(out.isError, JSON.stringify(out.content)).toBe(false);
    expect(out.structuredContent.result.clasher).toBe("ifcclash.ifcclash");
    expect(out.structuredContent.result.clearance_metres).toBeCloseTo(0.03, 6);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
