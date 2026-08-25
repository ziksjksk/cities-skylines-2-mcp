using System;
using System.Collections.Generic;
using Game;
using Game.Notifications;
using Game.Prefabs;
using Game.Rendering;
using Game.Simulation;
using Game.Zones;
using Newtonsoft.Json.Linq;
using Unity.Collections;
using Unity.Entities;
using Unity.Jobs;
using Unity.Mathematics;
using UnityEngine;

namespace CS2MCP
{
    /// <summary>
    /// Perception endpoints: camera control (for AI-directed screenshots),
    /// terrain/water export, cell-map grids (land value, pollution, ground
    /// water), zoning readback, warning-icon listing and entity inspection.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private const float kWorldHalfSize = 7168f; // CellMapSystem.kMapSize / 2

        private EntityQuery m_IconQuery;
        private bool m_IconQueryCreated;

        private EntityQuery IconQuery
        {
            get
            {
                if (!m_IconQueryCreated)
                {
                    m_IconQuery = EntityManager.CreateEntityQuery(new EntityQueryDesc
                    {
                        All = new[]
                        {
                            ComponentType.ReadOnly<Icon>(),
                            ComponentType.ReadOnly<PrefabRef>(),
                        },
                        None = new[]
                        {
                            ComponentType.ReadOnly<Game.Tools.Temp>(),
                            ComponentType.ReadOnly<Game.Common.Deleted>(),
                        },
                    });
                    m_IconQueryCreated = true;
                }
                return m_IconQuery;
            }
        }

        private BridgeResponse GetCamera()
        {
            CameraUpdateSystem cameraSystem = World.GetOrCreateSystemManaged<CameraUpdateSystem>();
            CameraController controller = cameraSystem.gamePlayController;
            if (controller == null)
            {
                return BridgeResponse.Error(503, "gameplay camera controller not available (still loading?)");
            }
            return BridgeResponse.Json(new
            {
                pivot = new { x = controller.pivot.x, y = controller.pivot.y, z = controller.pivot.z },
                position = new { x = controller.position.x, y = controller.position.y, z = controller.position.z },
                angle = new { x = controller.angle.x, y = controller.angle.y },
                zoom = controller.zoom,
                note = "pivot = look-at point; angle.x = compass rotation deg, angle.y = tilt deg; zoom = distance",
            });
        }

        private BridgeResponse SetCamera(BridgeRequest request)
        {
            CameraUpdateSystem cameraSystem = World.GetOrCreateSystemManaged<CameraUpdateSystem>();
            CameraController controller = cameraSystem.gamePlayController;
            if (controller == null)
            {
                return BridgeResponse.Error(503, "gameplay camera controller not available (still loading?)");
            }

            bool changed = false;
            bool hasX = request.TryGetFloat("x", out float x);
            bool hasZ = request.TryGetFloat("z", out float z);
            if (hasX && hasZ)
            {
                float y;
                if (!request.TryGetFloat("y", out y))
                {
                    TerrainSystem terrain = World.GetOrCreateSystemManaged<TerrainSystem>();
                    TerrainHeightData heightData = terrain.GetHeightData();
                    y = TerrainUtils.SampleHeight(ref heightData, new float3(x, 0f, z));
                }
                controller.pivot = new Vector3(x, y, z);
                changed = true;
            }
            if (request.TryGetFloat("angleX", out float angleX) | request.TryGetFloat("angleY", out float angleY))
            {
                float2 angle = controller.angle;
                if (request.Query.ContainsKey("angleX"))
                {
                    angle.x = angleX;
                }
                if (request.Query.ContainsKey("angleY"))
                {
                    angle.y = math.clamp(angleY, 0f, 89f);
                }
                controller.angle = angle;
                changed = true;
            }
            if (request.TryGetFloat("zoom", out float zoom))
            {
                controller.zoom = math.clamp(zoom, 10f, 10000f);
                changed = true;
            }

            if (!changed)
            {
                return BridgeResponse.Error(400, "provide at least one of: x&z (pivot, y optional), angleX, angleY, zoom");
            }
            return GetCamera();
        }

        private BridgeResponse GetTerrain(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            int resolution = request.TryGetInt("resolution", out int rawResolution)
                ? math.clamp(rawResolution, 16, 256)
                : 64;

            TerrainSystem terrain = World.GetOrCreateSystemManaged<TerrainSystem>();
            TerrainHeightData heightData = terrain.GetHeightData();
            WaterSystem water = World.GetOrCreateSystemManaged<WaterSystem>();
            WaterSurfaceData<SurfaceWater> surfaceData = water.GetSurfaceData(out JobHandle waterDeps);
            waterDeps.Complete();
            bool rawHeights = request.TryGetBool("raw", out bool requestedRawHeights)
                && requestedRawHeights;

            float step = kWorldHalfSize * 2f / resolution;
            var heights = new List<float>(resolution * resolution);
            var waterDepths = new List<float>(resolution * resolution);
            for (int row = 0; row < resolution; row++)
            {
                float worldZ = -kWorldHalfSize + (row + 0.5f) * step;
                for (int col = 0; col < resolution; col++)
                {
                    float worldX = -kWorldHalfSize + (col + 0.5f) * step;
                    var samplePosition = new float3(worldX, 0f, worldZ);
                    float height = TerrainUtils.SampleHeight(ref heightData, samplePosition);
                    heights.Add(rawHeights ? height : (float)Math.Round(height, 1));
                    float depth = WaterUtils.SampleDepth(ref surfaceData, samplePosition);
                    waterDepths.Add(depth > 0.05f ? (float)Math.Round(depth, 1) : 0f);
                }
            }

            return BridgeResponse.Json(new
            {
                resolution,
                worldMin = -kWorldHalfSize,
                worldMax = kWorldHalfSize,
                cellSize = step,
                note = rawHeights
                    ? "raw heights enabled; values are native TerrainSystem samples in meters"
                    : "row-major: index = row*resolution + col; world x = worldMin+(col+0.5)*cellSize, world z = worldMin+(row+0.5)*cellSize; heights in meters rounded to 0.1m; add &raw=true for native precision",
                heights,
                waterDepths,
            });
        }

        private BridgeResponse GetTerrainSamples(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            if (!request.Query.TryGetValue("points", out string rawPoints) || string.IsNullOrWhiteSpace(rawPoints))
            {
                return BridgeResponse.Error(400, "provide ?points=<JSON array of {x,z} samples>");
            }

            var points = new List<float3>();
            try
            {
                JToken parsed = JToken.Parse(rawPoints);
                if (parsed is not JArray array || array.Count == 0 || array.Count > 256)
                {
                    return BridgeResponse.Error(400, "points must be a non-empty JSON array with at most 256 points");
                }
                foreach (JToken token in array)
                {
                    if (token is not JObject point
                        || !TryReadFloat(point, "x", out float x)
                        || !TryReadFloat(point, "z", out float z))
                    {
                        return BridgeResponse.Error(400, "each terrain sample must contain numeric x and z fields");
                    }
                    points.Add(new float3(x, 0f, z));
                }
            }
            catch (Exception exception)
            {
                return BridgeResponse.Error(400, $"invalid points JSON: {exception.Message}");
            }

            TerrainSystem terrain = World.GetOrCreateSystemManaged<TerrainSystem>();
            TerrainHeightData heightData = terrain.GetHeightData();
            WaterSystem water = World.GetOrCreateSystemManaged<WaterSystem>();
            WaterSurfaceData<SurfaceWater> surfaceData = water.GetSurfaceData(out JobHandle waterDeps);
            waterDeps.Complete();
            bool raw = request.TryGetBool("raw", out bool requestedRaw) && requestedRaw;
            var samples = new List<object>(points.Count);
            foreach (float3 point in points)
            {
                float height = TerrainUtils.SampleHeight(ref heightData, point);
                float depth = WaterUtils.SampleDepth(ref surfaceData, point);
                samples.Add(new
                {
                    x = point.x,
                    z = point.z,
                    height = raw ? height : (float)Math.Round(height, 3),
                    waterDepth = depth > 0.01f ? (raw ? depth : (float)Math.Round(depth, 3)) : 0f,
                });
            }
            return BridgeResponse.Json(new
            {
                success = true,
                raw,
                returned = samples.Count,
                samples,
                note = "native TerrainSystem/WaterSystem point sampling; use this endpoint before and after /terraform for readback",
            });
        }

        private BridgeResponse GetGridMap(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            if (!request.Query.TryGetValue("layer", out string layer) || string.IsNullOrEmpty(layer))
            {
                return BridgeResponse.Error(400,
                    "provide ?layer=landValue|groundPollution|airPollution|noisePollution|groundWater|groundWaterPollution");
            }

            JobHandle deps;
            List<float> values;
            int sourceSize;
            string unit;
            switch (layer.ToLowerInvariant())
            {
                case "landvalue":
                {
                    NativeArray<LandValueCell> map = World.GetOrCreateSystemManaged<LandValueSystem>().GetMap(readOnly: true, out deps);
                    deps.Complete();
                    sourceSize = (int)math.round(math.sqrt(map.Length));
                    values = SampleGrid(map.Length, i => map[i].m_LandValue);
                    unit = "land value per cell";
                    break;
                }
                case "groundpollution":
                {
                    NativeArray<GroundPollution> map = World.GetOrCreateSystemManaged<GroundPollutionSystem>().GetMap(readOnly: true, out deps);
                    deps.Complete();
                    sourceSize = (int)math.round(math.sqrt(map.Length));
                    values = SampleGrid(map.Length, i => map[i].m_Pollution);
                    unit = "pollution amount";
                    break;
                }
                case "airpollution":
                {
                    NativeArray<AirPollution> map = World.GetOrCreateSystemManaged<AirPollutionSystem>().GetMap(readOnly: true, out deps);
                    deps.Complete();
                    sourceSize = (int)math.round(math.sqrt(map.Length));
                    values = SampleGrid(map.Length, i => map[i].m_Pollution);
                    unit = "pollution amount";
                    break;
                }
                case "noisepollution":
                {
                    NativeArray<NoisePollution> map = World.GetOrCreateSystemManaged<NoisePollutionSystem>().GetMap(readOnly: true, out deps);
                    deps.Complete();
                    sourceSize = (int)math.round(math.sqrt(map.Length));
                    values = SampleGrid(map.Length, i => map[i].m_Pollution);
                    unit = "noise amount";
                    break;
                }
                case "groundwater":
                {
                    NativeArray<GroundWater> map = World.GetOrCreateSystemManaged<GroundWaterSystem>().GetMap(readOnly: true, out deps);
                    deps.Complete();
                    sourceSize = (int)math.round(math.sqrt(map.Length));
                    values = SampleGrid(map.Length, i => map[i].m_Amount);
                    unit = "ground water amount";
                    break;
                }
                case "groundwaterpollution":
                {
                    NativeArray<GroundWater> map = World.GetOrCreateSystemManaged<GroundWaterSystem>().GetMap(readOnly: true, out deps);
                    deps.Complete();
                    sourceSize = (int)math.round(math.sqrt(map.Length));
                    values = SampleGrid(map.Length, i => map[i].m_Polluted);
                    unit = "polluted ground water amount";
                    break;
                }
                default:
                    return BridgeResponse.Error(400, $"unknown layer '{layer}'");
            }

            return BridgeResponse.Json(new
            {
                layer,
                textureSize = sourceSize,
                worldMin = -kWorldHalfSize,
                worldMax = kWorldHalfSize,
                cellSize = kWorldHalfSize * 2f / sourceSize,
                unit,
                note = "row-major over the game's native cell map; index = row*textureSize + col (row = z axis)",
                values,
            });
        }

        private static List<float> SampleGrid(int length, Func<int, float> selector)
        {
            var result = new List<float>(length);
            for (int i = 0; i < length; i++)
            {
                result.Add(selector(i));
            }
            return result;
        }

        private BridgeResponse GetZoning(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            bool hasCenter = request.TryGetFloat("x", out float x) & request.TryGetFloat("z", out float z);
            float radius = request.TryGetFloat("radius", out float rawRadius) ? math.max(rawRadius, 8f) : float.MaxValue;
            float2 center = new float2(x, z);

            // zone type index -> prefab name
            var zoneNames = new Dictionary<ushort, string>();
            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            using (NativeArray<Entity> zonePrefabs = ZonePrefabQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in zonePrefabs)
                {
                    PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(entity);
                    if (prefab != null)
                    {
                        zoneNames[EntityManager.GetComponentData<ZoneData>(entity).m_ZoneType.m_Index] = prefab.name;
                    }
                }
            }

            var byZone = new Dictionary<string, int[]>(); // name -> [cells, occupied]
            int totalVisible = 0;
            int totalZoned = 0;
            using (NativeArray<Entity> blocks = ZoneBlockQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity blockEntity in blocks)
                {
                    Block block = EntityManager.GetComponentData<Block>(blockEntity);
                    if (hasCenter && radius < float.MaxValue)
                    {
                        float blockExtent = kCellSize * (math.cmax(block.m_Size) + 1) * 0.71f;
                        if (math.distance(block.m_Position.xz, center) > radius + blockExtent)
                        {
                            continue;
                        }
                    }
                    DynamicBuffer<Cell> cells = EntityManager.GetBuffer<Cell>(blockEntity, isReadOnly: true);
                    for (int i = 0; i < cells.Length; i++)
                    {
                        Cell cell = cells[i];
                        if ((cell.m_State & CellFlags.Visible) == 0)
                        {
                            continue;
                        }
                        if (hasCenter && radius < float.MaxValue)
                        {
                            int2 cellIndex = new int2(i % block.m_Size.x, i / block.m_Size.x);
                            if (math.distance(ZoneUtils.GetCellPosition(block, cellIndex).xz, center) > radius)
                            {
                                continue;
                            }
                        }
                        totalVisible++;
                        if (cell.m_Zone.Equals(ZoneType.None))
                        {
                            continue;
                        }
                        totalZoned++;
                        string name = zoneNames.TryGetValue(cell.m_Zone.m_Index, out string zoneName) ? zoneName : $"<index {cell.m_Zone.m_Index}>";
                        if (!byZone.TryGetValue(name, out int[] counts))
                        {
                            counts = new int[2];
                            byZone[name] = counts;
                        }
                        counts[0]++;
                        if ((cell.m_State & CellFlags.Occupied) != 0)
                        {
                            counts[1]++;
                        }
                    }
                }
            }

            var zones = new Dictionary<string, object>();
            foreach (KeyValuePair<string, int[]> pair in byZone)
            {
                zones[pair.Key] = new { cells = pair.Value[0], occupied = pair.Value[1], empty = pair.Value[0] - pair.Value[1] };
            }

            return BridgeResponse.Json(new
            {
                scope = hasCenter && radius < float.MaxValue ? $"radius {radius} around ({x}, {z})" : "whole city",
                zonableCells = totalVisible,
                zonedCells = totalZoned,
                note = "empty zoned cells grow buildings while the simulation runs if demand exists",
                byZone = zones,
            });
        }

        private BridgeResponse GetNotifications(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            int limit = request.TryGetInt("limit", out int rawLimit) ? math.clamp(rawLimit, 1, 500) : 100;
            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();

            var counts = new Dictionary<string, int>();
            var items = new List<object>();
            int total = 0;
            using (NativeArray<Entity> icons = IconQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity iconEntity in icons)
                {
                    Icon icon = EntityManager.GetComponentData<Icon>(iconEntity);
                    PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(EntityManager.GetComponentData<PrefabRef>(iconEntity).m_Prefab);
                    string type = prefab != null ? prefab.name : "<unknown>";
                    total++;
                    counts[type] = counts.TryGetValue(type, out int c) ? c + 1 : 1;
                    if (items.Count < limit)
                    {
                        object target = null;
                        if (EntityManager.HasComponent<Game.Common.Owner>(iconEntity))
                        {
                            Entity owner = EntityManager.GetComponentData<Game.Common.Owner>(iconEntity).m_Owner;
                            string ownerPrefab = null;
                            if (EntityManager.HasComponent<PrefabRef>(owner))
                            {
                                PrefabBase op = prefabSystem.GetPrefab<PrefabBase>(EntityManager.GetComponentData<PrefabRef>(owner).m_Prefab);
                                ownerPrefab = op != null ? op.name : null;
                            }
                            target = new { index = owner.Index, version = owner.Version, prefab = ownerPrefab };
                        }
                        items.Add(new
                        {
                            type,
                            priority = (int)icon.m_Priority,
                            location = new { x = icon.m_Location.x, y = icon.m_Location.y, z = icon.m_Location.z },
                            target,
                        });
                    }
                }
            }

            return BridgeResponse.Json(new
            {
                total,
                returned = items.Count,
                countsByType = counts,
                note = "in-world warning icons (no electricity/water, garbage piling, abandoned...); use target with /entity/inspect",
                notifications = items,
            });
        }

        private BridgeResponse InspectEntity(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            if (!request.TryGetInt("index", out int index) || !request.TryGetInt("version", out int version))
            {
                return BridgeResponse.Error(400, "provide ?index=<int>&version=<int>");
            }
            var entity = new Entity { Index = index, Version = version };
            if (!EntityManager.Exists(entity))
            {
                return BridgeResponse.Error(404, $"entity {index}:{version} does not exist");
            }

            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            var result = new Dictionary<string, object>
            {
                ["entity"] = new { index, version },
            };

            if (EntityManager.HasComponent<PrefabRef>(entity))
            {
                PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(EntityManager.GetComponentData<PrefabRef>(entity).m_Prefab);
                result["prefab"] = prefab != null ? prefab.name : null;
            }
            if (EntityManager.HasComponent<Game.Objects.Transform>(entity))
            {
                Game.Objects.Transform transform = EntityManager.GetComponentData<Game.Objects.Transform>(entity);
                result["position"] = new { x = transform.m_Position.x, y = transform.m_Position.y, z = transform.m_Position.z };
                result["rotation"] = new { x = transform.m_Rotation.value.x, y = transform.m_Rotation.value.y, z = transform.m_Rotation.value.z, w = transform.m_Rotation.value.w };
            }

            if (EntityManager.HasComponent<Game.Net.Curve>(entity))
            {
                Game.Net.Curve curve = EntityManager.GetComponentData<Game.Net.Curve>(entity);
                object upgrades = null;
                if (EntityManager.HasComponent<Game.Net.Upgraded>(entity))
                {
                    Game.Net.Upgraded upgraded = EntityManager.GetComponentData<Game.Net.Upgraded>(entity);
                    upgrades = new
                    {
                        general = upgraded.m_Flags.m_General.ToString(),
                        left = upgraded.m_Flags.m_Left.ToString(),
                        right = upgraded.m_Flags.m_Right.ToString(),
                    };
                }
                result["network"] = new
                {
                    start = new { x = curve.m_Bezier.a.x, y = curve.m_Bezier.a.y, z = curve.m_Bezier.a.z },
                    end = new { x = curve.m_Bezier.d.x, y = curve.m_Bezier.d.y, z = curve.m_Bezier.d.z },
                    length = curve.m_Length,
                    upgrades,
                };
            }

            var flags = new List<string>();
            if (EntityManager.HasComponent<Game.Buildings.Building>(entity)) flags.Add("building");
            if (EntityManager.HasComponent<Game.Net.Edge>(entity)) flags.Add("roadSegment");
            if (EntityManager.HasComponent<Game.Buildings.TransportStation>(entity)) flags.Add("transportStation");
            if (EntityManager.HasComponent<Game.Buildings.TransportDepot>(entity)) flags.Add("transportDepot");
            if (EntityManager.HasComponent<Game.Routes.TransportStop>(entity)) flags.Add("transportStop");
            if (EntityManager.HasComponent<Game.Prefabs.TransportStopMarker>(entity)) flags.Add("transportStopMarker");
            if (EntityManager.HasComponent<Game.Buildings.Abandoned>(entity)) flags.Add("abandoned");
            if (EntityManager.HasComponent<Game.Buildings.Condemned>(entity)) flags.Add("condemned");
            if (EntityManager.HasComponent<Game.Common.Destroyed>(entity)) flags.Add("destroyed");
            if (EntityManager.HasComponent<Game.Common.Owner>(entity)) flags.Add("hasOwner");
            result["flags"] = flags;

            if (EntityManager.HasComponent<Game.Buildings.Building>(entity))
            {
                Game.Buildings.Building building = EntityManager.GetComponentData<Game.Buildings.Building>(entity);
                result["building"] = new
                {
                    flags = building.m_Flags.ToString(),
                    optionMask = building.m_OptionMask,
                    curvePosition = building.m_CurvePosition,
                    roadEdge = building.m_RoadEdge == Entity.Null
                        ? null
                        : new { index = building.m_RoadEdge.Index, version = building.m_RoadEdge.Version },
                };
            }

            if (EntityManager.HasComponent<Game.Buildings.TransportStation>(entity))
            {
                Game.Buildings.TransportStation station = EntityManager.GetComponentData<Game.Buildings.TransportStation>(entity);
                result["transportStation"] = new
                {
                    flags = station.m_Flags.ToString(),
                    comfortFactor = station.m_ComfortFactor,
                    loadingFactor = station.m_LoadingFactor,
                    carRefuelTypes = station.m_CarRefuelTypes.ToString(),
                    trainRefuelTypes = station.m_TrainRefuelTypes.ToString(),
                    aircraftRefuelTypes = station.m_AircraftRefuelTypes.ToString(),
                    watercraftRefuelTypes = station.m_WatercraftRefuelTypes.ToString(),
                };
            }

            if (EntityManager.HasComponent<Game.Buildings.TransportDepot>(entity))
            {
                Game.Buildings.TransportDepot depot = EntityManager.GetComponentData<Game.Buildings.TransportDepot>(entity);
                result["transportDepot"] = new
                {
                    flags = depot.m_Flags.ToString(),
                    availableVehicles = depot.m_AvailableVehicles,
                    maintenanceRequirement = depot.m_MaintenanceRequirement,
                    targetRequest = depot.m_TargetRequest == Entity.Null
                        ? null
                        : new { index = depot.m_TargetRequest.Index, version = depot.m_TargetRequest.Version },
                };
            }

            if (EntityManager.HasComponent<Game.Routes.TransportStop>(entity))
            {
                Game.Routes.TransportStop stop = EntityManager.GetComponentData<Game.Routes.TransportStop>(entity);
                result["transportStop"] = new
                {
                    flags = stop.m_Flags.ToString(),
                    comfortFactor = stop.m_ComfortFactor,
                    loadingFactor = stop.m_LoadingFactor,
                    accessRestriction = stop.m_AccessRestriction == Entity.Null
                        ? null
                        : new { index = stop.m_AccessRestriction.Index, version = stop.m_AccessRestriction.Version },
                };
            }

            if (EntityManager.HasComponent<Game.Routes.Connected>(entity))
            {
                Game.Routes.Connected connected = EntityManager.GetComponentData<Game.Routes.Connected>(entity);
                result["connected"] = connected.m_Connected == Entity.Null
                    ? null
                    : new { index = connected.m_Connected.Index, version = connected.m_Connected.Version };
            }

            if (EntityManager.HasComponent<Game.Routes.Waypoint>(entity))
            {
                Game.Routes.Waypoint waypoint = EntityManager.GetComponentData<Game.Routes.Waypoint>(entity);
                result["waypoint"] = new { index = waypoint.m_Index };
            }

            if (EntityManager.HasBuffer<Game.Objects.SubObject>(entity))
            {
                DynamicBuffer<Game.Objects.SubObject> subObjects = EntityManager.GetBuffer<Game.Objects.SubObject>(entity, isReadOnly: true);
                var children = new List<object>();
                for (int i = 0; i < subObjects.Length && i < 256; i++)
                {
                    Entity child = subObjects[i].m_SubObject;
                    string childPrefab = null;
                    if (EntityManager.Exists(child) && EntityManager.HasComponent<PrefabRef>(child))
                    {
                        PrefabBase childPrefabObject = prefabSystem.GetPrefab<PrefabBase>(EntityManager.GetComponentData<PrefabRef>(child).m_Prefab);
                        childPrefab = childPrefabObject != null ? childPrefabObject.name : null;
                    }
                    object childPosition = null;
                    if (EntityManager.Exists(child) && EntityManager.HasComponent<Game.Objects.Transform>(child))
                    {
                        Game.Objects.Transform childTransform = EntityManager.GetComponentData<Game.Objects.Transform>(child);
                        childPosition = new { x = childTransform.m_Position.x, y = childTransform.m_Position.y, z = childTransform.m_Position.z };
                    }
                    var childFlags = new List<string>();
                    if (EntityManager.Exists(child) && EntityManager.HasComponent<Game.Buildings.TransportStation>(child)) childFlags.Add("transportStation");
                    if (EntityManager.Exists(child) && EntityManager.HasComponent<Game.Buildings.TransportDepot>(child)) childFlags.Add("transportDepot");
                    if (EntityManager.Exists(child) && EntityManager.HasComponent<Game.Routes.TransportStop>(child)) childFlags.Add("transportStop");
                    if (EntityManager.Exists(child) && EntityManager.HasComponent<Game.Prefabs.TransportStopMarker>(child)) childFlags.Add("transportStopMarker");
                    children.Add(new
                    {
                        entity = new { index = child.Index, version = child.Version },
                        prefab = childPrefab,
                        position = childPosition,
                        flags = childFlags,
                    });
                }
                result["subObjects"] = children;
                result["subObjectCount"] = subObjects.Length;
            }

            if (EntityManager.HasBuffer<Game.Routes.ConnectedRoute>(entity))
            {
                DynamicBuffer<Game.Routes.ConnectedRoute> connections = EntityManager.GetBuffer<Game.Routes.ConnectedRoute>(entity, isReadOnly: true);
                var connectedRoutes = new List<object>();
                for (int i = 0; i < connections.Length && i < 256; i++)
                {
                    Entity waypoint = connections[i].m_Waypoint;
                    connectedRoutes.Add(new { index = waypoint.Index, version = waypoint.Version });
                }
                result["connectedRoutes"] = connectedRoutes;
            }

            if (EntityManager.HasBuffer<Game.Buildings.Renter>(entity))
            {
                DynamicBuffer<Game.Buildings.Renter> renters = EntityManager.GetBuffer<Game.Buildings.Renter>(entity, isReadOnly: true);
                var renterInfos = new List<object>();
                for (int i = 0; i < renters.Length && i < 20; i++)
                {
                    Entity renter = renters[i].m_Renter;
                    string renterPrefab = null;
                    if (EntityManager.HasComponent<PrefabRef>(renter))
                    {
                        PrefabBase rp = prefabSystem.GetPrefab<PrefabBase>(EntityManager.GetComponentData<PrefabRef>(renter).m_Prefab);
                        renterPrefab = rp != null ? rp.name : null;
                    }
                    int citizens = EntityManager.HasBuffer<Game.Citizens.HouseholdCitizen>(renter)
                        ? EntityManager.GetBuffer<Game.Citizens.HouseholdCitizen>(renter, isReadOnly: true).Length
                        : 0;
                    int employees = EntityManager.HasBuffer<Game.Companies.Employee>(renter)
                        ? EntityManager.GetBuffer<Game.Companies.Employee>(renter, isReadOnly: true).Length
                        : 0;
                    renterInfos.Add(new { prefab = renterPrefab, citizens, employees });
                }
                result["renterCount"] = renters.Length;
                result["renters"] = renterInfos;
            }

            if (EntityManager.HasBuffer<Game.Companies.Employee>(entity))
            {
                result["employees"] = EntityManager.GetBuffer<Game.Companies.Employee>(entity, isReadOnly: true).Length;
            }

            return BridgeResponse.Json(result);
        }
    }
}
