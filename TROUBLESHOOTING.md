# Troubleshooting

## `cs2_ping` cannot reach the bridge

Check all of these without changing the system proxy:

```powershell
Get-Process -Name Cities2 -ErrorAction SilentlyContinue
Test-NetConnection 127.0.0.1 -Port 8642
Get-ChildItem "$env:LOCALAPPDATA\Colossal Order\Cities Skylines II\Logs" -Filter "*CS2MCP*"
```

If the game is not running, start it and enable the local `CS2MCP` code mod. If the port is changed, set `CS2MCP_PORT` for the game and `CS2_BRIDGE_URL` for the MCP server to the same value. The listener is deliberately bound to `127.0.0.1`.

## Ping works but city tools return HTTP 409

The mod is loaded but the game is in the main menu/editor or the save is still loading. Wait for the city to finish loading, then call `cs2_game_state` and retry. Some lock flags are stale until the simulation has advanced at least one frame.

## C# says no SDKs are found

The machine may have a runtime-only `dotnet.exe` earlier on PATH. Check:

```powershell
& "$env:USERPROFILE\.dotnet\dotnet.exe" --list-sdks
```

If it reports the installed SDK, invoke that executable explicitly or install a standard .NET SDK. Do not treat a runtime-only installation as a compiler.

## C# reference or game path errors

Pass the exact install folder:

```powershell
& "$env:USERPROFILE\.dotnet\dotnet.exe" build ".\CS2MCP.Bridge\CS2MCP.Bridge.csproj" `
  -p:GamePath="D:\steam\steamapps\common\Cities Skylines II" `
  -p:SkipDeploy=true
```

The required file is `Cities2_Data\Managed\Game.dll`. If the game updates, recompile against the new assemblies and treat every previously enabled capability as needing a fresh smoke test.

## `npm ci` fails with `ECONNRESET`

The development machine had a failing mirror configured for some tarballs. Use a command-local registry override; this does not modify the global npm or proxy configuration:

```powershell
npm ci --registry=https://registry.npmjs.org/ --fetch-retries=5 --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=15000 --no-audit
```

Then run `npm test`.

## A dynamic prefab query returns no candidate

The runtime may be in the menu, all matches may be locked, or the query was too specific. Call `cs2_discover_assets({category:"road",pageSize:200})`, inspect `locked`/`available`, and pass the exact returned `name`. Do not invent an asset name or add it to a hard-coded list.

## A road or interchange plan is rejected

Inspect `plan.issues`. `segment_too_short`, `outside_map_bounds`, and native validation errors are blocking; `slope_too_steep` is a warning in the planner but may still be rejected by the game. Increase the horizontal run, add a control point, choose a compatible discovered prefab, or keep the design in preview mode. The current bridge supports endpoint connections, not arbitrary mid-segment merges.

## Advanced tool reports an unavailable capability

This is intentional. The current bridge contract reports `tile_purchase`, `terraform`, `surfaces`, `props`, native transport route-line creation/readback, same-cardinality and cardinality-changing route mutation/deletion, stop binding, native station/depot placement, native exact-save rollback, read-only line analytics, line settings, native vehicle dispatch requests, native resources/wind/outside-connection observation, and live object relocation as available. A fresh user-directed game session is still required to recheck the latest source-only rollback, waypoint insertion/removal, and vehicle-dispatch branches. Tunnel support is reported separately and is true only when the live runtime exposes an unlocked `PlaceableNetData.m_UndergroundPrefab`; otherwise keep the request in preview and do not infer a tunnel from negative elevation. For tile purchase, call `cs2_tiles_info` with details, preview with `dryRun:true`, and use the returned entity ID or coordinate. For terraforming, preview first, execute once, sample `/city/terrain/sample` before and after the native request, and capture a screenshot. For props, query the exact runtime prefab first and verify the concrete placed variant with `cs2_list_props`/`cs2_inspect`; randomized prefab names may resolve to a concrete variant. For surfaces, use `cs2_paint_surface` dry-run first and verify the resulting area with `cs2_list_surfaces` and visually. For route lines, use `cs2_create_transport_line` with route waypoints, then use `cs2_modify_transport_line` or `cs2_delete_transport_line` with the live `{index,version}` and verify coordinate/binding readback or entity absence; use `cs2_set_transport_line_settings` for schedule/name/interval/unbunching/ticket changes, `cs2_dispatch_transport_vehicle` for native vehicle requests, and `cs2_transport_analysis` for native line analytics. A dispatch request is only a queue acknowledgement until RouteVehicle count/entity readback confirms an additional vehicle; station/depot attachment to a route remains separate. Physical track construction is a separate capability-gated native path. For object relocation, use `cs2_transform_object` with the `{index,version}` returned by `cs2_list_props`/`cs2_query_entities`, dry-run first, and require the returned entity readback to match the target position. For the remaining capabilities, continue with a plan-only response or implement the native bridge capability first. Do not bypass the contract with direct ECS mutation.

## Master-plan execution fails partway through

The operation is bounded but native changes before the failure may already be committed. The tool pauses the simulation, returns `executedRoads`/`executedDistricts`, and attempts a native rollback against the exact preflight save. Inspect `rollback.success`, `rollback.verification`, and `/state` before issuing another mutation. If rollback fails or no checkpoint was created, save the evidence, inspect the partial city, repair or demolish by returned entity id, and rerun a smaller preview.

## Screenshots look like white road outlines

The game may still have a road tool panel active. Close the tool UI, set the camera explicitly, wait for a frame, and capture again. A screenshot is visual evidence, not a substitute for ECS/entity/traffic/service readings.
