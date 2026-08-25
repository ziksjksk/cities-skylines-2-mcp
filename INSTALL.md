# Installation

## Prerequisites

- Windows with Cities: Skylines II installed. The implementation was compiled against `D:\steam\steamapps\common\Cities Skylines II` in the development environment; use your own installation path when it differs.
- A .NET SDK that can build the legacy `net472` mod project. The development machine has SDK `8.0.423` at `C:\Users\zlyexn\.dotnet`; a runtime-only `dotnet.exe` is not sufficient.
- Node.js 18 or newer. Node 24 was used for the MCP smoke tests.
- A disposable test save for in-game verification. Do not first test large plans in a valuable city.

## Build the bridge

From the repository root:

```powershell
& "$env:USERPROFILE\.dotnet\dotnet.exe" build ".\CS2MCP.Bridge\CS2MCP.Bridge.csproj" `
  -p:GamePath="D:\steam\steamapps\common\Cities Skylines II"
```

The project references the installed `Cities2_Data\Managed` assemblies. A successful build deploys `CS2MCP.dll` and its PDB to:

```text
%LOCALAPPDATA%Low\Colossal Order\Cities Skylines II\Mods\CS2MCP
```

To compile without deployment, pass `-p:SkipDeploy=true`. Deployment is a normal build target and only replaces this mod's two output files.

## Build and test the MCP server

```powershell
Set-Location ".\mcp-server"
npm ci --registry=https://registry.npmjs.org/ --no-audit
npm test
```

`npm test` compiles TypeScript, runs pure geometry/road-graph/serialization tests, exercises MCP initialization and schema advertisement, and sends `cs2_ping`/`cs2_capabilities` through a real MCP process to a fake localhost bridge. It does not require the game to be running. The live game smoke test is opt-in with `CS2_INTEGRATION=1` and is skipped otherwise.

## Configure the bridge URL

Copy `.env.example` to `.env` only when a non-default endpoint is needed. The default is localhost-only:

```text
CS2_BRIDGE_URL=http://127.0.0.1:8642
```

The game-process port is controlled by `CS2MCP_PORT`; if it is changed, set the same port in `CS2_BRIDGE_URL`. Do not put credentials or tokens in this project.

## Run with an MCP client

Build first, then register the generated server entry point:

```json
{
  "mcpServers": {
    "cs2": {
      "command": "node",
      "args": ["C:\\path\\to\\cs2-autonomy\\mcp-server\\dist\\index.js"]
    }
  }
}
```

Start the game, enable the local `CS2MCP` code mod, load a city, and run `cs2_ping`. The tool should report `ok:true`, the mod version, and `gameMode:"Game"`. A main-menu ping is useful for loading diagnostics, but city endpoints require a loaded save.

## First safe session

Use this order in a disposable save:

```text
cs2_ping
cs2_capabilities
cs2_coordinate_info
cs2_discover_assets(category="road",pageSize=50)
cs2_analyze_map(resolution=32)
cs2_plan_metropolis(fetchTerrain=true)
cs2_build_interchange(...,preview=true)
cs2_execute_master_plan(plan=...,execute=false)
```

Only after reviewing the preview should an agent use `execute=true` with a small `maxSegments` and validate the result with `cs2_validate_city` and screenshots.
