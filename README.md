# IFC MCP

IFC MCP lets your AI assistant inspect IFC/BIM files, create IFC files, create
reports, open IFC models in a viewer, and apply BCF viewpoints.

## How It Works

After installation, ask your AI client in normal language. The AI client starts
IFC MCP when it needs the IFC tools and sends your request to the local server.
IFC MCP reads IFC files locally, runs the needed IFC logic in a local Pyodide
runtime with IfcOpenShell, and returns the answer to the chat.

[![Watch IFC MCP with Claude demo on YouTube](https://cdn.jsdelivr.net/npm/ifc-mcp@0.1.17/docs/ifc-mcp-demo-thumbnail.jpg)](https://youtu.be/Y4IgtZVmUeE)

Good example prompts:

- `Open examples/sample.ifc and summarize the model.`
- `Count the walls, doors, windows, spaces, and property sets in examples/sample.ifc.`
- `Find missing names, classifications, and suspicious property values in this IFC file.`
- `Create a CSV room-area report from this IFC file.`
- `Create a simple IFC file with one building, one storey, and four walls.`
- `Open the IFC viewer and show examples/sample.ifc.`
- `Apply C:\path\to\viewpoint.bcfzip in the open IFC viewer.`
- `Clear the IFC viewer.`

If IFC MCP creates a report, BCF file, or new IFC file, it returns a local
download link. If you ask to view a model, IFC MCP opens a local viewer link.
If your AI client does not open that link automatically, open it in your
browser.

The browser viewer and generated downloads share one localhost HTTP server per
IFC MCP process. It tries port `8765` and automatically selects a free port if
that port is occupied. Open the complete viewer URL returned by the tool.
The token after `#` authorizes access to models and view state and stays valid
until IFC MCP stops. Clearing the viewer keeps that server running. Disconnecting
or stopping IFC MCP closes the server and expires its temporary download links.

Large IFC files can take more than a minute to process. Cancelling a request
terminates its local Python worker. The next call starts a fresh runtime.

The package includes Pyodide 0.28.3, the checksum-verified IfcOpenShell wheel,
and the other Python packages needed for offline execution. Desktop and browser
each reuse a sandboxed Python worker. Desktop discards its worker when the
approved inputs change or the MCP connection closes.

IFC MCP accepts IFC and IFCZIP files.

For local analysis, give your assistant the file path. A client with local
terminal access can hand the file to IFC MCP using its existing permissions.
If the handoff is unavailable, you can select the file using the picker link.

Use `run-python` with `bcf-client` to create BCF viewpoints, including
orthographic cameras. The connected browser viewer returns a rendered screenshot
with the application status and issues from `set-bcf-view`.

## Installation

### 1. Prerequisites

Install Node.js 20 or newer from the [official Node.js download page](https://nodejs.org/en/download).
Choose the LTS version for your operating system, run the installer, then
reopen the app where you want to use IFC MCP.

IFC MCP uses `npx`, which is included with Node.js. If your app later says
`node` or `npx` is not found, reinstall Node.js LTS and reopen the app.

On Linux x64 and ARM64, `run-python` uses the bundled sandbox launcher and
requires a Linux 5.13 or newer kernel with Landlock enabled. No additional
runtime package is needed.

### 2. Choose your client

<a id="chatgpt-desktop"></a>
<details>
<summary><strong>ChatGPT desktop app</strong></summary>

ChatGPT desktop supports local MCP servers over STDIO.

1. Open the ChatGPT desktop app.
2. Open `Settings`.
3. Select `Plugins`, then `MCPs`.
4. Click `Add`. If prompted for a server type, choose `STDIO`.
5. Enter:
   - Name: `ifc-mcp`
   - Command to launch: `npx`
   - First argument: `-y`
   - Second argument: `ifc-mcp`
6. Leave the environment variable fields empty and save the server.
7. Restart the ChatGPT desktop app.
8. Start a new chat, type `/mcp`, and confirm that `ifc-mcp` is connected.

For more detail, see OpenAI's [MCP documentation](https://learn.chatgpt.com/docs/extend/mcp).

</details>

<a id="claude-desktop"></a>
<details>
<summary><strong>Claude Desktop</strong></summary>

**Option 1: Use the Claude Desktop UI**

1. Open Claude Desktop.
2. Open `Settings`.
3. Open `Developer` or `Desktop app` developer settings.
4. Click `Edit Config` if that button is available. This opens the Claude
   Desktop MCP config file.
5. Paste the JSON below, save the file, then fully quit and reopen Claude
   Desktop.

```json
{
  "mcpServers": {
    "ifc-mcp": {
      "command": "npx",
      "args": ["-y", "ifc-mcp"]
    }
  }
}
```

If the file already contains JSON, add only the `ifc-mcp` entry inside the
existing `mcpServers` object. Do not create a second `mcpServers` object.

**Option 2: Open the config file directly**

Use this only if you do not see `Edit Config` in Claude Desktop:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

Paste the same JSON from Option 1, save the file, then fully quit and reopen
Claude Desktop.

**Check**

To check the setup, open Claude Desktop, start a new chat, click the `+` button
near the chat box, and look for `Connectors`. IFC MCP should appear there after
Claude Desktop has restarted. You should see the tools listed in the
**How It Works** section above.

For more detail, see Claude's [local MCP server guide](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).

</details>

<a id="vs-code-mcp"></a>
<details>
<summary><strong>VS Code Copilot</strong></summary>

**Option 1: Use the install button**

This opens VS Code and adds `IFC MCP`.

[![Install IFC MCP in VS Code](https://img.shields.io/badge/Install%20IFC%20MCP-VS%20Code-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522IFC%2520MCP%2522%252C%2522type%2522%253A%2522stdio%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522ifc-mcp%2522%255D%257D)

If VS Code asks whether you trust the server, accept it. Reload VS Code if the
tools do not appear. Open Chat and use the tools/configure-tools button to see
the IFC MCP tools.

**Option 2: Add `.vscode/mcp.json` manually**

```json
{
  "servers": {
    "IFC MCP": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "ifc-mcp"]
    }
  }
}
```

Reload VS Code after saving the file.

Open Chat and use the tools/configure-tools button to see the IFC MCP tools.

For more detail, see the [VS Code MCP server docs](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

</details>

<a id="codex-in-vs-code"></a>
<details>
<summary><strong>VS Code Codex</strong></summary>

**Option 1: Use the Codex settings UI**

1. Open VS Code.
2. Open the Codex panel.
3. Open Codex settings.
4. Select `MCP servers`.
5. Click `Add server`.
6. Enter:
   - Name: `ifc-mcp`
   - Command: `npx`
   - Arguments: `-y ifc-mcp`
7. Save the server.
8. Reload VS Code or start a new Codex session.
9. Check that the IFC MCP tools are available in the new Codex session.

**Option 2: Use the terminal command**

1. Open `Terminal -> New Terminal` in VS Code.
2. Paste and run:

```powershell
codex mcp add ifc-mcp -- npx -y ifc-mcp
```

3. Reload VS Code or start a new Codex session.
4. Check that the IFC MCP tools are available in the new Codex session.

For more detail, see the [Codex MCP docs](https://developers.openai.com/codex/mcp).

</details>

<a id="claude-code-in-vs-code"></a>
<details>
<summary><strong>VS Code Claude Code</strong></summary>

**Option 1: Use a project JSON file**

1. Open your project in VS Code.
2. Create or edit `.mcp.json` in the project root.
3. Add this JSON and save the file:

```json
{
  "mcpServers": {
    "ifc-mcp": {
      "command": "npx",
      "args": ["-y", "ifc-mcp"]
    }
  }
}
```

4. Reopen Claude Code in VS Code.
5. Type `/mcp` and approve the project server if Claude asks.
6. Check that `ifc-mcp` is connected.

**Option 2: Use the terminal command for all projects**

```powershell
claude mcp add --transport stdio ifc-mcp --scope user -- npx -y ifc-mcp
```

Then reopen Claude Code in VS Code, type `/mcp`, and check that `ifc-mcp` is
connected.

If the `claude` command is not found, install Claude Code first.

For more detail, see the [Claude Code VS Code docs](https://code.claude.com/docs/en/vs-code) and [Claude Code MCP docs](https://code.claude.com/docs/en/mcp).

</details>

<a id="other-mcp-clients"></a>
<details>
<summary><strong>Other MCP clients</strong></summary>

Add this server entry to your MCP client config:

```json
{
  "mcpServers": {
    "ifc-mcp": {
      "command": "npx",
      "args": ["-y", "ifc-mcp"]
    }
  }
}
```

Restart the MCP client after saving the config.

For more detail, see the [Model Context Protocol docs](https://modelcontextprotocol.io/docs/getting-started/intro).

</details>

## Use Your Own Viewer

If your app already has an IFC viewer, you can reuse IFC MCP's normal tool
interface and apply viewer actions in your app instead of opening the default
local viewer. The MCP client still calls tools like `show-ifc-file` and
`set-bcf-view`; your app only defines what those viewer tools do.

<details>
<summary><strong>Node MCP server</strong></summary>

Provide handlers that receive local file paths. Replace the functions below
with your app's viewer actions:

```js
import { createServer } from "ifc-mcp";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

serveStdio(() => createServer({
  viewer: {
    "open-ifc-viewer": () => openThisViewer(),
    "show-ifc-file": ({ file_path }) => loadIfcIntoThisViewer(file_path),
    "set-bcf-view": ({ bcf_path }) => applyBcfToThisViewer(bcf_path),
    "clear-ifc-viewer": () => clearThisViewer(),
  },
}));
```

Return MCP tool results from your handlers: `content` contains feedback, and
`isError: true` indicates failure.

</details>

<details>
<summary><strong>Browser app</strong></summary>

Pass files selected in your app and callbacks for your existing viewer.
Here, `file` is a selected IFC `File`, and `viewer` is your viewer instance:

```js
import { createIfcMcpHost } from "ifc-mcp/browser";

const files = new Map([
  [file.name, { name: file.name, source: file }],
]);

const host = createIfcMcpHost({
  files,
  viewer: {
    "show-ifc-file": (name, bytes) => viewer.add(name, bytes),
    "set-bcf-view": (name, bytes) => viewer.add(name, bytes),
    "clear-ifc-viewer": () => viewer.clear(),
  },
});

const result = await host.handleToolCall({
  name: "show-ifc-file",
  input: { file_path: file.name },
});
```

File callbacks receive a filename and `Uint8Array` bytes. The BCF callback
must return an MCP tool result describing whether the viewpoint was applied.
Use `host.tools` for the tool definitions and `host.getGeneratedFiles()` for
generated downloads. Call `host.clearFiles()` when those downloads are no longer needed.

When serving the built browser entry, serve `python-worker-browser.js` and the
`python/` directory beside it. The sandbox loads these assets before executing
Python. The browser host must allow a sandboxed iframe and a blob worker.

Use one browser host per session. Python can retain data between calls. Call
`host.resetPythonSession()` when the session ends or file access is revoked.

</details>

## Local Development

Linux source builds use GCC and musl-tools to compile the sandbox launcher.

For local development from this checkout:

```powershell
npm install
npm test
```

The workspace includes `.vscode/mcp.json`, so VS Code can run the server from
this checkout.

`npm test` includes real stdio subprocesses, malformed protocol and viewer
requests, concurrent startup and shutdown, download expiry and storage limits,
and the local Python runtime.
The process and browser fixtures follow the approaches in the
[MCP SDK testing guide](https://ts.sdk.modelcontextprotocol.io/v2/testing) and
[Playwright MCP tests](https://github.com/microsoft/playwright-mcp/blob/main/tests/fixtures.ts).

To test the built server with the published viewer SDK in Chromium:

```powershell
npx playwright install chromium
npm run test:browser
```

The browser suite loads a real IFC wall, checks reload and BCF selection/color
round trips, verifies recovery from invalid IFC, and checks port cleanup.
It needs access to the pinned viewer SDK on Flinker's CDN. Failure screenshots,
traces, and the HTML report are saved under `.ifc-mcp/`.

After building, `npm run test:installed` installs a local tarball and tests the
desktop sandbox. Add `-- --browser` to test the browser sandbox from the same
tarball. The release workflow runs the desktop test on Windows, macOS and Linux
before publishing.

To compare resource use with another checkout, install its npm dependencies and
run `npm run benchmark:ifcopenshell -- --memory <checkout> [model.ifc ...]`.
The benchmark measures average and peak resident memory and CPU use across the
MCP server, its sandbox workers and the terminal handoff. On Windows it also
records private memory, GPU utilization, and shared and dedicated GPU memory.
It reads small ranges of a 256 MiB fixture and parses the supplied IFC models. Set
`IFC_BENCHMARK_MEMORY_MIB` to change the range fixture size. Results are written
to `.ifc-mcp/ifcopenshell-memory-benchmark.json`.

## Security

IFC MCP keeps the IFC work on your own machine. It reads your IFC files locally,
runs the IFC analysis locally, and opens a local viewer. It does not publish the
viewer to the public internet.

Python receives copies of the files provided for the run and writes its outputs
in a temporary workspace. The sandbox blocks network requests, reads of other
user file contents, and changes to host files. On Linux, the kernel can still
expose basic file metadata such as whether a named path exists. Generated
reports, BCF files, and IFC files are returned as temporary local downloads.
Choose where to save them.

The desktop handoff streams inputs into private temporary storage on the same
machine. The client needs permission to read the source file and connect to IFC
MCP on localhost. IFC MCP removes automatic handoffs after each run and expires
unused handoffs after five minutes. Files selected in the picker stay available
for the session or until you remove them.
Python reads only the parts it requests. The browser worker reads slices of the
selected file directly. IfcOpenShell can still use substantial memory to parse a
large model or build its geometry.

The desktop viewer tools accept local model and BCF paths for viewing.
