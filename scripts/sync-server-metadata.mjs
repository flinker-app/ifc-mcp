import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

// package.json owns the package identity and version; server.json is a registry artifact.
export async function syncServerMetadata({ check = false } = {}) {
  const packageInfo = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  const target = new URL("../server.json", import.meta.url);
  const previous = await fs.readFile(target, "utf8");
  const metadata = JSON.parse(previous);
  metadata.name = packageInfo.mcpName;
  metadata.version = packageInfo.version;
  metadata.repository = { url: packageInfo.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""), source: "github" };
  metadata.packages = [{ registryType: "npm", identifier: packageInfo.name, version: packageInfo.version, transport: { type: "stdio" } }];
  const next = JSON.stringify(metadata, null, 2) + "\n";
  if (JSON.stringify(JSON.parse(previous)) === JSON.stringify(metadata)) return;
  if (check) throw new Error("Registry metadata is stale. Run npm run sync-metadata.");
  await fs.writeFile(target, next);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await syncServerMetadata({ check: process.argv.includes("--check") });
}
