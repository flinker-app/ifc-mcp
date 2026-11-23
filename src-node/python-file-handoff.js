import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { IFC_SUFFIXES } from "./constants.js";
import { resolvePath } from "./paths.js";

export function describePythonFileHandoff(entry, pickerUrl, missing) {
  const request = Buffer.from(JSON.stringify({ pickerUrl, paths: missing.map(({ file }) => file) })).toString("base64url");
  const command = process.execPath;
  const args = [entry, "attach", request];
  const quoteSh = value => `'${value.replaceAll("'", `'"'"'`)}'`;
  const sh = [command, entry].map(value => process.platform === "win32" ? value.replaceAll("\\", "/") : value)
    .concat("attach", request).map(quoteSh).join(" ");
  const quotePwsh = value => `'${value.replace(/['\u2018-\u201b]/gu, "$&$&")}'`;
  const powershell = process.platform === "win32" ? `& ${[command, ...args].map(quotePwsh).join(" ")}` : undefined;
  return { command, args, sh, powershell, file_indices: missing.map(({ index }) => index) };
}

export async function attachPythonFiles(encoded) {
  const request = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!Array.isArray(request?.paths) || !request.paths.length || request.paths.some(file => typeof file !== "string" || !file)) {
    throw new Error("The IFC MCP file handoff needs local IFC or IFCZIP paths.");
  }
  const picker = new URL(request.pickerUrl);
  if (picker.protocol !== "http:" || picker.hostname !== "127.0.0.1" || !picker.port || picker.username ||
      picker.password || picker.pathname !== "/python-files" || picker.search || !/^#[\w-]{43}$/u.test(picker.hash)) {
    throw new Error("The file handoff needs a local IFC MCP file picker URL.");
  }

  const files = [];
  try {
    for (const reference of request.paths) {
      const source = resolvePath(reference, { mustExist: false, description: "IFC input" });
      const name = path.basename(source);
      if (!IFC_SUFFIXES.includes(path.extname(name).toLowerCase()) || /[/\\\u0000-\u001f\u007f]/u.test(name)) {
        throw new Error("The file handoff only accepts IFC or IFCZIP files.");
      }
      const file = await fs.open(source, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
      try {
        const stats = await file.stat();
        if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size < 1) {
          throw new Error("The file handoff needs a nonempty regular file.");
        }
        const body = file.createReadStream({ autoClose: false, end: stats.size - 1 });
        const result = await send(picker, "POST", {
          "X-IFC-File-Name": encodeURIComponent(name), "X-IFC-File-Handoff": "1", "Content-Length": stats.size,
        }, body);
        files.push(result.file);
      } finally {
        await file.close();
      }
    }
    return files;
  } catch (error) {
    await Promise.allSettled(files.map(file => send(picker, "DELETE", {}, undefined, file.tool_path)));
    throw error;
  }
}

async function send(picker, method, headers, body, id) {
  const endpoint = new URL("/python-files/approved", picker);
  if (id) endpoint.searchParams.set("id", id);
  const request = http.request(endpoint, {
    method,
    agent: false,
    headers: { ...headers, Origin: picker.origin, "X-IFC-Python-File-Token": picker.hash.slice(1) },
  });
  request.setTimeout(30_000, () => request.destroy(new Error("IFC MCP file handoff timed out.")));
  const response = new Promise((resolve, reject) => {
    request.once("error", reject);
    request.once("response", incoming => readResponse(incoming).then(resolve, reject));
  });

  if (!body) {
    request.end();
    return response;
  }
  const sent = pipeline(body, request).then(() => {
    if (body.bytesRead !== headers["Content-Length"]) {
      request.destroy(new Error("The IFC file changed during the handoff."));
    }
  });
  try {
    const [result] = await Promise.all([response, sent]);
    return result;
  } catch (error) {
    request.destroy();
    await sent.catch(() => {});
    throw error;
  }
}

async function readResponse(response) {
  let text = "";
  response.setEncoding("utf8");
  for await (const chunk of response) {
    text += chunk;
    if (text.length > 8192) throw new Error("Unexpected IFC MCP file handoff response.");
  }
  const result = JSON.parse(text);
  if (![200, 201].includes(response.statusCode)) {
    throw new Error(result.error || `IFC MCP rejected the file handoff (${response.statusCode}).`);
  }
  return result;
}
