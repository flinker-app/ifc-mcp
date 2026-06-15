import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { XMLBuilder, XMLParser } from "fast-xml-parser";

import { BCF_SUFFIXES } from "./constants.js";
import { resolvePath } from "./paths.js";
import { asArray, nowIso } from "./utils.js";

const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  suppressEmptyNode: false,
});

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

export async function createBcfBytes({
  title,
  selectedGlobalIds = [],
  isolatedGlobalIds = [],
  hiddenGlobalIds = [],
  coloredComponents = [],
  ifcFilename = undefined,
  topicType = "Issue",
  topicStatus = "Open",
  author = "ifc-mcp",
}) {
  const topicGuid = randomGuid();
  const viewpointGuid = randomGuid();
  const selected = cleanGuids(selectedGlobalIds);
  const isolated = cleanGuids(isolatedGlobalIds);
  const hidden = cleanGuids(hiddenGlobalIds);
  const colored = cleanColoredComponents(coloredComponents);
  const created = nowIso();

  const zip = new JSZip();
  zip.file("bcf.version", '<?xml version="1.0" encoding="UTF-8"?>\n<Version VersionId="2.1"/>\n');
  zip.file(
    `${topicGuid}/markup.bcf`,
    markupXml({
      topicGuid,
      viewpointGuid,
      title,
      created,
      ifcFilename,
      topicType,
      topicStatus,
      author,
    }),
  );
  zip.file(
    `${topicGuid}/${viewpointGuid}.bcfv`,
    viewpointXml({
      viewpointGuid,
      selectedGlobalIds: selected,
      isolatedGlobalIds: isolated,
      hiddenGlobalIds: hidden,
      coloredComponents: colored,
    }),
  );

  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return {
    bytes,
    metadata: {
      topic_guid: topicGuid,
      viewpoint_guid: viewpointGuid,
      title,
      selected_global_ids: selected,
      isolated_global_ids: isolated,
      hidden_global_ids: hidden,
      colored_components: colored,
      created,
      topic_type: topicType,
      topic_status: topicStatus,
    },
  };
}

export async function createBcfFile({
  outputPath,
  title,
  selectedGlobalIds = [],
  isolatedGlobalIds = [],
  hiddenGlobalIds = [],
  coloredComponents = [],
  ifcPath = undefined,
  topicType = "Issue",
  topicStatus = "Open",
  author = "ifc-mcp",
}) {
  const resolvedOutput = resolvePath(outputPath, {
    mustExist: false,
    suffixes: [".bcfzip"],
    description: "BCF output file",
  });
  await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });
  const { bytes, metadata } = await createBcfBytes({
    title,
    selectedGlobalIds,
    isolatedGlobalIds,
    hiddenGlobalIds,
    coloredComponents,
    ifcFilename: ifcPath ? path.basename(ifcPath) : undefined,
    topicType,
    topicStatus,
    author,
  });
  await fs.writeFile(resolvedOutput, bytes);
  return {
    output_path: resolvedOutput,
    size_bytes: bytes.length,
    ...metadata,
  };
}

export async function readBcfTopics(bcfPath, { maxTopics = 100 } = {}) {
  const resolved = resolvePath(bcfPath, {
    suffixes: BCF_SUFFIXES,
    description: "BCF file",
  });
  return readBcfTopicsFromBytes(await fs.readFile(resolved), {
    bcfPath: resolved,
    maxTopics,
  });
}

export async function readBcfTopicsFromBytes(bytes, { bcfPath = null, maxTopics = 100 } = {}) {
  const zip = await JSZip.loadAsync(bytes);
  const markupNames = Object.keys(zip.files).filter((name) => name.endsWith("/markup.bcf"));
  const topics = [];

  for (const markupName of markupNames.slice(0, maxTopics)) {
    const folder = markupName.slice(0, -"/markup.bcf".length);
    const markup = xmlParser.parse(await zip.file(markupName).async("string"));
    const topicNode = markup?.Markup?.Topic || {};
    const topic = {
      folder,
      guid: topicNode["@_Guid"] || null,
      title: textValue(topicNode.Title),
      topic_type: topicNode["@_TopicType"] || null,
      topic_status: topicNode["@_TopicStatus"] || null,
      viewpoints: [],
    };

    const viewpointRefs = asArray(markup?.Markup?.Viewpoints?.ViewPoint);
    for (const viewpointRef of viewpointRefs) {
      const viewpointFile = textValue(viewpointRef?.Viewpoint);
      if (!viewpointFile) {
        continue;
      }
      const viewpointName = `${folder}/${viewpointFile}`;
      const zipEntry = zip.file(viewpointName);
      if (!zipEntry) {
        continue;
      }
      const viewpoint = xmlParser.parse(await zipEntry.async("string"));
      topic.viewpoints.push(parseViewpoint(viewpoint?.VisualizationInfo || {}, viewpointFile));
    }
    topics.push(topic);
  }

  return {
    bcf_path: bcfPath,
    topic_count: topics.length,
    topics,
    truncated: topics.length >= maxTopics,
  };
}

function markupXml({
  topicGuid,
  viewpointGuid,
  title,
  created,
  ifcFilename,
  topicType,
  topicStatus,
  author,
}) {
  const markup = {
    Markup: {
      Topic: {
        "@_Guid": topicGuid,
        "@_TopicType": topicType,
        "@_TopicStatus": topicStatus,
        Title: title,
        CreationDate: created,
        CreationAuthor: author,
      },
      Viewpoints: {
        ViewPoint: {
          "@_Guid": viewpointGuid,
          Viewpoint: `${viewpointGuid}.bcfv`,
        },
      },
    },
  };
  if (ifcFilename) {
    markup.Markup.Header = {
      File: {
        "@_isExternal": "false",
        Filename: ifcFilename,
        Date: created,
        Reference: ifcFilename,
      },
    };
  }
  return xmlDocument(markup);
}

function viewpointXml({
  viewpointGuid,
  selectedGlobalIds,
  isolatedGlobalIds,
  hiddenGlobalIds,
  coloredComponents,
}) {
  const components = {};
  if (selectedGlobalIds.length > 0) {
    components.Selection = {
      Component: selectedGlobalIds.map((guid) => ({ "@_IfcGuid": guid })),
    };
  }
  if (isolatedGlobalIds.length > 0 || hiddenGlobalIds.length > 0) {
    const defaultVisible = isolatedGlobalIds.length > 0 ? "false" : "true";
    const exceptions = isolatedGlobalIds.length > 0 ? isolatedGlobalIds : hiddenGlobalIds;
    components.Visibility = {
      "@_DefaultVisibility": defaultVisible,
      Exceptions: {
        Component: exceptions.map((guid) => ({ "@_IfcGuid": guid })),
      },
    };
  }
  if (coloredComponents.length > 0) {
    components.Coloring = {
      Color: coloredComponents.map((item) => ({
        "@_Color": item.color,
        Component: item.global_ids.map((guid) => ({ "@_IfcGuid": guid })),
      })),
    };
  }
  return xmlDocument({
    VisualizationInfo: {
      "@_Guid": viewpointGuid,
      Components: components,
    },
  });
}

function parseViewpoint(viewpoint, filename) {
  const components = viewpoint.Components || {};
  const visibility = components.Visibility || {};
  return {
    filename,
    guid: viewpoint["@_Guid"] || null,
    selected_global_ids: asArray(components.Selection?.Component)
      .map((item) => item?.["@_IfcGuid"])
      .filter(Boolean),
    visibility_default: visibility["@_DefaultVisibility"] || null,
    visibility_exceptions: asArray(visibility.Exceptions?.Component)
      .map((item) => item?.["@_IfcGuid"])
      .filter(Boolean),
    colored_components: asArray(components.Coloring?.Color)
      .map((item) => ({
        color: normalizeColor(item?.["@_Color"]),
        global_ids: asArray(item?.Component)
          .map((component) => component?.["@_IfcGuid"])
          .filter(Boolean),
      }))
      .filter((item) => item.color && item.global_ids.length > 0),
  };
}

function xmlDocument(value) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xmlBuilder.build(value)}`;
}

function cleanGuids(globalIds) {
  return Array.from(
    new Set((globalIds || []).map((guid) => String(guid || "").trim()).filter(Boolean)),
  ).sort();
}

function cleanColoredComponents(coloredComponents) {
  const result = [];
  for (const item of coloredComponents || []) {
    const color = normalizeColor(item?.color);
    const globalIds = cleanGuids(item?.global_ids || item?.globalIds || item?.ids || []);
    if (!color || globalIds.length === 0) {
      continue;
    }
    result.push({ color, global_ids: globalIds });
  }
  return result;
}

function normalizeColor(value) {
  const color = String(value || "").trim().replace(/^#/, "").toUpperCase();
  return /^[0-9A-F]{6}$/.test(color) ? color : null;
}

function randomGuid() {
  return crypto.randomUUID().toUpperCase();
}

function textValue(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "object" && "#text" in value) {
    return String(value["#text"]);
  }
  return String(value);
}
