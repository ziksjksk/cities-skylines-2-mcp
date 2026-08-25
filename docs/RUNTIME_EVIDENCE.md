# CS2MCP Runtime Evidence

This report records historical local runtime checks for the CS2MCP autonomy bridge. It is intentionally split between operations that were executed in a disposable city and the final post-restart contract check, which includes bounded native executions with entity readback as well as dry-run requests.

> Current-source note: the workspace now contains additional native paths for cardinality-changing route mutation, exact-save rollback, native zoning, 8m building-grid placement, road-access preflight, and low-level district/demolish readback. The contract snapshot and claims below were captured before those final source-only changes. No new game session is started during the current implementation pass; the next user-directed restart should treat `/capabilities` and live readback as authoritative.

## Environment

- Game: Cities: Skylines II `1.6.0f1` from `D:\steam\steamapps\common\Cities Skylines II`
- Unity: `2022.3.71f1`
- Bridge: `CS2MCP` `0.9.0`
- Endpoint: `http://127.0.0.1:8642`
- Test map: Ribbon Isles; disposable test cities were created with normal mode, all unlocks, and unlocked map tiles.
- The bridge was rebuilt against the installed game and deployed to the local `Mods\CS2MCP` directory before the final restart check.

## Final post-restart contract check

After the final bridge rebuild, restarting the game through Steam and the Paradox launcher, loading the saved `CS2MCP route integration checkpoint`, and waiting for the simulation to finish loading, `/ping` returned:

```json
{"ok":true,"mod":"CS2MCP","version":"0.9.0","gameMode":"Game","isLoading":false}
```

The live `/capabilities` response reported:

- `roads`, `curved_roads`, `elevated_roads`, `bridges`, `buildings`, `zones`, `districts`, `trees`, `economy`, `policies`, `simulation`, `screenshots`, `save_game`: `true`
- `props`, `surfaces`, `terraform`, `tile_purchase`, `dynamic_prefab_discovery`, `entity_inspection`, `road_entity_listing`: `true`
- `transit_lines`: `true`
- `transit_line_mutation`: `true`
- `transit_stops`, `transit_stop_attachment`, `road_graph`, `transport_analysis`, `track_construction`: `true`
- `transit_line_settings`, `transport_analytics`, `natural_resources`, `wind_observation`, `outside_connections`: `true`
- `transport_facility_placement`: `true`
- `rollback`: `false` in this historical pre-rollback contract snapshot; current source advertises a capability-gated native rollback path that still needs a fresh session check.
- `object_transform`: `true`
- `tunnels`: `false` in this historical runtime snapshot; current source probes live unlocked `PlaceableNetData.m_UndergroundPrefab` references and may report a different value after a fresh game session

The same post-restart session returned successful dry-run previews for:

- `GardenBenchRandom01` through `/build/prop?...&dryRun=true`, with a runtime-resolved position and no native object definition emitted.
- `TRL Grass Surface` through `/surface?...&dryRun=true`, with a four-node polygon and no native surface definition emitted.
- `raise` terrain through `/terraform?...&dryRun=true`, with runtime `Terrain Shift Tool` and `Default Brush` entities and no native terrain definition emitted.

Entity IDs are runtime/session values and must not be hard-coded by an agent.

### Native environment maps and transport analytics/settings

The deployed bridge was then exercised against the live clean-save session with the new paged environment and line-settings readers:

- `/city/resources?resolution=8&page=0&pageSize=64` returned `64` cells from `Game.Simulation.NaturalResourceSystem.m_Map`, including `50` non-zero cells. The sampled average available values were fertility `319.078125`, oil `2036.234375`, ore `1796.609375`, and fish `5854.3125`; maximum available values were fertility `10000`, oil `65525`, ore `65481`, and fish `64968`.
- `/city/wind?resolution=8&page=0&pageSize=64` returned `64` cells from `Game.Simulation.WindSystem.m_Map`. Average magnitude was `0.3286866795`, maximum magnitude `0.682608068`, the sampled vector range was approximately `x=-0.31191..0.682598`, `z=-0.311146..0.606435`, and the native constant wind vector was `(0.275,0.275)`.
- `/city/outside-connections?limit=50` returned `10` rows from `Game.Net.OutsideConnection + Game.Net.Node`. The first row was `Medium Seaway`, entity `60373:1`, at approximately `(1236.8994,470.4783,-7271.25)`.
- `/transport/analysis` returned native line analytics for the clean-run route `220975:7`, including two connected stops, waiting passengers, vehicle timing, interval, ticket price, and schedule state. The response is read-only and preserves unavailable fields instead of fabricating values.
- The line-settings endpoint then applied Night schedule, active state, interval `37`, unbunching factor `0.45`, and ticket price `11`. It returned `success:true`; deferred verification reported `componentMatches:true` and `uiMatches:true`, and the next analysis readback matched the native ECS/UI state. This is the reason the capability contract now advertises `transit_line_settings` and `transport_analytics`.

These readers use the installed game's native maps/components and bounded paging. Forest resources are not inferred from another grid, and no resource, wind, outside-connection, waiting-passenger, or timing value is synthesized when the native runtime does not expose it.

### Native transport-line creation and readback

The final post-restart session also exercised the newly wired route pipeline against the live road network:

1. `/transport/prefabs?limit=50` returned ten runtime `TransportLinePrefab` entries, including the exact unlocked `Bus Line` prefab (`178:1`).
2. A dry-run request with three world points returned a native preview with terrain-sampled heights and `pointCount: 3`; the response explicitly stated that no route definition was emitted.
3. The matching execution request returned `queued: true` and the native path `CreationDefinition + WaypointDefinition -> GenerateWaypointsSystem -> GenerateRoutesSystem -> ApplyRoutesSystem`.
4. The same operation was then exercised through the MCP stdio server (`cs2_create_transport_line`, `execute: true`). After the next simulation frame, its readback returned one live route:

```json
{"entity":{"index":62461,"version":3},"prefab":"Bus Line","number":1,"vehicleInterval":0,"ticketPrice":8,"waypointCount":3,"segmentCount":3,"waypoints":[{"entity":{"index":62423,"version":5},"x":997.341064,"y":459.72467,"z":4462.149},{"entity":{"index":62456,"version":3},"x":935.106,"y":478.594147,"z":4221.3374},{"entity":{"index":62457,"version":3},"x":647.03,"y":480.967041,"z":3913.15576}]}
```

The MCP call returned the exact runtime `Bus Line` selection, the native route-definition path, and the committed `Route + TransportLine` readback. This proves native transport-line entity creation and live waypoint readback through the MCP surface, not only through a direct HTTP probe. The later stop-binding, facility-placement, and track-segment checks below cover the additional verified scopes; station/depot line attachment remains separate. Cardinality-changing waypoint insertion/removal is implemented in the current source but was not part of this historical creation run, while line settings and read-only analytics are covered by the native regression above.

### Native transport-line mutation/deletion and MCP readback

After deploying the rebuilt bridge and loading the clean `CS2MCP route mutation verified` save, the live contract reported `transit_line_mutation:true`. A separate MCP stdio client then exercised a disposable three-waypoint `Bus Line` without leaving it in the save:

1. `cs2_create_transport_line({mode:"bus",execute:true})` created runtime route entity `174625:3` and returned the native route-definition path.
2. `cs2_modify_transport_line` dry-run returned the native `m_Original` route/waypoint preview. The execute call changed the third waypoint from `(645.1286,3916.66455)` to `(745.1286,3916.66455)` and returned `success:true`, `verification.status:"readback"`, `positionMatches:true`, and `pointCount:3`.
3. `cs2_delete_transport_line` dry-run returned the native delete preview. The execute call returned `success:true`, `deleted:true`, and `verification.status:"absent"`; a final `cs2_list_transport_lines` readback returned the original three routes and no `174625:3` entity.

The mutation and deletion calls are therefore verified through the MCP stdio surface and live ECS readback, not only through direct HTTP. This historical run verifies same-cardinality waypoint replacement plus deletion; the current source extends the native mutation path to insertion/removal, but that branch awaits a fresh user-directed runtime check. Station/depot line attachment and line settings/analytics remain dedicated native tools.

### Native stop binding, physical track, graph observation, and autonomous cycle

On 2026-08-25 the rebuilt bridge was loaded into the near-empty `CS2MCP Runtime Test 20260824` save (population `0`, funds `6,250,000`, map `Ribbon Isles`). A single MCP `cs2_run_autonomous_city_cycle` execution was issued with no manual construction steps. The request used bounded limits (`maxSegments:3`, `maxDistricts:1`, `maxTrees:6`, `maxProps:1`, `maxServiceBuildings:3`), dynamic prefab selection, non-zero simulation (`runSimulationHours:0.02`), two screenshots, and `resume:false`.

The returned cycle reported:

- `success:true`; `plannedSegments:3`, `verifiedRoads:3`, `successfulDistricts:1`, `successfulZones:1`;
- quality gates `roadReadback`, `districtReadback`, `zoningReadback`, `simulation`, and `multiAngleScreenshots` all `true`;
- services, two native bus stops, one native route with verified stop bindings, trees/props/surface operations, road graph observation, and transport analysis observation;
- two asynchronous named saves only (`preflight` and `final`), both `saveOk:true`, with no file-lock exception after the save-pipeline fix;
- the revision stage re-ran zoning when the initial native zoning readback was incomplete, then completed the final quality gate;
- the final game state was `Game`, `cityLoaded:true`, and `simulation.paused:true`; the final screenshot is [`autonomous-cycle-final-live.png`](../../outputs/autonomous-cycle-final-live.png).

The road executor records a native compatibility fallback: when a dynamically selected highway/arterial prefab is rejected by game validation, only the unverified segments are retried with a dynamically discovered ordinary road. The quality gate still requires every requested bounded segment to have a native readback. This is a verified bounded autonomous cycle, not a claim that a zero-population save has already grown into a large populated metropolis.

### Final clean near-empty autonomous cycle

The earlier `3`-segment/`1`-district run exposed a real native-validation issue in the transit stage: one candidate stop was accepted while another was rejected by the game's object validation. The executor was changed to try multiple separated live road/transport anchors and to verify each accepted stop before creating the line. The final clean-save run below supersedes that earlier bounded record.

On 2026-08-25, the game UI loaded the near-empty `CS2MCP Runtime Test 20260824` save after the bridge rebuild. `/ping` returned `ok:true`, `gameMode:"Game"`, `isLoading:false`; `/state` returned `cityLoaded:true`, city `科林加`, `paused:false`, and date `2026-01-01 09:05` before execution. The MCP driver [`autonomous-growth-live.mjs`](../outputs/autonomous-growth-live.mjs) completed the real execute-mode cycle and wrote the full response to [`autonomous-growth-live.json`](../outputs/autonomous-growth-live.json).

The final artifact reported `success:true` at both wrapper and cycle level:

- `plannedSegments:12`, `verifiedRoads:12`, `plannedDistricts:4`, `successfulDistricts:4`, and `successfulZones:4`;
- eight native service placements with placement/readback verification: `WindTurbine03` (`57831:13`), `GroundwaterPumpingStation01` (`61742:55`), `SewageOutlet01` (`61972:55`), `Landfill01 Hazardous Waste Collection Point` (`64335:27`), `MedicalClinic02` (`67131:21`), `EE_FireStation02` (`74986:9`), `PoliceStation01` (`213210:25`), and `ElementarySchool03` (`214141:35`);
- two native bus stops, one bound `Bus Line` route (`220975:7`), and binding readback for stop entities `220967:5` and `220970:7`;
- successful landscape and non-zero simulation stages, three validation screenshots, and all ten quality gates set to `true`;
- successful asynchronous named saves `CS2MCP autonomous preflight 2026-08-25T05-32-13-742Z` and `CS2MCP autonomous final 2026-08-25T05-33-07-850Z`.

Validation retained one active-notifications warning with count `78` and recommended inspecting the warnings before expanding the build. This is diagnostic output, not a hidden success claim. The run is a bounded native integration acceptance test; it does not claim that the save has already grown into a large populated metropolis.

### Native object relocation and readback

After the same rebuilt bridge was loaded into the route checkpoint, a runtime-discovered `GardenBenchRandom01` prop was placed at `(1100,465.6057,4500)`. The game resolved the randomized request to `GardenBench04` and returned entity `62304:9` from `/city/props`. A dry-run `cs2_transform_object` MCP call, which delegated to `/object/transform`, selected `(1150,465.6057,4500)` and a 45-degree world-Y yaw without emitting a definition. The matching MCP execution returned:

```json
{"transformed":true,"entity":{"index":62304,"version":9},"position":{"x":1150.0,"y":465.6057,"z":4500.0},"rotation":{"x":0.0,"y":0.382683456,"z":0.0,"w":0.9238795},"nativePath":"BridgeToolSystem.OnUpdate -> ToolOutputBarrier -> CreationDefinition(Relocate) + ObjectDefinition -> native object apply"}
```

Post-frame verification returned the same entity at the new position through `/entity/inspect?index=62304&version=9` and `/city/props?x=1150&z=4500&radius=40`; the old-position query at `(1100,4500)` returned zero matches. The MCP response also reported `verification.entityReadback:true` and `verification.positionMatches:true`. This proves live object relocation through the native definition path and entity readback. It does not enable road relocation or transport-stop attachment. The native vehicle-dispatch request path was added after this historical session, so its RouteVehicle readback still requires a fresh session check; track construction, cardinality-changing route mutation, and rollback are separate capability-gated paths whose latest source changes require a fresh session check.

### Native station and depot placement after a full restart

After the facility-placement path was corrected to pass the native transport control point (`ControlPoint.m_OriginalEntity` plus curve position) and the bridge was rebuilt/deployed, a fresh runtime test city was saved as `CS2MCP facility verified baseline 2026-08-25`. The game was then exited and relaunched through the UI. Loading that save from the game's load menu produced `gameMode:Game`, `cityLoaded:true`, and a visible live city; the bridge contract reported `transport_facility_placement:true` with the installed-game verification detail.

The post-restart readback at `(1500,4432)` with radius `260` returned:

- `stations:1`, `depots:5`, `stops:3` from `/transport/analysis`;
- one root `BusStation02` at `(1500,478.8779,4424)` with `subObjectCount:92`;
- three native `Integrated Bus Stop` children under that station;
- two root `Pack7-BusDepot01` entities at `(1600,478.5159,4432)` and `(1400,479.1524,4432)`, both with `HasAvailableVehicles` and `availableVehicles:4`;
- `/city/buildings?query=Pack7-BusDepot01&limit=20` returned exactly those two root depot entities.

The two additional `BusDepot01 Extra Garage` objects in the count are disposable geometry probes from the same facility test. The evidence screenshot captured after the reload is [`facility-regression-reloaded.png`](../../outputs/facility-regression-reloaded.png), and the follow-up checkpoint save was requested as `CS2MCP facility verified reload 2026-08-25`.

This is native facility placement and persistence/readback evidence. The native vehicle-dispatch request path was added after this historical evidence and is not claimed as runtime-verified here; line settings and read-only analytics are separately implemented and verified.

The MCP stdio surface was then exercised against a fresh road-side anchor in the loaded city. After a native `Small Road` was created from `(1700,4400)` to `(2300,4400)`, the MCP client executed:

- `cs2_place_station({mode:"bus",prefab:"BusStation02",anchor:{x:1850,z:4424},rotation:270,execute:true,force:true})`, which returned `success:true`, `verification.status:"readback"`, and station entity `65947:3` at `(1850,479.3801,4424)`;
- `cs2_place_depot({mode:"bus",prefab:"Pack7-BusDepot01",anchor:{x:2150,z:4432},rotation:270,execute:true,force:true})`, which returned `success:true`, `verification.status:"readback"`, and depot entity `71923:5` at `(2150,478.1323,4432)`;
- `cs2_transport_analysis({x:2000,z:4432,radius:450,limit:500})`, which returned one station, four depots, three integrated station stops, and the two newly observed native facility roots in the response.

The MCP call transcript driver is [`mcp-facility-verify.mjs`](../../outputs/mcp-facility-verify.mjs), the post-call screenshot is [`mcp-facility-verify.png`](../../outputs/mcp-facility-verify.png), and the paused checkpoint save was requested as `CS2MCP MCP facility final 2026-08-25`. This confirms the public MCP tool path, native apply, and post-apply building readback rather than only a direct bridge probe.

## Executed native operations

The following operations were executed in an earlier disposable Ribbon Isles city using the same bridge implementation, then verified through readback and screenshots:

### Props

1. Runtime discovery of `GardenBenchRandom01`, `GardenBench01` through `GardenBench04` returned unlocked `StaticObjectPrefab` entries.
2. A dry-run returned the resolved placement preview at `(800, 478.8198, 700)`.
3. The committed placement returned `placed: true`.
4. The game resolved the randomized source prefab to `GardenBench02`. `/city/props?x=800&z=700&radius=250` returned entity `59690:25` at `(800, 478.8198, 700)`, and `/entity/inspect` returned the same prefab and position.

### Surfaces

1. Runtime discovery found `SurfacePrefab` entries including `TRL Grass Surface`.
2. A four-node rectangle around `(700,730)` to `(900,850)` passed dry-run validation.
3. The committed native area definition returned `created: true`, `areaType: "surface"`, and `nodes: 4`.
4. The visual result is recorded in [`surface-prop-city.png`](../runtime-evidence/surface-prop-city.png).

### Terraforming

1. A native `ToolOutputBarrier` request was issued with a runtime `Terrain Shift Tool` and `Default Brush`.
2. The response reported the native `CreationDefinition + BrushDefinition` path rather than direct height-component mutation.
3. Comparing `/city/terrain?resolution=256&raw=true` before and after the operation found three changed samples; the maximum absolute height delta was approximately `3.234436 m`.
4. The visible result is recorded in [`after-terrain.png`](../runtime-evidence/after-terrain.png).

### Roads

An earlier native `Small Road` placement was committed and verified through `/city/roads`, which returned newly created road edges. The visual result is recorded in [`after-road-prop.png`](../runtime-evidence/after-road-prop.png).

## Build and automated checks

- C# bridge build against the installed game: 0 warnings, 0 errors; the compiled DLL was deployed to the local Mods directory.
- TypeScript build: passed.
- MCP smoke/unit tests: 6 passed.

## Acceptance boundary

The runtime evidence proves real native execution for roads, buildings/trees through the existing placement path, props, surfaces, terraforming, bus stops, stop-bound bus transport-line creation/readback, native station/depot placement and post-restart readback, physical track segments, same-cardinality route modification/deletion, native line settings and analytics, native resources/wind/outside connections, native road-graph observation, object relocation, dynamic runtime prefab discovery, and a bounded autonomous observe/build/simulate/repair/validate cycle. It does **not** prove the full blank-save-to-large-populated-metropolis acceptance target or the latest source-only cardinality-changing/rollback changes in a new session.

The following remain explicitly incomplete and are reported as unavailable rather than simulated:

- a fresh runtime verification of the new native per-vehicle dispatch request/readback path and generic object recoloring;
- a fresh runtime recheck of the current native waypoint insertion/removal and save rollback branches;
- an autonomous run that grows and validates a complete large populated metropolitan city from a blank save (the bounded cycle is verified, the large-city acceptance target remains open).
