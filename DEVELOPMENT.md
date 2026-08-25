# Development

## Repository layout

| Path | Responsibility |
|---|---|
| `CS2MCP.Bridge/` | In-process C# mod, HTTP listener, main-thread queue, ECS perception, native construction, capability contract |
| `mcp-server/src/index.ts` | Existing MCP tool adapters and stdio entry point |
| `mcp-server/src/geometry.ts` | Pure geometry, terrain summary, interchange, and master-plan algorithms |
| `mcp-server/src/autonomy.ts` | Capability-gated orchestration and advanced MCP tools |
| `tests/` | Node built-in tests for geometry, road-graph derivation, JSON serialization, MCP schema/advertisement, bridge communication, and opt-in game integration |
| `docs/` | Research and verification records |
| `examples/` | Safe plan-only inputs and agent playbook examples |
| `src/` | Stable top-level planning-source boundary; executable TypeScript remains under `mcp-server/src/` |
| `bridge/` | Stable top-level bridge-source boundary; executable C# remains under `CS2MCP.Bridge/` |

## Repeatable checks

```powershell
# MCP compile and tests
Set-Location ".\mcp-server"
npm test

# Bridge compile without changing the installed mod
Set-Location ".."
& "$env:USERPROFILE\.dotnet\dotnet.exe" build ".\CS2MCP.Bridge\CS2MCP.Bridge.csproj" `
  -p:GamePath="D:\steam\steamapps\common\Cities Skylines II" `
  -p:SkipDeploy=true
```

Use `git diff --check` after edits. Build output and `node_modules` are local artifacts; do not commit them.

## Adding a bridge endpoint

1. Add a route in `RequestHandlers.Handle`.
2. Implement the handler in a partial `RequestHandlers.*.cs` file.
3. Guard city-dependent handlers with `TryGetCity`.
4. Keep all ECS reads/writes on the `BridgeSystem.OnUpdate` thread.
5. Use a native game system/tool pipeline for mutation; do not add raw `Deleted`, `Transform`, lane, node, or prefab components by hand.
6. Add the capability boolean/detail only when the endpoint is actually implemented.
7. Return machine-readable failure reasons, not only `Failed`.
8. Compile against the installed Managed assemblies and playtest in a disposable save.

## Adding an MCP tool

1. Define a Zod schema with coordinate units and bounds.
2. Use `cs2_capabilities` before any advanced mutation.
3. Provide preview/dry-run behavior for large or irreversible operations.
4. Use dynamic discovery for prefab selection; never add a permanent asset name list.
5. Return native results and entity ids for mutations.
6. Add a test for its advertisement or pure planning behavior.
7. Document parameters, returns, errors, and an example in `TOOLS.md`.

## Design constraints

- Planning code must remain deterministic and side-effect free.
- An unavailable feature is not a zero-valued feature.
- A successful HTTP response only proves the bridge accepted a request; post-build state, entity listings, and screenshots are the quality evidence.
- Avoid returning full ECS/prefab worlds in one response. Use bounds, filters, pagination, summaries, and raw-grid opt-ins.
- Version compatibility should be feature-probed. Do not branch on an assumed game build when the runtime can report the capability directly.
