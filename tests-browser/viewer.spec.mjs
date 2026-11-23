import fs from "node:fs/promises";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import JSZip from "jszip";
import { readBcfTopicsFromBytes } from "../src-node/bcf.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const wallPath = fileURLToPath(new URL("fixtures/wall.ifc", import.meta.url));
const wallGuid = "2S8vfxeQD889mePBPmVN0r";

const test = base.extend({
  mcp: async ({ page }, use, testInfo) => {
    const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/ifc-mcp.js"], cwd: root, env: process.env, stderr: "pipe" });
    const client = new Client({ name: "browser-integration-test", version: "1" });
    let url;
    let stderr = "";
    try {
      await client.connect(transport);
      transport.stderr?.on("data", chunk => { stderr = (stderr + chunk).slice(-20000); });
      const opened = await client.callTool({ name: "open-ifc-viewer", arguments: {} });
      expect(opened.isError).toBe(false);
      url = opened.structuredContent.url;
      const connected = page.waitForResponse(response => response.url() === new URL("/state", url).href && response.ok());
      await page.goto(url);
      await connected;
      await page.evaluate(() => window.ifcMcpViewer.ready);
      await use({ client, url, call: (name, args = {}) => client.callTool({ name, arguments: args }, { timeout: 60_000 }) });
    } finally {
      await page.goto("about:blank").catch(() => {});
      await client.close();
      if (stderr) await testInfo.attach("mcp-stderr", { body: stderr, contentType: "text/plain" });
      // Exercise cleanup of the built executable, not just the source module.
      if (url) {
        const replacement = http.createServer();
        await new Promise((resolve, reject) => {
          replacement.once("error", reject);
          replacement.listen(Number(new URL(url).port), "127.0.0.1", resolve);
        });
        await new Promise(resolve => replacement.close(resolve));
      }
    }
  },
});

test("published viewer renders IFC, survives reload and round-trips BCF state", async ({ page, mcp }, testInfo) => {
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const opened = await mcp.call("show-ifc-file", { file_path: wallPath });
  expect(opened.isError).toBe(false);
  expect(opened.structuredContent.loaded_ifc_file).toBe(true);
  expect(opened.structuredContent.model_count).toBe(1);
  await expect(page.locator("canvas").first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("wall.png") });

  const reconnected = page.waitForResponse(response => response.url() === new URL("/state", mcp.url).href && response.ok());
  await page.reload();
  await reconnected;
  const reloaded = await mcp.call("show-ifc-file", { file_path: wallPath });
  expect(reloaded.isError).toBe(false);
  expect(reloaded.structuredContent.added_model).toBe(false);
  expect(reloaded.structuredContent.url).toBe(mcp.url);
  expect(reloaded.structuredContent.model_count).toBe(1);

  const created = await mcp.call("run-python", {
    files: [wallPath],
    code: `
from uuid import uuid4

import ifcopenshell
from bcf.v3 import model as mdl
from bcf.v3.bcfxml import BcfXml
from bcf.v3.visinfo import VisualizationInfoHandler

model = ifcopenshell.open("wall.ifc")
component = mdl.Component(ifc_guid=model.by_type("IfcWall")[0].GlobalId)
camera = mdl.OrthogonalCamera(
    camera_view_point=mdl.Point(x=2.5, y=0.1, z=10),
    camera_direction=mdl.Direction(x=0, y=0, z=-1),
    camera_up_vector=mdl.Direction(x=0, y=1, z=0),
    view_to_world_scale=5.0,
    aspect_ratio=1.4,
)
components = mdl.Components(
    selection=mdl.ComponentSelection(component=[component]),
    coloring=mdl.ComponentColoring(color=[mdl.ComponentColoringColor(
        color="FF0000",
        components=mdl.ComponentColoringColorComponents(component=[component]),
    )]),
)
bcf = BcfXml.create_new(project_name="Viewer integration test")
topic = bcf.add_topic("Orthographic round trip", None, "ifc-mcp", topic_type="Issue", topic_status="Open")
topic.add_visinfo_handler(VisualizationInfoHandler(mdl.VisualizationInfo(
    guid=str(uuid4()), orthogonal_camera=camera, components=components,
)))
bcf.save("view.bcfzip")
print(ifcopenshell.version)
`,
  });
  expect(created.isError, created.content[0].text).toBe(false);
  expect(created.structuredContent.stdout).toContain("0.9.1");
  const bcfPath = created.structuredContent.saved_files.find(file => file.name === "view.bcfzip")?.url;
  expect(bcfPath).toBeTruthy();
  const applied = await mcp.call("set-bcf-view", { bcf_path: bcfPath });
  expect(applied.isError).toBe(false);
  expect(applied.content[0].text).toBe("BCF applied.");
  const screenshot = applied.content.find(part => part.type === "image");
  expect(screenshot?.mimeType).toMatch(/^image\/(png|jpeg)$/);
  const imageBytes = Buffer.from(screenshot.data, "base64");
  expect(imageBytes.length).toBeLessThanOrEqual(256 * 1024);
  const renderedPixels = await page.evaluate(async ({ mimeType, data }) => {
    const blob = await (await fetch(`data:${mimeType};base64,${data}`)).blob();
    const image = await createImageBitmap(blob);
    const context = new OffscreenCanvas(image.width, image.height).getContext("2d");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    image.close();
    let colored = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset + 3] && Math.abs(pixels[offset] - pixels[offset + 2]) > 30) colored++;
    }
    return colored;
  }, screenshot);
  expect(renderedPixels).toBeGreaterThan(100);
  await testInfo.attach("orthographic-viewer-screenshot", { body: imageBytes, contentType: screenshot.mimeType });
  const captured = await page.evaluate(async () => Array.from(await window.ifcMcpViewer.createTopic(undefined, { output: "bytes", snapshot: false })));
  const archive = await JSZip.loadAsync(Buffer.from(captured));
  const viewpoint = archive.file(/\.bcfv$/)[0];
  expect(await viewpoint.async("string")).toContain("<OrthogonalCamera>");
  const exported = await readBcfTopicsFromBytes(Buffer.from(captured));
  const view = exported.topics[0].viewpoints[0];
  expect(view.selected_global_ids).toContain(wallGuid);
  expect(view.colored_components.some(item => item.global_ids.includes(wallGuid) && /^(FF)?FF0000$/.test(item.color))).toBe(true);

  await page.evaluate(() => {
    window.ifcMcpViewer.createTopic = async () => { throw new Error("Test snapshot failure"); };
  });
  const withoutScreenshot = await mcp.call("set-bcf-view", { bcf_path: bcfPath });
  expect(withoutScreenshot.isError).toBe(false);
  expect(withoutScreenshot.content).toEqual([
    { type: "text", text: "BCF applied." },
    { type: "text", text: "Viewer screenshot unavailable: Test snapshot failure" },
  ]);

  const cleared = await mcp.call("clear-ifc-viewer");
  expect(cleared.isError).toBe(false);
  expect(cleared.structuredContent.cleared_viewer).toBe(true);
  expect(cleared.structuredContent.model_count).toBe(0);
  expect(cleared.structuredContent.url).toBe(mcp.url);
  expect(pageErrors).toEqual([]);
});

test("invalid IFC produces an error and the viewer recovers after clearing", async ({ mcp }, testInfo) => {
  const broken = testInfo.outputPath("broken.ifc");
  await fs.writeFile(broken, "ISO-10303-21;\nEND-ISO-10303-21;\n");
  const failed = await mcp.call("show-ifc-file", { file_path: broken });
  expect(failed.isError).toBe(true);
  expect(failed.structuredContent.loaded_ifc_file).toBe(false);
  expect((await mcp.call("clear-ifc-viewer")).isError).toBe(false);
  const recovered = await mcp.call("show-ifc-file", { file_path: wallPath });
  expect(recovered.isError).toBe(false);
  expect(recovered.structuredContent.loaded_ifc_file).toBe(true);
  expect(recovered.structuredContent.model_count).toBe(1);
});
