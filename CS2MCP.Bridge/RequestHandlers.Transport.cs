using System;
using System.Collections.Generic;
using System.Reflection;
using Game.Buildings;
using Game.Common;
using Game.Objects;
using Game.Prefabs;
using Game.Routes;
using Game.Simulation;
using Game.UI.InGame;
using Newtonsoft.Json.Linq;
using Unity.Collections;
using Unity.Entities;
using Unity.Mathematics;

namespace CS2MCP
{
    /// <summary>
    /// Native route/transport-line discovery, creation, mutation and readback.
    /// Stops, stations and track courses still need their own native contracts;
    /// route geometry mutation is kept separate because it reconciles existing
    /// route/waypoint entities through the game's route systems.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private EntityQuery m_TransportLinePrefabQuery;
        private bool m_TransportLinePrefabQueryCreated;
        private EntityQuery m_TransportLineQuery;
        private bool m_TransportLineQueryCreated;

        private EntityQuery TransportLinePrefabQuery
        {
            get
            {
                if (!m_TransportLinePrefabQueryCreated)
                {
                    m_TransportLinePrefabQuery = EntityManager.CreateEntityQuery(
                        ComponentType.ReadOnly<TransportLineData>());
                    m_TransportLinePrefabQueryCreated = true;
                }
                return m_TransportLinePrefabQuery;
            }
        }

        private EntityQuery TransportLineQuery
        {
            get
            {
                if (!m_TransportLineQueryCreated)
                {
                    m_TransportLineQuery = EntityManager.CreateEntityQuery(new EntityQueryDesc
                    {
                        All = new[]
                        {
                            ComponentType.ReadOnly<Route>(),
                            ComponentType.ReadOnly<TransportLine>(),
                        },
                        None = new[]
                        {
                            ComponentType.ReadOnly<Game.Tools.Temp>(),
                            ComponentType.ReadOnly<Deleted>(),
                        },
                    });
                    m_TransportLineQueryCreated = true;
                }
                return m_TransportLineQuery;
            }
        }

        private BridgeResponse ListTransportLinePrefabs(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            request.Query.TryGetValue("query", out string search);
            int limit = request.TryGetInt("limit", out int rawLimit)
                ? math.clamp(rawLimit, 1, 200)
                : 100;
            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            var results = new List<object>();
            int total = 0;
            using (NativeArray<Entity> entities = TransportLinePrefabQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    TransportLinePrefab prefab = prefabSystem.GetPrefab<TransportLinePrefab>(entity);
                    if (prefab == null
                        || (!string.IsNullOrEmpty(search)
                            && prefab.name.IndexOf(search, StringComparison.OrdinalIgnoreCase) < 0))
                    {
                        continue;
                    }
                    total++;
                    if (results.Count >= limit)
                    {
                        continue;
                    }
                    TransportLineData data = EntityManager.GetComponentData<TransportLineData>(entity);
                    results.Add(new
                    {
                        entity = new { index = entity.Index, version = entity.Version },
                        name = prefab.name,
                        type = prefab.GetType().Name,
                        transportType = data.m_TransportType.ToString(),
                        passenger = data.m_PassengerTransport,
                        cargo = data.m_CargoTransport,
                        locked = IsLocked(entity),
                        available = !IsLocked(entity),
                    });
                }
            }

            return BridgeResponse.Json(new
            {
                category = "transport",
                totalMatches = total,
                returned = results.Count,
                note = "runtime TransportLinePrefab discovery; use the exact name with /transport/line",
                prefabs = results,
            });
        }

        private BridgeResponse ListTransportLines(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            request.Query.TryGetValue("query", out string search);
            int limit = request.TryGetInt("limit", out int rawLimit)
                ? math.clamp(rawLimit, 1, 200)
                : 100;
            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            var results = new List<object>();
            int total = 0;
            using (NativeArray<Entity> entities = TransportLineQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    string prefabName = null;
                    if (EntityManager.HasComponent<PrefabRef>(entity))
                    {
                        PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(
                            EntityManager.GetComponentData<PrefabRef>(entity).m_Prefab);
                        prefabName = prefab != null ? prefab.name : null;
                    }
                    if (!string.IsNullOrEmpty(search)
                        && (prefabName == null
                            || prefabName.IndexOf(search, StringComparison.OrdinalIgnoreCase) < 0))
                    {
                        continue;
                    }
                    total++;
                    if (results.Count >= limit)
                    {
                        continue;
                    }

                    Route route = EntityManager.GetComponentData<Route>(entity);
                    TransportLine line = EntityManager.GetComponentData<TransportLine>(entity);
                    var points = new List<object>();
                    int segmentCount = 0;
                    if (EntityManager.HasBuffer<RouteWaypoint>(entity))
                    {
                        DynamicBuffer<RouteWaypoint> routeWaypoints =
                            EntityManager.GetBuffer<RouteWaypoint>(entity, isReadOnly: true);
                        for (int i = 0; i < routeWaypoints.Length; i++)
                        {
                            Entity waypoint = routeWaypoints[i].m_Waypoint;
                            if (!EntityManager.Exists(waypoint)
                                || !EntityManager.HasComponent<Position>(waypoint))
                            {
                                continue;
                            }
                            Position position = EntityManager.GetComponentData<Position>(waypoint);
                            Entity connection = EntityManager.HasComponent<Connected>(waypoint)
                                ? EntityManager.GetComponentData<Connected>(waypoint).m_Connected
                                : Entity.Null;
                            points.Add(new
                            {
                                entity = new { index = waypoint.Index, version = waypoint.Version },
                                x = position.m_Position.x,
                                y = position.m_Position.y,
                                z = position.m_Position.z,
                                connection = DescribeEntity(connection),
                                connectionIsTransportStop = connection != Entity.Null
                                    && EntityManager.Exists(connection)
                                    && EntityManager.HasComponent<Game.Routes.TransportStop>(connection),
                            });
                        }
                    }
                    if (EntityManager.HasBuffer<RouteSegment>(entity))
                    {
                        segmentCount = EntityManager.GetBuffer<RouteSegment>(entity, isReadOnly: true).Length;
                    }

                    int? number = EntityManager.HasComponent<RouteNumber>(entity)
                        ? EntityManager.GetComponentData<RouteNumber>(entity).m_Number
                        : null;
                    RouteInfo info = EntityManager.HasComponent<RouteInfo>(entity)
                        ? EntityManager.GetComponentData<RouteInfo>(entity)
                        : default;
                    results.Add(new
                    {
                        entity = new { index = entity.Index, version = entity.Version },
                        prefab = prefabName,
                        number,
                        flags = route.m_Flags.ToString(),
                        optionMask = route.m_OptionMask,
                        vehicleInterval = line.m_VehicleInterval,
                        ticketPrice = line.m_TicketPrice,
                        distance = info.m_Distance,
                        duration = info.m_Duration,
                        waypointCount = points.Count,
                        segmentCount,
                        waypoints = points,
                    });
                }
            }

            return BridgeResponse.Json(new
            {
                totalMatches = total,
                returned = results.Count,
                note = "live Route + TransportLine entities; waypoint positions are read from the game's route ECS",
                lines = results,
            });
        }

        private BridgeResponse AnalyzeTransport(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            int limit = request.TryGetInt("limit", out int rawLimit)
                ? math.clamp(rawLimit, 1, 500)
                : 200;
            bool hasCenter = request.TryGetFloat("x", out float x)
                & request.TryGetFloat("z", out float z);
            float radius = request.TryGetFloat("radius", out float rawRadius)
                ? math.max(rawRadius, 1f)
                : 20000f;
            float2 center = new float2(x, z);
            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();

            var stations = new List<object>();
            var depots = new List<object>();
            var stops = new List<object>();

            EntityQuery stationQuery = EntityManager.CreateEntityQuery(new EntityQueryDesc
            {
                All = new[]
                {
                    ComponentType.ReadOnly<Game.Buildings.TransportStation>(),
                    ComponentType.ReadOnly<Transform>(),
                },
                None = new[]
                {
                    ComponentType.ReadOnly<Game.Tools.Temp>(),
                    ComponentType.ReadOnly<Deleted>(),
                },
            });
            using (NativeArray<Entity> entities = stationQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    Transform transform = EntityManager.GetComponentData<Transform>(entity);
                    if (hasCenter && math.distance(transform.m_Position.xz, center) > radius)
                    {
                        continue;
                    }

                    Game.Buildings.TransportStation station = EntityManager.GetComponentData<Game.Buildings.TransportStation>(entity);
                    stations.Add(new
                    {
                        entity = DescribeEntity(entity),
                        prefab = DescribePrefab(entity, prefabSystem),
                        position = DescribePosition(transform.m_Position),
                        rotation = DescribeRotation(transform.m_Rotation),
                        flags = station.m_Flags.ToString(),
                        comfortFactor = station.m_ComfortFactor,
                        loadingFactor = station.m_LoadingFactor,
                        carRefuelTypes = station.m_CarRefuelTypes.ToString(),
                        trainRefuelTypes = station.m_TrainRefuelTypes.ToString(),
                        watercraftRefuelTypes = station.m_WatercraftRefuelTypes.ToString(),
                        aircraftRefuelTypes = station.m_AircraftRefuelTypes.ToString(),
                        subObjectCount = EntityManager.HasBuffer<Game.Objects.SubObject>(entity)
                            ? EntityManager.GetBuffer<Game.Objects.SubObject>(entity, isReadOnly: true).Length
                            : 0,
                    });
                    if (stations.Count >= limit)
                    {
                        break;
                    }
                }
            }

            EntityQuery depotQuery = EntityManager.CreateEntityQuery(new EntityQueryDesc
            {
                All = new[]
                {
                    ComponentType.ReadOnly<Game.Buildings.TransportDepot>(),
                    ComponentType.ReadOnly<Transform>(),
                },
                None = new[]
                {
                    ComponentType.ReadOnly<Game.Tools.Temp>(),
                    ComponentType.ReadOnly<Deleted>(),
                },
            });
            using (NativeArray<Entity> entities = depotQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    Transform transform = EntityManager.GetComponentData<Transform>(entity);
                    if (hasCenter && math.distance(transform.m_Position.xz, center) > radius)
                    {
                        continue;
                    }

                    Game.Buildings.TransportDepot depot = EntityManager.GetComponentData<Game.Buildings.TransportDepot>(entity);
                    depots.Add(new
                    {
                        entity = DescribeEntity(entity),
                        prefab = DescribePrefab(entity, prefabSystem),
                        position = DescribePosition(transform.m_Position),
                        rotation = DescribeRotation(transform.m_Rotation),
                        flags = depot.m_Flags.ToString(),
                        availableVehicles = depot.m_AvailableVehicles,
                        maintenanceRequirement = depot.m_MaintenanceRequirement,
                        targetRequest = DescribeEntity(depot.m_TargetRequest),
                        subObjectCount = EntityManager.HasBuffer<Game.Objects.SubObject>(entity)
                            ? EntityManager.GetBuffer<Game.Objects.SubObject>(entity, isReadOnly: true).Length
                            : 0,
                    });
                    if (depots.Count >= limit)
                    {
                        break;
                    }
                }
            }

            EntityQuery stopQuery = EntityManager.CreateEntityQuery(new EntityQueryDesc
            {
                All = new[]
                {
                    ComponentType.ReadOnly<Game.Routes.TransportStop>(),
                },
                None = new[]
                {
                    ComponentType.ReadOnly<Game.Tools.Temp>(),
                    ComponentType.ReadOnly<Deleted>(),
                },
            });
            using (NativeArray<Entity> entities = stopQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    float3 position = default;
                    quaternion rotation = quaternion.identity;
                    bool hasPosition = false;
                    if (EntityManager.HasComponent<Transform>(entity))
                    {
                        Transform transform = EntityManager.GetComponentData<Transform>(entity);
                        position = transform.m_Position;
                        rotation = transform.m_Rotation;
                        hasPosition = true;
                    }
                    else if (EntityManager.HasComponent<Game.Routes.Position>(entity))
                    {
                        position = EntityManager.GetComponentData<Game.Routes.Position>(entity).m_Position;
                        hasPosition = true;
                    }

                    if (hasCenter && (!hasPosition || math.distance(position.xz, center) > radius))
                    {
                        continue;
                    }

                    Game.Routes.TransportStop stop = EntityManager.GetComponentData<Game.Routes.TransportStop>(entity);
                    var connectedRoutes = new List<object>();
                    if (EntityManager.HasBuffer<Game.Routes.ConnectedRoute>(entity))
                    {
                        DynamicBuffer<Game.Routes.ConnectedRoute> routes = EntityManager.GetBuffer<Game.Routes.ConnectedRoute>(entity, isReadOnly: true);
                        for (int i = 0; i < routes.Length; i++)
                        {
                            connectedRoutes.Add(DescribeEntity(routes[i].m_Waypoint));
                        }
                    }

                    stops.Add(new
                    {
                        entity = DescribeEntity(entity),
                        prefab = DescribePrefab(entity, prefabSystem),
                        position = hasPosition ? DescribePosition(position) : null,
                        rotation = hasPosition ? DescribeRotation(rotation) : null,
                        flags = stop.m_Flags.ToString(),
                        comfortFactor = stop.m_ComfortFactor,
                        loadingFactor = stop.m_LoadingFactor,
                        accessRestriction = DescribeEntity(stop.m_AccessRestriction),
                        connectedRouteWaypointCount = connectedRoutes.Count,
                        connectedRouteWaypoints = connectedRoutes,
                        hasStopMarker = EntityManager.HasComponent<Game.Prefabs.TransportStopMarker>(entity),
                        waitingPassengers = EntityManager.HasComponent<Game.Routes.WaitingPassengers>(entity)
                            ? DescribeWaitingPassengers(EntityManager.GetComponentData<Game.Routes.WaitingPassengers>(entity))
                            : null,
                    });
                    if (stops.Count >= limit)
                    {
                        break;
                    }
                }
            }

            return BridgeResponse.Json(new
            {
                success = true,
                center = hasCenter ? new { x, z } : null,
                radius = hasCenter ? radius : (float?)null,
                limit,
                counts = new
                {
                    stations = stations.Count,
                    depots = depots.Count,
                    stops = stops.Count,
                },
                stations,
                depots,
                stops,
                lineAnalytics = DescribeTransportLineAnalytics(request, prefabSystem),
                note = "read-only native TransportStation, TransportDepot, TransportStop and ConnectedRoute observation; it does not infer missing stop-to-route bindings",
            });
        }

        private static object DescribeWaitingPassengers(Game.Routes.WaitingPassengers waiting)
        {
            return new
            {
                count = waiting.m_Count,
                ongoingAccumulation = waiting.m_OngoingAccumulation,
                concludedAccumulation = waiting.m_ConcludedAccumulation,
                successfulAccumulation = waiting.m_SuccessAccumulation,
                averageWaitingTimeSeconds = waiting.m_AverageWaitingTime,
            };
        }

        private List<object> DescribeTransportLineAnalytics(BridgeRequest request, PrefabSystem prefabSystem)
        {
            int limit = request.TryGetInt("lineLimit", out int rawLimit)
                ? math.clamp(rawLimit, 1, 200)
                : 100;
            bool hasCenter = request.TryGetFloat("x", out float x)
                & request.TryGetFloat("z", out float z);
            float radius = request.TryGetFloat("radius", out float rawRadius)
                ? math.max(rawRadius, 1f)
                : 20000f;
            float2 center = new float2(x, z);
            var results = new List<object>();
            using (NativeArray<Entity> entities = TransportLineQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    float3 anchor = default;
                    bool hasAnchor = false;
                    if (EntityManager.HasBuffer<RouteWaypoint>(entity))
                    {
                        DynamicBuffer<RouteWaypoint> waypoints = EntityManager.GetBuffer<RouteWaypoint>(entity, isReadOnly: true);
                        if (waypoints.Length > 0 && EntityManager.Exists(waypoints[0].m_Waypoint))
                        {
                            Entity waypoint = waypoints[0].m_Waypoint;
                            if (EntityManager.HasComponent<Position>(waypoint))
                            {
                                anchor = EntityManager.GetComponentData<Position>(waypoint).m_Position;
                                hasAnchor = true;
                            }
                        }
                    }
                    if (hasCenter && (!hasAnchor || math.distance(anchor.xz, center) > radius))
                    {
                        continue;
                    }

                    TransportLine line = EntityManager.GetComponentData<TransportLine>(entity);
                    UITransportLineData? ui = null;
                    try
                    {
                        ui = TransportUIUtils.BuildTransportLine(entity, EntityManager, prefabSystem);
                    }
                    catch (Exception)
                    {
                        // A partially initialized route is still useful below;
                        // keep the native component readback and mark UI data
                        // unavailable instead of turning analytics into a fake zero.
                    }

                    int routeVehicleCount = 0;
                    var vehicleEntities = new List<object>();
                    if (EntityManager.HasBuffer<RouteVehicle>(entity))
                    {
                        DynamicBuffer<RouteVehicle> vehicles = EntityManager.GetBuffer<RouteVehicle>(entity, isReadOnly: true);
                        routeVehicleCount = vehicles.Length;
                        for (int i = 0; i < vehicles.Length && i < 64; i++)
                        {
                            vehicleEntities.Add(DescribeEntity(vehicles[i].m_Vehicle));
                        }
                    }

                    int waitingCount = 0;
                    int connectedStopCount = 0;
                    if (EntityManager.HasBuffer<RouteWaypoint>(entity))
                    {
                        DynamicBuffer<RouteWaypoint> waypoints = EntityManager.GetBuffer<RouteWaypoint>(entity, isReadOnly: true);
                        for (int i = 0; i < waypoints.Length; i++)
                        {
                            Entity waypoint = waypoints[i].m_Waypoint;
                            if (!EntityManager.Exists(waypoint) || !EntityManager.HasComponent<Connected>(waypoint))
                            {
                                continue;
                            }
                            Entity connected = EntityManager.GetComponentData<Connected>(waypoint).m_Connected;
                            if (connected == Entity.Null || !EntityManager.Exists(connected)
                                || !EntityManager.HasComponent<Game.Routes.TransportStop>(connected))
                            {
                                continue;
                            }
                            connectedStopCount++;
                            if (EntityManager.HasComponent<WaitingPassengers>(connected))
                            {
                                waitingCount += math.max(0, EntityManager.GetComponentData<WaitingPassengers>(connected).m_Count);
                            }
                        }
                    }

                    VehicleTiming? timing = EntityManager.HasComponent<VehicleTiming>(entity)
                        ? EntityManager.GetComponentData<VehicleTiming>(entity)
                        : (VehicleTiming?)null;
                    object timingData = timing.HasValue
                        ? new
                        {
                            lastDepartureFrame = timing.Value.m_LastDepartureFrame,
                            averageTravelTimeSeconds = timing.Value.m_AverageTravelTime,
                        }
                        : null;

                    results.Add(new
                    {
                        entity = DescribeEntity(entity),
                        prefab = DescribePrefab(entity, prefabSystem),
                        anchor = hasAnchor ? DescribePosition(anchor) : null,
                        native = new
                        {
                            vehicleIntervalSeconds = line.m_VehicleInterval,
                            unbunchingFactor = line.m_UnbunchingFactor,
                            ticketPrice = line.m_TicketPrice,
                            flags = line.m_Flags.ToString(),
                            vehicleRequest = DescribeEntity(line.m_VehicleRequest),
                            optionMask = EntityManager.GetComponentData<Route>(entity).m_OptionMask,
                        },
                        ui = !ui.HasValue
                            ? null
                            : new
                            {
                                active = ui.Value.active,
                                schedule = ui.Value.schedule,
                                scheduleName = ((RouteOption)ui.Value.schedule).ToString(),
                                type = ui.Value.type.ToString(),
                                length = ui.Value.length,
                                stops = ui.Value.stops,
                                vehicles = ui.Value.vehicles,
                                cargo = ui.Value.cargo,
                                usage = ui.Value.usage,
                            },
                        routeVehicleCount,
                        vehicleEntities,
                        connectedStopCount,
                        waitingPassengers = waitingCount,
                        timing = timingData,
                    });
                    if (results.Count >= limit)
                    {
                        break;
                    }
                }
            }
            return results;
        }

        private static object DescribeEntity(Entity entity)
        {
            return entity == Entity.Null
                ? null
                : new { index = entity.Index, version = entity.Version };
        }

        private static object DescribePosition(float3 position)
        {
            return new { x = position.x, y = position.y, z = position.z };
        }

        private static object DescribeRotation(quaternion rotation)
        {
            return new
            {
                x = rotation.value.x,
                y = rotation.value.y,
                z = rotation.value.z,
                w = rotation.value.w,
            };
        }

        private static string DescribePrefab(Entity entity, PrefabSystem prefabSystem)
        {
            if (entity == Entity.Null)
            {
                return null;
            }
            if (!prefabSystem.EntityManager.HasComponent<PrefabRef>(entity))
            {
                return null;
            }
            PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(prefabSystem.EntityManager.GetComponentData<PrefabRef>(entity).m_Prefab);
            return prefab != null ? prefab.name : null;
        }

        private BridgeResponse PlaceTransportStop(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse cityError))
            {
                return cityError;
            }
            if (!request.TryGetFloat("x", out float x) || !request.TryGetFloat("z", out float z))
            {
                return BridgeResponse.Error(400, "provide ?x=<float>&z=<float> world coordinates");
            }

            request.Query.TryGetValue("prefab", out string requestedName);
            request.Query.TryGetValue("mode", out string requestedMode);
            bool force = IsForced(request);
            if (!TryFindTransportStopPrefab(requestedName, requestedMode, force,
                out Entity prefabEntity, out PrefabBase prefab, out TransportStopData stopData, out BridgeResponse prefabError))
            {
                return prefabError;
            }

            float y;
            if (!request.TryGetFloat("y", out y))
            {
                TerrainSystem terrain = World.GetOrCreateSystemManaged<TerrainSystem>();
                TerrainHeightData heightData = terrain.GetHeightData();
                y = TerrainUtils.SampleHeight(ref heightData, new float3(x, 0f, z));
            }
            request.TryGetFloat("rotation", out float rotationDegrees);
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
                            entity = DescribeEntity(prefabEntity),
                            name = prefab.name,
                            type = prefab.GetType().Name,
                            transportType = stopData.m_TransportType.ToString(),
                            passenger = stopData.m_PassengerTransport,
                            cargo = stopData.m_CargoTransport,
                            locked = IsLocked(prefabEntity),
                        },
                        position = DescribePosition(new float3(x, y, z)),
                        rotation = DescribeRotation(rotation),
                    },
                    nativePath = "ObjectToolBaseSystem/CreateDefinitions with a road ControlPoint anchor -> native TransportStopData expansion",
                    note = "preview only; no stop definition was emitted",
                });
            }

            BridgeToolSystem tool = World.GetOrCreateSystemManaged<BridgeToolSystem>();
            if (!tool.TryQueuePlacement(prefabEntity, prefab, new float3(x, y, z), rotation, request))
            {
                return BridgeResponse.Error(409, tool.LastPlacementFailure ?? "another build operation is in progress, retry shortly");
            }
            return null;
        }

        private bool TryFindTransportStopPrefab(
            string requestedName,
            string requestedMode,
            bool force,
            out Entity entity,
            out PrefabBase prefab,
            out TransportStopData stopData,
            out BridgeResponse error)
        {
            entity = Entity.Null;
            prefab = null;
            stopData = default;
            error = null;
            TransportType? mode = ParseTransportType(requestedMode);
            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            Entity bestEntity = Entity.Null;
            PrefabBase bestPrefab = null;
            TransportStopData bestData = default;
            using (NativeArray<Entity> candidates = ObjectPrefabQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity candidate in candidates)
                {
                    if (!EntityManager.HasComponent<TransportStopData>(candidate))
                    {
                        continue;
                    }
                    PrefabBase candidatePrefab = prefabSystem.GetPrefab<PrefabBase>(candidate);
                    if (candidatePrefab == null
                        || (candidatePrefab is not StaticObjectPrefab
                            && candidatePrefab is not MarkerObjectPrefab))
                    {
                        continue;
                    }
                    if (!string.IsNullOrEmpty(requestedName)
                        && !string.Equals(candidatePrefab.name, requestedName, StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }
                    TransportStopData candidateData = EntityManager.GetComponentData<TransportStopData>(candidate);
                    if (mode.HasValue && !MatchesTransportStopMode(candidateData, requestedMode, mode.Value))
                    {
                        continue;
                    }
                    if (IsLocked(candidate) && !force)
                    {
                        error = BridgeResponse.Error(409,
                            $"transport stop prefab '{candidatePrefab.name}' is locked (milestone not reached); pass force=true to use it");
                        return false;
                    }

                    // Prefer the user-facing static stop sign when the caller
                    // did not request an exact prefab. MarkerObjectPrefab is
                    // still accepted for explicit integrated-stop requests.
                    if (bestPrefab == null
                        || (bestPrefab is MarkerObjectPrefab && candidatePrefab is StaticObjectPrefab))
                    {
                        bestEntity = candidate;
                        bestPrefab = candidatePrefab;
                        bestData = candidateData;
                    }
                    if (!string.IsNullOrEmpty(requestedName))
                    {
                        break;
                    }
                }
            }

            if (bestPrefab == null)
            {
                error = BridgeResponse.Error(404,
                    string.IsNullOrEmpty(requestedName)
                        ? "no runtime transport-stop prefab matched; discover with /prefabs?category=all&query=Stop"
                        : $"unknown transport-stop prefab '{requestedName}'; discover with /prefabs?category=all&query=Stop");
                return false;
            }
            entity = bestEntity;
            prefab = bestPrefab;
            stopData = bestData;
            return true;
        }

        private static bool MatchesTransportStopMode(TransportStopData data, string requestedMode, TransportType mode)
        {
            if (string.Equals(requestedMode, "cargo", StringComparison.OrdinalIgnoreCase))
            {
                return data.m_CargoTransport;
            }
            return data.m_TransportType == mode && data.m_PassengerTransport;
        }

        private bool TryFindTransportPrefab(
            string requestedName,
            string requestedMode,
            bool force,
            out Entity entity,
            out TransportLinePrefab prefab,
            out BridgeResponse error)
        {
            entity = Entity.Null;
            prefab = null;
            error = null;
            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            TransportType? mode = ParseTransportType(requestedMode);
            using (NativeArray<Entity> entities = TransportLinePrefabQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity candidateEntity in entities)
                {
                    TransportLinePrefab candidate = prefabSystem.GetPrefab<TransportLinePrefab>(candidateEntity);
                    if (candidate == null)
                    {
                        continue;
                    }
                    TransportLineData data = EntityManager.GetComponentData<TransportLineData>(candidateEntity);
                    if (!string.IsNullOrEmpty(requestedName)
                        && !string.Equals(candidate.name, requestedName, StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }
                    if (mode.HasValue && data.m_TransportType != mode.Value)
                    {
                        continue;
                    }
                    if (IsLocked(candidateEntity) && !force)
                    {
                        error = BridgeResponse.Error(409,
                            $"transport prefab '{candidate.name}' is locked (milestone not reached); pass force=true to use it");
                        return false;
                    }
                    entity = candidateEntity;
                    prefab = candidate;
                    return true;
                }
            }

            if (!string.IsNullOrEmpty(requestedName))
            {
                error = BridgeResponse.Error(404,
                    $"unknown transport prefab '{requestedName}'; discover with /prefabs?category=transport");
            }
            else if (mode.HasValue)
            {
                error = BridgeResponse.Error(404,
                    $"no runtime transport prefab for mode '{requestedMode}'; discover with /prefabs?category=transport");
            }
            else
            {
                error = BridgeResponse.Error(400, "provide ?prefab=<runtime transport prefab> or ?mode=bus|tram|subway|train|ship|ferry|taxi");
            }
            return false;
        }

        private static TransportType? ParseTransportType(string raw)
        {
            if (string.IsNullOrEmpty(raw))
            {
                return null;
            }
            if (string.Equals(raw, "cargo", StringComparison.OrdinalIgnoreCase))
            {
                return TransportType.Train;
            }
            return Enum.TryParse(raw, true, out TransportType value) && value != TransportType.None
                ? value
                : (TransportType?)null;
        }

        private bool TryReadTransportPoints(BridgeRequest request, out float3[] points, out BridgeResponse error)
        {
            points = null;
            error = null;
            if (!request.Query.TryGetValue("points", out string raw) || string.IsNullOrWhiteSpace(raw))
            {
                error = BridgeResponse.Error(400,
                    "provide ?points=<url-encoded JSON array [{x,z,y?},...]> with at least 2 points");
                return false;
            }

            var parsedPoints = new List<float3>();
            try
            {
                JToken parsed = JToken.Parse(raw);
                if (parsed is not JArray array || array.Count < 2 || array.Count > 128)
                {
                    error = BridgeResponse.Error(400, "points must be a JSON array with 2-128 point objects");
                    return false;
                }
                foreach (JToken token in array)
                {
                    if (!TryReadPoint(token, out TerrainPoint point))
                    {
                        error = BridgeResponse.Error(400, "each transport point must contain numeric x and z, with optional y");
                        return false;
                    }
                    parsedPoints.Add(point.Position);
                }
            }
            catch (Exception e)
            {
                error = BridgeResponse.Error(400, $"cannot parse points JSON: {e.Message}");
                return false;
            }

            TerrainSystem terrain = World.GetOrCreateSystemManaged<TerrainSystem>();
            TerrainHeightData heightData = terrain.GetHeightData();
            for (int i = 0; i < parsedPoints.Count; i++)
            {
                float3 point = parsedPoints[i];
                if (math.abs(point.y) < 0.0001f)
                {
                    point.y = TerrainUtils.SampleHeight(ref heightData, point);
                    parsedPoints[i] = point;
                }
            }
            points = parsedPoints.ToArray();
            return true;
        }

        private static object[] DescribeTransportPoints(float3[] points)
        {
            var result = new object[points.Length];
            for (int i = 0; i < points.Length; i++)
            {
                result[i] = new
                {
                    x = points[i].x,
                    y = points[i].y,
                    z = points[i].z,
                };
            }
            return result;
        }

        private bool TryReadTransportConnections(
            BridgeRequest request,
            int pointCount,
            out Entity[] connections,
            out BridgeResponse error)
        {
            connections = new Entity[pointCount];
            error = null;
            for (int i = 0; i < connections.Length; i++)
            {
                connections[i] = Entity.Null;
            }

            if (!request.Query.TryGetValue("connections", out string raw)
                || string.IsNullOrWhiteSpace(raw))
            {
                return true;
            }

            try
            {
                JToken parsed = JToken.Parse(raw);
                if (parsed is not JArray array || array.Count != pointCount)
                {
                    error = BridgeResponse.Error(400,
                        $"connections must be a JSON array with exactly {pointCount} entries (null for an unbound waypoint)");
                    return false;
                }

                for (int i = 0; i < array.Count; i++)
                {
                    JToken token = array[i];
                    if (token == null || token.Type == JTokenType.Null)
                    {
                        continue;
                    }
                    if (token.Type != JTokenType.Object
                        || !int.TryParse((string)token["index"], out int index)
                        || !int.TryParse((string)token["version"], out int version))
                    {
                        error = BridgeResponse.Error(400,
                            "each connections entry must be null or {\"index\":<int>,\"version\":<int>}");
                        return false;
                    }

                    Entity connection = new Entity { Index = index, Version = version };
                    if (!EntityManager.Exists(connection)
                        || !EntityManager.HasComponent<Game.Routes.TransportStop>(connection)
                        || EntityManager.HasComponent<Game.Tools.Temp>(connection)
                        || EntityManager.HasComponent<Deleted>(connection))
                    {
                        error = BridgeResponse.Error(404,
                            $"connection {index}:{version} is not a live TransportStop entity");
                        return false;
                    }
                    connections[i] = connection;
                }
            }
            catch (Exception e)
            {
                error = BridgeResponse.Error(400, $"cannot parse connections JSON: {e.Message}");
                return false;
            }
            return true;
        }

        private BridgeResponse CreateTransportLine(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse cityError))
            {
                return cityError;
            }
            if (!TryReadTransportPoints(request, out float3[] points, out BridgeResponse pointError))
            {
                return pointError;
            }
            if (!TryReadTransportConnections(request, points.Length, out Entity[] connections, out BridgeResponse connectionError))
            {
                return connectionError;
            }
            request.Query.TryGetValue("prefab", out string requestedName);
            request.Query.TryGetValue("mode", out string requestedMode);
            bool force = IsForced(request);
            if (!TryFindTransportPrefab(requestedName, requestedMode, force,
                out Entity prefabEntity, out TransportLinePrefab prefab, out BridgeResponse prefabError))
            {
                return prefabError;
            }

            float length = 0f;
            for (int i = 1; i < points.Length; i++)
            {
                length += math.distance(points[i - 1], points[i]);
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
                        prefab = new
                        {
                            entity = new { index = prefabEntity.Index, version = prefabEntity.Version },
                            name = prefab.name,
                            transportType = EntityManager.GetComponentData<TransportLineData>(prefabEntity).m_TransportType.ToString(),
                            locked = IsLocked(prefabEntity),
                        },
                         points = DescribeTransportPoints(points),
                         connections = DescribeTransportConnections(connections),
                        pointCount = points.Length,
                        length,
                    },
                    note = "preview only; no route definition was emitted",
                });
            }

            BridgeToolSystem tool = World.GetOrCreateSystemManaged<BridgeToolSystem>();
            if (!tool.TryQueueTransportLine(prefabEntity, prefab, points, connections, request))
            {
                return BridgeResponse.Error(409, "another build operation is in progress, retry shortly");
            }
            return null;
        }

        private BridgeResponse DispatchTransportVehicle(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse cityError))
            {
                return cityError;
            }
            if (!request.TryGetInt("index", out int index) || !request.TryGetInt("version", out int version))
            {
                return BridgeResponse.Error(400, "provide ?index=<int>&version=<int> from /transport/lines");
            }

            Entity route = new Entity { Index = index, Version = version };
            if (!EntityManager.Exists(route)
                || !EntityManager.HasComponent<Route>(route)
                || !EntityManager.HasComponent<TransportLine>(route)
                || EntityManager.HasComponent<Game.Tools.Temp>(route)
                || EntityManager.HasComponent<Deleted>(route))
            {
                return BridgeResponse.Error(404, $"entity {index}:{version} is not a live TransportLine route");
            }
            if (!EntityManager.HasBuffer<RouteWaypoint>(route)
                || EntityManager.GetBuffer<RouteWaypoint>(route, isReadOnly: true).Length < 2)
            {
                return BridgeResponse.Error(409, "transport route has fewer than two native waypoints; refusing to dispatch a vehicle");
            }

            float priority = request.TryGetFloat("priority", out float requestedPriority)
                ? math.clamp(requestedPriority, 0f, 100f)
                : 1f;
            TransportLine line = EntityManager.GetComponentData<TransportLine>(route);
            bool pendingRequest = line.m_VehicleRequest != Entity.Null
                && EntityManager.Exists(line.m_VehicleRequest)
                && EntityManager.HasComponent<TransportVehicleRequest>(line.m_VehicleRequest);
            bool dryRun = request.TryGetBool("dryRun", out bool requestedDryRun) && requestedDryRun;
            if (dryRun)
            {
                return BridgeResponse.Json(new
                {
                    success = true,
                    dryRun = true,
                    route = new { index, version },
                    priority,
                    pendingRequest,
                    nativeArchetype = new[] { "ServiceRequest", "TransportVehicleRequest", "RequestGroup" },
                    nativePath = "TransportLineSystem.m_VehicleRequestArchetype + TransportPathfindSetupSystem + TransportVehicleDispatchSystem",
                    note = "preview only; no vehicle request entity was emitted",
                });
            }
            if (pendingRequest)
            {
                return BridgeResponse.Error(409, "this route already has a pending native transport-vehicle request; wait for it to resolve before dispatching another");
            }

            BridgeToolSystem tool = World.GetOrCreateSystemManaged<BridgeToolSystem>();
            if (!tool.TryQueueTransportDispatch(route, priority, request))
            {
                return BridgeResponse.Error(409, "another build or transport operation is in progress, retry shortly");
            }
            return null;
        }

        private static object[] DescribeTransportConnections(Entity[] connections)
        {
            var result = new object[connections?.Length ?? 0];
            for (int i = 0; i < result.Length; i++)
            {
                result[i] = DescribeEntity(connections[i]);
            }
            return result;
        }

        private static object[] DescribeTransportEntities(Entity[] entities)
        {
            var result = new object[entities?.Length ?? 0];
            for (int i = 0; i < result.Length; i++)
            {
                result[i] = DescribeEntity(entities[i]);
            }
            return result;
        }

        private bool TryReadTransportLine(
            BridgeRequest request,
            out Entity route,
            out Entity[] waypoints,
            out Entity[] connections,
            out float3[] points,
            out BridgeResponse error)
        {
            route = Entity.Null;
            waypoints = null;
            connections = null;
            points = null;
            error = null;

            if (!request.TryGetInt("index", out int index)
                || !request.TryGetInt("version", out int version))
            {
                error = BridgeResponse.Error(400,
                    "provide ?index=<int>&version=<int> from /transport/lines");
                return false;
            }

            route = new Entity { Index = index, Version = version };
            if (!EntityManager.Exists(route))
            {
                error = BridgeResponse.Error(404,
                    $"transport route {index}:{version} does not exist (stale id?)");
                return false;
            }
            if (!EntityManager.HasComponent<Route>(route)
                || !EntityManager.HasComponent<TransportLine>(route))
            {
                error = BridgeResponse.Error(400,
                    $"entity {index}:{version} is not a live transport line");
                return false;
            }
            if (EntityManager.HasComponent<Game.Tools.Temp>(route)
                || EntityManager.HasComponent<Deleted>(route))
            {
                error = BridgeResponse.Error(409,
                    $"transport route {index}:{version} is already in a native mutation");
                return false;
            }
            if (!EntityManager.HasBuffer<RouteWaypoint>(route))
            {
                error = BridgeResponse.Error(409,
                    "transport route has no RouteWaypoint buffer; refusing a partial mutation");
                return false;
            }

            DynamicBuffer<RouteWaypoint> routeWaypoints =
                EntityManager.GetBuffer<RouteWaypoint>(route, isReadOnly: true);
            if (routeWaypoints.Length < 2 || routeWaypoints.Length > 128)
            {
                error = BridgeResponse.Error(409,
                    $"transport route has {routeWaypoints.Length} waypoints; native mutation requires 2-128");
                return false;
            }

            waypoints = new Entity[routeWaypoints.Length];
            connections = new Entity[routeWaypoints.Length];
            points = new float3[routeWaypoints.Length];
            for (int i = 0; i < routeWaypoints.Length; i++)
            {
                Entity waypoint = routeWaypoints[i].m_Waypoint;
                if (!EntityManager.Exists(waypoint)
                    || !EntityManager.HasComponent<Position>(waypoint))
                {
                    error = BridgeResponse.Error(409,
                        $"route waypoint {i} is stale or has no native Position component");
                    return false;
                }
                waypoints[i] = waypoint;
                points[i] = EntityManager.GetComponentData<Position>(waypoint).m_Position;
                connections[i] = EntityManager.HasComponent<Connected>(waypoint)
                    ? EntityManager.GetComponentData<Connected>(waypoint).m_Connected
                    : Entity.Null;
            }
            return true;
        }

        private bool TryReadTransportOriginalWaypoints(
            BridgeRequest request,
            Entity[] currentWaypoints,
            float3[] newPoints,
            out Entity[] originalWaypoints,
            out bool cardinalityChanged,
            out BridgeResponse error)
        {
            originalWaypoints = null;
            cardinalityChanged = false;
            error = null;

            if (!request.Query.TryGetValue("originalWaypoints", out string raw)
                || string.IsNullOrWhiteSpace(raw))
            {
                if (newPoints.Length != currentWaypoints.Length)
                {
                    error = BridgeResponse.Error(400,
                        "originalWaypoints is required for cardinality-changing route mutations; pass one existing waypoint entity or null for each target point");
                    return false;
                }
                originalWaypoints = (Entity[])currentWaypoints.Clone();
                return true;
            }

            try
            {
                JToken parsed = JToken.Parse(raw);
                if (parsed is not JArray array || array.Count != newPoints.Length)
                {
                    error = BridgeResponse.Error(400,
                        $"originalWaypoints must be a JSON array with exactly {newPoints.Length} entries; use null for an inserted waypoint");
                    return false;
                }

                var currentSet = new HashSet<Entity>(currentWaypoints);
                var used = new HashSet<Entity>();
                originalWaypoints = new Entity[newPoints.Length];
                for (int i = 0; i < originalWaypoints.Length; i++)
                {
                    originalWaypoints[i] = Entity.Null;
                    JToken token = array[i];
                    if (token == null || token.Type == JTokenType.Null)
                    {
                        cardinalityChanged = true;
                        continue;
                    }
                    if (token.Type != JTokenType.Object
                        || !int.TryParse((string)token["index"], out int index)
                        || !int.TryParse((string)token["version"], out int version))
                    {
                        error = BridgeResponse.Error(400,
                            "each originalWaypoints entry must be null or {\"index\":<int>,\"version\":<int>}");
                        return false;
                    }

                    Entity original = new Entity { Index = index, Version = version };
                    if (!currentSet.Contains(original)
                        || !EntityManager.Exists(original)
                        || !EntityManager.HasComponent<Position>(original)
                        || EntityManager.HasComponent<Game.Tools.Temp>(original)
                        || EntityManager.HasComponent<Deleted>(original))
                    {
                        error = BridgeResponse.Error(404,
                            $"original waypoint {index}:{version} is not a live waypoint of the target route");
                        return false;
                    }
                    if (!used.Add(original))
                    {
                        error = BridgeResponse.Error(400,
                            $"original waypoint {index}:{version} appears more than once; each existing waypoint can be retained at most once");
                        return false;
                    }
                    originalWaypoints[i] = original;
                }

                cardinalityChanged = cardinalityChanged
                    || originalWaypoints.Length != currentWaypoints.Length
                    || used.Count != currentWaypoints.Length;
                return true;
            }
            catch (Exception e)
            {
                error = BridgeResponse.Error(400, $"cannot parse originalWaypoints JSON: {e.Message}");
                return false;
            }
        }

        private BridgeResponse ModifyTransportLine(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse cityError))
            {
                return cityError;
            }
            if (!TryReadTransportLine(request, out Entity route, out Entity[] waypoints,
                out Entity[] currentConnections, out float3[] currentPoints, out BridgeResponse routeError))
            {
                return routeError;
            }
            if (!TryReadTransportPoints(request, out float3[] newPoints, out BridgeResponse pointError))
            {
                return pointError;
            }
            if (!TryReadTransportOriginalWaypoints(request, waypoints, newPoints,
                out Entity[] originalWaypoints, out bool cardinalityChanged,
                out BridgeResponse originalWaypointError))
            {
                return originalWaypointError;
            }

            Entity[] connections = new Entity[newPoints.Length];
            for (int i = 0; i < connections.Length; i++)
            {
                connections[i] = Entity.Null;
                for (int j = 0; j < waypoints.Length; j++)
                {
                    if (originalWaypoints[i] == waypoints[j])
                    {
                        connections[i] = currentConnections[j];
                        break;
                    }
                }
            }
            if (request.Query.ContainsKey("connections")
                && !TryReadTransportConnections(request, newPoints.Length, out connections, out BridgeResponse connectionError))
            {
                return connectionError;
            }

            bool dryRun = request.TryGetBool("dryRun", out bool requestedDryRun) && requestedDryRun;
            if (dryRun)
            {
                return BridgeResponse.Json(new
                {
                    success = true,
                    dryRun = true,
                    entity = new { index = route.Index, version = route.Version },
                     current = DescribeTransportPoints(currentPoints),
                     target = DescribeTransportPoints(newPoints),
                     originalWaypoints = DescribeTransportEntities(originalWaypoints),
                     connections = DescribeTransportConnections(connections),
                    pointCount = newPoints.Length,
                    cardinalityChanged,
                    nativePath = "CreationDefinition(m_Original route, optional Recreate) + WaypointDefinition(m_Original waypoint/null) -> GenerateWaypointsSystem -> GenerateRoutesSystem -> ApplyRoutesSystem",
                    note = "preview only; no route definition was emitted",
                });
            }

            BridgeToolSystem tool = World.GetOrCreateSystemManaged<BridgeToolSystem>();
            if (!tool.TryQueueTransportLineModify(route, originalWaypoints, connections, newPoints, request, cardinalityChanged))
            {
                return BridgeResponse.Error(409, "another build operation is in progress, retry shortly");
            }
            return null;
        }

        private BridgeResponse DeleteTransportLine(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse cityError))
            {
                return cityError;
            }
            if (!TryReadTransportLine(request, out Entity route, out Entity[] waypoints,
                out Entity[] connections, out float3[] currentPoints, out BridgeResponse routeError))
            {
                return routeError;
            }

            bool dryRun = request.TryGetBool("dryRun", out bool requestedDryRun) && requestedDryRun;
            if (dryRun)
            {
                return BridgeResponse.Json(new
                {
                    success = true,
                    dryRun = true,
                    entity = new { index = route.Index, version = route.Version },
                    current = DescribeTransportPoints(currentPoints),
                    pointCount = currentPoints.Length,
                    nativePath = "CreationDefinition(Delete, m_Original route) + WaypointDefinition(Delete, m_Original waypoint) -> GenerateWaypointsSystem -> GenerateRoutesSystem -> ApplyRoutesSystem",
                    note = "preview only; no route definition was emitted",
                });
            }

            BridgeToolSystem tool = World.GetOrCreateSystemManaged<BridgeToolSystem>();
            if (!tool.TryQueueTransportLineDelete(route, waypoints, connections, currentPoints, request))
            {
                return BridgeResponse.Error(409, "another build operation is in progress, retry shortly");
            }
            return null;
        }

        private BridgeResponse SetTransportLineSettings(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse cityError))
            {
                return cityError;
            }
            if (!request.TryGetInt("index", out int index)
                || !request.TryGetInt("version", out int version))
            {
                return BridgeResponse.Error(400,
                    "provide ?index=<int>&version=<int> from /transport/lines");
            }

            Entity route = new Entity { Index = index, Version = version };
            if (!EntityManager.Exists(route)
                || !EntityManager.HasComponent<Route>(route)
                || !EntityManager.HasComponent<TransportLine>(route))
            {
                return BridgeResponse.Error(404,
                    $"transport route {index}:{version} does not exist or is not a live Route + TransportLine entity");
            }
            if (EntityManager.HasComponent<Game.Tools.Temp>(route)
                || EntityManager.HasComponent<Deleted>(route))
            {
                return BridgeResponse.Error(409,
                    $"transport route {index}:{version} is already in a native mutation");
            }

            bool dryRun = request.TryGetBool("dryRun", out bool requestedDryRun) && requestedDryRun;
            TransportLine before = EntityManager.GetComponentData<TransportLine>(route);
            UITransportLineData? beforeUi = null;
            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            try
            {
                beforeUi = TransportUIUtils.BuildTransportLine(route, EntityManager, prefabSystem);
            }
            catch (Exception)
            {
                // The native component snapshot remains valid even if the UI
                // projection is unavailable during route initialization.
            }

            int? requestedSchedule = null;
            if (request.Query.TryGetValue("schedule", out string scheduleRaw)
                && !string.IsNullOrWhiteSpace(scheduleRaw))
            {
                if (int.TryParse(scheduleRaw, out int scheduleNumber))
                {
                    requestedSchedule = math.clamp(scheduleNumber, 0, 2);
                }
                else if (string.Equals(scheduleRaw, "day", StringComparison.OrdinalIgnoreCase))
                {
                    requestedSchedule = (int)RouteOption.Day;
                }
                else if (string.Equals(scheduleRaw, "night", StringComparison.OrdinalIgnoreCase))
                {
                    requestedSchedule = (int)RouteOption.Night;
                }
                else if (string.Equals(scheduleRaw, "inactive", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(scheduleRaw, "off", StringComparison.OrdinalIgnoreCase))
                {
                    requestedSchedule = (int)RouteOption.Inactive;
                }
                else
                {
                    return BridgeResponse.Error(400,
                        "schedule must be day, night, inactive, or the native numeric RouteOption value 0-2");
                }
            }

            bool? requestedActive = null;
            if (request.Query.ContainsKey("active"))
            {
                if (!request.TryGetBool("active", out bool active))
                {
                    return BridgeResponse.Error(400, "active must be true or false");
                }
                requestedActive = active;
            }

            float? requestedInterval = null;
            if (request.Query.ContainsKey("vehicleInterval"))
            {
                if (!request.TryGetFloat("vehicleInterval", out float interval)
                    || float.IsNaN(interval)
                    || float.IsInfinity(interval)
                    || interval <= 0f)
                {
                    return BridgeResponse.Error(400,
                        "vehicleInterval must be a finite number greater than zero (seconds)");
                }
                requestedInterval = math.clamp(interval, 1f, 3600f);
            }

            float? requestedUnbunching = null;
            if (request.Query.ContainsKey("unbunchingFactor"))
            {
                if (!request.TryGetFloat("unbunchingFactor", out float factor)
                    || float.IsNaN(factor)
                    || float.IsInfinity(factor)
                    || factor < 0f)
                {
                    return BridgeResponse.Error(400,
                        "unbunchingFactor must be a finite non-negative number");
                }
                requestedUnbunching = math.clamp(factor, 0f, 1f);
            }

            ushort? requestedTicket = null;
            if (request.Query.ContainsKey("ticketPrice"))
            {
                if (!request.TryGetInt("ticketPrice", out int ticketPrice)
                    || ticketPrice < 0
                    || ticketPrice > ushort.MaxValue)
                {
                    return BridgeResponse.Error(400,
                        $"ticketPrice must be an integer between 0 and {ushort.MaxValue}");
                }
                requestedTicket = (ushort)ticketPrice;
            }

            string requestedName = request.Query.TryGetValue("name", out string name)
                && !string.IsNullOrWhiteSpace(name)
                ? name.Trim()
                : null;

            object current = new
            {
                vehicleIntervalSeconds = before.m_VehicleInterval,
                unbunchingFactor = before.m_UnbunchingFactor,
                ticketPrice = before.m_TicketPrice,
                ui = !beforeUi.HasValue
                    ? null
                    : new
                    {
                        active = beforeUi.Value.active,
                        schedule = beforeUi.Value.schedule,
                        scheduleName = ((RouteOption)beforeUi.Value.schedule).ToString(),
                        name = requestedName == null ? null : "not read through this endpoint",
                    },
            };
            object target = new
            {
                vehicleIntervalSeconds = requestedInterval ?? before.m_VehicleInterval,
                unbunchingFactor = requestedUnbunching ?? before.m_UnbunchingFactor,
                ticketPrice = requestedTicket ?? before.m_TicketPrice,
                schedule = requestedSchedule,
                active = requestedActive,
                name = requestedName,
            };

            if (dryRun)
            {
                return BridgeResponse.Json(new
                {
                    success = true,
                    dryRun = true,
                    executed = false,
                    entity = new { index, version },
                    current,
                    target,
                    nativePaths = new[]
                    {
                        "TransportationOverviewUISystem.SetLineSchedule/SetLineState/SetLineName",
                        "main-thread TransportLine component write for vehicle interval, unbunching factor, and ticket price",
                    },
                    note = "preview only; no line settings were changed",
                });
            }

            TransportLine updated = before;
            if (requestedInterval.HasValue)
            {
                updated.m_VehicleInterval = requestedInterval.Value;
            }
            if (requestedUnbunching.HasValue)
            {
                updated.m_UnbunchingFactor = requestedUnbunching.Value;
            }
            if (requestedTicket.HasValue)
            {
                updated.m_TicketPrice = requestedTicket.Value;
            }
            if (requestedInterval.HasValue || requestedUnbunching.HasValue || requestedTicket.HasValue)
            {
                EntityManager.SetComponentData(route, updated);
            }

            TransportationOverviewUISystem overview =
                World.GetOrCreateSystemManaged<TransportationOverviewUISystem>();
            bool uiCallSucceeded = true;
            if (requestedSchedule.HasValue)
            {
                uiCallSucceeded &= TryInvokeTransportUi(overview, "SetLineSchedule", route, requestedSchedule.Value);
            }
            if (requestedActive.HasValue)
            {
                uiCallSucceeded &= TryInvokeTransportUi(overview, "SetLineState", route, requestedActive.Value);
            }
            if (requestedName != null)
            {
                uiCallSucceeded &= TryInvokeTransportUi(overview, "SetLineName", route, requestedName);
            }

            // The UI system accepts the native write in this frame, but its
            // UITransportLineData projection is refreshed by the next
            // UIUpdate. Defer verification whenever a UI-backed setting was
            // requested so a transient stale projection is never reported as
            // a false failure (or, worse, treated as a successful readback).
            if (requestedSchedule.HasValue || requestedActive.HasValue)
            {
                m_System.DeferToNextFrame(() => CompleteTransportLineSettingsAfterFrame(
                    request,
                    route,
                    index,
                    version,
                    current,
                    target,
                    uiCallSucceeded,
                    requestedSchedule,
                    requestedActive,
                    requestedInterval,
                    requestedUnbunching,
                    requestedTicket,
                    attempt: 0));
                return null;
            }

            return BuildTransportLineSettingsResponse(
                route,
                index,
                version,
                current,
                target,
                uiCallSucceeded,
                requestedSchedule,
                requestedActive,
                requestedInterval,
                requestedUnbunching,
                requestedTicket);
        }

        private void CompleteTransportLineSettingsAfterFrame(
            BridgeRequest request,
            Entity route,
            int index,
            int version,
            object current,
            object target,
            bool uiCallSucceeded,
            int? requestedSchedule,
            bool? requestedActive,
            float? requestedInterval,
            float? requestedUnbunching,
            ushort? requestedTicket,
            int attempt)
        {
            if (!EntityManager.Exists(route)
                || !EntityManager.HasComponent<Route>(route)
                || !EntityManager.HasComponent<TransportLine>(route))
            {
                request.Complete(BridgeResponse.Error(404,
                    $"transport route {index}:{version} disappeared before native settings readback"));
                return;
            }

            BridgeResponse response = BuildTransportLineSettingsResponse(
                route,
                index,
                version,
                current,
                target,
                uiCallSucceeded,
                requestedSchedule,
                requestedActive,
                requestedInterval,
                requestedUnbunching,
                requestedTicket,
                out bool verified);

            if (!verified && attempt < 4)
            {
                m_System.DeferToNextFrame(() => CompleteTransportLineSettingsAfterFrame(
                    request,
                    route,
                    index,
                    version,
                    current,
                    target,
                    uiCallSucceeded,
                    requestedSchedule,
                    requestedActive,
                    requestedInterval,
                    requestedUnbunching,
                    requestedTicket,
                    attempt + 1));
                return;
            }

            request.Complete(response);
        }

        private BridgeResponse BuildTransportLineSettingsResponse(
            Entity route,
            int index,
            int version,
            object current,
            object target,
            bool uiCallSucceeded,
            int? requestedSchedule,
            bool? requestedActive,
            float? requestedInterval,
            float? requestedUnbunching,
            ushort? requestedTicket)
        {
            return BuildTransportLineSettingsResponse(
                route,
                index,
                version,
                current,
                target,
                uiCallSucceeded,
                requestedSchedule,
                requestedActive,
                requestedInterval,
                requestedUnbunching,
                requestedTicket,
                out _);
        }

        private BridgeResponse BuildTransportLineSettingsResponse(
            Entity route,
            int index,
            int version,
            object current,
            object target,
            bool uiCallSucceeded,
            int? requestedSchedule,
            bool? requestedActive,
            float? requestedInterval,
            float? requestedUnbunching,
            ushort? requestedTicket,
            out bool verified)
        {
            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            UITransportLineData? afterUi = null;
            try
            {
                afterUi = TransportUIUtils.BuildTransportLine(route, EntityManager, prefabSystem);
            }
            catch (Exception)
            {
                // A missing UI projection is a verification failure when a UI
                // setting was requested; the native component snapshot below
                // remains useful and is returned for diagnosis.
            }

            TransportLine after = EntityManager.GetComponentData<TransportLine>(route);
            bool componentMatches = (!requestedInterval.HasValue || math.abs(after.m_VehicleInterval - requestedInterval.Value) < 0.01f)
                && (!requestedUnbunching.HasValue || math.abs(after.m_UnbunchingFactor - requestedUnbunching.Value) < 0.01f)
                && (!requestedTicket.HasValue || after.m_TicketPrice == requestedTicket.Value);
            bool uiRequested = requestedSchedule.HasValue || requestedActive.HasValue;
            bool uiMatches = uiCallSucceeded
                && (!requestedSchedule.HasValue || (afterUi.HasValue && afterUi.Value.schedule == requestedSchedule.Value))
                && (!requestedActive.HasValue || (afterUi.HasValue && afterUi.Value.active == requestedActive.Value));
            verified = componentMatches && (!uiRequested || uiMatches);

            return BridgeResponse.Json(new
            {
                success = verified,
                dryRun = false,
                executed = true,
                entity = new { index, version },
                current,
                target,
                readback = new
                {
                    vehicleIntervalSeconds = after.m_VehicleInterval,
                    unbunchingFactor = after.m_UnbunchingFactor,
                    ticketPrice = after.m_TicketPrice,
                    ui = !afterUi.HasValue
                        ? null
                        : new
                        {
                            active = afterUi.Value.active,
                            schedule = afterUi.Value.schedule,
                            scheduleName = ((RouteOption)afterUi.Value.schedule).ToString(),
                            vehicles = afterUi.Value.vehicles,
                            usage = afterUi.Value.usage,
                        },
                },
                verification = new { componentMatches, uiMatches },
                nativePaths = new[]
                {
                    "TransportationOverviewUISystem.SetLineSchedule/SetLineState/SetLineName",
                    "main-thread TransportLine component write + deferred ECS/UI readback",
                },
                note = verified
                    ? null
                    : "the native write was issued but the deferred ECS/UI readback did not match every requested setting",
            });
        }

        private static bool TryInvokeTransportUi(object target, string methodName, params object[] arguments)
        {
            if (target == null)
            {
                return false;
            }
            MethodInfo[] methods = target.GetType().GetMethods(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            foreach (MethodInfo method in methods)
            {
                if (!string.Equals(method.Name, methodName, StringComparison.Ordinal)
                    || method.GetParameters().Length != arguments.Length)
                {
                    continue;
                }
                try
                {
                    method.Invoke(target, arguments);
                    return true;
                }
                catch (Exception)
                {
                    return false;
                }
            }
            return false;
        }
    }
}
