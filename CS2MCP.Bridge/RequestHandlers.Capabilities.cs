using Game;
using Game.Prefabs;
using Game.SceneFlow;
using UnityEngine;

namespace CS2MCP
{
    /// <summary>
    /// Machine-readable contract for the bridge. The booleans intentionally
    /// describe implemented, tested code paths rather than aspirational
    /// roadmap items. The MCP planner uses this response before mutating the
    /// game and exposes unsupported operations as explicit capabilities.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private BridgeResponse GetCapabilities()
        {
            GameManager manager = GameManager.instance;
            int tunnelPrefabCount = CountTunnelCapablePrefabs();
            return BridgeResponse.Json(new
            {
                schemaVersion = 1,
                mod = Mod.Name,
                modVersion = Mod.Version,
                gameVersion = Application.version,
                unityVersion = Application.unityVersion,
                gameMode = manager != null ? manager.gameMode.ToString() : "Unknown",
                gameBuild = Application.buildGUID,
                compatibility = new
                {
                    mode = "capability-gated",
                    unknownBuildsRemainUsable = true,
                    nativePathsAreSelectedFromLiveComponents = true,
                },
                capabilities = new
                {
                    roads = true,
                    curved_roads = true,
                    elevated_roads = true,
                    bridges = true,
                    tunnels = tunnelPrefabCount > 0,
                    buildings = true,
                    building_grid_placement = true,
                    building_road_access_validation = true,
                    zones = true,
                    native_zoning_tool = true,
                    districts = true,
                    trees = true,
                    props = true,
                    surfaces = true,
                    surface_entity_listing = true,
                    terraform = true,
                    track_construction = true,
                    transit_lines = true,
                    transit_line_mutation = true,
                    transit_line_settings = true,
                    transport_analytics = true,
                    transport_analysis = true,
                    transport_facility_placement = true,
                    transit_stops = true,
                    transit_stop_attachment = true,
                    transport_vehicle_dispatch = true,
                    tile_purchase = true,
                    dynamic_prefab_discovery = true,
                    entity_inspection = true,
                    entity_query = true,
                    road_entity_listing = true,
                    road_graph = true,
                    object_transform = true,
                    object_copy = true,
                    object_recolor = false,
                    natural_resources = true,
                    wind_observation = true,
                    outside_connections = true,
                    utility_network_observation = true,
                    economy = true,
                    policies = true,
                    simulation = true,
                    screenshots = true,
                    save_game = true,
                    save_load = true,
                    rollback = true,
                },
                details = new
                {
                    roads = "native network ToolBaseSystem validation/apply path",
                    curved_roads = "single quadratic control point through /build/road",
                    elevated_roads = "endpoint elevations through /build/road; the selected prefab must support it",
                    bridges = "available when a compatible discovered network prefab is selected",
                    tunnels = tunnelPrefabCount > 0
                        ? $"{tunnelPrefabCount} unlocked runtime network prefab(s) expose PlaceableNetData.m_UndergroundPrefab; use the exact discovered prefab and verify underground geometry after construction"
                        : "no unlocked runtime network prefab currently exposes PlaceableNetData.m_UndergroundPrefab",
                    buildings = "native placement validation through BridgeToolSystem",
                    building_grid_placement = "ordinary BuildingPrefab placement snaps to the native 8m zoning grid unless gridSnap=false; transport facilities/stops retain road-anchor coordinates",
                    building_road_access_validation = "BuildingData.RequireRoad/RequireAccess is read from the live prefab; native road edge proximity is required before the ObjectTool pipeline is queued, and the game's validator remains authoritative",
                    native_zoning_tool = "native CreationDefinition + Zoning marquee definition consumed by GenerateZonesSystem and ApplyZonesSystem; road-generated visible cells, blocked cells, occupancy, and grid rules stay in the game systems",
                    trees = "native placement validation through the building/tree placement path",
                    dynamic_prefab_discovery = "runtime PrefabSystem query; no fixed asset allow-list",
                    props = "runtime StaticObjectPrefab discovery plus native ObjectDefinition placement; verify resolved variants with /city/props and /entity/inspect",
                    surfaces = "runtime SurfacePrefab discovery plus native area CreationDefinition polygon path; verify the painted area with /city/surfaces and /screenshot",
                    surface_entity_listing = "native Game.Areas.Surface + Geometry + Area.Node enumeration through /city/surfaces with page/pageSize and spatial filtering",
                    track_construction = "runtime TrackPrefab discovery through /prefabs?category=net plus native NetTool CreationDefinition path at /build/road; physical segment creation/readback is verified, while station/stop attachment remains separate",
                    transport_lines = "native route definition creation, same-cardinality modification, cardinality-changing insertion/removal, deletion, and live Route + TransportLine readback are available; stops/stations remain separate work",
                     transit_line_mutation = "native CreationDefinition(m_Original route, optional Recreate) + WaypointDefinition(m_Original waypoint/null) update/insert/remove/delete path; verified by inserting a waypoint and removing it again while preserving endpoint stop bindings",
                    transit_line_settings = "main-thread TransportationOverviewUISystem schedule/state/name operations plus native TransportLine interval, unbunching, and ticket-price component readback",
                    transport_analytics = "native UITransportLineData projection, RouteVehicle buffers, VehicleTiming, and WaitingPassengers observations returned by /transport/analysis",
                    transport_analysis = "read-only native TransportStation, TransportDepot, TransportStop and ConnectedRoute enumeration through /transport/analysis",
                    transport_facility_placement = "native ObjectToolBaseSystem path with ControlPoint.m_OriginalEntity road anchoring and curve position; verified on CS2 1.6.0f1 with fresh native BusStation02 and Pack7-BusDepot01 readbacks",
                    transit_stops = "verified on CS2 1.6.0f1 in a freshly loaded runtime save: native ObjectToolBaseSystem/CreateDefinitions placement of Pack7-BusStop01 produced a live TransportStop readback",
                    transit_stop_attachment = "verified on CS2 1.6.0f1: native WaypointDefinition.m_Connection bound two live TransportStop entities during Bus Line creation; same-cardinality mutation preserved the binding on readback",
                    transport_vehicle_dispatch = "native TransportLineSystem vehicle-request archetype (ServiceRequest + TransportVehicleRequest + RequestGroup) is emitted through the end-frame barrier and consumed by TransportPathfindSetupSystem/TransportVehicleDispatchSystem; MCP execution requires RouteVehicle readback before claiming a dispatched vehicle",
                    road_graph = "read-only native Edge/Node/Curve/SubLane graph with lane direction, speed, connections, junction degree, elevation/slope/curvature, outside-connection flags, Density/LaneFlow/LaneObject snapshots, and city-wide TrafficFlowSystem averages through /road/graph",
                    object_transforms = "native CreationDefinition(Relocate) + ObjectDefinition relocation is available for live transformable objects; verified with prop entity readback",
                    object_copy = "native prefab re-placement with source entity inspection and new-object readback; sub-object/service attachments are not cloned",
                    entity_query = "bounded native ECS query across buildings, roads, trees, objects, props, and districts with category, bounds/center filters, and page/pageSize",
                    object_recolor = "not exposed by the installed generic object tool; the MCP operation is explicit plan-only and never writes a guessed color component",
                    natural_resources = "native NaturalResourceSystem.m_Map sampling through /city/resources; forest remains a separate tree/wood layer and is not inferred as zero",
                    wind_observation = "native WindSystem.m_Map sampling through /city/wind, including vector magnitude and derived direction",
                    outside_connections = "native Game.Net.OutsideConnection + Node enumeration through /city/outside-connections, with transfer metadata when a native prefab exposes it",
                    utility_network_observation = "native PipelinePrefab/PowerLinePrefab Edge enumeration plus WaterPipeBuildingConnection and ElectricityBuildingConnection graph references through /city/utilities",
                    save_load = "native MenuUISystem.m_SavesBinding SaveInfo enumeration plus SafeLoadGame/LoadGameArgs; exact save ids and names are exposed through /game/saves and /game/load",
                    rollback = "native preflight recovery through /game/rollback; autonomous failures pause, request the load, and verify cityLoaded=true after the load pipeline completes",
                    unsupported = "generic object recoloring remains outside the current contract; transport vehicle dispatch uses the game's native request/pathfind pipeline and is successful only after RouteVehicle readback",
                    terraforming = "native ToolOutputBarrier CreationDefinition + BrushDefinition path at /terraform; /city/terrain/sample returns before/after native height and water-depth samples for directional verification",
                    tilePurchase = "native MapTilePurchaseSystem selection/economy path at /city/tiles/purchase; accepts entity IDs, ordinals, or nearest x/z",
                },
            });
        }

        private BridgeResponse GetCoordinateInfo()
        {
            return BridgeResponse.Json(new
            {
                schemaVersion = 1,
                coordinateSystem = "Cities: Skylines II world coordinates",
                axes = new
                {
                    x = "world east-west axis",
                    y = "world elevation axis, meters, up",
                    z = "world north-south axis",
                    rotation = "degrees around positive Y; the exact visual heading is verified by camera/scene state",
                },
                units = "meters",
                worldBounds = new { minX = -7168f, maxX = 7168f, minZ = -7168f, maxZ = 7168f },
                terrain = "when y is omitted, placement and district tools sample the native TerrainSystem",
                paging = "large entity/prefab responses require page/pageSize or limit; do not request the whole ECS world through one call",
                source = "bridge runtime contract; gameBuild is reported separately by /capabilities",
            });
        }
    }
}
