using System;
using System.Collections.Generic;
using Game.Areas;
using Game.Prefabs;
using Unity.Collections;
using Unity.Entities;
using Unity.Mathematics;

namespace CS2MCP
{
    /// <summary>
    /// One bounded, paged entity surface for planning agents.  The query is
    /// read-only and runs on the same simulation thread as every other ECS
    /// reader; it never materializes the whole world into the HTTP response.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private BridgeResponse GetEntities(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            string category = request.Query.TryGetValue("category", out string rawCategory)
                ? rawCategory.ToLowerInvariant()
                : "all";
            if (category == "net" || category == "segment") category = "road";
            if (category == "flora") category = "tree";
            if (category == "objects") category = "object";
            if (category == "props") category = "prop";
            if (category != "all"
                && category != "building"
                && category != "road"
                && category != "tree"
                && category != "object"
                && category != "prop"
                && category != "district")
            {
                return BridgeResponse.Error(400, "category must be all, building, road, tree, object, prop, or district");
            }

            request.Query.TryGetValue("query", out string search);
            int page = request.TryGetInt("page", out int rawPage) ? math.clamp(rawPage, 0, 100000) : 0;
            int pageSize = request.TryGetInt("pageSize", out int rawPageSize) ? math.clamp(rawPageSize, 1, 500) : 100;
            int skip = page * pageSize;

            bool hasBounds = request.TryGetFloat("minX", out float minX)
                | request.TryGetFloat("maxX", out float maxX)
                | request.TryGetFloat("minZ", out float minZ)
                | request.TryGetFloat("maxZ", out float maxZ);
            if (hasBounds)
            {
                bool complete = request.TryGetFloat("minX", out minX)
                    && request.TryGetFloat("maxX", out maxX)
                    && request.TryGetFloat("minZ", out minZ)
                    && request.TryGetFloat("maxZ", out maxZ);
                if (!complete || minX > maxX || minZ > maxZ)
                {
                    return BridgeResponse.Error(400, "bounds require minX<=maxX and minZ<=maxZ");
                }
            }

            bool hasCenter = request.TryGetFloat("x", out float centerX)
                & request.TryGetFloat("z", out float centerZ);
            if (request.Query.ContainsKey("x") || request.Query.ContainsKey("z"))
            {
                if (!hasCenter)
                {
                    return BridgeResponse.Error(400, "spatial center requires both x and z");
                }
            }
            float radius = request.TryGetFloat("radius", out float rawRadius) ? math.max(0f, rawRadius) : 0f;
            float2 center = new float2(centerX, centerZ);
            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            var entities = new List<object>();
            int total = 0;

            bool MatchesName(string name)
            {
                return string.IsNullOrEmpty(search)
                    || name.IndexOf(search, StringComparison.OrdinalIgnoreCase) >= 0;
            }

            bool MatchesPoint(float2 point)
            {
                if (hasBounds && (point.x < minX || point.x > maxX || point.y < minZ || point.y > maxZ))
                {
                    return false;
                }
                return !hasCenter || math.distance(point, center) <= radius;
            }

            bool MatchesSegment(float2 start, float2 end)
            {
                float2 midpoint = (start + end) * 0.5f;
                return MatchesPoint(start) || MatchesPoint(end) || MatchesPoint(midpoint);
            }

            void Add(object row)
            {
                total++;
                if (total > skip && entities.Count < pageSize)
                {
                    entities.Add(row);
                }
            }

            if (category == "all" || category == "building")
            {
                using NativeArray<Entity> placedBuildings = PlacedBuildingQuery.ToEntityArray(Allocator.Temp);
                foreach (Entity entity in placedBuildings)
                {
                    Game.Objects.Transform transform = EntityManager.GetComponentData<Game.Objects.Transform>(entity);
                    PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(EntityManager.GetComponentData<PrefabRef>(entity).m_Prefab);
                    string name = prefab != null ? prefab.name : "<unknown>";
                    if (!MatchesName(name) || !MatchesPoint(transform.m_Position.xz)) continue;
                    Add(new
                    {
                        entity = new { index = entity.Index, version = entity.Version },
                        entityType = "building",
                        category = "building",
                        prefab = name,
                        position = new { x = transform.m_Position.x, y = transform.m_Position.y, z = transform.m_Position.z },
                        isSubBuilding = EntityManager.HasComponent<Game.Common.Owner>(entity),
                    });
                }
            }

            if (category == "all" || category == "road")
            {
                using NativeArray<Entity> placedRoads = PlacedRoadQuery.ToEntityArray(Allocator.Temp);
                foreach (Entity entity in placedRoads)
                {
                    Game.Net.Curve curve = EntityManager.GetComponentData<Game.Net.Curve>(entity);
                    float3 start = curve.m_Bezier.a;
                    float3 end = curve.m_Bezier.d;
                    PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(EntityManager.GetComponentData<PrefabRef>(entity).m_Prefab);
                    string name = prefab != null ? prefab.name : "<unknown>";
                    if (!MatchesName(name) || !MatchesSegment(start.xz, end.xz)) continue;
                    float3 midpoint = (start + end) * 0.5f;
                    Add(new
                    {
                        entity = new { index = entity.Index, version = entity.Version },
                        entityType = "road",
                        category = "road",
                        prefab = name,
                        position = new { x = midpoint.x, y = midpoint.y, z = midpoint.z },
                        start = new { x = start.x, y = start.y, z = start.z },
                        end = new { x = end.x, y = end.y, z = end.z },
                        length = curve.m_Length,
                    });
                }
            }

            if (category == "all" || category == "tree" || category == "object")
            {
                using NativeArray<Entity> standaloneObjects = StandaloneObjectQuery.ToEntityArray(Allocator.Temp);
                foreach (Entity entity in standaloneObjects)
                {
                    Game.Objects.Transform transform = EntityManager.GetComponentData<Game.Objects.Transform>(entity);
                    PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(EntityManager.GetComponentData<PrefabRef>(entity).m_Prefab);
                    string name = prefab != null ? prefab.name : "<unknown>";
                    bool isTree = EntityManager.HasComponent<Game.Objects.Tree>(entity)
                        || EntityManager.HasComponent<Game.Objects.Plant>(entity);
                    if (category == "tree" && !isTree) continue;
                    if (category == "object" && isTree) continue;
                    if (!MatchesName(name) || !MatchesPoint(transform.m_Position.xz)) continue;
                    Add(new
                    {
                        entity = new { index = entity.Index, version = entity.Version },
                        entityType = isTree ? "tree" : "object",
                        category = isTree ? "tree" : "object",
                        prefab = name,
                        position = new { x = transform.m_Position.x, y = transform.m_Position.y, z = transform.m_Position.z },
                    });
                }
            }

            if (category == "all" || category == "prop")
            {
                using NativeArray<Entity> placedProps = PlacedPropQuery.ToEntityArray(Allocator.Temp);
                foreach (Entity entity in placedProps)
                {
                    Game.Objects.Transform transform = EntityManager.GetComponentData<Game.Objects.Transform>(entity);
                    PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(EntityManager.GetComponentData<PrefabRef>(entity).m_Prefab);
                    string name = prefab != null ? prefab.name : "<unknown>";
                    if (!MatchesName(name) || !MatchesPoint(transform.m_Position.xz)) continue;
                    Add(new
                    {
                        entity = new { index = entity.Index, version = entity.Version },
                        entityType = "prop",
                        category = "prop",
                        prefab = name,
                        position = new { x = transform.m_Position.x, y = transform.m_Position.y, z = transform.m_Position.z },
                    });
                }
            }

            if (category == "all" || category == "district")
            {
                using NativeArray<Entity> districts = DistrictQuery.ToEntityArray(Allocator.Temp);
                foreach (Entity entity in districts)
                {
                    Geometry geometry = EntityManager.GetComponentData<Geometry>(entity);
                    float3 position = geometry.m_CenterPosition;
                    string name = EntityManager.HasComponent<PrefabRef>(entity)
                        ? prefabSystem.GetPrefab<PrefabBase>(EntityManager.GetComponentData<PrefabRef>(entity).m_Prefab)?.name ?? "<district>"
                        : "<district>";
                    if (!MatchesName(name) || !MatchesPoint(position.xz)) continue;
                    Add(new
                    {
                        entity = new { index = entity.Index, version = entity.Version },
                        entityType = "district",
                        category = "district",
                        prefab = name,
                        position = new { x = position.x, y = position.y, z = position.z },
                        polygonNodes = EntityManager.HasBuffer<Game.Areas.Node>(entity)
                            ? EntityManager.GetBuffer<Game.Areas.Node>(entity, isReadOnly: true).Length
                            : 0,
                    });
                }
            }

            return BridgeResponse.Json(new
            {
                success = true,
                category,
                query = search,
                page,
                pageSize,
                totalMatches = total,
                returned = entities.Count,
                hasMore = skip + entities.Count < total,
                entities,
                note = "bounded native ECS query; entity ids are runtime index/version pairs and remain valid only while the entity exists",
            });
        }
    }
}
