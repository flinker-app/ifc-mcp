import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { createBcfBytes, readBcfTopicsFromBytes } from "../src-node/bcf.js";

test("generated BCF 2.1 follows the markup and visibility requirements of strict viewers", async () => {
  const { bytes, metadata } = await createBcfBytes({
    title: "Strict viewer compatibility", ifcFilename: "model.ifc",
    coloredComponents: [{ color: "FF0000", global_ids: ["0000000000000000000005"] }],
  });
  const zip = await JSZip.loadAsync(bytes);
  const parser = new XMLParser({ ignoreAttributes: false });
  const xml = await zip.file(`${metadata.topic_guid}/markup.bcf`).async("string");
  const markup = parser.parse(xml).Markup;
  assert.ok(xml.indexOf("<Header>") < xml.indexOf("<Topic "), "BCF Header must precede Topic");
  assert.equal(markup.Viewpoints["@_Guid"], metadata.viewpoint_guid);
  assert.equal(markup.Viewpoints.Viewpoint, `${metadata.viewpoint_guid}.bcfv`);
  const viewpoint = parser.parse(await zip.file(`${metadata.topic_guid}/${metadata.viewpoint_guid}.bcfv`).async("string"));
  assert.equal(viewpoint.VisualizationInfo.Components.Visibility["@_DefaultVisibility"], "true");
});

for (const version of ["2.1", "3.0"]) for (const color of ["000000", "80001122"]) {
  test(`BCF ${version} preserves color ${color} and its component references`, async () => {
    const ids = ["0000000000000000000005", "1c3i0t_Ab2DOOzofuJVP$0"];
    const { bytes } = await createBcfBytes({ title: "Colors", coloredComponents: [{ color, global_ids: ids }] });
    const zip = await JSZip.loadAsync(bytes);
    if (version === "3.0") {
      zip.file("bcf.version", '<Version VersionId="3.0"/>');
      const file = Object.values(zip.files).find(file => file.name.endsWith(".bcfv"));
      zip.file(file.name, (await file.async("string")).replace(/(<Color\b[^>]*>)([\s\S]*?)(<\/Color>)/g,
        (_, open, contents, close) => `${open}<Components>${contents}</Components>${close}`));
    }
    const result = await readBcfTopicsFromBytes(await zip.generateAsync({ type: "uint8array" }));
    assert.deepEqual(result.topics[0].viewpoints[0].colored_components, [{ color, global_ids: ids }]);
  });
}
