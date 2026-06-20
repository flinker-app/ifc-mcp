export function createIfcMcpHostHandlers({
  viewer = null,
  python = null,
} = {}) {
  const handlers = {};

  if (typeof python?.["run-python"] === "function") {
    handlers["run-python"] = python["run-python"];
  }

  if (typeof viewer?.["open-ifc-viewer"] === "function") {
    handlers["open-ifc-viewer"] = viewer["open-ifc-viewer"];
  }

  if (typeof viewer?.["show-ifc-file"] === "function") {
    handlers["show-ifc-file"] = viewer["show-ifc-file"];
  }

  if (typeof viewer?.["clear-ifc-viewer"] === "function") {
    handlers["clear-ifc-viewer"] = viewer["clear-ifc-viewer"];
  }

  if (typeof viewer?.["set-bcf-view"] === "function") {
    handlers["set-bcf-view"] = viewer["set-bcf-view"];
  }

  return handlers;
}
