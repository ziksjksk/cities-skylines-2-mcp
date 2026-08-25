# CS2MCP Autonomy — An MCP Server for Cities: Skylines II

**English** | [简体中文](README.CHS.md)

Give Claude (or any MCP client) structured, capability-gated control over a running Cities: Skylines II game: read city data, discover the active runtime prefab set, analyze terrain and bounded areas, plan hierarchical metropolitan layouts, preview and validate road/interchange geometry, build through the native game tool pipeline, stage detailing, run simulation checks, and report unsupported operations without pretending they succeeded.

## Current status

The repository now contains a real three-layer implementation:

- Perception: the existing ECS-backed city/terrain/GridMap/building/road/notification readers plus `cs2_capabilities`, `cs2_coordinate_info`, paged dynamic PrefabSystem discovery, map/area/city analysis, and explicit observability status.
- Construction: the existing main-thread bridge and native ToolBaseSystem/bulldozer paths, extended with compound road geometry, guarded highway/expressway/interchange execution, native 8m building-grid and road-access validation, native zoning definitions, district orchestration, runtime-discovered tree/prop/surface detailing, native terrain definitions, physical track segments, native transport-stop and station/depot placement, route creation/cardinality-changing mutation/deletion, stop binding, and readback.
- Planning: deterministic geometry validation, metropolitan master plans, district/TOD/transport proposals, city validation, native traffic diagnosis with an opt-in bounded parallel-road repair, and a guarded save/pause/build/validate/screenshot/resume loop.

The live bridge contract is authoritative. In this build, `tile_purchase` is wired through the native `MapTilePurchaseSystem` selection/economy path, `terraform` emits the game's native `ToolOutputBarrier` terrain definitions, `props`/`surfaces` use runtime prefab discovery plus native object/area definition paths, `object_transform` uses native `CreationDefinition(Relocate) + ObjectDefinition` with entity readback, utility observation uses native pipeline/power edges plus building connection components, and transport tools use native route/waypoint/object/network definitions. Save/load and rollback now use exact native save IDs; route mutation supports same-cardinality edits plus waypoint insertion/removal/deletion through the game's recreation path; `cs2_dispatch_transport_vehicle` emits the native transport request archetype and requires RouteVehicle readback before claiming dispatch success. Generic object recoloring remains an explicit capability boundary. Tunnel capability is probed from live `PlaceableNetData.m_UndergroundPrefab` records and is enabled only when the current runtime reports an unlocked tunnel-capable prefab; construction still requires the exact discovered prefab and post-build readback. The MCP tools return plan-only or structured failure responses for unsupported paths and never report a fake success.

> The original 44-tool baseline covers observe / build / tune / govern / time. The autonomy layer adds runtime-gated planning and execution tools; full live-game verification remains a required acceptance step for each installed game build.

The 2026-08-25 clean-save evidence completed a bounded autonomous cycle with `12` verified road segments, `4` districts, `4` successful zone groups, `8` native service placements/readbacks, `2` bus stops, `1` stop-bound bus line, and multi-angle screenshots. The same run queried native resources, wind, outside connections, road/traffic graph data, and transport analytics; a separate line-settings regression changed a live line to Night with interval `37`, unbunching `0.45`, and ticket price `11`, then confirmed both ECS and UI readback. A separate facility regression loaded a saved runtime city after a full game restart and read back one `BusStation02`, three integrated station platforms, and two `Pack7-BusDepot01` entities with available vehicles. A later larger probe reached `52` verified roads, `6` districts, `68` buildings, and `1191` zoning cells but correctly remained at population `0` with `198` notification rows; the strict utility-connectivity gate therefore does not claim that probe as a healthy metropolis. The autonomous cycle is intentionally bounded and must be expanded one verified phase at a time.

## Architecture

```
Claude Code / Claude Desktop (any MCP client)
      │  MCP (stdio)
      ▼
cs2-mcp  (mcp-server/, Node.js process)
      │  HTTP, localhost-only 127.0.0.1:8642
      ▼
CS2MCP bridge mod  (CS2MCP.Bridge/, inside the game process)
      │  all ECS reads/writes run on the simulation main thread
      ▼
Cities: Skylines II
```

- **In-game mod** (C#): runs a minimal HTTP server on a `TcpListener` bound to 127.0.0.1 inside the game process. Requests are queued by listener threads and executed on the simulation main thread by an ECS system registered at `SystemUpdatePhase.UIUpdate` (works while paused). Construction goes through a custom `ToolBaseSystem` using the game's native definition/validation/apply pipeline; demolition goes through the bulldozer pipeline — no entity mutations that bypass game validation.
- **MCP server** (TypeScript): translates MCP tool calls into HTTP requests against the bridge mod, over stdio transport.

## Requirements

- Windows + Cities: Skylines II (Steam)
- .NET SDK 8.0+ (to build the mod)
- Node.js 18+ (to run the MCP server)

## Build & Install

```powershell
# 1. Build the in-game mod (auto-deploys to the game's local Mods folder)
dotnet build CS2MCP.Bridge\CS2MCP.Bridge.csproj

# 2. Build the MCP server
cd mcp-server
npm install
npm run build
```

The mod deploys to `%USERPROFILE%\AppData\LocalLow\Colossal Order\Cities Skylines II\Mods\CS2MCP\` and loads automatically on game start — no Paradox Mods publishing required. To disable it temporarily, rename the folder to `.CS2MCP`.

### Game path configuration

Building the mod references assemblies from the game folder. Resolution order (first match wins):

1. Command line: `dotnet build -p:GamePath="X:\...\Cities Skylines II"`
2. **`CS2_PATH`** environment variable
3. `CSII_INSTALLATIONPATH` environment variable (set by the official modding toolchain)
4. Auto-probing of common Steam library locations (`C:\Program Files (x86)\Steam`, `Steam` / `SteamLibrary` on common drive letters)

If the game cannot be found the build fails with a clear error. Example:

```powershell
setx CS2_PATH "D:\Steam\steamapps\common\Cities Skylines II"
```

### Runtime environment variables (.env supported)

The MCP server loads `mcp-server/.env` via [dotenv](https://github.com/motdotla/dotenv) (see `.env.example`):

| Variable | Scope | Default | Description |
|---|---|---|---|
| `CS2_BRIDGE_URL` | MCP server | `http://127.0.0.1:8642` | Address of the bridge mod |
| `CS2MCP_PORT` | game process | `8642` | Bridge listen port (change both together) |
| `CS2_PATH` | build time | auto-probed | Game install folder |

## Using with Claude

**Claude Code**: [.mcp.json](.mcp.json) in the repository root registers the `cs2` server — just open Claude Code in the project directory (it asks for trust on first use). To register from another directory:

```powershell
claude mcp add cs2 -- node <repo-path>\mcp-server\dist\index.js
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "cs2": {
      "command": "node",
      "args": ["<repo-path>\\mcp-server\\dist\\index.js"]
    }
  }
}
```

Start the game, load a save, then ask Claude: "How are my city's finances?", "Zone a residential area by the river", "Build a road connecting the industrial area to the highway".

## Tool Reference

The original 44 observation/build/governance tools remain available. The autonomy layer adds capability discovery, map understanding, planning, validated geometry, staged detailing, validation, and execution tools. See [TOOLS.md](TOOLS.md) for the complete parameter/return/error reference.

**State & view**

| Tool | Description |
|---|---|
| `cs2_ping` | Bridge liveness, mod version, game mode (responds even while loading) |
| `cs2_game_state` | Mode, city name, pause/speed, in-game date & time |
| `cs2_city_overview` | Population, happiness, health, money, XP, date |
| `cs2_screenshot` | Current view as PNG (end-of-frame capture, default 1280px wide) |
| `cs2_get_camera` / `cs2_set_camera` | Camera read/write (pivot/angles/zoom) — combined with screenshots, the AI's own eyes |

**City data**

| Tool | Description |
|---|---|
| `cs2_demand` | RCI demand + demand factors (internal 0-255 scale; refreshes only while simulating) |
| `cs2_budget` | Budget breakdown: 14 income / 15 expense sources |
| `cs2_city_services` | Electricity, water & sewage, garbage status |
| `cs2_labor` | Employment, unemployment, jobs by education level, age structure |
| `cs2_statistics` | Time series for 60+ statistics (32 samples per in-game day) |
| `cs2_terrain` | Whole-map heightmap + water depth grid |
| `cs2_gridmap` | Native cell-map layers: land value, ground/air/noise pollution, ground water |
| `cs2_zoning` | Zoning summary (occupied/empty per zone type) |
| `cs2_notifications` | All in-world warning icons (no power/water, abandoned...) with target entities |
| `cs2_inspect` | Single-entity detail (residents/employees/status flags) |
| `cs2_query_resources` / `cs2_query_wind` | Native paged resource deposits and wind vector/magnitude observations; no inferred zeros |
| `cs2_query_outside_connections` | Native outside-connection nodes, prefab, position, and transfer metadata |
| `cs2_query_utilities` | Native water/sewage/power edge and building-connection observation with paging; placed lines are not assumed connected |

**Construction**

| Tool | Description |
|---|---|
| `cs2_find_prefabs` | Search runtime building/road/network/tree/prop/surface/terraform/brush prefabs by name |
| `cs2_place_building` | Place buildings through native validation, default 8m grid snapping, and prefab road-access rules; trees use the dedicated native tree helper |
| `cs2_place_prop` / `cs2_list_props` | Place runtime-discovered props or inspect generic static prop entities |
| `cs2_paint_surface` | Preview or paint a polygon using a runtime-discovered native surface prefab |
| `cs2_list_surfaces` | Read native painted surface entities and their polygons for post-construction verification |
| `cs2_build_road` | Any network segment or compound path: straight / Bezier / arc / spline / polyline; supports `start/end`, `controlPoints[]`, `points[]`, `elevation`, `startElevation`, `endElevation`, `targetSlope`, and `parallelOffset`, with the native validator as the final road/grid-rule authority |
| `cs2_build_utility_network` | Runtime-discovered water, sewage, combined-pipe, or electricity network plan/build with edge and notification readback |
| `cs2_build_track` / `cs2_build_greenway` | Native physical track or runtime-discovered pedestrian-path construction with per-segment readback |
| `cs2_upgrade_road` | Road upgrades: grass/trees/wide sidewalk/sound barrier/parking/lighting/median |
| `cs2_zone_area` / `cs2_list_zones` | Paint or clear zoning through the native zoning tool/grid and list zone types |
| `cs2_demolish` | Demolish buildings/segments/trees/districts through the bulldozer pipeline and verify entity absence |
| `cs2_list_buildings` / `cs2_list_roads` / `cs2_list_objects` | Entity listings (ids, coordinates) |
| `cs2_move_object` / `cs2_rotate_object` / `cs2_copy_object` | Native object transform/copy operations with entity readback; `cs2_recolor_object` is explicit plan-only when the game exposes no generic color definition |

**Autonomy & transit**

| Tool | Description |
|---|---|
| `cs2_analyze_map` | Terrain/environment/road/transport summary with observed-vs-unavailable status |
| `cs2_analyze_city` | Combined overview, demand, finance, services, labor, zoning, notifications, terrain, roads, utilities, and transport snapshot |
| `cs2_build_district` / `cs2_build_greenway` | Execute the corresponding native district/path plan and return construction readback |
| `cs2_list_tiles` / `cs2_purchase_tile` / `cs2_purchase_tiles` | Paged tile catalog and native single/batch purchase wrappers |
| `cs2_transport_analysis` | Native station, depot, stop, route-binding, waiting-passenger, vehicle-timing, and line-settings readback |
| `cs2_set_transport_line_settings` | Preview/apply line name, day/night/inactive schedule, active state, interval, unbunching, and ticket price with deferred ECS/UI verification |
| `cs2_run_autonomous_city_cycle` | Bounded observe → plan → native build → simulate → repair → validate cycle with saves, screenshots, and quality gates |

**Finance & policy**

| Tool | Description |
|---|---|
| `cs2_get_taxes` / `cs2_set_tax` | Tax rates for the four zone classes (clamped to game limits) |
| `cs2_policies` / `cs2_set_policy` | City policies (with localized names) |
| `cs2_service_budgets` / `cs2_set_service_budget` | Per-service budget sliders 50-150% |
| `cs2_get_fees` / `cs2_set_fee` | Service fees (electricity/water/healthcare/education...) |
| `cs2_get_loan` / `cs2_set_loan` | Borrow / repay loans |
| `cs2_list_districts` / `cs2_create_district` | List districts / draw a district polygon |
| `cs2_district_policies` / `cs2_set_district_policy` | District policies |
| `cs2_tiles_info` | Owned map tiles / upkeep info |

**Time & meta**

| Tool | Description |
|---|---|
| `cs2_set_simulation` | Pause / set speed (0-8) |
| `cs2_run_simulation` | Timed run: simulate N in-game hours, then auto-pause |
| `cs2_save_game` | Trigger a save (recommended before large AI operations) |

## Troubleshooting

- **`cs2_ping` unreachable**: the mod is not loaded. Check `%USERPROFILE%\AppData\LocalLow\Colossal Order\Cities Skylines II\Logs\CS2MCP.log` (should contain `bridge listening on ...`); if the file is missing, check `Player.log` in the same folder.
- **409 no city loaded**: still in the main menu — load a save first.
- **Lock states look wrong**: unpause briefly once after loading (lock-related endpoints return a `stalenessWarning` until the simulation has ticked).
- **Port conflict**: set `CS2MCP_PORT` for the game process and update `CS2_BRIDGE_URL` in `.env` to match.

## Known limitations

- Map tile purchasing and terrain operations use native game data/tool-definition paths. Terrain mutation is verified on CS2 1.6.0f1 with raw height readback and a screenshot; repeat the smoke test after a game update.
- Surface painting and arbitrary prop placement are implemented through runtime-discovered prefabs and native definition pipelines. Prop variants may resolve to a concrete prefab (for example `GardenBenchRandom01` can materialize as `GardenBench02`); verify with `cs2_list_props`/`cs2_inspect`.
- Live object relocation is available through `cs2_transform_object` for entities exposing `Transform + PrefabRef`; it is dry-run-first and requires entity-position readback. Road edges remain on native network mutation paths.
 - Native transport station/depot placement is implemented and verified through live readback after a game restart. Exact save load/rollback and waypoint insertion/removal are implemented through native IDs and route recreation; native per-vehicle dispatch now uses the game's transport request/pathfind pipeline and `cs2_dispatch_transport_vehicle` reports success only after RouteVehicle readback. A fresh post-rebuild game-session check remains the final acceptance step after source changes; station/depot route attachment and generic object recoloring remain explicit capability boundaries in the installed runtime. Tunnel support is runtime-gated: `/capabilities` scans unlocked `PlaceableNetData.m_UndergroundPrefab` references and only reports `tunnels:true` when the loaded game exposes one; use `cs2_discover_assets` and verify the resulting underground network before claiming a tunnel. Bus stops, stop-to-route binding, physical track-segment construction, route modification/deletion, line schedule/settings mutation, read-only line analytics, and the native road/traffic graph are implemented through native paths and return explicit readback status.
- Utility construction and utility observation are separate contracts: `/city/utilities` exposes native edge/building-connection readback and the autonomous cycle records notification deltas. A placed pipe or power line is not reported as healthy connectivity unless the native graph/notification evidence supports that conclusion.
- Ramps can only connect at segment endpoints (nodes); mid-segment smooth merges are not supported yet
- Screenshots capture the game's current rendering: with a road-tool panel open the game renders roads in white outline mode

These are capability-state facts, not hidden assumptions. Additions must first extend the native bridge and its tests, then flip the corresponding capability only after in-game verification.

## Advanced quick start

```text
1. cs2_ping
2. cs2_capabilities
3. cs2_coordinate_info
4. cs2_discover_assets(category="road")
5. cs2_analyze_map(includeEnvironment=true) and cs2_query_utilities
6. cs2_plan_metropolis
7. inspect the returned plan; use preview/dryRun tools first
8. cs2_run_autonomous_city_cycle(execute=false) to inspect the complete bounded cycle
9. cs2_run_autonomous_city_cycle(execute=true, maxSegments=bounded value, runSimulationHours=non-zero)
10. cs2_validate_city(includeScreenshots=true) and inspect utility notifications before expanding
```

Do not skip the capability and validation calls. The planner is designed to distinguish “the game says zero” from “the bridge cannot observe this subsystem.”

## Disclaimer & Credits

- This is an unofficial community mod, not affiliated with Colossal Order or Paradox Interactive.
- `CS2MCP.Bridge/CreateDefinitions.cs` is ported from [LineTool-CS2](https://github.com/algernon-A/LineTool-CS2) (Apache-2.0, © algernon) and contains portions derived from decompiled game code, subject to the Paradox Interactive User Agreement.
- Thanks to the CS2 modding community — the public code of LineTool, InfoLoom, Traffic, unity-mcp and others made this project possible.

## License

[Apache-2.0](LICENSE)

