import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const entry = "python-worker-node.mjs";

export async function startPosixSandbox(dist, stage) {
  if (process.platform === "darwin") return macSandbox(stage);
  if (process.platform === "linux") return linuxSandbox(dist, stage);
  throw new Error("A Python sandbox is unavailable on this platform.");
}

async function macSandbox(stage) {
  const executable = await fs.realpath(process.execPath);
  const quote = JSON.stringify;
  const node = `(literal ${quote(executable)})`;
  const systemLibraries = '(subpath "/usr/lib") (subpath "/System/Library") (subpath "/private/var/db/dyld")';
  const ancestors = [stage, executable].flatMap(value => {
    const directories = [];
    while (path.dirname(value) !== value) {
      value = path.dirname(value);
      directories.push(value);
    }
    return directories;
  });
  const profile = [
    "(version 1)",
    "(deny default)",
    `(allow process-exec ${node})`,
    `(allow file-map-executable ${node} ${systemLibraries})`,
    "(allow sysctl-read)",
    `(allow file-read-metadata ${Array.from(new Set(ancestors), value => `(literal ${quote(value)})`).join(" ")})`,
    `(allow file-read* ${node} (subpath ${quote(stage)}) ${systemLibraries}`,
    '  (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
  ].join("\n");
  const launcher = "/usr/bin/sandbox-exec";
  await fs.access(launcher);
  return { launcher, args: ["-p", profile, executable, "--preserve-symlinks-main", "--preserve-symlinks", path.join(stage, entry)],
    options: { cwd: stage, env: {} } };
}

async function linuxSandbox(dist, stage) {
  const launcher = fileURLToPath(new URL(`sandbox/linux-${process.arch}`, dist));
  await fs.access(launcher);
  await fs.copyFile(process.execPath, path.join(stage, "node"));
  await fs.chmod(path.join(stage, "node"), 0o755);
  return { launcher, args: [stage, String(process.pid)], options: { env: {} } };
}
