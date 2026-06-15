import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolvePath(
  value,
  { mustExist = true, suffixes = undefined, description = "path" } = {},
) {
  if (!value || typeof value !== "string") {
    throw new Error(`${description} must be a non-empty string`);
  }

  const candidate = path.isAbsolute(expandHome(value))
    ? expandHome(value)
    : path.join(process.cwd(), expandHome(value));

  let resolved = path.resolve(candidate);
  if (mustExist) {
    if (!fs.existsSync(resolved)) {
      throw new Error(`${description} does not exist: ${resolved}`);
    }
    resolved = fs.realpathSync(resolved);
  }

  const suffixSet = new Set((suffixes || []).map((suffix) => suffix.toLowerCase()));
  if (suffixSet.size > 0 && !suffixSet.has(path.extname(resolved).toLowerCase())) {
    throw new Error(
      `${description} must have one of these suffixes: ${Array.from(suffixSet).sort().join(", ")}`,
    );
  }

  return resolved;
}

function expandHome(value) {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}
