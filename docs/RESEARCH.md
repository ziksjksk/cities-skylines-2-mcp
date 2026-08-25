# Research and reference audit

## Local evidence

The starting point was the clean local checkout under the previous workspace at `2026-07-19\c-d-s\work\cities-skylines-2-mcp`. Its remote was `https://github.com/LancerComet/cities-skylines-2-mcp.git`, and its README described a 44-tool MCP-to-localhost-HTTP-to-in-process-CS2 architecture with main-thread ECS execution and native tool/bulldozer paths.

The current development environment contains:

- `D:\steam\steamapps\common\Cities Skylines II\Cities2_Data\Managed\Game.dll` and the Unity/Colossal assemblies;
- a user-level .NET SDK `8.0.423` under `C:\Users\zlyexn\.dotnet`;
- Node.js 24 and npm;
- the deployed local mod directory `%LOCALAPPDATA%Low\Colossal Order\Cities Skylines II\Mods\CS2MCP`.

The baseline README explicitly identified map-tile purchasing, transit line planning, terraforming, and smooth mid-segment ramp merges as limitations. The map-tile gap is now addressed by a native `MapTilePurchaseSystem` selection/economy adapter. Terraforming, props, surfaces, native transport-line route geometry, native bus stops and stop binding, native station/depot placement, same-cardinality and cardinality-changing route mutation/deletion, physical track segments, read-only road/traffic graph observation, native resource/wind/outside-connection observation, read-only transport analytics, line settings, native vehicle dispatch requests, live object relocation/copy, grid-aware building access validation, native zoning, save/load/rollback, and the bounded autonomous cycle now have bridge paths. Generic object recoloring and station/depot subobject route attachment remain explicit capability boundaries. Tunnel support is now a capability-gated runtime probe over unlocked `PlaceableNetData.m_UndergroundPrefab` references; it is not enabled by negative elevation alone and still needs exact-prefab/native-readback verification. The historical runtime records below predate the latest source-only contract tightening where noted; no gap is hidden behind mock success responses, and the new dispatch path still needs a fresh game-session check.

## Online references consulted

- [LancerComet/cities-skylines-2-mcp](https://github.com/LancerComet/cities-skylines-2-mcp) — baseline MCP/bridge architecture, native tool pipeline, current tool surface, and known limitations.
- [mayor-modder/Cities2-MCP](https://github.com/mayor-modder/Cities2-MCP) — complementary local knowledge/modding toolkit. Its README emphasizes runtime/local encyclopedia and mod workflow support rather than direct construction control, so it was treated as a research/knowledge reference, not a construction base.
- [BrokeAssSoftware/cs2-modding-guide](https://github.com/BrokeAssSoftware/cs2-modding-guide) — community modding guidance and links to official documentation, especially for code-mod/UI conventions.
- [Paradox Interactive Cities: Skylines II Modding](https://www.paradoxinteractive.com/games/cities-skylines-ii/modding) — official modding scope and the existence of code/map/asset editor support. Runtime behavior still has to be probed in the installed game.
- [Official Cities: Skylines II Modding Wiki](https://cs2.paradoxwikis.com/Modding) — authoritative community-maintained documentation target for future native API research; some pages were not machine-readable during this audit, so no unverified API claim was promoted into executable code.

## Decisions derived from the audit

1. Extend the LancerComet architecture rather than replace the verified bridge threading and native construction pipeline.
2. Add capability discovery before high-level planning so agents can query → confirm → use.
3. Query runtime prefabs through `PrefabSystem`; do not maintain a fixed asset name list.
4. Keep the planner pure and deterministic, with native construction as a separate execution phase.
5. Expose an unavailable state for generic object recoloring, station/depot subobject route attachment, and tunnel construction when the live runtime has no unlocked underground network prefab; enable vehicle dispatch only through the native request endpoint and require RouteVehicle readback before claiming success. Only enable tunnel execution after the capability probe, exact discovery, and post-build readback. Likewise enable waypoint insertion/removal, stops, stop binding, station/depot placement, physical track, route-line mutation, line settings, transport analytics, terrain, props, surfaces, tile purchase, transforms, resources, wind, outside connections, utilities, zoning, save/load/rollback, and graph observation when the native endpoint and live capability contract report them available. A source build is not a substitute for a fresh game-session check.
