"jhÆ–•ã•Fä-zW¶z{b≤h¨≤)‡"{⁄ñ'N•Í⁄∂*'"w^∆ä^≠´b¢w⁄äWù∂öÆ∂≤äw^≈Î⁄ñÊ≠y€hûÈe"{⁄ñ'N•Í⁄∂*'"w^∆ä^≠´b¢w⁄äWù∂öÆ∂≤äw^≈Î⁄ñÊ≠y€hûÈe# Verification record

> Scope note: the runtime entries below are historical game-session evidence collected before the final source-only contract tightening in this workspace. The current source now exposes native cardinality-changing route mutation, exact-save rollback, native zoning, building-grid snapping, road-access preflight, and verified low-level district/demolish wrappers. Per the current task direction, no new game session is being started here; use `/capabilities` after the next user-directed restart as the final runtime authority.

## Reproducible checks completed

The following commands were run in the development workspace on 2026-08-24:

```powershell
Set-Location "C:\Users\zlyexn\Documents\Codex\2026-08-24\v\work\cs2-autonomy\mcp-server"
npm test
```

Result: TypeScript compiled; ten tests passed and one opt-in live-game test was skipped (`CS2_INTEGRATION` was not set):

- long-road splitting preserves the endpoint;
- steep elevation produces a structured issue;
- terrain summary distinguishes wet/flat/buildable cells;
- interchange preview returns footprint and ramp roles;
- metropolitan plan includes corridors/districts without fixed asset names;
- the built MCP server completes initialize/tools-list and advertises advanced tools plus the engineering road schema;
- native source contracts cover grid/access/zoning/entity/surface, dynamic tunnel probing, road-upgrade, traffic-repair, and terrain-sampling paths;
- the pure road-graph summary derives junction/dead-end/traffic-signal candidates while preserving paged scope;
- JSON serialization preserves road and metropolitan plan payloads;
- a fake localhost bridge receives `/ping` and `/capabilities` through the real MCP stdio process.

The optional `tests/game-integration.test.mjs` is intentionally skipped by default. Set `CS2_INTEGRATION=1` only with a running game and loaded city; it performs an MCP `cs2_ping` smoke check and is not run in this source-only pass.

The Bridge was built with:

```powershell
& "C:\Users\zlyexn\.dotnet\dotnet.exe" build ".\CS2MCP.Bridge\CS2MCP.Bridge.csproj" `
  -p:GamePath="D:\steam\steamapps\common\Cities Skylines II" `
  -p:SkipDeploy=true
```

Result: `CS2MCP.Bridge -> ...\CS2MCP.dll`, 0 warnings, 0 errors. A deployment build then copied the same project output to the local CS2 Mods directory.

## Runtime checks completed

On 2026-08-24 the installed Steam build was launched with Computer Use, a fresh Ribbon Isles city was created, and the deployed mod was exercised through `http://127.0.0.1:8642`. The game reported `1.6.0f1`; the bridge reported `gameMode=Game` and `isLoading=false` after the city finished loading.

Observed runtime evidence:

- `/ping` returned `{ok:true, mod:"CS2MCP", version:"0.9.0", gameMode:"Game", isLoading:false}`.
- `/prefabs?category=prop&query=GardenBench` returned five live `StaticObjectPrefab` entries, including `GardenBenchRandom01` and `GardenBench01`‚Äì`04`.
- `/build/prop?...&dryRun=true` returned a preview with terrain-sampled `y=478.8198` and emitted no definition.
- The committed prop operation returned HTTP 200. The game resolved the randomized request `GardenBenchRandom01` to `GardenBench02`; `/city/props?x=800&z=700&radius=250` returned entity `59690:25` at `(800,478.8198,700)`, and `/entity/inspect?index=59690&version=25` returned the same prefab/position.
- `/prefabs?category=surface&query=Grass` returned live `SurfacePrefab` entries, including `TRL Grass Surface`. Surface dry-run returned a four-node polygon preview; the committed call returned `created:true`. The visual result is recorded in [`surface-prop-city.png`](../runtime-evidence/surface-prop-city.png).
- A native `/terraform?operation=raise` call returned the `ToolOutputBarrier -> CreationDefinition + BrushDefinition` path. Comparing `resolution=256&raw=true` height grids five seconds later found 3 changed samples with a maximum absolute delta of `3.234436m`; [`after-terrain.png`](../runtime-evidence/after-terrain.png) shows the raised strip.
- Earlier in the same installed build, native road placement returned `placed:true` and `/city/roads` showed the added `Small Road` edges; the resulting view is recorded in [`after-road-prop.png`](../runtime-evidence/after-road-prop.png).

These checks prove real bridge-to-game behavior for the listed paths. They do not prove a completed large populated autonomous metropolis. The historical session did not exercise the later cardinality-changing waypoint and rollback source paths; those paths are now implemented through native definitions and capability-gated readback, but require a fresh user-directed game-session check. Native resources, wind, outside connections, line settings, and read-only transport analytics are covered by the final clean-save checks below. Native station/depot placement is covered by the separate post-restart facility regression recorded below.

On 2026-08-25, after restarting the rebuilt bridge and loading the saved `CS2MCP route integration checkpoint`, the transport route adapter was also exercised:

- `/transport/prefabs?limit=50` returned ten live `TransportLinePrefab` records, including `Bus Line` (`178:1`).
- A three-point bus dry-run returned a terrain-sampled preview and did not emit a route definition.
- The matching execution returned `queued:true` with the native `CreationDefinition + WaypointDefinition -> GenerateWaypointsSystem -> GenerateRoutesSystem -> ApplyRoutesSystem` path.
- The same operation was then exercised through MCP stdio with `cs2_create_transport_line({mode:"bus",execute:true})`; after the final post-restart deployment its readback returned route entity `62461:3`, prefab `Bus Line`, `ticketPrice:8`, `waypointCount:3`, `segmentCount:3`, and three live waypoint entities (`62423:5`, `62456:3`, `62457:3`).

This is a real line-creation/readback check, not a planned-only response. Native bus-stop placement and stop-to-route binding were verified in a later MCP cycle; station/depot line attachment and physical track attachment remain separate scopes. The current source also exposes cardinality-changing waypoint insertion/removal through native route recreation; that newer path is not re-run in this historical record. Line schedule/settings and read-only analytics are exposed through `cs2_set_transport_line_settings` and `cs2_transport_analysis` and are covered by the final clean-save evidence below.

The rebuilt bridge was then restarted again and the clean `CS2MCP route mutation verified` save was loaded. The live `/capabilities` response reported `transit_line_mutation:true`. A fresh MCP stdio client performed a disposable route mutation cycle:

- `cs2_create_transport_line({mode:"bus",execute:true})` selected the runtime `Bus Line` prefab and created route entity `174625:3`.
- `cs2_modify_transport_line` dry-run returned a native preview; execute changed the third point from `x=645.1286` to `x=745.1286` while preserving three waypoints. The MCP response returned `success:true`, `verification.status:"readback"`, `verification.positionMatches:true`, and `pointCount:3`.
- `cs2_delete_transport_line` dry-run returned a native delete preview; execute returned `success:true`, `deleted:true`, and `verification.status:"absent"`. A final list returned three routes and no entity `174625:3`.

This proves same-cardinality native route modification and deletion through MCP stdio plus live readback. It does not prove station/depot line attachment. The current source extends the same native recreation path to waypoint insertion/removal; that cardinality-changing branch was added after this historical check and remains pending a fresh user-directed runtime recheck. Line settings and analytics are separate native tools rather than part of this mutation call.

On 2026-08-25, the rebuilt bridge was loaded into the near-empty `CS2MCP Runtime Test 20260824` save. One `cs2_run_autonomous_city_cycle` MCP call with dynamic prefab discovery, `maxSegments:3`, `maxDistricts:1`, `runSimulationHours:0.02`, two screenshot views, and `resume:false` returned `success:true`. The readbacks were `verifiedRoads:3`, `successfulDistricts:1`, `successfulZones:1`, two native bus stops, one stop-bound bus line, service-stage results, landscape-stage results, native road-graph and transport-analysis observations, two successful named saves (`preflight`, `final`), and a paused final state. The initial zoning stage was repaired by the revision loop before the final quality gate passed. A highway/arterial native rejection was handled by retrying only unverified segments with a dynamically discovered ordinary road; the road gate still required all three bounded segments to read back.

The final strengthened run was performed after fixing the transit candidate strategy exposed by the first run. The executor now tries multiple separated live road/transport anchors and only proceeds to line creation after two stops have individually read back. On the clean save, the final response reported `success:true` and all ten quality gates as `true`: `roadReadback`, `districtReadback`, `zoningReadback`, `services`, `transit`, `landscape`, `simulation`, `multiAngleScreenshots`, `nativeTrafficObservation`, and `nativeTransportObservation`. The accepted stops were entities `67745:55` and `67832:57`; the created `Bus Line` was entity `58138:13`, and both waypoint connections read back with `connectionIsTransportStop:true`. `/transport/analysis` reported two active stops, each with one connected route waypoint. The preflight and final named saves both returned `saveOk:true` (`CS2MCP autonomous preflight 2026-08-25T00-31-18-774Z` and `CS2MCP autonomous final 2026-08-25T00-32-15-074Z`). The final screenshot is [`autonomous-cycle-final-live.png`](../../outputs/autonomous-cycle-final-live.png). This remains a bounded near-empty-save acceptance run, not proof of growth into a large populated metropolis.

That earlier `3`-segment/`1`-district run is retained as the first strengthened-cycle record. It was superseded by the final clean-save run below after the autonomous driver was expanded to exercise the complete currently supported bounded scope.

### Final clean near-empty autonomous cycle and native environment/settings checks

On 2026-08-25, the game UI loaded the near-empty `CS2MCP Runtime Test 20260824` save after the bridge rebuild. `/ping` then returned `ok:true`, `gameMode:"Game"`, `isLoading:false`; `/state` returned `cityLoaded:true`, city `ÁßëÊûóÂä†`, `paused:false`, and date `2026-01-01 09:05` before the cycle began. The MCP autonomous driver [`autonomous-growth-live.mjs`](../outputs/autonomous-growth-live.mjs) completed a real execute-mode cycle and wrote the full response to [`autonomous-growth-live.json`](../outputs/autonomous-growth-live.json).

The final artifact reported `success:true` at both the wrapper and cycle level, with:

- `plannedSegments:12` and `verifiedRoads:12`;
- `plannedDistricts:4`, `successfulDistricts:4`, and `successfulZones:4`;
- eight native service placements with placement/readback verification: `WindTurbine03` (`57831:13`), `GroundwaterPumpingStation01` (`61742:55`), `SewageOutlet01` (`61972:55`), `Landfill01 Hazardous Waste Collection Point` (`64335:27`), `MedicalClinic02` (`67131:21`), `EE_FireStation02` (`74986:9`), `PoliceStation01` (`213210:25`), and `ElementarySchool03` (`214141:35`);
- two native bus stops, one bound `Bus Line` route (`220975:7`), and binding readback for stop entities `220967:5` and `220970:7`;
- successful landscape and non-zero simulation stages, three validation screenshots, and all ten quality gates set to `true`;
- successful asynchronous named saves `CS2MCP autonomous preflight 2026-08-25T05-32-13-742Z` and `CS2MCP autonomous final 2026-08-25T05-33-07-850Z`.

Validation retained one active-notifications warning with count `78` and recommended inspecting the warnings before expanding the build. That warning is diagnostic output, not a hidden success claim. The run is a bounded native integration acceptance test; it does not claim that the save has already grown into a large populated metropolis.

The same live session verified the newly exposed environment readers. `/city/resources?resolution=8&page=0&pageSize=64` returned `64` cells from `Game.Simulation.NaturalResourceSystem.m_Map`, with `50` non-zero cells; the sampled averages were fertility `319.078125`, oil `2036.234375`, ore `1796.609375`, and fish `5854.3125`. `/city/wind?resolution=8&page=0&pageSize=64` returned `64` cells from `Game.Simulation.WindSystem.m_Map`, with average magnitude `0.3286866795`, maximum magnitude `0.682608068`, and constant wind vector `(0.275,0.275)`. `/city/outside-connections?limit=50` returned `10` native `Game.Net.OutsideConnection + Game.Net.Node` rows; the first was `Medium Seaway`, entity `60373:1`, at approximately `(1236.8994,470.4783,-7271.25)`. These are observed native values, not terrain- or pollution-derived estimates.

The live line-settings regression used route `220975:7` and applied Night schedule, active state, interval `37`, unbunching factor `0.45`, and ticket price `11`. The bridge returned `success:true`; deferred verification reported `componentMatches:true` and `uiMatches:true`, and the next transport-analysis readback matched the same native values. Line analytics also read back connected stop count `2`, waiting passengers, vehicle timing, and native schedule/interval/ticket fields.

The facility path was then tested separately after the game was fully restarted. The saved `CS2MCP facility verified baseline 2026-08-25` loaded into a live city, and the bridge reported `transport_facility_placement:true`. `/transport/analysis?x=1500&z=4432&radius=260&limit=500` read back one `BusStation02`, three integrated bus stops, five depots in total, and two root `Pack7-BusDepot01` entities. The two root depots were at `(1600,478.5159,4432)` and `(1400,479.1524,4432)` and each reported `HasAvailableVehicles` with `availableVehicles:4`; `/city/buildings?query=Pack7-BusDepot01&limit=20` returned exactly those two roots. The reloaded screenshot is [`facility-regression-reloaded.png`](../../outputs/facility-regression-reloaded.png). This verifies native station/depot placement plus persistence/readback; line settings and read-only analytics are covered by the separate native transport regression. The native per-vehicle dispatch endpoint was added after this historical session and still requires a fresh runtime request/readback check.

The same loaded city then received a fresh `Small Road` anchor through the bridge, followed by a real MCP stdio facility call. `cs2_place_station` with exact `BusStation02` at `(1850,4424)` returned `success:true`, `verification.status:"readback"`, and entity `65947:3`; `cs2_place_depot` with exact `Pack7-BusDepot01` at `(2150,4432)` returned `success:true`, `verification.status:"readback"`, and entity `71923:5`. A subsequent `cs2_transport_analysis` call returned one station, four depots, and three integrated station stops around the anchor. The MCP driver is [`mcp-facility-verify.mjs`](../../outputs/mcp-facility-verify.mjs), the screenshot is [`mcp-facility-verify.png`](../../outputs/mcp-facility-verify.png), and the paused checkpoint save was requested as `CS2MCP MCP facility final 2026-08-25`.

The same fresh checkpoint session then verified object relocation through MCP stdio. A runtime `GardenBenchRandom01` placement resolved to `GardenBench04`, entity `62304:9`, at `(1100,465.6057,4500)`. `cs2_transform_object` dry-run previewed `(1150,465.6057,4500)` with 45-degree yaw; the matching MCP execution returned the native `CreationDefinition(Relocate) + ObjectDefinition` request and `verification.positionMatches:true`. `/entity/inspect?index=62304&version=9` and `/city/props?x=1150&z=4500&radius=40` both read the entity at the target position, while the old-position query returned zero matches.

## Read-only Game.dll API audit

Because the attempted launch failed before the mod listener became available, the installed `Cities2_Data\Managed\Game.dll` was inspected without modifying the game directory. `AssemblyName.GetAssemblyName` identified it as a CLR assembly (`Game, Version=0.0.0.0`). The assembly contains the following relevant types:

| Area | Observed type/API surface | Engineering interpretation |
|---|---|---|
| Terraforming | `Game.Tools.TerrainToolSystem`, `GenerateBrushesSystem`, `ApplyBrushesSystem`, and `BrushDefinition` were inspected and then exercised through the bridge | Native `CreationDefinition`/`BrushDefinition` emission and a measurable heightmap delta were verified in CS2 1.6.0f1 |
| Tile purchase | `Game.Simulation.MapTilePurchaseSystem` exposes `PurchaseSelection()` and static `UnlockTile(EntityManager, Entity)`; bridge emits `SelectionInfo`/`SelectionElement` | Native adapter is implemented; purchase should still be rechecked in a city with an unowned, affordable tile |
| Transport | `Game.Routes.TransportLine` and `Game.Routes.TransportStop` are ECS data structs; `RouteToolSystem`/`GenerateWaypointsSystem`/`GenerateRoutesSystem`/`ApplyRoutesSystem` form the native route pipeline; `UITransportLineData` and `VehicleTiming` expose native settings/analytics; `TransportLineSystem` exposes the native vehicle-request archetype consumed by the pathfind/dispatch systems | Native route creation, same-cardinality and cardinality-changing modification/deletion, live `Route + TransportLine`/waypoint readback, stop binding, line settings, waiting-passenger/vehicle-timing analytics, stations/depots, track courses, and the source-level vehicle-request endpoint are implemented; historical runtime evidence covers the former same-cardinality branch, while the latest cardinality-changing and vehicle-dispatch branches await a fresh session |
| Map tiles | `Game.Areas.MapTileSystem` owns tile generation and ownership-related systems | A tile adapter still needs game-version-specific ECS component/entity contracts and in-game validation |
| Water/surfaces | `Game.Simulation.SurfaceDataReader`, `Game.Areas.Surface*System`, and runtime `SurfacePrefab` query | Four-node surface area creation and a visible painted rectangle were verified; list/readback endpoint for surface entities is still a future improvement |

The audit also found no installed command-line decompiler (`ilspycmd`, `diec`, `dnSpy`, `dnSpyEx`, or `ildasm`) in the current shell. The conclusions above therefore use CLR metadata and reflection only; they are not a decompilation-based proof of stable modding contracts.

## Acceptance matrix

| Requirement family | Evidence | Status |
|---|---|---|
| Existing perception/build/governance | baseline C# build plus live bridge/game calls | implemented; core runtime paths exercised |
| Main-thread safety | `BridgeSystem` queue and `OnUpdate`; native prop/surface/terrain calls completed | implemented; runtime exercised |
| Dynamic Prefab discovery | `/prefabs` category pagination returned live prop/surface assets | implemented and runtime verified |
| Capability API | `/capabilities` and `cs2_capabilities` | implemented; final deployed build reports verified prop/surface/terrain/transport-line mutation, line settings/analytics, resource/wind/outside-connection, and object-transform state |
| Coordinate contract | `/coordinate/info` and `cs2_coordinate_info` | implemented; runtime endpoint available |
| Map/area/city analysis | MCP orchestration over live endpoints | implemented; broad coverage still needs per-feature regression |
| Road geometry | pure geometry tests + native adapter | implemented in code; native road placement previously verified; interchange traffic quality pending |
| Interchange planning | pure planner tests + native adapter | implemented in code; visual/traffic quality pending |
| Transit line creation/readback | runtime `TransportLinePrefab` discovery, native route-definition emission, and live `Route + TransportLine`/waypoint readback | implemented; bus route verified |
| Transit line mutation/deletion | native `CreationDefinition(m_Original route, optional Recreate)` plus `WaypointDefinition(m_Original waypoint/null)` update/insert/remove/delete path; MCP dry-run/execute and readback | implemented in current source; same-cardinality modify/delete verified historically, cardinality-changing branch pending fresh runtime recheck |
| Transit stops and route binding | native `ObjectToolBaseSystem` stop placement plus `WaypointDefinition.m_Connection` route binding; MCP readback in the bounded cycle | implemented and verified for bus stops/route binding |
| Transit stations and depots | native `ObjectToolBaseSystem` placement anchored through `ControlPoint.m_OriginalEntity`/curve position; post-restart `BusStation02` and `Pack7-BusDepot01` readback | implemented and verified on CS2 1.6.0f1 |
| Transport settings and analytics | native `UITransportLineData`, `VehicleTiming`, `WaitingPassengers`, and deferred main-thread UI/component readback | implemented and verified; Night schedule, interval, unbunching, ticket price, active state, connected stops, and waiting/timing fields read back |
| Natural resources, wind, outside connections | native `NaturalResourceSystem.m_Map`, `WindSystem.m_Map`, and `OutsideConnection + Node` readers with paging/bounds | implemented and verified; observed values are returned only when the native layer is available |
| Physical track mutation | runtime TrackPrefab discovery plus native network definition/readback path | capability true and physical segment path exercised; station/route attachment remains separate |
| Terraforming | runtime-discovered `TerraformingPrefab`/`BrushPrefab`, native `CreationDefinition` + `BrushDefinition` emission through `ToolOutputBarrier`, dry-run, raw height readback, screenshot | implemented; live delta verified |
| Tile purchasing | native `SelectionInfo`/`SelectionElement` adapter, paged tile descriptors, dry-run and economy-gated purchase endpoint | implemented in code; live purchase on an unowned tile still needs a dedicated affordable-tile test |
| Props/surfaces | runtime prefab discovery, dry-run, native object/area definitions, entity/visual readback | implemented; fresh-city runtime verified |
| Object relocation | native `CreationDefinition(Relocate) + ObjectDefinition`, MCP dry-run/execute, entity readback, old/new spatial queries | implemented; `GardenBench04` entity `62304:9` moved and read back in the installed game |
| Full road/traffic graph | native edge/node/curve/sublane graph and traffic-flow observations through `/road/graph`; optimizer remains proposal-only | implemented for read-only graph observation; repair automation remains bounded/proposal-only |
| Save rollback | native exact save IDs, `/game/load`, `/game/rollback`, post-load `/state` verification, and paused-on-failure orchestration | implemented in current source; the historical capability snapshot predates it, so fresh runtime recheck is still required |
| Autonomous blank-to-metropolis run | bounded roads, services, zoning, transit, simulation, repair, visual quality, saves, and readback | final clean near-empty cycle verified at 12 roads/4 districts/4 zones with all ten gates and eight service readbacks; large populated-metropolis growth acceptance remains open |

## Correct interpretation

‚ÄúImplemented in code‚Äù means the source compiles and the non-game planner/protocol tests pass. It does not mean the installed game accepted every prefab, every terrain grade, or every generated road. Use the runtime acceptance procedure in `INSTALL.md` and `AUTONOMOUS_CITY_AGENT.md` before treating a build as a finished city controller.
