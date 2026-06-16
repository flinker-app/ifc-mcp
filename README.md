# IFC MCP

IFC MCP lets your AI assistant inspect IFC/BIM files, create IFC files, create
reports, open IFC models in a viewer, and apply BCF viewpoints.

## How It Works

After installation, ask your AI client in normal language. The AI client starts
IFC MCP when it needs the IFC tools and sends your request to the local server.
IFC MCP reads IFC files locally, runs the needed IFC logic in a local Pyodide
runtime with IfcOpenShell, and returns the answer to the chat.

[![Watch IFC MCP with Claude demo on YouTube](https://cdn.jsdelivr.net/npm/ifc-mcp@0.1.12/docs/ifc-mcp-demo-thumbnail.jpg)](https://youtu.be/Y4IgtZVmUeE)

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

## Installation

### 1. Prerequisites

Install Node.js 18.20 or newer from the [official Node.js download page](https://nodejs.org/en/download).
Choose the LTS version for your operating system, run the installer, then
reopen the app where you want to use IFC MCP.

IFC MCP uses `npx`, which is included with Node.js. If your app later says
`node` or `npx` is not found, reinstall Node.js LTS and reopen the app.

### 2. Choose your client

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

## Local Development

For local development from this checkout:

```powershell
npm install
npm test
```

The workspace includes `.vscode/mcp.json`, so VS Code can run the server from
this checkout.

## Security

IFC MCP keeps the IFC work on your own machine. It reads your IFC files locally,
runs the IFC analysis locally, and opens a local viewer. It does not publish the
viewer to the public internet.

Generated reports, BCF files, and IFC files are temporary local download links.
IFC MCP does not write generated output files into your project folder by
default.

Use IFC MCP only with IFC/BIM files and project folders you trust. It can read
the files you ask it to use, and incorrect or misleading model data can lead to
wrong reports or generated IFC files.
