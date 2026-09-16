import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { createBcfBytes, readBcfTopicsFromBytes } from "../src-node/bcf.js";

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
