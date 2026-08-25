using System;
using Colossal.Mathematics;
using Game;
using Game.City;
using Game.Common;
using Game.Net;
using Game.Prefabs;
using Game.Simulation;
using Game.Tools;
using Unity.Collections;
using Unity.Entities;
using Unity.Jobs;
using Unity.Mathematics;
using UnityEngine.Scripting;
using AgeMask = Game.Tools.AgeMask;
using Transform = Game.Objects.Transform;

namespace CS2MCP
{
    /// <summary>
    /// Headless placement tool. Activated programmatically for exactly three
    /// tool-update frames per operation:
    ///   1. CreateDefinitions — build definition entities (ported LineTool job),
    ///      applyMode=Clear lets the game generate preview Temp entities.
    ///   2. Apply — if validation passed (GetAllowApply), applyMode=Apply commits
    ///      the Temp entities to permanent ones; otherwise reject.
    ///   3. Finish — restore the previously active tool.
    /// </summary>
    public sealed partial class BridgeToolSystem : ObjectToolBaseSystem
    {
        private enum Stage
        {
            Idle,
            CreateDefinitions,
            Apply,
            Finish,
        }

        private enum OperationKind
        {
            Object,
            Net,
            Demolish,
            Upgrade,
            Area,
            Zoning,
            Terrain,
            TransportLine,
            TransportLineModify,
            TransportLineDelete,
            TransportDispatch,
            Relocate,
        }

        private Stage m_Stage = Stage.Idle;
        private OperationKind m_PendingKind;
        private Entity m_PendingPrefabEntity;
        private Entity m_PendingTarget;
        private PrefabBase m_PendingPrefab;
        private string m_PendingLabel;
        private float3 m_PendingPosition;
        private float3 m_PendingEnd;
        private float3 m_PendingMid;
        private bool m_PendingHasMid;
        private CompositionFlags m_PendingUpgradeFlags;
        private float3[] m_PendingAreaNodes;
        private float2 m_PendingElevations;
        private quaternion m_PendingRotation;
        private BridgeRequest m_PendingRequest;
        private Entity m_PendingTerraformPrefab;
        private Entity m_PendingBrushPrefab;
        private float3 m_PendingTerrainStart;
        private float3 m_PendingTerrainEnd;
        private float3 m_PendingTerrainTarget;
        private float m_PendingTerrainStrength;
        private float3[] m_PendingRoutePoints;
        private Entity[] m_PendingRouteWaypoints;
        private Entity[] m_PendingRouteConnections;
        private Entity m_PendingRouteTarget;
        private bool m_PendingRouteCardinalityChanged;
        private Entity m_PendingDispatchRoute;
        private float m_PendingDispatchPriority;
        private Entity m_PendingZonePrefabEntity;
        private string m_PendingZoneName;
        private float3 m_PendingZoneCenter;
        private float m_PendingZoneRadius;
        private bool m_PendingZoneOverwrite;
        private bool m_PendingZoneDezone;
        private float3 m_PendingTransformPosition;
        private quaternion m_PendingTransformRotation;
        private Entity m_PendingRoadAnchor;
        private float m_PendingRoadCurvePosition;
        private Entity m_PendingStartRoadAnchor;
        private Entity m_PendingEndRoadAnchor;
        private bool m_PendingHasStartRoadAnchor;
        private bool m_PendingHasEndRoadAnchor;
        private float m_PendingStartRoadCurvePosition;
        private float m_PendingEndRoadCurvePosition;
        private object m_PendingPreview;
        private ToolBaseSystem m_PreviousTool;

        private CityConfigurationSystem m_CityConfigurationSystem;

        public override string toolID => "CS2MCP.Bridge";

        public bool IsBusy => m_Stage != Stage.Idle;

        /// <summary>
        /// Structured reason for a placement request rejected before it
        /// reaches the asynchronous native tool pipeline.  The HTTP handler
        /// reads this immediately when TryQueuePlacement returns false.
        /// </summary>
        public string LastPlacementFailure { get; private set; }

        [Preserve]
        protected override void OnCreate()
        {
            base.OnCreate();
            m_CityConfigurationSystem = base.World.GetOrCreateSystemManaged<CityConfigurationSystem>();
        }

        public override PrefabBase GetPrefab()
        {
            return m_PendingPrefab;
        }

        public override bool TrySetPrefab(PrefabBase prefab)
        {
            // Never let the game UI select this tool via asset selection.
            return false;
        }

        /// <summary>Must be called on the simulation thread.</summary>
        public bool TryQueuePlacement(Entity prefabEntity, PrefabBase prefab, float3 position, quaternion rotation, BridgeRequest request)
        {
            LastPlacementFailure = null;
            if (m_Stage != Stage.Idle)
            {
                LastPlacementFailure = "another build operation is in progress, retry shortly";
                return false;
            }

            bool isBuilding = prefab is BuildingPrefab && EntityManager.HasComponent<BuildingData>(prefabEntity);
            bool isTransportObject = IsTransportFacilityPrefab(prefab) || IsTransportStopPrefab(prefabEntity);
            bool gridSnap = request.TryGetBool("gridSnap", out bool requestedGridSnap)
                ? requestedGridSnap
                : isBuilding && !isTransportObject;
            if (gridSnap && isBuilding && !isTransportObject)
            {
                const float placementGrid = 8f;
                position.x = math.round(position.x / placementGrid) * placementGrid;
                position.z = math.round(position.z / placementGrid) * placementGrid;
                if (!request.TryGetFloat("y", out _))
                {
                    TerrainHeightData heightData = m_TerrainSystem.GetHeightData();
                    position.y = TerrainUtils.SampleHeight(ref heightData, position);
                }
            }

            BuildingFlags buildingFlags = default;
            if (isBuilding)
            {
                buildingFlags = EntityManager.GetComponentData<BuildingData>(prefabEntity).m_Flags;
            }
            bool nativeRequiresRoad = isBuilding
                && (buildingFlags & (BuildingFlags.RequireRoad | BuildingFlags.RequireAccess)) != 0
                && (buildingFlags & BuildingFlags.NoRoadConnection) == 0;
            bool requestedRoad = request.TryGetBool("requireRoad", out bool requestedRequireRoad) && requestedRequireRoad;
            bool requiresRoad = requestedRoad || nativeRequiresRoad || isTransportObject;
            if (requiresRoad && TryFindNearestRoadAnchor(position, out Entity roadAnchor, out float roadCurvePosition))
            {
                m_PendingRoadAnchor = roadAnchor;
                m_PendingRoadCurvePosition = roadCurvePosition;
            }
            else if (requiresRoad)
            {
                LastPlacementFailure = "road access is required by this prefab or request, but no live road edge was found within 80m; build a native road first or move the placement anchor to road frontage";
                return false;
            }
            m_PendingKind = OperationKind.Object;
            m_PendingPrefabEntity = prefabEntity;
            m_PendingPrefab = prefab;
            m_PendingPosition = position;
            m_PendingRotation = rotation;
            if (!requiresRoad)
            {
                m_PendingRoadAnchor = Entity.Null;
                m_PendingRoadCurvePosition = 0f;
            }
            m_PendingRequest = request;
            Activate();
            return true;
        }

        /// <summary>Must be called on the simulation thread.</summary>
        public bool TryQueueZoning(Entity zonePrefabEntity, string zoneName, float3 center, float radius, bool overwrite, bool dezone, BridgeRequest request)
        {
            if (m_Stage != Stage.Idle)
            {
                return false;
            }
            m_PendingKind = OperationKind.Zoning;
            m_PendingZonePrefabEntity = zonePrefabEntity;
            m_PendingZoneName = zoneName;
            m_PendingZoneCenter = center;
            m_PendingZoneRadius = math.clamp(radius, 8f, 200f);
            m_PendingZoneOverwrite = overwrite;
            m_PendingZoneDezone = dezone;
            m_PendingRequest = request;
            Activate();
            return true;
        }

        /// <summary>Must be called on the simulation thread.</summary>
        public bool TryQueueRoad(
            Entity prefabEntity,
            PrefabBase prefab,
            float3 start,
            float3 end,
            float3 mid,
            bool hasMid,
            float2 elevations,
            BridgeRequest request,
            Entity startAnchor = default,
            float startCurvePosition = 0f,
            Entity endAnchor = default,
            float endCurvePosition = 1f)
        {
            if (m_Stage != Stage.Idle)
            {
                return false;
            }
            m_PendingKind = OperationKind.Net;
            m_PendingPrefabEntity = prefabEntity;
            m_PendingPrefab = prefab;
            m_PendingPosition = start;
            m_PendingEnd = end;
            m_PendingMid = mid;
            m_PendingHasMid = hasMid;
            m_PendingElevations = elevations;
            m_PendingHasStartRoadAnchor = startAnchor != default && startAnchor != Entity.Null;
            m_PendingHasEndRoadAnchor = endAnchor != default && endAnchor != Entity.Null;
            m_PendingStartRoadAnchor = m_PendingHasStartRoadAnchor ? startAnchor : default;
            m_PendingEndRoadAnchor = m_PendingHasEndRoadAnchor ? endAnchor : default;
            m_PendingStartRoadCurvePosition = math.clamp(startCurvePosition, 0f, 1f);
            m_PendingEndRoadCurvePosition = math.clamp(endCurvePosition, 0f, 1f);
            m_PendingRotation = quaternion.identity;
            m_PendingRequest = request;
            Activate();
            return true;
        }

        /// <summary>Must be called on the simulation thread.</summary>
        public bool TryQueueUpgrade(Entity target, string label, CompositionFlags upgradeFlags, BridgeRequest request)
        {
            if (m_Stage != Stage.Idle)
            {
                return false;
            }
            m_PendingKind = OperationKind.Upgrade;
            m_PendingTarget = target;
            m_PendingLabel = label;
            m_PendingUpgradeFlags = upgradeFlags;
            m_PendingRequest = request;
            Activate();
            return true;
        }

        /// <summary>Must be called on the simulation thread.</summary>
        public bool TryQueueDemolish(Entity target, string label, BridgeRequest request)
        {
            if (m_Stage != Stage.Idle)
            {
                return false;
            }
            m_PendingKind = OperationKind.Demolish;
            m_PendingTarget = target;
            m_PendingLabel = label;
            m_PendingRequest = request;
            Activate();
            return true;
        }

        /// <summary>Must be called on the simulation thread.</summary>
        public bool TryQueueArea(Entity prefabEntity, PrefabBase prefab, float3[] polygonNodes, BridgeRequest request)
        {
            return TryQueueArea(prefabEntity, prefab, polygonNodes, request, "area");
        }

        /// <summary>Must be called on the simulation thread.</summary>
        public bool TryQueueArea(Entity prefabEntity, PrefabBase prefab, float3[] polygonNodes, BridgeRequest request, string areaKind)
        {
            if (m_Stage != Stage.Idle)
            {
                return false;
            }
            m_PendingKind = OperationKind.Area;
            m_PendingPrefabEntity = prefabEntity;
            m_PendingPrefab = prefab;
            m_PendingAreaNodes = polygonNodes;
            m_PendingLabel = areaKind;
            m_PendingRequest = request;
            Activate();
            return true;
        }

        /// <summary>
        /// Queue a terrain-tool definition for the next native tool update.
        /// ToolOutputBarrier ECBs are only legal from an owning ECS system's
        /// update; the HTTP handler therefore records the operation here and
        /// this system emits it from OnUpdate.
        /// </summary>
        public bool TryQueueTerraform(
            Entity terraformPrefab,
            Entity brushPrefab,
            PrefabBase brushPrefabObject,
            float3 start,
            float3 end,
            float3 target,
            float strength,
            object preview,
            BridgeRequest request)
        {
            if (m_Stage != Stage.Idle)
            {
                return false;
            }
            m_PendingKind = OperationKind.Terrain;
            m_PendingTerraformPrefab = terraformPrefab;
            m_PendingBrushPrefab = brushPrefab;
            m_PendingPrefabEntity = brushPrefab;
            m_PendingPrefab = brushPrefabObject;
            m_PendingTerrainStart = start;
            m_PendingTerrainEnd = end;
            m_PendingTerrainTarget = target;
            m_PendingTerrainStrength = strength;
            m_PendingPreview = preview;
            m_PendingRequest = request;
            Activate();
            return true;
        }

        /// <summary>
        /// Queue a transport-line definition for the game's native route
        /// pipeline. Route definitions must be emitted by an owning tool system
        /// so the ToolOutputBarrier can hand them to GenerateWaypointsSystem,
        /// GenerateRoutesSystem and ApplyRoutesSystem in the normal order.
        /// </summary>
        public bool TryQueueTransportLine(
            Entity routePrefab,
            PrefabBase routePrefabObject,
            float3[] points,
            Entity[] connections,
            BridgeRequest request)
        {
            if (m_Stage != Stage.Idle)
            {
                return false;
            }
            m_PendingKind = OperationKind.TransportLine;
            m_PendingPrefabEntity = routePrefab;
            m_PendingPrefab = routePrefabObject;
            m_PendingRoutePoints = points;
            m_PendingRouteConnections = connections;
            m_PendingRequest = request;
            Activate();
            return true;
        }

        /// <summary>
        /// Queue a native same-cardinality route update. Existing waypoint
        /// entities are retained as m_Original values so the game's route
        /// systems can update their positions and rebuild affected segments.
        /// </summary>
        public bool TryQueueTransportLineModify(
            Entity route,
            Entity[] waypoints,
            Entity[] connections,
            float3[] points,
            BridgeRequest request,
            bool cardinalityChanged = false)
        {
            if (m_Stage != Stage.Idle)
            {
                return false;
            }
            m_PendingKind = OperationKind.TransportLineModify;
            m_PendingRouteTarget = route;
            m_PendingRouteWaypoints = waypoints;
            m_PendingRouteConnections = connections;
            m_PendingRoutePoints = points;
            m_PendingRouteCardinalityChanged = cardinalityChanged;
            m_PendingRequest = request;
            Activate();
            return true;
        }

        /// <summary>
        /// Queue a native route deletion. The original waypoint definitions
        /// are emitted as delete-marked route definitions so the game's
        /// ApplyRoutesSystem removes the route, waypoints and segments as a
        /// coherent unit.
        /// </summary>
        public bool TryQueueTransportLineDelete(
            Entity route,
            Entity[] waypoints,
            Entity[] connections,
            float3[] points,
            BridgeRequest request)
        {
            if (m_Stage != Stage.Idle)
            {
                return false;
            }
            m_PendingKind = OperationKind.TransportLineDelete;
            m_PendingRouteTarget = route;
            m_PendingRouteWaypoints = waypoints;
            m_PendingRouteConnections = connections;
            m_PendingRoutePoints = points;
            m_PendingRequest = request;
            Activate();
            return true;
        }

        /// <summary>
        /// Queue the same request archetype used by TransportLineSystem when
        /// it asks the native dispatch/pathfind pipeline for another vehicle.
        /// The request is intentionally created through the end-frame command
        /// buffer so the simulation systems, cooldowns, pathfind setup and
        /// depot validation remain authoritative.
        /// </summary>
        public bool TryQueueTransportDispatch(Entity route, float priority, BridgeRequest request)
        {
            if (m_Stage != Stage.Idle)
            {
                return false;
            }
            m_PendingKind = OperationKind.TransportDispatch;
            m_PendingDispatchRoute = route;
            m_PendingDispatchPriority = priority;
            m_PendingRequest = request;
            Activate();
            return true;
        }

        /// <summary>
        /// Queue a native object relocation. The definition keeps the original
        /// entity and uses CreationFlags.Relocate so the game's object apply
        /// systems rebuild ownership/attachments instead of a raw Transform edit.
        /// </summary>
        public bool TryQueueRelocate(Entity target, float3 position, quaternion rotation, BridgeRequest request)
        {
            if (m_Stage != Stage.Idle)
            {
                return false;
            }
            m_PendingKind = OperationKind.Relocate;
            m_PendingTarget = target;
            m_PendingTransformPosition = position;
            m_PendingTransformRotation = rotation;
            m_PendingRequest = request;
            Activate();
            return true;
        }

        private void Activate()
        {
            m_Stage = Stage.CreateDefinitions;
            m_PreviousTool = m_ToolSystem.activeTool;
            m_ToolSystem.activeTool = this;
        }

        [Preserve]
        protected override JobHandle OnUpdate(JobHandle inputDeps)
        {
            try
            {
                switch (m_Stage)
                {
                    case Stage.CreateDefinitions:
                        applyMode = ApplyMode.Clear;
                        switch (m_PendingKind)
                        {
                            case OperationKind.Object:
                                CreatePlacementDefinitions();
                                break;
                            case OperationKind.Net:
                                CreateRoadDefinitions();
                                break;
                            case OperationKind.Demolish:
                                CreateModifyDefinitions(CreationFlags.Delete, default);
                                break;
                            case OperationKind.Upgrade:
                                CreateModifyDefinitions(CreationFlags.Upgrade, m_PendingUpgradeFlags);
                                break;
                            case OperationKind.Area:
                                CreateAreaDefinitions();
                                break;
                            case OperationKind.Zoning:
                                CreateZoningDefinitions();
                                break;
                            case OperationKind.Terrain:
                                CreateTerrainDefinitions();
                                break;
                            case OperationKind.TransportLine:
                                CreateTransportLineDefinitions();
                                break;
                            case OperationKind.TransportLineModify:
                            case OperationKind.TransportLineDelete:
                                CreateTransportLineMutationDefinitions();
                                break;
                            case OperationKind.TransportDispatch:
                                CreateTransportDispatchDefinition();
                                break;
                            case OperationKind.Relocate:
                                CreateRelocateDefinitions();
                                break;
                        }
                        // Leave the definition in the native tool pipeline
                        // for one update before asking it to apply.  This is
                        // the same two-phase cadence used by the game's
                        // TerrainToolSystem and lets GenerateBrushesSystem
                        // materialize the temporary Brush entity first.
                        m_Stage = Stage.Apply;
                        break;

                    case Stage.Apply:
                        if (m_PendingKind == OperationKind.Terrain
                            || m_PendingKind == OperationKind.Zoning
                            || m_PendingKind == OperationKind.TransportLine
                            || m_PendingKind == OperationKind.TransportLineModify
                            || m_PendingKind == OperationKind.TransportLineDelete
                            || m_PendingKind == OperationKind.TransportDispatch)
                        {
                            applyMode = ApplyMode.Apply;
                            CompletePending(BuildSuccessResponse());
                            m_Stage = Stage.Finish;
                        }
                        else if (GetAllowApply())
                        {
                            applyMode = ApplyMode.Apply;
                            CompletePending(BuildSuccessResponse());
                        }
                        else
                        {
                            applyMode = ApplyMode.Clear;
                            CompletePending(BridgeResponse.Error(409,
                                "operation blocked by game validation (overlap, water, steep terrain, protected entity...); " +
                                "try a different position or target"));
                        }
                        m_Stage = Stage.Finish;
                        break;

                    case Stage.Finish:
                        applyMode = ApplyMode.None;
                        Deactivate();
                        break;

                    default:
                        applyMode = ApplyMode.None;
                        break;
                }
            }
            catch (Exception e)
            {
                Mod.Log.Warn($"BridgeToolSystem error in stage {m_Stage}: {e}");
                CompletePending(BridgeResponse.Error(500, $"placement failed: {e.GetType().Name}: {e.Message}"));
                applyMode = ApplyMode.None;
                Deactivate();
            }
            return inputDeps;
        }

        private BridgeResponse BuildSuccessResponse()
        {
            switch (m_PendingKind)
            {
                case OperationKind.Demolish:
                    return BridgeResponse.Json(new
                    {
                        demolished = true,
                        prefab = m_PendingLabel,
                        entity = new { index = m_PendingTarget.Index, version = m_PendingTarget.Version },
                        note = "deleted via the game's bulldoze pipeline (nodes/blocks/lanes cleaned up by the game)",
                    });
                case OperationKind.Upgrade:
                    return BridgeResponse.Json(new
                    {
                        upgraded = true,
                        prefab = m_PendingLabel,
                        entity = new { index = m_PendingTarget.Index, version = m_PendingTarget.Version },
                        note = "upgrade applied via the tool pipeline; the segment is recreated with the new composition",
                    });
                case OperationKind.Net:
                    return BridgeResponse.Json(new
                    {
                        placed = true,
                        prefab = m_PendingPrefab != null ? m_PendingPrefab.name : null,
                        start = new { x = m_PendingPosition.x, z = m_PendingPosition.z },
                        end = new { x = m_PendingEnd.x, z = m_PendingEnd.z },
                        startAnchor = !m_PendingHasStartRoadAnchor
                            ? null
                            : new { index = m_PendingStartRoadAnchor.Index, version = m_PendingStartRoadAnchor.Version, curvePosition = m_PendingStartRoadCurvePosition },
                        endAnchor = !m_PendingHasEndRoadAnchor
                            ? null
                            : new { index = m_PendingEndRoadAnchor.Index, version = m_PendingEndRoadAnchor.Version, curvePosition = m_PendingEndRoadCurvePosition },
                        note = "committed this frame; verify via /city/roads or /screenshot",
                    });
                case OperationKind.Area:
                    return BridgeResponse.Json(new
                    {
                        created = true,
                        areaType = string.IsNullOrEmpty(m_PendingLabel) ? "area" : m_PendingLabel,
                        prefab = m_PendingPrefab != null ? m_PendingPrefab.name : null,
                        nodes = m_PendingAreaNodes != null ? m_PendingAreaNodes.Length : 0,
                        note = m_PendingLabel == "surface"
                            ? "surface area committed this frame; verify the painted area in the game view"
                            : "area committed this frame; list districts via /districts",
                    });
                case OperationKind.Zoning:
                    return BridgeResponse.Json(new
                    {
                        success = true,
                        dryRun = false,
                        queued = true,
                        center = new { x = m_PendingZoneCenter.x, z = m_PendingZoneCenter.z },
                        radius = m_PendingZoneRadius,
                        zone = m_PendingZoneName,
                        dezone = m_PendingZoneDezone,
                        overwrite = m_PendingZoneOverwrite,
                        nativePath = "BridgeToolSystem.OnUpdate -> ToolOutputBarrier -> CreationDefinition + Zoning -> GenerateZonesSystem -> ApplyZonesSystem",
                        note = "native zoning definition queued; verify changed cells through /city/zoning after the next simulation frame",
                    });
                case OperationKind.Terrain:
                    return BridgeResponse.Json(new
                    {
                        success = true,
                        dryRun = false,
                        queued = true,
                        preview = m_PendingPreview,
                        nativePath = "BridgeToolSystem.OnUpdate -> ToolOutputBarrier -> CreationDefinition + BrushDefinition -> terrain systems",
                        note = "definition queued through the owning native tool update; sample /city/terrain after the next simulation frame to verify the delta",
                    });
                case OperationKind.TransportLine:
                    return BridgeResponse.Json(new
                    {
                        success = true,
                        dryRun = false,
                        queued = true,
                        prefab = m_PendingPrefab != null ? m_PendingPrefab.name : null,
                        pointCount = m_PendingRoutePoints != null ? m_PendingRoutePoints.Length : 0,
                        nativePath = "BridgeToolSystem.OnUpdate -> ToolOutputBarrier -> CreationDefinition + WaypointDefinition -> GenerateWaypointsSystem -> GenerateRoutesSystem -> ApplyRoutesSystem",
                        note = "route definition queued; verify the committed route through /transport/lines after the next simulation frame",
                    });
                case OperationKind.TransportLineModify:
                    return BridgeResponse.Json(new
                    {
                        success = true,
                        dryRun = false,
                        queued = true,
                        modified = true,
                        entity = new { index = m_PendingRouteTarget.Index, version = m_PendingRouteTarget.Version },
                        pointCount = m_PendingRoutePoints != null ? m_PendingRoutePoints.Length : 0,
                        cardinalityChanged = m_PendingRouteCardinalityChanged,
                        nativePath = "BridgeToolSystem.OnUpdate -> ToolOutputBarrier -> CreationDefinition(m_Original route) + WaypointDefinition(m_Original waypoint) -> GenerateWaypointsSystem -> GenerateRoutesSystem -> ApplyRoutesSystem",
                        note = m_PendingRouteCardinalityChanged
                            ? "route cardinality mutation queued; verify the route waypoint count, positions, and native waypoint entities through /transport/lines"
                            : "route modification queued; verify the same route entity and waypoint positions through /transport/lines",
                    });
                case OperationKind.TransportLineDelete:
                    return BridgeResponse.Json(new
                    {
                        success = true,
                        dryRun = false,
                        queued = true,
                        deleted = true,
                        entity = new { index = m_PendingRouteTarget.Index, version = m_PendingRouteTarget.Version },
                        pointCount = m_PendingRoutePoints != null ? m_PendingRoutePoints.Length : 0,
                        nativePath = "BridgeToolSystem.OnUpdate -> ToolOutputBarrier -> CreationDefinition(Delete, m_Original route) + WaypointDefinition(Delete, m_Original waypoint) -> GenerateWaypointsSystem -> GenerateRoutesSystem -> ApplyRoutesSystem",
                        note = "route deletion queued; verify that the route entity and its waypoints disappear from /transport/lines",
                    });
                case OperationKind.TransportDispatch:
                    return BridgeResponse.Json(new
                    {
                        success = true,
                        dryRun = false,
                        queued = true,
                        dispatchRequested = true,
                        route = new { index = m_PendingDispatchRoute.Index, version = m_PendingDispatchRoute.Version },
                        priority = m_PendingDispatchPriority,
                        nativePath = "BridgeToolSystem.OnUpdate -> EndFrameBarrier -> ServiceRequest + TransportVehicleRequest(route, priority) + RequestGroup -> TransportPathfindSetupSystem -> TransportVehicleDispatchSystem",
                        note = "a native transport-vehicle request was queued; verify RouteVehicle count and vehicle entity readback through /transport/analysis after simulation advances",
                    });
                case OperationKind.Relocate:
                    return BridgeResponse.Json(new
                    {
                        transformed = true,
                        entity = new { index = m_PendingTarget.Index, version = m_PendingTarget.Version },
                        position = new
                        {
                            x = m_PendingTransformPosition.x,
                            y = m_PendingTransformPosition.y,
                            z = m_PendingTransformPosition.z,
                        },
                        rotation = new
                        {
                            x = m_PendingTransformRotation.value.x,
                            y = m_PendingTransformRotation.value.y,
                            z = m_PendingTransformRotation.value.z,
                            w = m_PendingTransformRotation.value.w,
                        },
                        nativePath = "BridgeToolSystem.OnUpdate -> ToolOutputBarrier -> CreationDefinition(Relocate) + ObjectDefinition -> native object apply",
                        note = "object relocation committed through the native definition pipeline; verify with /entity/inspect",
                    });
                default:
                    return BridgeResponse.Json(new
                    {
                        placed = true,
                        prefab = m_PendingPrefab != null ? m_PendingPrefab.name : null,
                        position = new
                        {
                            x = m_PendingPosition.x,
                            y = m_PendingPosition.y,
                            z = m_PendingPosition.z,
                        },
                        note = "committed this frame; verify via /city/buildings or /screenshot",
                    });
            }
        }

        private void CompletePending(BridgeResponse response)
        {
            m_PendingRequest?.Complete(response);
            m_PendingRequest = null;
        }

        private void Deactivate()
        {
            m_Stage = Stage.Idle;
            m_PendingRequest = null;
            m_PendingPrefab = null;
            m_PendingPrefabEntity = Entity.Null;
            m_PendingLabel = null;
            m_PendingTerraformPrefab = Entity.Null;
            m_PendingBrushPrefab = Entity.Null;
            m_PendingRoutePoints = null;
            m_PendingRouteConnections = null;
            m_PendingRouteWaypoints = null;
            m_PendingRouteTarget = Entity.Null;
            m_PendingDispatchRoute = Entity.Null;
            m_PendingDispatchPriority = 0f;
            m_PendingZonePrefabEntity = Entity.Null;
            m_PendingZoneName = null;
            m_PendingZoneCenter = default;
            m_PendingZoneRadius = 0f;
            m_PendingZoneOverwrite = false;
            m_PendingZoneDezone = false;
            m_PendingTransformPosition = default;
            m_PendingTransformRotation = quaternion.identity;
            m_PendingRoadAnchor = Entity.Null;
            m_PendingRoadCurvePosition = 0f;
            m_PendingStartRoadAnchor = Entity.Null;
            m_PendingEndRoadAnchor = Entity.Null;
            m_PendingHasStartRoadAnchor = false;
            m_PendingHasEndRoadAnchor = false;
            m_PendingStartRoadCurvePosition = 0f;
            m_PendingEndRoadCurvePosition = 1f;
            m_PendingPreview = null;
            if (m_ToolSystem.activeTool == this)
            {
                m_ToolSystem.activeTool = m_PreviousTool != null ? m_PreviousTool : m_DefaultToolSystem;
            }
            m_PreviousTool = null;
        }

        /// <summary>
        /// Creates a modify definition for the pending target, faithfully
        /// mirroring BulldozeToolSystem.AddEntity (CreationDefinition with
        /// m_Original + flags plus a NetCourse/ObjectDefinition describing the
        /// original). Used for Delete (bulldoze) and Upgrade (road upgrades:
        /// grass/trees/lighting...). The game's generate/apply systems handle
        /// all related cleanup/recreation — nodes, zone blocks, lanes — which a
        /// raw component edit would skip (and skipping corrupts state).
        /// </summary>
        private void CreateModifyDefinitions(CreationFlags flags, CompositionFlags upgrades)
        {
            Entity target = m_PendingTarget;
            EntityCommandBuffer commandBuffer = m_ToolOutputBarrier.CreateCommandBuffer();
            Entity e = commandBuffer.CreateEntity();
            var definition = new CreationDefinition
            {
                m_Original = target,
                m_Flags = flags,
            };
            commandBuffer.AddComponent(e, default(Updated));
            if (upgrades != default(CompositionFlags))
            {
                commandBuffer.AddComponent(e, new Game.Net.Upgraded { m_Flags = upgrades });
            }

            if (EntityManager.HasComponent<Game.Net.Edge>(target))
            {
                Game.Net.Edge edge = EntityManager.GetComponentData<Game.Net.Edge>(target);
                NetCourse course = default;
                course.m_Curve = EntityManager.GetComponentData<Game.Net.Curve>(target).m_Bezier;
                course.m_Length = MathUtils.Length(course.m_Curve);
                course.m_FixedIndex = EntityManager.HasComponent<Game.Net.Fixed>(target)
                    ? EntityManager.GetComponentData<Game.Net.Fixed>(target).m_Index
                    : -1;
                course.m_StartPosition.m_Entity = edge.m_Start;
                course.m_StartPosition.m_Position = course.m_Curve.a;
                course.m_StartPosition.m_Rotation = NetUtils.GetNodeRotation(MathUtils.StartTangent(course.m_Curve));
                course.m_StartPosition.m_CourseDelta = 0f;
                course.m_EndPosition.m_Entity = edge.m_End;
                course.m_EndPosition.m_Position = course.m_Curve.d;
                course.m_EndPosition.m_Rotation = NetUtils.GetNodeRotation(MathUtils.EndTangent(course.m_Curve));
                course.m_EndPosition.m_CourseDelta = 1f;
                commandBuffer.AddComponent(e, course);
            }
            else if (EntityManager.HasComponent<Transform>(target))
            {
                Transform transform = EntityManager.GetComponentData<Transform>(target);
                var objectDefinition = new ObjectDefinition
                {
                    m_Position = transform.m_Position,
                    m_Rotation = transform.m_Rotation,
                    m_Probability = 100,
                    m_PrefabSubIndex = -1,
                    m_LocalPosition = transform.m_Position,
                    m_LocalRotation = transform.m_Rotation,
                };
                if (EntityManager.HasComponent<Game.Objects.Elevation>(target))
                {
                    Game.Objects.Elevation elevation = EntityManager.GetComponentData<Game.Objects.Elevation>(target);
                    objectDefinition.m_Elevation = elevation.m_Elevation;
                    objectDefinition.m_ParentMesh = Game.Objects.ObjectUtils.GetSubParentMesh(elevation.m_Flags);
                }
                else
                {
                    objectDefinition.m_ParentMesh = -1;
                }
                commandBuffer.AddComponent(e, objectDefinition);
            }
            else if (EntityManager.HasBuffer<Game.Areas.Node>(target))
            {
                DynamicBuffer<Game.Areas.Node> nodes = EntityManager.GetBuffer<Game.Areas.Node>(target, isReadOnly: true);
                commandBuffer.AddBuffer<Game.Areas.Node>(e).CopyFrom(nodes.AsNativeArray());
            }

            commandBuffer.AddComponent(e, definition);
        }

        /// <summary>
        /// Creates an area definition (district/surface): CreationDefinition +
        /// polygon node buffer; elevation float.MinValue snaps nodes to terrain
        /// (mirrors the game's area definition flow).
        /// </summary>
        private void CreateAreaDefinitions()
        {
            EntityCommandBuffer commandBuffer = m_ToolOutputBarrier.CreateCommandBuffer();
            Entity e = commandBuffer.CreateEntity();
            Unity.Mathematics.Random random = RandomSeed.Next().GetRandom(0);
            commandBuffer.AddComponent(e, new CreationDefinition
            {
                m_Prefab = m_PendingPrefabEntity,
                m_RandomSeed = random.NextInt(),
            });
            commandBuffer.AddComponent(e, default(Updated));
            DynamicBuffer<Game.Areas.Node> nodes = commandBuffer.AddBuffer<Game.Areas.Node>(e);
            foreach (float3 position in m_PendingAreaNodes)
            {
                nodes.Add(new Game.Areas.Node(position, float.MinValue));
            }
        }

        /// <summary>
        /// Emits the game's native terrain brush definition from the tool
        /// system update, where ToolOutputBarrier permits ECB creation.
        /// </summary>
        private void CreateTerrainDefinitions()
        {
            EntityCommandBuffer commandBuffer = m_ToolOutputBarrier.CreateCommandBuffer();
            Entity definitionEntity = commandBuffer.CreateEntity();
            commandBuffer.AddComponent(definitionEntity, new CreationDefinition
            {
                m_Prefab = m_PendingBrushPrefab,
            });
            commandBuffer.AddComponent(definitionEntity, new BrushDefinition
            {
                m_Line = new Line3.Segment(m_PendingTerrainStart, m_PendingTerrainEnd),
                m_Size = 50f,
                m_Angle = 0f,
                m_Strength = m_PendingTerrainStrength,
                m_Time = UnityEngine.Time.deltaTime,
                m_Target = m_PendingTerrainTarget,
                m_Start = m_PendingTerrainStart,
                m_Tool = m_PendingTerraformPrefab,
            });
            commandBuffer.AddComponent<Updated>(definitionEntity);
        }

        /// <summary>
        /// Emits the same definition shape used by RouteToolSystem for a new
        /// route. The route prefab supplies the route archetypes and transport
        /// metadata; the native route systems create the permanent route,
        /// waypoint and segment entities from the point buffer.
        /// </summary>
        private void CreateTransportLineDefinitions()
        {
            EntityCommandBuffer commandBuffer = m_ToolOutputBarrier.CreateCommandBuffer();
            Entity definitionEntity = commandBuffer.CreateEntity();
            commandBuffer.AddComponent(definitionEntity, new CreationDefinition
            {
                m_Prefab = m_PendingPrefabEntity,
            });
            commandBuffer.AddComponent(definitionEntity, new ColorDefinition
            {
                m_Color = ((RoutePrefab)m_PendingPrefab).color,
            });
            DynamicBuffer<Game.Routes.WaypointDefinition> waypoints =
                commandBuffer.AddBuffer<Game.Routes.WaypointDefinition>(definitionEntity);
            foreach (float3 point in m_PendingRoutePoints)
            {
                waypoints.Add(new Game.Routes.WaypointDefinition(point));
                if (waypoints.Length > 0
                    && m_PendingRouteConnections != null
                    && waypoints.Length <= m_PendingRouteConnections.Length)
                {
                    Game.Routes.WaypointDefinition definition = waypoints[waypoints.Length - 1];
                    definition.m_Connection = m_PendingRouteConnections[waypoints.Length - 1];
                    waypoints[waypoints.Length - 1] = definition;
                }
            }
            commandBuffer.AddComponent<Updated>(definitionEntity);
        }

        /// <summary>
        /// Emits the route-tool definition shape for updating or deleting an
        /// existing transport line. The game derives the route prefab from
        /// the original route's PrefabRef, while each waypoint definition
        /// retains its original ECS entity for native reconciliation.
        /// </summary>
        private void CreateTransportLineMutationDefinitions()
        {
            EntityCommandBuffer commandBuffer = m_ToolOutputBarrier.CreateCommandBuffer();
            Entity definitionEntity = commandBuffer.CreateEntity();
            commandBuffer.AddComponent(definitionEntity, new CreationDefinition
            {
                m_Original = m_PendingRouteTarget,
                m_Flags = m_PendingKind == OperationKind.TransportLineDelete
                    ? CreationFlags.Delete
                    : (m_PendingRouteCardinalityChanged ? CreationFlags.Recreate : 0),
            });

            DynamicBuffer<Game.Routes.WaypointDefinition> waypoints =
                commandBuffer.AddBuffer<Game.Routes.WaypointDefinition>(definitionEntity);
            for (int i = 0; i < m_PendingRoutePoints.Length; i++)
            {
                var definition = new Game.Routes.WaypointDefinition(m_PendingRoutePoints[i])
                {
                    m_Original = m_PendingRouteWaypoints[i],
                    m_Connection = m_PendingRouteConnections[i],
                };
                waypoints.Add(definition);
            }
            commandBuffer.AddComponent<Updated>(definitionEntity);
        }

        private void CreateTransportDispatchDefinition()
        {
            EntityCommandBuffer commandBuffer = m_ToolOutputBarrier.CreateCommandBuffer();
            Entity requestEntity = commandBuffer.CreateEntity();
            commandBuffer.AddComponent(requestEntity, default(ServiceRequest));
            commandBuffer.AddComponent(requestEntity, new TransportVehicleRequest
            {
                m_Route = m_PendingDispatchRoute,
                m_Priority = m_PendingDispatchPriority,
            });
            commandBuffer.AddComponent(requestEntity, new RequestGroup(8u));
        }

        /// <summary>
        /// Emits the native relocation definition shape used by the object tool:
        /// original entity + Relocate flag + replacement transform. This keeps
        /// the game's ownership, sub-object, clear-area, and attachment systems
        /// in the apply path.
        /// </summary>
        private void CreateRelocateDefinitions()
        {
            EntityCommandBuffer commandBuffer = m_ToolOutputBarrier.CreateCommandBuffer();
            Entity definitionEntity = commandBuffer.CreateEntity();
            commandBuffer.AddComponent(definitionEntity, new CreationDefinition
            {
                m_Original = m_PendingTarget,
                m_Flags = CreationFlags.Relocate,
            });

            ObjectDefinition objectDefinition = default(ObjectDefinition);
            objectDefinition.m_Position = m_PendingTransformPosition;
            objectDefinition.m_LocalPosition = m_PendingTransformPosition;
            objectDefinition.m_Rotation = m_PendingTransformRotation;
            objectDefinition.m_LocalRotation = m_PendingTransformRotation;
            objectDefinition.m_Scale = 1f;
            objectDefinition.m_Intensity = 1f;
            objectDefinition.m_Probability = 100;
            objectDefinition.m_PrefabSubIndex = -1;
            objectDefinition.m_ParentMesh = -1;
            if (EntityManager.HasComponent<Game.Objects.Elevation>(m_PendingTarget))
            {
                objectDefinition.m_Elevation = EntityManager.GetComponentData<Game.Objects.Elevation>(m_PendingTarget).m_Elevation;
            }
            commandBuffer.AddComponent(definitionEntity, objectDefinition);
            commandBuffer.AddComponent<Updated>(definitionEntity);
        }

        /// <summary>
        /// Creates a standalone straight-road course definition from the pending
        /// start to end position, terrain-following (mirrors the standalone-net
        /// branch of the game's net definition flow).
        /// </summary>
        private void CreateRoadDefinitions()
        {
            TerrainHeightData terrainHeight = m_TerrainSystem.GetHeightData();

            Curve rawCurve = default;
            if (m_PendingHasMid)
            {
                // Quadratic bezier through the mid control point, elevated to cubic.
                float3 a = m_PendingPosition;
                float3 d = m_PendingEnd;
                float3 m = m_PendingMid;
                rawCurve.m_Bezier = new Bezier4x3(a, a + (m - a) * (2f / 3f), d + (m - d) * (2f / 3f), d);
            }
            else
            {
                rawCurve.m_Bezier = NetUtils.StraightCurve(m_PendingPosition, m_PendingEnd);
            }
            Bezier4x3 adjusted = NetUtils.AdjustPosition(
                rawCurve, fixedStart: false, linearMiddle: false, fixedEnd: false, ref terrainHeight).m_Bezier;

            float e1 = m_PendingElevations.x;
            float e2 = m_PendingElevations.y;
            if (e1 != 0f || e2 != 0f)
            {
                // Lift the terrain-following curve by linearly interpolated
                // elevation; the pipeline turns nonzero course elevations into
                // bridge/elevated segments with pillars.
                adjusted.a.y += e1;
                adjusted.b.y += math.lerp(e1, e2, 1f / 3f);
                adjusted.c.y += math.lerp(e1, e2, 2f / 3f);
                adjusted.d.y += e2;
            }

            NetCourse course = default;
            course.m_Curve = adjusted;
            course.m_Elevation = new float2(math.min(e1, e2), math.max(e1, e2));
            course.m_StartPosition.m_Position = course.m_Curve.a;
            course.m_StartPosition.m_Rotation = NetUtils.GetNodeRotation(MathUtils.StartTangent(course.m_Curve));
            course.m_StartPosition.m_CourseDelta = 0f;
            course.m_StartPosition.m_ParentMesh = -1;
            course.m_StartPosition.m_Elevation = e1;
            course.m_StartPosition.m_Flags = CoursePosFlags.IsFirst | CoursePosFlags.FreeHeight;
            if (m_PendingHasStartRoadAnchor)
            {
                course.m_StartPosition.m_Entity = m_PendingStartRoadAnchor;
                course.m_StartPosition.m_CourseDelta = m_PendingStartRoadCurvePosition;
                course.m_StartPosition.m_SplitPosition = m_PendingStartRoadCurvePosition;
            }
            course.m_EndPosition.m_Position = course.m_Curve.d;
            course.m_EndPosition.m_Rotation = NetUtils.GetNodeRotation(MathUtils.EndTangent(course.m_Curve));
            course.m_EndPosition.m_CourseDelta = 1f;
            course.m_EndPosition.m_ParentMesh = -1;
            course.m_EndPosition.m_Elevation = e2;
            course.m_EndPosition.m_Flags = CoursePosFlags.IsLast | CoursePosFlags.FreeHeight;
            if (m_PendingHasEndRoadAnchor)
            {
                course.m_EndPosition.m_Entity = m_PendingEndRoadAnchor;
                course.m_EndPosition.m_CourseDelta = m_PendingEndRoadCurvePosition;
                course.m_EndPosition.m_SplitPosition = m_PendingEndRoadCurvePosition;
            }
            course.m_Length = MathUtils.Length(course.m_Curve);
            course.m_FixedIndex = -1;

            Unity.Mathematics.Random random = RandomSeed.Next().GetRandom(0);
            EntityCommandBuffer commandBuffer = m_ToolOutputBarrier.CreateCommandBuffer();
            Entity entity = commandBuffer.CreateEntity();
            commandBuffer.AddComponent(entity, new CreationDefinition
            {
                m_Prefab = m_PendingPrefabEntity,
                m_RandomSeed = random.NextInt(),
            });
            commandBuffer.AddComponent(entity, default(Updated));
            commandBuffer.AddComponent(entity, course);
        }

        /// <summary>
        /// Fills and synchronously executes the ported LineTool definition job
        /// for a single object at the pending position/rotation.
        /// </summary>
        private void CreatePlacementDefinitions()
        {
            // Transport facilities are not ordinary props/buildings.  Their
            // prefab expansion creates owned station/depot/stop entities that
            // are consumed by several simulation systems immediately after
            // placement.  Use the game's own ObjectToolBaseSystem pipeline for
            // these prefabs so all runtime lookups and attachment metadata are
            // populated exactly as they are for a UI placement.  Keep the
            // older synchronous port for the already verified generic object
            // path until it can be retired independently.
            if (IsTransportFacilityPrefab() || IsTransportStopPrefab(m_PendingPrefabEntity))
            {
                CreateNativeTransportObjectDefinitions();
                return;
            }

            CreateDefinitions definitions = default;
            definitions.m_RandomizationEnabled = false;
            definitions.m_FixedRandomSeed = 0;
            definitions.m_EditorMode = m_ToolSystem.actionMode.IsEditor();
            definitions.m_LefthandTraffic = m_CityConfigurationSystem.leftHandTraffic;
            definitions.m_ObjectPrefab = m_PendingPrefabEntity;
            definitions.m_Theme = m_CityConfigurationSystem.defaultTheme;
            definitions.m_RandomSeed = RandomSeed.Next();
            definitions.m_AgeMask = AgeMask.Mature;
            definitions.m_ControlPoint = new ControlPoint
            {
                m_Position = m_PendingPosition,
                m_HitPosition = m_PendingPosition,
                m_Direction = new float2(
                    math.mul(m_PendingRotation, new float3(0f, 0f, 1f)).x,
                    math.mul(m_PendingRotation, new float3(0f, 0f, 1f)).z),
                m_HitDirection = new float3(0f, 1f, 0f),
                m_Rotation = m_PendingRotation,
                m_OriginalEntity = m_PendingRoadAnchor,
                m_ElementIndex = new int2(-1, -1),
                m_CurvePosition = m_PendingRoadCurvePosition,
                m_Elevation = m_PendingPosition.y,
            };
            definitions.m_AttachmentPrefab = default;
            definitions.m_OwnerData = GetComponentLookup<Owner>(true);
            definitions.m_TransformData = GetComponentLookup<Transform>(true);
            definitions.m_AttachedData = GetComponentLookup<Game.Objects.Attached>(true);
            definitions.m_LocalTransformCacheData = GetComponentLookup<LocalTransformCache>(true);
            definitions.m_ElevationData = GetComponentLookup<Game.Objects.Elevation>(true);
            definitions.m_BuildingData = GetComponentLookup<Game.Buildings.Building>(true);
            definitions.m_LotData = GetComponentLookup<Game.Buildings.Lot>(true);
            definitions.m_EdgeData = GetComponentLookup<Game.Net.Edge>(true);
            definitions.m_NodeData = GetComponentLookup<Game.Net.Node>(true);
            definitions.m_CurveData = GetComponentLookup<Game.Net.Curve>(true);
            definitions.m_NetElevationData = GetComponentLookup<Game.Net.Elevation>(true);
            definitions.m_OrphanData = GetComponentLookup<Game.Net.Orphan>(true);
            definitions.m_UpgradedData = GetComponentLookup<Game.Net.Upgraded>(true);
            definitions.m_CompositionData = GetComponentLookup<Game.Net.Composition>(true);
            definitions.m_AreaClearData = GetComponentLookup<Game.Areas.Clear>(true);
            definitions.m_AreaSpaceData = GetComponentLookup<Game.Areas.Space>(true);
            definitions.m_AreaLotData = GetComponentLookup<Game.Areas.Lot>(true);
            definitions.m_EditorContainerData = GetComponentLookup<Game.Tools.EditorContainer>(true);
            definitions.m_PrefabRefData = GetComponentLookup<PrefabRef>(true);
            definitions.m_PrefabNetObjectData = GetComponentLookup<NetObjectData>(true);
            definitions.m_PrefabBuildingData = GetComponentLookup<BuildingData>(true);
            definitions.m_PrefabAssetStampData = GetComponentLookup<AssetStampData>(true);
            definitions.m_PrefabBuildingExtensionData = GetComponentLookup<BuildingExtensionData>(true);
            definitions.m_PrefabSpawnableObjectData = GetComponentLookup<SpawnableObjectData>(true);
            definitions.m_PrefabObjectGeometryData = GetComponentLookup<ObjectGeometryData>(true);
            definitions.m_PrefabPlaceableObjectData = GetComponentLookup<PlaceableObjectData>(true);
            definitions.m_PrefabAreaGeometryData = GetComponentLookup<AreaGeometryData>(true);
            definitions.m_PrefabBuildingTerraformData = GetComponentLookup<BuildingTerraformData>(true);
            definitions.m_PrefabCreatureSpawnData = GetComponentLookup<CreatureSpawnData>(true);
            definitions.m_PlaceholderBuildingData = GetComponentLookup<PlaceholderBuildingData>(true);
            definitions.m_PrefabNetGeometryData = GetComponentLookup<NetGeometryData>(true);
            definitions.m_PrefabCompositionData = GetComponentLookup<NetCompositionData>(true);
            definitions.m_SubObjects = GetBufferLookup<Game.Objects.SubObject>(true);
            definitions.m_CachedNodes = GetBufferLookup<LocalNodeCache>(true);
            definitions.m_InstalledUpgrades = GetBufferLookup<Game.Buildings.InstalledUpgrade>(true);
            definitions.m_SubNets = GetBufferLookup<Game.Net.SubNet>(true);
            definitions.m_ConnectedEdges = GetBufferLookup<Game.Net.ConnectedEdge>(true);
            definitions.m_SubAreas = GetBufferLookup<Game.Areas.SubArea>(true);
            definitions.m_AreaNodes = GetBufferLookup<Game.Areas.Node>(true);
            definitions.m_AreaTriangles = GetBufferLookup<Game.Areas.Triangle>(true);
            definitions.m_PrefabSubObjects = GetBufferLookup<Game.Prefabs.SubObject>(true);
            definitions.m_PrefabSubNets = GetBufferLookup<Game.Prefabs.SubNet>(true);
            definitions.m_PrefabSubLanes = GetBufferLookup<Game.Prefabs.SubLane>(true);
            definitions.m_PrefabSubAreas = GetBufferLookup<Game.Prefabs.SubArea>(true);
            definitions.m_PrefabSubAreaNodes = GetBufferLookup<SubAreaNode>(true);
            definitions.m_PrefabPlaceholderElements = GetBufferLookup<PlaceholderObjectElement>(true);
            definitions.m_PrefabRequirementElements = GetBufferLookup<ObjectRequirementElement>(true);
            definitions.m_PrefabServiceUpgradeBuilding = GetBufferLookup<ServiceUpgradeBuilding>(true);
            definitions.m_WaterSurfaceData = m_WaterSystem.GetSurfaceData(out _);
            definitions.m_TerrainHeightData = m_TerrainSystem.GetHeightData();
            definitions.m_CommandBuffer = m_ToolOutputBarrier.CreateCommandBuffer();
            definitions.Execute();
        }

        private static bool IsTransportFacilityPrefab(PrefabBase prefab)
        {
            if (prefab == null)
            {
                return false;
            }

            string name = prefab.name ?? string.Empty;
            return name.IndexOf("Station", StringComparison.OrdinalIgnoreCase) >= 0
                || name.IndexOf("Depot", StringComparison.OrdinalIgnoreCase) >= 0
                || name.IndexOf("Yard", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private bool IsTransportFacilityPrefab()
        {
            return IsTransportFacilityPrefab(m_PendingPrefab);
        }

        private bool IsTransportStopPrefab(Entity prefabEntity)
        {
            return prefabEntity != Entity.Null
                && EntityManager.HasComponent<TransportStopData>(prefabEntity);
        }

        /// <summary>
        /// Finds the closest live road edge and its normalized curve position.
        /// The vanilla object tool receives this information from its raycast;
        /// supplying it here is necessary for transport facilities whose
        /// building prefab requires a road attachment.
        /// </summary>
        private bool TryFindNearestRoadAnchor(float3 position, out Entity roadEntity, out float curvePosition)
        {
            roadEntity = Entity.Null;
            curvePosition = 0f;
            float bestDistance = 80f;
            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            EntityQuery query = EntityManager.CreateEntityQuery(new EntityQueryDesc
            {
                All = new[]
                {
                    ComponentType.ReadOnly<Game.Net.Edge>(),
                    ComponentType.ReadOnly<Game.Net.Curve>(),
                    ComponentType.ReadOnly<PrefabRef>(),
                },
                None = new[]
                {
                    ComponentType.ReadOnly<Game.Tools.Temp>(),
                    ComponentType.ReadOnly<Game.Common.Deleted>(),
                    ComponentType.ReadOnly<Game.Common.Owner>(),
                },
            });

            using (NativeArray<Entity> entities = query.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    PrefabRef prefabRef = EntityManager.GetComponentData<PrefabRef>(entity);
                    PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(prefabRef.m_Prefab);
                    if (!(prefab is RoadPrefab))
                    {
                        continue;
                    }

                    Bezier4x3 bezier = EntityManager.GetComponentData<Game.Net.Curve>(entity).m_Bezier;
                    float bestT = 0f;
                    float bestLocalDistance = float.MaxValue;
                    const int samples = 32;
                    for (int i = 0; i <= samples; i++)
                    {
                        float t = i / (float)samples;
                        float3 point = EvaluateBezier(bezier, t);
                        float distance = math.distance(point.xz, position.xz);
                        if (distance < bestLocalDistance)
                        {
                            bestLocalDistance = distance;
                            bestT = t;
                        }
                    }

                    if (bestLocalDistance < bestDistance)
                    {
                        bestDistance = bestLocalDistance;
                        roadEntity = entity;
                        curvePosition = bestT;
                    }
                }
            }

            return roadEntity != Entity.Null;
        }

        private static float3 EvaluateBezier(Bezier4x3 bezier, float t)
        {
            float oneMinusT = 1f - t;
            return oneMinusT * oneMinusT * oneMinusT * bezier.a
                + 3f * oneMinusT * oneMinusT * t * bezier.b
                + 3f * oneMinusT * t * t * bezier.c
                + t * t * t * bezier.d;
        }

        /// <summary>
        /// Calls the installed game's own object-definition pipeline for a
        /// transport facility.  The request is already on the simulation
        /// thread, so completing the returned handle here gives the next
        /// BridgeToolSystem stage a fully materialized definition set while
        /// preserving the game's command-buffer and component expansion path.
        /// </summary>
        private void CreateNativeTransportObjectDefinitions()
        {
            NativeList<ControlPoint> controlPoints = new NativeList<ControlPoint>(1, Allocator.TempJob);
            quaternion rotation = m_PendingRotation;
            float3 forward = math.mul(rotation, new float3(0f, 0f, 1f));
            controlPoints.Add(new ControlPoint
            {
                m_Position = m_PendingPosition,
                m_HitPosition = m_PendingPosition,
                m_Direction = new float2(forward.x, forward.z),
                m_HitDirection = new float3(0f, 1f, 0f),
                m_Rotation = rotation,
                m_OriginalEntity = m_PendingRoadAnchor,
                m_SnapPriority = float2.zero,
                m_ElementIndex = new int2(-1, -1),
                m_CurvePosition = m_PendingRoadCurvePosition,
                m_Elevation = m_PendingPosition.y,
            });

            try
            {
                JobHandle definitions = base.CreateDefinitions(
                    m_PendingPrefabEntity,
                    Entity.Null,
                    Entity.Null,
                    Entity.Null,
                    Entity.Null,
                    Entity.Null,
                    m_CityConfigurationSystem.defaultTheme,
                    controlPoints,
                    default,
                    m_ToolSystem.actionMode.IsEditor(),
                    m_CityConfigurationSystem.leftHandTraffic,
                    false,
                    false,
                    0f,
                    0f,
                    0f,
                    0f,
                    UnityEngine.Time.deltaTime,
                    RandomSeed.Next(),
                    Snap.All,
                    AgeMask.Mature,
                    false,
                    default);
                definitions.Complete();
            }
            finally
            {
                if (controlPoints.IsCreated)
                {
                    controlPoints.Dispose();
                }
            }
        }

        /// <summary>
        /// Emits the same definition shape as the game's ZoneToolSystem for a
        /// bounded marquee operation.  The zone systems then perform the
        /// road-frontage, blocked-cell, occupancy, and grid-cell validation;
        /// this method intentionally does not rewrite Block/Cell buffers.
        /// </summary>
        private void CreateZoningDefinitions()
        {
            TerrainHeightData terrainHeight = m_TerrainSystem.GetHeightData();
            float radius = math.clamp(m_PendingZoneRadius, 8f, 200f);
            float3 center = m_PendingZoneCenter;
            float3 right = new float3(radius, 0f, 0f);
            float3 forward = new float3(0f, 0f, radius);
            float3 a = center - right - forward;
            float3 b = center - right + forward;
            float3 c = center + right + forward;
            float3 d = center + right - forward;
            a.y = TerrainUtils.SampleHeight(ref terrainHeight, a);
            b.y = TerrainUtils.SampleHeight(ref terrainHeight, b);
            c.y = TerrainUtils.SampleHeight(ref terrainHeight, c);
            d.y = TerrainUtils.SampleHeight(ref terrainHeight, d);

            EntityCommandBuffer commandBuffer = m_ToolOutputBarrier.CreateCommandBuffer();
            Entity definitionEntity = commandBuffer.CreateEntity();
            commandBuffer.AddComponent(definitionEntity, new CreationDefinition
            {
                m_Prefab = m_PendingZonePrefabEntity,
                m_RandomSeed = RandomSeed.Next().GetRandom(0).NextInt(),
            });
            commandBuffer.AddComponent<Updated>(definitionEntity);
            commandBuffer.AddComponent(definitionEntity, new Zoning
            {
                m_Position = new Quad3(a, b, c, d),
                m_Flags = ZoningFlags.Marquee
                    | (m_PendingZoneDezone ? ZoningFlags.Dezone | ZoningFlags.Overwrite : ZoningFlags.Zone
                        | (m_PendingZoneOverwrite ? ZoningFlags.Overwrite : 0)),
            });
        }
    }
}
