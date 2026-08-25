using System;
using System.Collections.Generic;
using Game.Prefabs;
using Game.Tools;
using Game.Zones;
using Unity.Collections;
using Unity.Entities;
using Unity.Mathematics;

namespace CS2MCP
{
    /// <summary>
    /// Zoning endpoints. Zone mutations are emitted as the game's native
    /// Zoning definition and consumed by GenerateZonesSystem/ApplyZonesSystem;
    /// this handler never rewrites Block/Cell buffers directly.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private const float kCellSize = 8f;

        private EntityQuery m_ZonePrefabQuery;
        private bool m_ZonePrefabQueryCreated;
        private EntityQuery m_ZoneBlockQuery;
        private bool m_ZoneBlockQueryCreated;

        private EntityQuery ZonePrefabQuery
        {
            get
            {
                if (!m_ZonePrefabQueryCreated)
                {
                    m_ZonePrefabQuery = EntityManager.CreateEntityQuery(
                        ComponentType.ReadOnly<PrefabData>(),
                        ComponentType.ReadOnly<ZoneData>());
                    m_ZonePrefabQueryCreated = true;
                }
                return m_ZonePrefabQuery;
            }
        }

        private EntityQuery ZoneBlockQuery
        {
            get
            {
                if (!m_ZoneBlockQueryCreated)
                {
                    m_ZoneBlockQuery = EntityManager.CreateEntityQuery(new EntityQueryDesc
                    {
                        All = new[]
                        {
                            ComponentType.ReadOnly<Block>(),
                            ComponentType.ReadOnly<Cell>(),
                        },
                        None = new[]
                        {
                            ComponentType.ReadOnly<Game.Tools.Temp>(),
                            ComponentType.ReadOnly<Game.Common.Deleted>(),
                        },
                    });
                    m_ZoneBlockQueryCreated = true;
                }
                return m_ZoneBlockQuery;
            }
        }

        private BridgeResponse GetZoneTypes()
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            var zones = new List<object>();
            using (NativeArray<Entity> entities = ZonePrefabQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(entity);
                    if (prefab == null)
                    {
                        continue;
                    }
                    ZoneData zoneData = EntityManager.GetComponentData<ZoneData>(entity);
                    zones.Add(new
                    {
                        name = prefab.name,
                        areaType = zoneData.m_AreaType.ToString(),
                        office = zoneData.IsOffice(),
                        locked = IsLocked(entity),
                    });
                }
            }

            return BridgeResponse.Json(new
            {
                note = "use 'name' with /build/zone; zone 'None' clears zoning (dezone)",
                stalenessWarning = LockStalenessWarning,
                zones,
            });
        }

        private BridgeResponse ZoneArea(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            if (!request.Query.TryGetValue("zone", out string zoneName) || string.IsNullOrEmpty(zoneName))
            {
                return BridgeResponse.Error(400, "provide ?zone=<name from /zones, or 'None' to dezone>");
            }
            if (!request.TryGetFloat("x", out float x) || !request.TryGetFloat("z", out float z))
            {
                return BridgeResponse.Error(400, "provide ?x=&z= center coordinates");
            }
            float radius = request.TryGetFloat("radius", out float rawRadius)
                ? math.clamp(rawRadius, kCellSize, 200f)
                : 32f;
            bool snapToGrid = !request.TryGetBool("snapToGrid", out bool requestedSnapToGrid) || requestedSnapToGrid;
            float requestedX = x;
            float requestedZ = z;
            if (snapToGrid)
            {
                x = math.round(x / kCellSize) * kCellSize;
                z = math.round(z / kCellSize) * kCellSize;
                radius = math.max(kCellSize, math.round(radius / kCellSize) * kCellSize);
            }

            bool dezone = string.Equals(zoneName, "None", StringComparison.OrdinalIgnoreCase);
            Entity zonePrefabEntity = Entity.Null;
            string resolvedName;
            if (dezone)
            {
                resolvedName = "None";
            }
            else
            {
                if (!TryFindPrefabByName(ZonePrefabQuery, zoneName, out zonePrefabEntity, out PrefabBase zonePrefab))
                {
                    return BridgeResponse.Error(404, $"unknown zone '{zoneName}'; list via /zones");
                }
                if (IsLocked(zonePrefabEntity) && !IsForced(request))
                {
                    return BridgeResponse.Error(409, $"zone '{zonePrefab.name}' is locked (milestone not reached); pass force=true to zone anyway");
                }
                resolvedName = zonePrefab.name;
            }

            bool overwrite = request.TryGetBool("overwrite", out bool requestedOverwrite) && requestedOverwrite;
            bool dryRun = request.TryGetBool("dryRun", out bool requestedDryRun) && requestedDryRun;
            if (dryRun)
            {
                return BridgeResponse.Json(new
                {
                    success = true,
                    dryRun = true,
                    zone = resolvedName,
                    requestedCenter = new { x = requestedX, z = requestedZ },
                    center = new { x, z },
                    radius,
                    snapToGrid,
                    overwrite,
                    dezone,
                    nativePath = "CreationDefinition + Zoning -> GenerateZonesSystem -> ApplyZonesSystem",
                    note = "preview only; the native zone tool will accept only road-generated, visible, non-blocked, and non-occupied cells unless overwrite=true",
                });
            }

            BridgeToolSystem tool = World.GetOrCreateSystemManaged<BridgeToolSystem>();
            if (!tool.TryQueueZoning(zonePrefabEntity, resolvedName, new float3(x, 0f, z), radius, overwrite, dezone, request))
            {
                return BridgeResponse.Error(409, "another build operation is in progress, retry shortly");
            }
            return null;
        }
    }
}
