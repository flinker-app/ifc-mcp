import { execFile, spawn } from "node:child_process";
import os from "node:os";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const logicalCpus = os.cpus().length;

export function sampleResources(root, record) {
  return process.platform === "win32" ? sampleWindows(root, record) : samplePosix(root, record);
}

export function summarizeResources(samples) {
  const metrics = {};
  for (const key of ["rss_bytes", "private_bytes", "cpu_percent", "gpu_percent", "gpu_dedicated_bytes", "gpu_shared_bytes"]) {
    let peak = null;
    let sum = 0;
    let weight = 0;
    for (let i = 1; i < samples.length; i++) {
      const value = samples[i][key];
      const interval = samples[i].time_ms - samples[i - 1].time_ms;
      if (value == null || interval <= 0) continue;
      peak = Math.max(peak ?? 0, value);
      sum += value * interval;
      weight += interval;
    }
    metrics[`average_${key}`] = weight ? sum / weight : null;
    metrics[`peak_${key}`] = peak;
  }
  return metrics;
}

function sampleWindows(root, record) {
  const script = fileURLToPath(new URL("./benchmark-resources-windows.ps1", import.meta.url));
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script, root, logicalCpus],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  let stopping = false;
  child.stderr.setEncoding("utf8").on("data", text => { stderr += text; });
  const task = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => stopping ? resolve() : reject(new Error(stderr || `Resource sampler exited (${code}).`)));
  });
  const ready = Promise.race([new Promise((resolve, reject) => {
    lines.on("line", line => {
      try {
        record(JSON.parse(line));
        resolve();
      } catch (error) { reject(error); }
    });
  }), task]);
  return { ready, async stop() {
    stopping = true;
    lines.close();
    child.kill();
    await task;
  } };
}

function samplePosix(root, record) {
  let stopped = false;
  let previous = new Map();
  let previousTime;
  async function sample() {
    const rows = await new Promise((resolve, reject) => {
      const ps = execFile("ps", ["-axo", "pid=,ppid=,rss=,time="], { maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim().split("\n").map(line => line.trim().split(/\s+/))
          .filter(([pid]) => Number(pid) !== ps.pid));
      });
    });
    const time_ms = performance.now();
    const tree = new Set([root]);
    for (const parent of tree) {
      for (const [pid, ppid] of rows) if (Number(ppid) === parent) tree.add(Number(pid));
    }
    const current = new Map();
    let rss_bytes = 0;
    let cpuMs = 0;
    for (const [pid, , rss, time] of rows) {
      if (Number(pid) === root || !tree.has(Number(pid))) continue;
      rss_bytes += Number(rss) * 1024;
      const used = cpuTimeMs(time);
      current.set(pid, used);
      cpuMs += Math.max(0, used - (previous.get(pid) ?? 0));
    }
    const cpu_percent = previousTime === undefined ? null : 100 * cpuMs / ((time_ms - previousTime) * logicalCpus);
    record({ time_ms, rss_bytes, cpu_percent });
    previous = current;
    previousTime = time_ms;
  }
  const ready = sample();
  const task = ready.then(async () => {
    while (!stopped) {
      await delay(150);
      if (!stopped) await sample();
    }
  });
  task.catch(() => {});
  return { ready, async stop() { stopped = true; await task; } };
}

function cpuTimeMs(text) {
  const [clock, days] = text.split("-").reverse();
  return ((Number(days) || 0) * 86400 + clock.split(":").reduce((total, part) => total * 60 + Number(part), 0)) * 1000;
}
