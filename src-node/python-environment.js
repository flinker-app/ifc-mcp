export function normalizePythonOptions({ env, grab, scriptFileName } = {}) {
  const normalized = {};
  for (const [rawName, rawValue] of Object.entries(env || {})) {
    if (rawValue == null) continue;
    const name = rawName.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid Python environment variable name: ${rawName}`);
    const value = String(rawValue);
    if (value.includes("\0")) throw new Error(`Invalid Python environment variable value for ${name}`);
    normalized[name] = value;
  }
  return { env: normalized, grab: Array.isArray(grab) ? grab.map(String) : [],
    scriptFileName: typeof scriptFileName === "string" ? scriptFileName.trim() : undefined };
}
