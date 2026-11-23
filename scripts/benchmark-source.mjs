import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const runtimePaths = ["bin", "src-node", "vendor", "package.json", "package-lock.json"];

export async function readBenchmarkSource(root, benchmarkPaths) {
  const files = [...runtimePaths, ...benchmarkPaths];
  const git = async args => (await exec("git", args, {
    cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  })).stdout;
  const [revisionText, branch, diff, filenames] = await Promise.all([
    git(["rev-parse", "HEAD"]),
    git(["branch", "--show-current"]),
    git(["diff", "HEAD", "--binary", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "--", ...files]),
    git(["ls-files", "--others", "--exclude-standard", "-z", "--", ...files]),
  ]);
  const revision = revisionText.trim();
  const untracked = filenames.split("\0").filter(Boolean).sort();
  const hash = createHash("sha256").update("ifc-benchmark-source-v1\0").update(revision);
  hash.update(`\0diff\0${diff.length}\0`).update(diff);
  for (const filename of untracked) {
    const bytes = await fs.readFile(path.join(root, filename));
    hash.update(`\0file\0${filename}\0${bytes.length}\0`).update(bytes);
  }
  return {
    ref: branch.trim() || "detached HEAD",
    revision,
    modified: Boolean(diff || untracked.length),
    fingerprint: hash.digest("hex"),
  };
}
