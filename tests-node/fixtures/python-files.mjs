import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export async function approvePythonFile(pickerUrl, source, headers = {}) {
  const picker = new URL(pickerUrl);
  const { size } = await fs.stat(source);
  const response = await fetch(new URL("/python-files/approved", picker), {
    method: "POST",
    headers: { Origin: picker.origin, "X-IFC-Python-File-Token": picker.hash.slice(1),
      "X-IFC-File-Name": encodeURIComponent(path.basename(source)), "Content-Length": String(size), ...headers },
    body: createReadStream(source), duplex: "half",
  });
  if (!response.ok) throw new Error(`Could not approve Python test file: ${response.status} ${await response.text()}`);
  return (await response.json()).file.tool_path;
}
