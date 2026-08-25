using System;
using System.Collections.Generic;
using Game.Prefabs;
using Game.SceneFlow;
using Game.Simulation;
using Unity.Collections;
using Unity.Entities;
using Unity.Mathematics;
using Transform = Game.Objects.Transform;

namespace CS2MCP
{
    /// <summary>
    /// Construction endpoints: prefab search, building placement (via
    /// BridgeToolSystem), placed-building listing and demolition.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private EntityQuery m_BuildingPrefabQuery;
        private bool m_BuildingPrefabQueryCreated;
        private EntityQuery m_RoadPrefabQuery;
        private bool m_RoadPrefabQueryCreated;
        private EntityQuery m_PlacedBuildingQuery;
        private bool m_PlacedBuildingQueryCreated;
        private EntityQuery m_PlacedRoadQuery;
        private bool m_PlacedRoadQueryCreated;
        private EntityQuery m_NetPrefabQuery;
        private bool m_NetPrefabQueryCreated;
        private EntityQuery m_TreePrefabQuery;
        private bool m_TreePrefabQueryCreated;
        private EntityQuery m_TerraformPrefabQuery;
        private bool m_TerraformPrefabQueryCreated;
        private EntityQuery m_BrushPrefabQuery;
        private bool m_BrushPrefabQueryCreated;
        private EntityQuery m_ObjectPrefabQuery;
        private bool m_ObjectPrefabQueryCreated;
        private EntityQuery m_SurfacePrefabQuery;
        private bool m_SurfacePrefabQueryCreated;

        private EntityQuery ObjectPrefabQuery
        {
            get
            {
                if (!m_ObjectPrefabQueryCreated)
                {
                    m_ObjectPrefabQuery = EntityManager.CreateEntityQuery(
                        ComponentType.ReadOnly<PrefabData>(),
                        ComponentType.ReadOnly<ObjectData>());
                    m_ObjectPrefabQueryCreated = true;
                }
                return m_ObjectPrefabQuery;
            }
        }

        private EntityQuery SurfacePrefabQuery
        {
            get
            {
                if (!m_SurfacePrefabQueryCreated)
                {
                    m_SurfacePrefabQuery = EntityManager.CreateEntityQuery(
                        ComponentType.ReadOnly<PrefabData>(),
                        ComponentType.ReadOnly<SurfaceData>());
                    m_SurfacePrefabQueryCreated = true;
                }
                return m_SurfacePrefabQuery;
            }
        }

        private EntityQuery NetPrefabQuery
        {
            get
            {
                if (!m_NetPrefabQueryCreated)
                {
                    m_NetPrefabQuery = EntityManager.CreateEntityQuery(
                        ComponentType.ReadOnly<PrefabData>(),
                        ComponentType.ReadOnly<NetGeometryData>());
                    m_NetPrefabQueryCreated = true;
                }
                return m_NetPrefabQuery;
            }
        }

        private EntityQuery TreePrefabQuery
        {
            get
            {
                if (!m_TreePrefabQueryCreated)
                {
                    m_TreePrefabQuery = EntityManager.CreateEntityQuery(
                        ComponentType.ReadOnly<PrefabData>(),
                        ComponentType.ReadOnly<TreeData>());
                    m_TreePrefabQueryCreated = true;
                }
                return m_TreePrefabQuery;
            }
        }

        private EntityQuery TerraformPrefabQuery
        {
            get
            {
                if (!m_TerraformPrefabQueryCreated)
                {
                    m_TerraformPrefabQuery = EntityManager.CreateEntityQuery(
                        ComponentType.ReadOnly<PrefabData>(),
                        ComponentType.ReadOnly<TerraformingData>());
                    m_TerraformPrefabQueryCreated = true;
                }
                return m_TerraformPrefabQuery;
            }
        }

        private EntityQuery BrushPrefabQuery
        {
            get
            {
                if (!m_BrushPrefabQueryCreated)
                {
                    m_BrushPrefabQuery = EntityManager.CreateEntityQuery(
                        ComponentType.ReadOnly<PrefabData>(),
                        ComponentType.ReadOnly<BrushData>());
                    m_BrushPrefabQueryCreated = true;
                }
                return m_BrushPrefabQuery;
            }
        }

        private EntityQuery BuildingPrefabQuery
        {
            get
            {
                if (!m_BuildingPrefabQueryCreated)
                {
                    m_BuildingPrefabQuery = EntityManager.CreateEntityQuery(
                        ComponentType.ReadOnly<PrefabData>(),
                        ComponentType.ReadOnly<BuildingData>());
                    m_BuildingPrefabQueryCreated = true;
                }
                return m_BuildingPrefabQuery;
            }
        }

        private EntityQuery RoadPrefabQuery
        {
            get
            {
                if (!m_RoadPrefabQueryCreated)
                {
                    m_RoadPrefabQuery = EntityManager.CreateEntityQuery(
                        ComponentType.ReadOnly<PrefabData>(),
                        ComponentType.ReadOnly<RoadData>());
                    m_RoadPrefabQueryCreated = true;
                }
                return m_RoadPrefabQuery;
            }
        }

        private EntityQuery PlacedBuildingQuery
        {
            get
            {
                if (!m_PlacedBuildingQueryCreated)
                {
                    m_PlacedBuildingQuery = EntityManager.CreateEntityQuery(new EntityQueryDesc
                    {
                        All = new[]
                        {
                            ComponentType.ReadOnly<Game.Buildings.Building>(),
                            ComponentType.ReadOnly<Transform>(),
                            ComponentType.ReadOnly<PrefabRef>(),
                        },
                        None = new[]
                        {
                            ComponentType.ReadOnly<Game.Tools.Temp>(),
                            ComponentType.ReadOnly<Game.Common.Deleted>(),
                        },
                    });
                    m_PlacedBuildingQueryCreated = true;
                }
                return m_PlacedBuildingQuery;
            }
        }

        private EntityQuery PlacedRoadQuery
        {
            get
            {
                if (!m_PlacedRoadQueryCreated)
                {
                    m_PlacedRoadQuery = EntityManager.CreateEntityQuery(new EntityQueryDesc
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
                    m_PlacedRoadQueryCreated = true;
                }
                return m_PlacedRoadQuery;
            }
        }

        private BridgeResponse ListRoads(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            request.Query.TryGetValue("query", out string search);
            int limit = request.TryGetInt("limit", out int rawLimit) ? math.clamp(rawLimit, 1, 500) : 100;
            bool hasCenter = request.TryGetFloat("x", out float x) & request.TryGetFloat("z", out float z);
            float radius = request.TryGetFloat("radius", out float rawRadius) ? math.max(rawRadius, 1f) : 250f;
            float2 center = new float2(x, z);

            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            var results = new List<object>();
            int total = 0;
            using (NativeArray<Entity> entities = PlacedRoadQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    Game.Net.Edge edge = EntityManager.GetComponentData<Game.Net.Edge>(entity);
                    Game.Net.Curve curve = EntityManager.GetComponentData<Game.Net.Curve>(entity);
                    float2 midpoint = (curve.m_Bezier.a.xz + curve.m_Bezier.d.xz) * 0.5f;
                    if (hasCenter && math.distance(midpoint, center) > radius)
                    {
                        continue;
                    }
                     string name = SafePrefabName(entity, prefabSystem) ?? "<unknown>";
                     if (!string.IsNullOrEmpty(search)
                         && name.IndexOf(search, StringComparison.OrdinalIgnoreCase) < 0)
                     {
                         continue;
                     }
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
                     total++;
                     if (results.Count < limit)
                     {
                             results.Add(new
                         {
                            entity = new { index = entity.Index, version = entity.Version },
                             prefab = name,
                             start = new { x = curve.m_Bezier.a.x, z = curve.m_Bezier.a.z },
                             end = new { x = curve.m_Bezier.d.x, z = curve.m_Bezier.d.z },
                             startNode = DescribeEntity(edge.m_Start),
                             endNode = DescribeEntity(edge.m_End),
                             curve = new
                             {
                                 a = new { x = curve.m_Bezier.a.x, y = curve.m_Bezier.a.y, z = curve.m_Bezier.a.z },
                                 b = new { x = curve.m_Bezier.b.x, y = curve.m_Bezier.b.y, z = curve.m_Bezier.b.z },
                                 c = new { x = curve.m_Bezier.c.x, y = curve.m_Bezier.c.y, z = curve.m_Bezier.c.z },
                                 d = new { x = curve.m_Bezier.d.x, y = curve.m_Bezier.d.y, z = curve.m_Bezier.d.z },
                             },
                             length = curve.m_Length,
                             upgrades,
                         });
                     }
                 }
             }

            return BridgeResponse.Json(new
            {
                totalMatches = total,
                returned = results.Count,
                note = "one entry per road segment (edge); use entity index+version with /build/demolish",
                roads = results,
            });
        }

        private BridgeResponse GetPrefabs(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            string category = request.Query.TryGetValue("category", out string rawCategory)
                ? rawCategory.ToLowerInvariant()
                : "building";
            EntityQuery query;
            switch (category)
            {
                case "building":
                    query = BuildingPrefabQuery;
                    break;
                case "road":
                    query = RoadPrefabQuery;
                    break;
                case "net":
                    query = NetPrefabQuery;
                    break;
                case "tree":
                    query = TreePrefabQuery;
                    break;
                case "terraform":
                    query = TerraformPrefabQuery;
                    break;
                case "brush":
                    query = BrushPrefabQuery;
                    break;
                case "prop":
                case "props":
                case "object":
                    query = ObjectPrefabQuery;
                    break;
                case "surface":
                case "surfaces":
                    query = SurfacePrefabQuery;
                    break;
                case "transport":
                case "transit":
                case "route":
                    query = TransportLinePrefabQuery;
                    break;
                case "all":
                    query = EntityManager.CreateEntityQuery(ComponentType.ReadOnly<PrefabData>());
                    break;
                default:
                    return BridgeResponse.Error(400, "category must be 'all', 'building', 'road', 'net' (all networks incl. pipes/power/tracks/paths), 'tree', 'terraform', 'brush', 'prop', 'surface', or 'transport'");
            }

            bool propsOnly = category == "prop" || category == "props" || category == "object";

            request.Query.TryGetValue("query", out string search);
            int page = request.TryGetInt("page", out int rawPage) ? math.max(rawPage, 0) : 0;
            int pageSize = request.TryGetInt("pageSize", out int rawPageSize)
                ? math.clamp(rawPageSize, 1, 200)
                : request.TryGetInt("limit", out int rawLimit) ? math.clamp(rawLimit, 1, 200) : 50;
            int pageStart = page * pageSize;

            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            var results = new List<object>();
            int total = 0;
            using (NativeArray<Entity> entities = query.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(entity);
                    if (prefab == null)
                    {
                        continue;
                    }
                    if (propsOnly && !IsPlaceablePropPrefab(entity, prefab))
                    {
                        continue;
                    }
                    if (!string.IsNullOrEmpty(search)
                        && prefab.name.IndexOf(search, StringComparison.OrdinalIgnoreCase) < 0)
                    {
                        continue;
                    }
                    total++;
                    if (total <= pageStart || results.Count >= pageSize)
                    {
                        continue;
                    }

                    string title = null;
                    try
                    {
                        GameManager.instance?.localizationManager?.activeDictionary?
                            .TryGetValue($"Prefab.TITLE[{prefab.name}]", out title);
                    }
                    catch
                    {
                        // Localization keys vary across game versions; keep
                        // the internal prefab name as the stable machine key.
                    }

                    string assembly = prefab.GetType().Assembly.GetName().Name;
                    object buildingData = null;
                    if (EntityManager.HasComponent<BuildingData>(entity))
                    {
                        BuildingData data = EntityManager.GetComponentData<BuildingData>(entity);
                        buildingData = new
                        {
                            lotSize = new { x = data.m_LotSize.x, z = data.m_LotSize.y },
                            flags = data.m_Flags.ToString(),
                        };
                    }

                    object geometryData = null;
                    if (EntityManager.HasComponent<ObjectGeometryData>(entity))
                    {
                        ObjectGeometryData data = EntityManager.GetComponentData<ObjectGeometryData>(entity);
                        geometryData = new
                        {
                            size = new { x = data.m_Size.x, y = data.m_Size.y, z = data.m_Size.z },
                            pivot = new { x = data.m_Pivot.x, y = data.m_Pivot.y, z = data.m_Pivot.z },
                            flags = data.m_Flags.ToString(),
                        };
                    }

                    object placeableData = null;
                    if (EntityManager.HasComponent<PlaceableObjectData>(entity))
                    {
                        PlaceableObjectData data = EntityManager.GetComponentData<PlaceableObjectData>(entity);
                        placeableData = new
                        {
                            placementOffset = new { x = data.m_PlacementOffset.x, y = data.m_PlacementOffset.y, z = data.m_PlacementOffset.z },
                            constructionCost = data.m_ConstructionCost,
                            rotationSymmetry = data.m_RotationSymmetry.ToString(),
                            flags = data.m_Flags.ToString(),
                        };
                    }

                    object transportStationData = null;
                    if (EntityManager.HasComponent<TransportStationData>(entity))
                    {
                        TransportStationData data = EntityManager.GetComponentData<TransportStationData>(entity);
                        transportStationData = new
                        {
                            comfortFactor = data.m_ComfortFactor,
                            loadingFactor = data.m_LoadingFactor,
                            carRefuelTypes = data.m_CarRefuelTypes.ToString(),
                            trainRefuelTypes = data.m_TrainRefuelTypes.ToString(),
                            watercraftRefuelTypes = data.m_WatercraftRefuelTypes.ToString(),
                            aircraftRefuelTypes = data.m_AircraftRefuelTypes.ToString(),
                        };
                    }

                    object transportDepotData = null;
                    if (EntityManager.HasComponent<TransportDepotData>(entity))
                    {
                        TransportDepotData data = EntityManager.GetComponentData<TransportDepotData>(entity);
                        transportDepotData = new
                        {
                            transportType = data.m_TransportType.ToString(),
                            energyTypes = data.m_EnergyTypes.ToString(),
                            sizeClass = data.m_SizeClass.ToString(),
                            dispatchCenter = data.m_DispatchCenter,
                            vehicleCapacity = data.m_VehicleCapacity,
                        };
                    }

                    object roadData = null;
                    if (prefab is RoadPrefab roadPrefab)
                    {
                        var lanes = new List<object>();
                        int laneCount = 0;
                        if (EntityManager.HasBuffer<SubNet>(entity))
                        {
                            DynamicBuffer<SubNet> subNets = EntityManager.GetBuffer<SubNet>(entity, isReadOnly: true);
                            for (int laneIndex = 0; laneIndex < subNets.Length; laneIndex++)
                            {
                                Entity lanePrefabEntity = subNets[laneIndex].m_Prefab;
                                if (lanePrefabEntity == Entity.Null
                                    || !EntityManager.Exists(lanePrefabEntity)
                                    || !EntityManager.HasComponent<NetLaneData>(lanePrefabEntity))
                                {
                                    continue;
                                }
                                NetLaneData laneData = EntityManager.GetComponentData<NetLaneData>(lanePrefabEntity);
                                PrefabBase lanePrefab = prefabSystem.GetPrefab<PrefabBase>(lanePrefabEntity);
                                laneCount++;
                                lanes.Add(new
                                {
                                    index = laneIndex,
                                    prefab = lanePrefab != null ? lanePrefab.name : null,
                                    flags = laneData.m_Flags.ToString(),
                                    width = laneData.m_Width,
                                });
                            }
                        }
                        string compositionFlags = EntityManager.HasComponent<RoadComposition>(entity)
                            ? EntityManager.GetComponentData<RoadComposition>(entity).m_Flags.ToString()
                            : null;
                        roadData = new
                        {
                            roadType = roadPrefab.m_RoadType.ToString(),
                            speedLimit = roadPrefab.m_SpeedLimit,
                            trafficLights = roadPrefab.m_TrafficLights,
                            highwayRules = roadPrefab.m_HighwayRules,
                            roadFlags = compositionFlags,
                            laneCount,
                            lanes,
                        };
                    }

                    object networkData = null;
                    bool tunnelNetwork = false;
                    if (EntityManager.HasComponent<NetData>(entity))
                    {
                        NetData data = EntityManager.GetComponentData<NetData>(entity);
                        object undergroundPrefab = null;
                        if (EntityManager.HasComponent<PlaceableNetData>(entity))
                        {
                            PlaceableNetData placeable = EntityManager.GetComponentData<PlaceableNetData>(entity);
                            tunnelNetwork = placeable.m_UndergroundPrefab != Entity.Null
                                && EntityManager.Exists(placeable.m_UndergroundPrefab);
                            undergroundPrefab = placeable.m_UndergroundPrefab == Entity.Null
                                ? null
                                : new { index = placeable.m_UndergroundPrefab.Index, version = placeable.m_UndergroundPrefab.Version };
                            networkData = new
                            {
                                requiredLayers = data.m_RequiredLayers.ToString(),
                                connectLayers = data.m_ConnectLayers.ToString(),
                                localConnectLayers = data.m_LocalConnectLayers.ToString(),
                                elevationRange = new { min = placeable.m_ElevationRange.min, max = placeable.m_ElevationRange.max },
                                placementFlags = placeable.m_PlacementFlags.ToString(),
                                undergroundPrefab,
                                defaultConstructionCost = placeable.m_DefaultConstructionCost,
                                defaultUpkeepCost = placeable.m_DefaultUpkeepCost,
                                snapDistance = placeable.m_SnapDistance,
                                minWaterElevation = placeable.m_MinWaterElevation,
                            };
                        }
                        else
                        {
                            networkData = new
                            {
                                requiredLayers = data.m_RequiredLayers.ToString(),
                                connectLayers = data.m_ConnectLayers.ToString(),
                                localConnectLayers = data.m_LocalConnectLayers.ToString(),
                                undergroundPrefab,
                            };
                        }
                    }

                    results.Add(new
                    {
                        entity = new { index = entity.Index, version = entity.Version },
                        name = prefab.name,
                        type = prefab.GetType().Name,
                        locked = IsLocked(entity),
                        available = !IsLocked(entity),
                        localizedName = title,
                        category,
                        sourceAssembly = assembly,
                        source = assembly == "Game" ? "base-game-runtime" : "runtime-discovered",
                        prefabCapabilities = new
                        {
                            objectData = EntityManager.HasComponent<ObjectData>(entity),
                            buildingData = EntityManager.HasComponent<BuildingData>(entity),
                            objectGeometryData = EntityManager.HasComponent<ObjectGeometryData>(entity),
                            placeableObjectData = EntityManager.HasComponent<PlaceableObjectData>(entity),
                            treeData = EntityManager.HasComponent<TreeData>(entity),
                            netObjectData = EntityManager.HasComponent<NetObjectData>(entity),
                            transportStopMarker = EntityManager.HasComponent<TransportStopMarker>(entity),
                            transportStopData = EntityManager.HasComponent<TransportStopData>(entity),
                            transportStationData = EntityManager.HasComponent<TransportStationData>(entity),
                            transportDepotData = EntityManager.HasComponent<TransportDepotData>(entity),
                            routeData = EntityManager.HasComponent<RouteData>(entity),
                            bridgePrefab = EntityManager.HasComponent<Bridge>(entity),
                            tunnelNetwork,
                        },
                        buildingData,
                        geometryData,
                        placeableData,
                        roadData,
                        networkData,
                        transportStationData,
                        transportDepotData,
                    });
                }
            }

            return BridgeResponse.Json(new
            {
                category,
                page,
                pageSize,
                totalMatches = total,
                returned = results.Count,
                note = "runtime PrefabSystem discovery; use the exact 'name' value with construction tools. 'source' is conservative and is not a DLC/Mod attribution.",
                stalenessWarning = LockStalenessWarning,
                prefabs = results,
            });
        }

        /// <summary>
        /// Reports whether the currently loaded runtime exposes at least one
        /// unlocked placeable network prefab with an underground counterpart.
        /// This is a structural capability probe: it does not claim that an
        /// arbitrary road can be tunneled, only that the native network tool
        /// has a runtime tunnel prefab it can select and validate.
        /// </summary>
        private int CountTunnelCapablePrefabs()
        {
            int count = 0;
            using (NativeArray<Entity> entities = NetPrefabQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    if (IsLocked(entity) || !EntityManager.HasComponent<PlaceableNetData>(entity))
                    {
                        continue;
                    }
                    PlaceableNetData data = EntityManager.GetComponentData<PlaceableNetData>(entity);
                    if (data.m_UndergroundPrefab != Entity.Null && EntityManager.Exists(data.m_UndergroundPrefab))
                    {
                        count++;
                    }
                }
            }
            return count;
        }

        private BridgeResponse PlaceBuilding(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            if (!request.Query.TryGetValue("prefab", out string prefabName) || string.IsNullOrEmpty(prefabName))
            {
                return BridgeResponse.Error(400, "provide ?prefab=<name from /prefabs>");
            }
            if (!request.TryGetFloat("x", out float x) || !request.TryGetFloat("z", out float z))
            {
                return BridgeResponse.Error(400, "provide ?x=<float>&z=<float> world coordinates");
            }
            request.TryGetFloat("rotation", out float rotationDegrees);

            if (!TryFindPrefabByName(BuildingPrefabQuery, prefabName, out Entity prefabEntity, out PrefabBase prefab)
                && !TryFindPrefabByName(TreePrefabQuery, prefabName, out prefabEntity, out prefab))
            {
                return BridgeResponse.Error(404, $"unknown building/tree prefab '{prefabName}'; search via /prefabs?category=building|tree&query=...");
            }
            return QueueObjectPlacement(request, prefabEntity, prefab, x, z, rotationDegrees);
        }

        private BridgeResponse PlaceProp(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            if (!request.Query.TryGetValue("prefab", out string prefabName) || string.IsNullOrEmpty(prefabName))
            {
                return BridgeResponse.Error(400, "provide ?prefab=<name from /prefabs?category=prop>");
            }
            if (!request.TryGetFloat("x", out float x) || !request.TryGetFloat("z", out float z))
            {
                return BridgeResponse.Error(400, "provide ?x=<float>&z=<float> world coordinates");
            }
            request.TryGetFloat("rotation", out float rotationDegrees);

            if (!TryFindPropPrefabByName(prefabName, out Entity prefabEntity, out PrefabBase prefab))
            {
                return BridgeResponse.Error(404, $"unknown placeable prop prefab '{prefabName}'; search via /prefabs?category=prop&query=...");
            }
            return QueueObjectPlacement(request, prefabEntity, prefab, x, z, rotationDegrees);
        }

        private BridgeResponse QueueObjectPlacement(BridgeRequest request, Entity prefabEntity, PrefabBase prefab, float x, float z, float rotationDegrees)
        {
            if (IsLocked(prefabEntity) && !IsForced(request))
            {
                return BridgeResponse.Error(409, $"prefab '{prefab.name}' is locked (milestone not reached); pass force=true to place anyway");
            }

            float3 position = new float3(x, 0f, z);
            if (request.TryGetFloat("y", out float y))
            {
                position.y = y;
            }
            else
            {
                TerrainSystem terrain = World.GetOrCreateSystemManaged<TerrainSystem>();
                TerrainHeightData heightData = terrain.GetHeightData();
                position.y = TerrainUtils.SampleHeight(ref heightData, position);
            }
            quaternion rotation = quaternion.RotateY(math.radians(rotationDegrees));

            bool dryRun = request.TryGetBool("dryRun", out bool requestedDryRun) && requestedDryRun;
            if (dryRun)
            {
                return BridgeResponse.Json(new
                {
                    success = true,
                    dryRun = true,
                    preview = new
                    {
                        prefab = new
                        {
                            entity = new { index = prefabEntity.Index, version = prefabEntity.Version },
                            name = prefab.name,
                            locked = IsLocked(prefabEntity),
                        },
                        position = new { x = position.x, y = position.y, z = position.z },
                        rotation = new { x = rotation.value.x, y = rotation.value.y, z = rotation.value.z, w = rotation.value.w },
                    },
                    note = "preview only; no native object definition was emitted",
                });
            }

            BridgeToolSystem tool = World.GetOrCreateSystemManaged<BridgeToolSystem>();
            if (!tool.TryQueuePlacement(prefabEntity, prefab, position, rotation, request))
            {
                return BridgeResponse.Error(409, tool.LastPlacementFailure ?? "another build operation is in progress, retry shortly");
            }
            // Completed asynchronously by BridgeToolSystem over the next tool frames.
            return null;
        }

        private BridgeResponse BuildRoad(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            if (!request.Query.TryGetValue("prefab", out string prefabName) || string.IsNullOrEmpty(prefabName))
            {
                return BridgeResponse.Error(400, "provide ?prefab=<name from /prefabs?category=road>");
            }
            if (!request.TryGetFloat("x1", out float x1) || !request.TryGetFloat("z1", out float z1)
                || !request.TryGetFloat("x2", out float x2) || !request.TryGetFloat("z2", out float z2))
            {
                return BridgeResponse.Error(400, "provide ?x1=&z1=&x2=&z2= world coordinates for both endpoints");
            }

            float length = math.distance(new float2(x1, z1), new float2(x2, z2));
            if (length < 8f)
            {
                return BridgeResponse.Error(400, $"segment too short ({length:F1}m); minimum ~8m");
            }
            if (length > 1500f)
            {
                return BridgeResponse.Error(400, $"segment too long ({length:F0}m); split into segments of <=1500m");
            }

            if (!TryFindPrefabByName(NetPrefabQuery, prefabName, out Entity prefabEntity, out PrefabBase prefab))
            {
                return BridgeResponse.Error(404, $"unknown network prefab '{prefabName}'; search via /prefabs?category=road|net&query=...");
            }
            if (IsLocked(prefabEntity) && !IsForced(request))
            {
                return BridgeResponse.Error(409, $"prefab '{prefab.name}' is locked (milestone not reached); pass force=true to build anyway");
            }

            TerrainSystem terrain = World.GetOrCreateSystemManaged<TerrainSystem>();
            TerrainHeightData heightData = terrain.GetHeightData();
            float3 start = new float3(x1, 0f, z1);
            start.y = TerrainUtils.SampleHeight(ref heightData, start);
            float3 end = new float3(x2, 0f, z2);
            end.y = TerrainUtils.SampleHeight(ref heightData, end);

            bool hasMid = request.TryGetFloat("cx", out float cx) & request.TryGetFloat("cz", out float cz);
            float3 mid = default;
            if (hasMid)
            {
                mid = new float3(cx, 0f, cz);
                mid.y = TerrainUtils.SampleHeight(ref heightData, mid);
            }

            request.TryGetFloat("e1", out float e1);
            request.TryGetFloat("e2", out float e2);
            var elevations = new float2(math.clamp(e1, -30f, 60f), math.clamp(e2, -30f, 60f));

            if (!TryReadRoadAnchor(request, "start", out Entity startAnchor, out float startCurvePosition, out bool hasStartAnchor, out BridgeResponse startAnchorError))
            {
                return startAnchorError;
            }
            if (!TryReadRoadAnchor(request, "end", out Entity endAnchor, out float endCurvePosition, out bool hasEndAnchor, out BridgeResponse endAnchorError))
            {
                return endAnchorError;
            }

            BridgeToolSystem tool = World.GetOrCreateSystemManaged<BridgeToolSystem>();
            if (!tool.TryQueueRoad(
                prefabEntity,
                prefab,
                start,
                end,
                mid,
                hasMid,
                elevations,
                request,
                hasStartAnchor ? startAnchor : default,
                startCurvePosition,
                hasEndAnchor ? endAnchor : default,
                endCurvePosition))
            {
                return BridgeResponse.Error(409, "another build operation is in progress, retry shortly");
            }
            return null;
        }

        private bool TryReadRoadAnchor(
            BridgeRequest request,
            string prefix,
            out Entity anchor,
            out float curvePosition,
            out bool provided,
            out BridgeResponse error)
        {
            anchor = default;
            curvePosition = prefix.Equals("end", StringComparison.OrdinalIgnoreCase) ? 1f : 0f;
            provided = false;
            error = null;

            string indexKey = prefix + "EntityIndex";
            string versionKey = prefix + "EntityVersion";
            bool hasIndex = request.Query.ContainsKey(indexKey);
            bool hasVersion = request.Query.ContainsKey(versionKey);
            if (!hasIndex && !hasVersion)
            {
                return true;
            }
            if (!hasIndex || !hasVersion
                || !request.TryGetInt(indexKey, out int index)
                || !request.TryGetInt(versionKey, out int version))
            {
                error = BridgeResponse.Error(400, $"{prefix} road anchor requires {indexKey}= and {versionKey}= from /city/roads");
                return false;
            }

            anchor = new Entity { Index = index, Version = version };
            bool isEdge = EntityManager.Exists(anchor)
                && EntityManager.HasComponent<Game.Net.Edge>(anchor)
                && EntityManager.HasComponent<Game.Net.Curve>(anchor);
            bool isNode = EntityManager.Exists(anchor)
                && EntityManager.HasComponent<Game.Net.Node>(anchor);
            if (!isEdge && !isNode
                || EntityManager.HasComponent<Game.Tools.Temp>(anchor)
                || EntityManager.HasComponent<Game.Common.Deleted>(anchor))
            {
                error = BridgeResponse.Error(404, $"{prefix} road anchor {index}:{version} is not a live native road edge/node");
                return false;
            }

            if (request.TryGetFloat(prefix + "CurvePosition", out float requestedCurvePosition))
            {
                if (requestedCurvePosition < 0f || requestedCurvePosition > 1f)
                {
                    error = BridgeResponse.Error(400, $"{prefix}CurvePosition must be between 0 and 1");
                    return false;
                }
                curvePosition = requestedCurvePosition;
            }
            provided = true;
            return true;
        }

        private static readonly Dictionary<string, (Game.Prefabs.CompositionFlags.General general, Game.Prefabs.CompositionFlags.Side side)> kUpgradeNames =
            new Dictionary<string, (Game.Prefabs.CompositionFlags.General, Game.Prefabs.CompositionFlags.Side)>(StringComparer.OrdinalIgnoreCase)
            {
                ["grass"] = (default, Game.Prefabs.CompositionFlags.Side.PrimaryBeautification),
                ["trees"] = (default, Game.Prefabs.CompositionFlags.Side.SecondaryBeautification),
                ["wideSidewalk"] = (default, Game.Prefabs.CompositionFlags.Side.WideSidewalk),
                ["soundBarrier"] = (default, Game.Prefabs.CompositionFlags.Side.SoundBarrier),
                ["parking"] = (default, Game.Prefabs.CompositionFlags.Side.ParkingSpaces),
                ["lighting"] = (Game.Prefabs.CompositionFlags.General.Lighting, default),
                ["medianGrass"] = (Game.Prefabs.CompositionFlags.General.PrimaryMiddleBeautification, default),
                ["medianTrees"] = (Game.Prefabs.CompositionFlags.General.SecondaryMiddleBeautification, default),
            };

        private BridgeResponse HandleUpgradeRoad(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            if (!request.TryGetInt("index", out int index) || !request.TryGetInt("version", out int version))
            {
                return BridgeResponse.Error(400, "provide ?index=&version= of a road segment from /city/roads");
            }
            if (!request.Query.TryGetValue("upgrades", out string upgradesRaw) || string.IsNullOrEmpty(upgradesRaw))
            {
                return BridgeResponse.Error(400,
                    $"provide ?upgrades=<comma list>: {string.Join(", ", kUpgradeNames.Keys)}");
            }

            var entity = new Entity { Index = index, Version = version };
            if (!EntityManager.Exists(entity) || !EntityManager.HasComponent<Game.Net.Edge>(entity))
            {
                return BridgeResponse.Error(404, $"entity {index}:{version} is not an existing road segment");
            }

            string side = request.Query.TryGetValue("side", out string rawSide) ? rawSide.ToLowerInvariant() : "both";
            Game.Prefabs.CompositionFlags flags = default;
            foreach (string name in upgradesRaw.Split(','))
            {
                string trimmed = name.Trim();
                if (!kUpgradeNames.TryGetValue(trimmed, out (Game.Prefabs.CompositionFlags.General general, Game.Prefabs.CompositionFlags.Side side) mapped))
                {
                    return BridgeResponse.Error(400, $"unknown upgrade '{trimmed}'; valid: {string.Join(", ", kUpgradeNames.Keys)}");
                }
                flags.m_General |= mapped.general;
                if (side == "left" || side == "both")
                {
                    flags.m_Left |= mapped.side;
                }
                if (side == "right" || side == "both")
                {
                    flags.m_Right |= mapped.side;
                }
            }

            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            string prefabName = null;
            if (EntityManager.HasComponent<PrefabRef>(entity))
            {
                PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(EntityManager.GetComponentData<PrefabRef>(entity).m_Prefab);
                prefabName = prefab != null ? prefab.name : null;
            }

            if (side != "left" && side != "right" && side != "both")
            {
                return BridgeResponse.Error(400, "side must be one of: both, left, right");
            }

            bool dryRun = request.TryGetBool("dryRun", out bool requestedDryRun) && requestedDryRun;
            if (dryRun)
            {
                return BridgeResponse.Json(new
                {
                    success = true,
                    dryRun = true,
                    preview = new
                    {
                        entity = new { index, version },
                        prefab = prefabName,
                        upgrades = upgradesRaw,
                        side,
                    },
                    nativePath = "CreationDefinition(Upgrade) + Generate/Apply network systems",
                    note = "preview only; no road upgrade definition was emitted",
                });
            }

            BridgeToolSystem tool = World.GetOrCreateSystemManaged<BridgeToolSystem>();
            if (!tool.TryQueueUpgrade(entity, prefabName, flags, request))
            {
                return BridgeResponse.Error(409, "another build operation is in progress, retry shortly");
            }
            return null;
        }

        private BridgeResponse ListBuildings(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            request.Query.TryGetValue("query", out string search);
            int limit = request.TryGetInt("limit", out int rawLimit) ? math.clamp(rawLimit, 1, 500) : 100;

            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            var results = new List<object>();
            int total = 0;
            using (NativeArray<Entity> entities = PlacedBuildingQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    PrefabRef prefabRef = EntityManager.GetComponentData<PrefabRef>(entity);
                    PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(prefabRef.m_Prefab);
                    string name = prefab != null ? prefab.name : "<unknown>";
                    if (!string.IsNullOrEmpty(search)
                        && name.IndexOf(search, StringComparison.OrdinalIgnoreCase) < 0)
                    {
                        continue;
                    }
                    total++;
                    if (results.Count < limit)
                    {
                        Transform transform = EntityManager.GetComponentData<Transform>(entity);
                        results.Add(new
                        {
                            entity = new { index = entity.Index, version = entity.Version },
                            prefab = name,
                            isSubBuilding = EntityManager.HasComponent<Game.Common.Owner>(entity),
                            position = new
                            {
                                x = transform.m_Position.x,
                                y = transform.m_Position.y,
                                z = transform.m_Position.z,
                            },
                        });
                    }
                }
            }

            return BridgeResponse.Json(new
            {
                totalMatches = total,
                returned = results.Count,
                note = "use entity index+version with /build/demolish",
                buildings = results,
            });
        }

        private BridgeResponse Demolish(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            if (!request.TryGetInt("index", out int index) || !request.TryGetInt("version", out int version))
            {
                return BridgeResponse.Error(400, "provide ?index=<int>&version=<int> from /city/buildings");
            }

            var entity = new Entity { Index = index, Version = version };
            if (!EntityManager.Exists(entity))
            {
                return BridgeResponse.Error(404, $"entity {index}:{version} does not exist (stale id?)");
            }
            bool isBuilding = EntityManager.HasComponent<Game.Buildings.Building>(entity);
            bool isNetEdge = EntityManager.HasComponent<Game.Net.Edge>(entity);
            bool isFlora = EntityManager.HasComponent<Game.Objects.Tree>(entity)
                || EntityManager.HasComponent<Game.Objects.Plant>(entity);
            bool isDistrict = EntityManager.HasComponent<Game.Areas.District>(entity);
            if (!isBuilding && !isNetEdge && !isFlora && !isDistrict)
            {
                return BridgeResponse.Error(400, "entity is not a building, road segment, tree/plant or district; refusing to delete");
            }
            if (EntityManager.HasComponent<Game.Common.Deleted>(entity))
            {
                return BridgeResponse.Error(409, "entity is already being deleted");
            }

            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            string prefabName = null;
            if (EntityManager.HasComponent<PrefabRef>(entity))
            {
                PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(EntityManager.GetComponentData<PrefabRef>(entity).m_Prefab);
                prefabName = prefab != null ? prefab.name : null;
            }

            // Deletion MUST go through the game's bulldoze pipeline. Adding a raw
            // Deleted component skips node/block/lane cleanup and corrupts state.
            BridgeToolSystem tool = World.GetOrCreateSystemManaged<BridgeToolSystem>();
            if (!tool.TryQueueDemolish(entity, prefabName, request))
            {
                return BridgeResponse.Error(409, "another build operation is in progress, retry shortly");
            }
            return null;
        }

        private static bool IsForced(BridgeRequest request)
        {
            return request.TryGetBool("force", out bool force) && force;
        }

        private bool TryFindPrefabByName(EntityQuery query, string name, out Entity prefabEntity, out PrefabBase prefab)
        {
            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            using (NativeArray<Entity> entities = query.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    PrefabBase candidate = prefabSystem.GetPrefab<PrefabBase>(entity);
                    if (candidate != null && string.Equals(candidate.name, name, StringComparison.OrdinalIgnoreCase))
                    {
                        prefabEntity = entity;
                        prefab = candidate;
                        return true;
                    }
                }
            }
            prefabEntity = Entity.Null;
            prefab = null;
            return false;
        }

        private bool TryFindPropPrefabByName(string name, out Entity prefabEntity, out PrefabBase prefab)
        {
            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            using (NativeArray<Entity> entities = ObjectPrefabQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    PrefabBase candidate = prefabSystem.GetPrefab<PrefabBase>(entity);
                    if (candidate != null
                        && IsPlaceablePropPrefab(entity, candidate)
                        && string.Equals(candidate.name, name, StringComparison.OrdinalIgnoreCase))
                    {
                        prefabEntity = entity;
                        prefab = candidate;
                        return true;
                    }
                }
            }
            prefabEntity = Entity.Null;
            prefab = null;
            return false;
        }

        private bool IsPlaceablePropPrefab(Entity entity, PrefabBase prefab)
        {
            // ObjectData is shared by buildings, trees, vehicles, and props.
            // Keep the prop category narrow enough that a caller cannot place a
            // moving vehicle or a building through the prop endpoint.
            return prefab is StaticObjectPrefab
                && !EntityManager.HasComponent<BuildingData>(entity)
                && !EntityManager.HasComponent<TreeData>(entity)
                && !EntityManager.HasComponent<NetObjectData>(entity);
        }
    }
}
