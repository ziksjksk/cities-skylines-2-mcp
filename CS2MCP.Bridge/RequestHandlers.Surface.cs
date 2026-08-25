using System;
using System.Collections.Generic;
using Game.Areas;
using Game.Prefabs;
using Game.SceneFlow;
using Game.Simulation;
using Newtonsoft.Json.Linq;
using Unity.Collections;
using Unity.Entities;
using Unity.Mathematics;

namespace CS2MCP
{
    /// <summary>
    /// Surface-area placement through the game's area definition pipeline.
    /// The endpoint emits a SurfacePrefab + polygon definition to
    /// BridgeToolSystem; it never paints a surface by editing runtime ECS data.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private EntityQuery m_SurfaceQuery;
        private bool m_SurfaceQueryCreated;

        private EntityQuery SurfaceQuery
        {
            get
            {
                if (!m_SurfaceQueryCreated)
                {
                    m_SurfaceQuery = EntityManager.CreateEntityQuery(new EntityQueryDesc
                    {
                        All = new[]
                        {
                            ComponentType.ReadOnly<Game.Areas.Surface>(),
                            ComponentType.ReadOnly<Geometry>(),
                            ComponentType.ReadOnly<Game.Areas.Node>(),
                        },
                        None = new[]
                        {
                            ComponentType.ReadOnly<Game.Tools.Temp>(),
                            ComponentType.ReadOnly<Game.Common.Deleted>(),
                        },
                    });
                    m_SurfaceQueryCreated = true;
                }
                return m_SurfaceQuery;
            }
        }

        private BridgeResponse GetSurfaces(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            request.Query.TryGetValue("query", out string search);
            int page = request.TryGetInt("page", out int rawPage) ? math.clamp(rawPage, 0, 100000) : 0;
            int pageSize = request.TryGetInt("pageSize", out int rawPageSize) ? math.clamp(rawPageSize, 1, 200) : 100;
            int skip = page * pageSize;
            bool hasCenter = request.TryGetFloat("x", out float centerX) & request.TryGetFloat("z", out float centerZ);
            if (request.Query.ContainsKey("x") || request.Query.ContainsKey("z"))
            {
                if (!hasCenter) return BridgeResponse.Error(400, "surface spatial filter requires both x and z");
            }
            float radius = request.TryGetFloat("radius", out float rawRadius) ? math.max(0f, rawRadius) : 0f;
            float2 center = new float2(centerX, centerZ);
            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            var results = new List<object>();
            int total = 0;
            using (NativeArray<Entity> entities = SurfaceQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    Geometry geometry = EntityManager.GetComponentData<Geometry>(entity);
                    string name = EntityManager.HasComponent<PrefabRef>(entity)
                        ? prefabSystem.GetPrefab<PrefabBase>(EntityManager.GetComponentData<PrefabRef>(entity).m_Prefab)?.name ?? "<unknown>"
                        : "<unknown>";
                    if (!string.IsNullOrEmpty(search) && name.IndexOf(search, StringComparison.OrdinalIgnoreCase) < 0) continue;
                    if (hasCenter && math.distance(geometry.m_CenterPosition.xz, center) > radius) continue;

                    total++;
                    if (total <= skip || results.Count >= pageSize) continue;
                    DynamicBuffer<Game.Areas.Node> nodes = EntityManager.GetBuffer<Game.Areas.Node>(entity, isReadOnly: true);
                    var polygon = new List<object>(nodes.Length);
                    for (int i = 0; i < nodes.Length; i++)
                    {
                        float3 position = nodes[i].m_Position;
                        polygon.Add(new { x = position.x, y = position.y, z = position.z });
                    }
                    results.Add(new
                    {
                        entity = new { index = entity.Index, version = entity.Version },
                        prefab = name,
                        center = new { x = geometry.m_CenterPosition.x, y = geometry.m_CenterPosition.y, z = geometry.m_CenterPosition.z },
                        nodeCount = nodes.Length,
                        polygon,
                    });
                }
            }

            return BridgeResponse.Json(new
            {
                success = true,
                page,
                pageSize,
                totalMatches = total,
                returned = results.Count,
                hasMore = skip + results.Count < total,
                surfaces = results,
                note = "native Surface area entities and Area.Node polygons; entity ids are runtime index/version pairs",
            });
        }

        private static bool TryReadSurfacePoint(JToken token, out float3 point)
        {
            point = default;
            if (token is not JObject obj
                || !TryReadSurfaceFloat(obj, "x", out float x)
                || !TryReadSurfaceFloat(obj, "z", out float z))
            {
                return false;
            }

            float y = 0f;
            if (TryReadSurfaceFloat(obj, "y", out float explicitY))
            {
                y = explicitY;
            }
            point = new float3(x, y, z);
            return true;
        }

        private static bool TryReadSurfaceFloat(JObject obj, string key, out float value)
        {
            value = 0f;
            if (obj[key]?.Type is not (JTokenType.Float or JTokenType.Integer))
            {
                return false;
            }
            return float.TryParse(
                obj[key].ToString(),
                System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture,
                out value);
        }

        private BridgeResponse PaintSurface(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            if (!request.Query.TryGetValue("polygon", out string rawPolygon) || string.IsNullOrWhiteSpace(rawPolygon))
            {
                return BridgeResponse.Error(400, "provide ?polygon=<JSON array of {x,z[,y]} points>");
            }

            float3[] nodes;
            try
            {
                JToken parsed = JToken.Parse(rawPolygon);
                if (parsed is not JArray array || array.Count < 3 || array.Count > 256)
                {
                    return BridgeResponse.Error(400, "polygon must be a JSON array with 3 to 256 points");
                }
                nodes = new float3[array.Count];
                for (int i = 0; i < array.Count; i++)
                {
                    if (!TryReadSurfacePoint(array[i], out nodes[i]))
                    {
                        return BridgeResponse.Error(400, "each polygon point must contain numeric x and z fields, with optional y");
                    }
                }
            }
            catch (Exception e)
            {
                return BridgeResponse.Error(400, $"invalid polygon JSON: {e.Message}");
            }

            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            Entity prefabEntity = Entity.Null;
            SurfacePrefab surfacePrefab = null;
            if (request.Query.TryGetValue("prefab", out string prefabName) && !string.IsNullOrEmpty(prefabName))
            {
                if (!TryFindPrefabByName(SurfacePrefabQuery, prefabName, out prefabEntity, out PrefabBase rawPrefab))
                {
                    return BridgeResponse.Error(404, $"unknown surface prefab '{prefabName}'; search via /prefabs?category=surface");
                }
                surfacePrefab = prefabSystem.GetPrefab<SurfacePrefab>(prefabEntity);
            }
            else
            {
                using NativeArray<Entity> prefabs = SurfacePrefabQuery.ToEntityArray(Allocator.Temp);
                foreach (Entity candidateEntity in prefabs)
                {
                    if (IsLocked(candidateEntity))
                    {
                        continue;
                    }
                    SurfacePrefab candidate = prefabSystem.GetPrefab<SurfacePrefab>(candidateEntity);
                    if (candidate != null)
                    {
                        prefabEntity = candidateEntity;
                        surfacePrefab = candidate;
                        break;
                    }
                }
            }

            if (prefabEntity == Entity.Null || surfacePrefab == null)
            {
                return BridgeResponse.Error(404, "no runtime SurfacePrefab was discovered; inspect /prefabs?category=surface");
            }
            if (IsLocked(prefabEntity) && !IsForced(request))
            {
                return BridgeResponse.Error(409, $"surface prefab '{surfacePrefab.name}' is locked (milestone not reached); pass force=true to place anyway");
            }

            var preview = new
            {
                prefab = new
                {
                    entity = new { index = prefabEntity.Index, version = prefabEntity.Version },
                    name = surfacePrefab.name,
                    locked = IsLocked(prefabEntity),
                },
                nodeCount = nodes.Length,
                polygon = Array.ConvertAll(nodes, node => new { x = node.x, y = node.y, z = node.z }),
            };
            bool dryRun = request.TryGetBool("dryRun", out bool requestedDryRun) && requestedDryRun;
            if (dryRun)
            {
                return BridgeResponse.Json(new
                {
                    success = true,
                    dryRun = true,
                    preview,
                    note = "preview only; no native surface definition was emitted",
                });
            }

            BridgeToolSystem tool = World.GetOrCreateSystemManaged<BridgeToolSystem>();
            if (!tool.TryQueueArea(prefabEntity, surfacePrefab, nodes, request, "surface"))
            {
                return BridgeResponse.Error(409, "another build operation is in progress, retry shortly");
            }
            return null;
        }
    }
}
