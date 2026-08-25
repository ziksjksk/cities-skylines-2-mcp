using System;
using System.Collections.Generic;
using Game.Buildings;
using Game.Common;
using Game.Net;
using Game.Prefabs;
using Game.Simulation;
using Newtonsoft.Json.Linq;
using Unity.Collections;
using Unity.Entities;
using Unity.Mathematics;

namespace CS2MCP
{
    /// <summary>
    /// Native utility-network observation.  The construction endpoint already
    /// accepts PipelinePrefab and PowerLinePrefab network courses; this read
    /// path exposes the graph edges and the building-graph connection
    /// components so an agent can distinguish a placed line from a connected
    /// line.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private BridgeResponse GetUtilities(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            string kind = request.Query.TryGetValue("kind", out string rawKind)
                ? rawKind.ToLowerInvariant()
                : "all";
            if (kind != "all" && kind != "pipeline" && kind != "water" && kind != "electricity" && kind != "power")
            {
                return BridgeResponse.Error(400, "kind must be all, pipeline, water, electricity, or power");
            }

            int page = request.TryGetInt("page", out int requestedPage) ? Math.Max(0, requestedPage) : 0;
            int pageSize = request.TryGetInt("pageSize", out int requestedPageSize)
                ? ClampInt(requestedPageSize, 1, 500)
                : request.TryGetInt("limit", out int requestedLimit) ? ClampInt(requestedLimit, 1, 500) : 100;
            bool hasX = request.TryGetFloat("x", out float centerX);
            bool hasZ = request.TryGetFloat("z", out float centerZ);
            bool hasRadius = request.TryGetFloat("radius", out float radius);
            if (hasRadius && radius < 0f)
            {
                return BridgeResponse.Error(400, "radius must be non-negative");
            }

            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            var edges = new List<object>();
            var allEdges = new List<object>();
            EntityQuery edgeQuery = EntityManager.CreateEntityQuery(new EntityQueryDesc
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
                    ComponentType.ReadOnly<Deleted>(),
                },
            });
            using (NativeArray<Entity> entities = edgeQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(EntityManager.GetComponentData<PrefabRef>(entity).m_Prefab);
                    bool isPipeline = prefab is PipelinePrefab;
                    bool isElectricity = prefab is PowerLinePrefab;
                    if (!isPipeline && !isElectricity)
                    {
                        continue;
                    }
                    if ((kind == "pipeline" || kind == "water") && !isPipeline)
                    {
                        continue;
                    }
                    if ((kind == "electricity" || kind == "power") && !isElectricity)
                    {
                        continue;
                    }

                    Game.Net.Edge edge = EntityManager.GetComponentData<Game.Net.Edge>(entity);
                    if (!EntityManager.Exists(edge.m_Start) || !EntityManager.Exists(edge.m_End)
                        || !EntityManager.HasComponent<Game.Net.Node>(edge.m_Start)
                        || !EntityManager.HasComponent<Game.Net.Node>(edge.m_End))
                    {
                        continue;
                    }
                    float3 start = EntityManager.GetComponentData<Game.Net.Node>(edge.m_Start).m_Position;
                    float3 end = EntityManager.GetComponentData<Game.Net.Node>(edge.m_End).m_Position;
                    float3 midpoint = (start + end) * 0.5f;
                    if ((hasX || hasZ) && (!hasX || !hasZ))
                    {
                        return BridgeResponse.Error(400, "x and z must be supplied together");
                    }
                    if (hasX && hasZ && hasRadius && math.distance(new float2(midpoint.x, midpoint.z), new float2(centerX, centerZ)) > radius)
                    {
                        continue;
                    }

                    var connectedNodes = new List<object>();
                    if (EntityManager.HasBuffer<Game.Net.ConnectedNode>(entity))
                    {
                        DynamicBuffer<Game.Net.ConnectedNode> buffer = EntityManager.GetBuffer<Game.Net.ConnectedNode>(entity, isReadOnly: true);
                        for (int i = 0; i < buffer.Length && i < 256; i++)
                        {
                            connectedNodes.Add(new
                            {
                        entity = DescribeEntity(buffer[i].m_Node),
                                curvePosition = buffer[i].m_CurvePosition,
                            });
                        }
                    }

                    object row = new
                    {
                        entity = DescribeEntity(entity),
                        kind = isPipeline ? "pipeline" : "electricity",
                        prefab = prefab != null ? prefab.name : null,
                        start = DescribePosition(start),
                        end = DescribePosition(end),
                        length = math.distance(start, end),
                        startNode = DescribeEntity(edge.m_Start),
                        endNode = DescribeEntity(edge.m_End),
                        connectedNodes,
                    };
                    allEdges.Add(row);
                }
            }

            var buildingConnections = new List<object>();
            float filterRadius = hasRadius ? radius : float.PositiveInfinity;
            AddWaterBuildingConnections(buildingConnections, prefabSystem, kind, hasX, hasZ, centerX, centerZ, filterRadius, "water");
            AddElectricityBuildingConnections(buildingConnections, prefabSystem, kind, hasX, hasZ, centerX, centerZ, filterRadius);

            int totalEdges = allEdges.Count;
            int totalConnections = buildingConnections.Count;
            int offset = Math.Min(page * pageSize, totalEdges);
            for (int i = offset; i < Math.Min(totalEdges, offset + pageSize); i++)
            {
                edges.Add(allEdges[i]);
            }

            return BridgeResponse.Json(new
            {
                success = true,
                kind,
                page,
                pageSize,
                totalEdges,
                returnedEdges = edges.Count,
                totalBuildingConnections = totalConnections,
                edges,
                buildingConnections,
                note = "native PipelinePrefab/PowerLinePrefab Edge enumeration plus WaterPipeBuildingConnection/ElectricityBuildingConnection readback; a placed edge is not assumed to be connected",
            });
        }

        private void AddWaterBuildingConnections(
            List<object> output,
            PrefabSystem prefabSystem,
            string kind,
            bool hasX,
            bool hasZ,
            float centerX,
            float centerZ,
            float radius,
            string connectionKind)
        {
            if (kind != "all" && kind != "pipeline" && kind != "water")
            {
                return;
            }
            EntityQuery query = EntityManager.CreateEntityQuery(new EntityQueryDesc
            {
                All = new[]
                {
                    ComponentType.ReadOnly<WaterPipeBuildingConnection>(),
                    ComponentType.ReadOnly<PrefabRef>(),
                },
                None = new[]
                {
                    ComponentType.ReadOnly<Game.Tools.Temp>(),
                    ComponentType.ReadOnly<Deleted>(),
                },
            });
            using (NativeArray<Entity> entities = query.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    float3 position = EntityManager.HasComponent<Game.Objects.Transform>(entity)
                        ? EntityManager.GetComponentData<Game.Objects.Transform>(entity).m_Position
                        : float3.zero;
                    if (hasX && hasZ && math.distance(new float2(position.x, position.z), new float2(centerX, centerZ)) > radius)
                    {
                        continue;
                    }
                    PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(EntityManager.GetComponentData<PrefabRef>(entity).m_Prefab);
                    WaterPipeBuildingConnection connection = EntityManager.GetComponentData<WaterPipeBuildingConnection>(entity);
                    output.Add(new
                    {
                        entity = DescribeEntity(entity),
                        kind = connectionKind,
                        prefab = prefab != null ? prefab.name : null,
                        position = DescribePosition(position),
                        producerEdge = DescribeNullableEntity(connection.m_ProducerEdge),
                        consumerEdge = DescribeNullableEntity(connection.m_ConsumerEdge),
                        connected = connection.m_ProducerEdge != Entity.Null || connection.m_ConsumerEdge != Entity.Null,
                    });
                }
            }
        }

        private void AddElectricityBuildingConnections(
            List<object> output,
            PrefabSystem prefabSystem,
            string kind,
            bool hasX,
            bool hasZ,
            float centerX,
            float centerZ,
            float radius)
        {
            if (kind != "all" && kind != "electricity" && kind != "power")
            {
                return;
            }
            EntityQuery query = EntityManager.CreateEntityQuery(new EntityQueryDesc
            {
                All = new[]
                {
                    ComponentType.ReadOnly<ElectricityBuildingConnection>(),
                    ComponentType.ReadOnly<PrefabRef>(),
                },
                None = new[]
                {
                    ComponentType.ReadOnly<Game.Tools.Temp>(),
                    ComponentType.ReadOnly<Deleted>(),
                },
            });
            using (NativeArray<Entity> entities = query.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    float3 position = EntityManager.HasComponent<Game.Objects.Transform>(entity)
                        ? EntityManager.GetComponentData<Game.Objects.Transform>(entity).m_Position
                        : float3.zero;
                    if (hasX && hasZ && math.distance(new float2(position.x, position.z), new float2(centerX, centerZ)) > radius)
                    {
                        continue;
                    }
                    PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(EntityManager.GetComponentData<PrefabRef>(entity).m_Prefab);
                    ElectricityBuildingConnection connection = EntityManager.GetComponentData<ElectricityBuildingConnection>(entity);
                    output.Add(new
                    {
                        entity = DescribeEntity(entity),
                        kind = "electricity",
                        prefab = prefab != null ? prefab.name : null,
                        position = DescribePosition(position),
                        transformerNode = DescribeNullableEntity(connection.m_TransformerNode),
                        producerEdge = DescribeNullableEntity(connection.m_ProducerEdge),
                        consumerEdge = DescribeNullableEntity(connection.m_ConsumerEdge),
                        chargeEdge = DescribeNullableEntity(connection.m_ChargeEdge),
                        dischargeEdge = DescribeNullableEntity(connection.m_DischargeEdge),
                        connected = connection.m_TransformerNode != Entity.Null
                            || connection.m_ProducerEdge != Entity.Null
                            || connection.m_ConsumerEdge != Entity.Null
                            || connection.m_ChargeEdge != Entity.Null
                            || connection.m_DischargeEdge != Entity.Null,
                    });
                }
            }
        }

        private static object DescribeNullableEntity(Entity entity)
        {
            return DescribeEntity(entity);
        }

        private static int ClampInt(int value, int minimum, int maximum)
        {
            return Math.Max(minimum, Math.Min(maximum, value));
        }
    }
}
