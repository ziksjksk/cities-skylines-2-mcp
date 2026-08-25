using System;
using System.Collections.Generic;
using Game.Areas;
using Game.Common;
using Game.Prefabs;
using Game.Simulation;
using Game.Tools;
using Newtonsoft.Json.Linq;
using Unity.Collections;
using Unity.Entities;
using Unity.Mathematics;

namespace CS2MCP
{
    /// <summary>
    /// Native map-tile inspection and purchase. The purchase path intentionally
    /// drives the same SelectionInfo/SelectionElement contract consumed by
    /// MapTilePurchaseSystem, so funds, permits, milestone availability and
    /// tile ownership remain game-controlled.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private sealed class TileRequest
        {
            public int? EntityIndex;
            public int? EntityVersion;
            public int? Ordinal;
            public float? X;
            public float? Z;
        }

        private object DescribeTile(Entity entity, int ordinal)
        {
            bool owned = !EntityManager.HasComponent<Native>(entity);
            float3 min = new float3(float.PositiveInfinity, float.PositiveInfinity, float.PositiveInfinity);
            float3 max = new float3(float.NegativeInfinity, float.NegativeInfinity, float.NegativeInfinity);
            int pointCount = 0;

            if (EntityManager.HasBuffer<Node>(entity))
            {
                DynamicBuffer<Node> nodes = EntityManager.GetBuffer<Node>(entity, isReadOnly: true);
                for (int i = 0; i < nodes.Length; i++)
                {
                    float3 p = nodes[i].m_Position;
                    min = math.min(min, p);
                    max = math.max(max, p);
                    pointCount++;
                }
            }

            float3 center = pointCount > 0
                ? (min + max) * 0.5f
                : float3.zero;

            return new
            {
                ordinal,
                entity = new { index = entity.Index, version = entity.Version },
                owned,
                center = new { x = center.x, y = center.y, z = center.z },
                bounds = pointCount > 0
                    ? new
                    {
                        min = new { x = min.x, y = min.y, z = min.z },
                        max = new { x = max.x, y = max.y, z = max.z },
                    }
                    : null,
                nodeCount = pointCount,
            };
        }

        private List<Entity> ReadMapTileEntities()
        {
            var result = new List<Entity>();
            using (NativeArray<Entity> entities = MapTileQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    result.Add(entity);
                }
            }
            return result;
        }

        private bool TryResolveTile(TileRequest request, List<Entity> entities, out Entity tile, out string error)
        {
            tile = Entity.Null;
            error = null;

            if (request.EntityIndex.HasValue)
            {
                foreach (Entity entity in entities)
                {
                    if (entity.Index == request.EntityIndex.Value
                        && (!request.EntityVersion.HasValue || entity.Version == request.EntityVersion.Value))
                    {
                        tile = entity;
                        return true;
                    }
                }
                error = $"map tile entity index {request.EntityIndex.Value} was not found";
                return false;
            }

            if (request.Ordinal.HasValue)
            {
                if (request.Ordinal.Value >= 0 && request.Ordinal.Value < entities.Count)
                {
                    tile = entities[request.Ordinal.Value];
                    return true;
                }
                error = $"map tile ordinal {request.Ordinal.Value} is outside 0..{Math.Max(0, entities.Count - 1)}";
                return false;
            }

            if (request.X.HasValue && request.Z.HasValue)
            {
                float bestDistance = float.PositiveInfinity;
                foreach (Entity entity in entities)
                {
                    object descriptor = DescribeTile(entity, 0);
                    // Recompute the center without serializing/deserializing the
                    // anonymous descriptor; this keeps the resolver allocation-free.
                    float3 center = GetTileCenter(entity);
                    float distance = math.lengthsq(new float2(center.x - request.X.Value, center.z - request.Z.Value));
                    if (distance < bestDistance)
                    {
                        bestDistance = distance;
                        tile = entity;
                    }
                }

                if (tile != Entity.Null)
                {
                    return true;
                }
                error = "no map tiles were available for coordinate resolution";
                return false;
            }

            error = "provide tile entity {index,version}, ordinal, or x and z coordinates";
            return false;
        }

        private float3 GetTileCenter(Entity entity)
        {
            if (!EntityManager.HasBuffer<Node>(entity))
            {
                return float3.zero;
            }

            DynamicBuffer<Node> nodes = EntityManager.GetBuffer<Node>(entity, isReadOnly: true);
            if (nodes.Length == 0)
            {
                return float3.zero;
            }

            float3 min = new float3(float.PositiveInfinity, float.PositiveInfinity, float.PositiveInfinity);
            float3 max = new float3(float.NegativeInfinity, float.NegativeInfinity, float.NegativeInfinity);
            for (int i = 0; i < nodes.Length; i++)
            {
                min = math.min(min, nodes[i].m_Position);
                max = math.max(max, nodes[i].m_Position);
            }
            return (min + max) * 0.5f;
        }

        private static bool TryReadTileRequest(JToken token, out TileRequest request)
        {
            request = new TileRequest();
            if (token is not JObject obj)
            {
                return false;
            }

            request.EntityIndex = ReadNullableInt(obj, "entityIndex") ?? ReadNullableInt(obj, "index");
            request.EntityVersion = ReadNullableInt(obj, "entityVersion") ?? ReadNullableInt(obj, "version");
            request.Ordinal = ReadNullableInt(obj, "ordinal") ?? ReadNullableInt(obj, "tileIndex");
            request.X = ReadNullableFloat(obj, "x");
            request.Z = ReadNullableFloat(obj, "z");
            if (obj["entity"] is JObject entity)
            {
                request.EntityIndex = request.EntityIndex ?? ReadNullableInt(entity, "index");
                request.EntityVersion = request.EntityVersion ?? ReadNullableInt(entity, "version");
            }

            return request.EntityIndex.HasValue
                || request.Ordinal.HasValue
                || (request.X.HasValue && request.Z.HasValue);
        }

        private static int? ReadNullableInt(JObject obj, string key)
        {
            return obj[key]?.Type == JTokenType.Integer && int.TryParse(obj[key].ToString(), out int value)
                ? value
                : null;
        }

        private static float? ReadNullableFloat(JObject obj, string key)
        {
            return obj[key]?.Type is JTokenType.Float or JTokenType.Integer
                && float.TryParse(obj[key].ToString(), System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out float value)
                ? value
                : null;
        }

        private BridgeResponse PurchaseTiles(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            List<Entity> entities = ReadMapTileEntities();
            var requested = new List<TileRequest>();

            if (request.Query.TryGetValue("tiles", out string rawTiles) && !string.IsNullOrWhiteSpace(rawTiles))
            {
                try
                {
                    JToken parsed = JToken.Parse(rawTiles);
                    if (parsed is not JArray array || array.Count == 0)
                    {
                        return BridgeResponse.Error(400, "tiles must be a non-empty JSON array");
                    }
                    foreach (JToken token in array)
                    {
                        if (!TryReadTileRequest(token, out TileRequest tileRequest))
                        {
                            return BridgeResponse.Error(400, "each tile must contain entity/index, ordinal, or x and z");
                        }
                        requested.Add(tileRequest);
                    }
                }
                catch (Exception e)
                {
                    return BridgeResponse.Error(400, $"invalid tiles JSON: {e.Message}");
                }
            }
            else
            {
                var single = new JObject();
                if (request.TryGetInt("entityIndex", out int entityIndex)) single["entityIndex"] = entityIndex;
                if (request.TryGetInt("entityVersion", out int entityVersion)) single["entityVersion"] = entityVersion;
                if (request.TryGetInt("ordinal", out int ordinal)) single["ordinal"] = ordinal;
                if (request.TryGetFloat("x", out float x)) single["x"] = x;
                if (request.TryGetFloat("z", out float z)) single["z"] = z;
                if (!TryReadTileRequest(single, out TileRequest tileRequest))
                {
                    return BridgeResponse.Error(400, "provide ?tiles=<JSON array> or one tile entity/index, ordinal, or x&z");
                }
                requested.Add(tileRequest);
            }

            var selected = new List<Entity>();
            var resolved = new List<object>();
            var skippedOwned = new List<object>();
            foreach (TileRequest tileRequest in requested)
            {
                if (!TryResolveTile(tileRequest, entities, out Entity tile, out string resolveError))
                {
                    return BridgeResponse.Error(404, resolveError);
                }

                int ordinal = entities.IndexOf(tile);
                object descriptor = DescribeTile(tile, ordinal);
                if (!EntityManager.HasComponent<Native>(tile))
                {
                    skippedOwned.Add(descriptor);
                    continue;
                }
                if (!selected.Contains(tile))
                {
                    selected.Add(tile);
                    resolved.Add(descriptor);
                }
            }

            bool dryRun = request.TryGetBool("dryRun", out bool requestedDryRun) && requestedDryRun;
            if (dryRun || selected.Count == 0)
            {
                return BridgeResponse.Json(new
                {
                    success = true,
                    dryRun,
                    selected = resolved,
                    alreadyOwned = skippedOwned,
                    note = dryRun
                        ? "preview only; the native purchase system was not called"
                        : "all requested tiles were already owned; no native purchase was needed",
                });
            }

            Entity selection = EntityManager.CreateEntity(
                ComponentType.ReadWrite<SelectionInfo>(),
                ComponentType.ReadWrite<SelectionElement>());
            try
            {
                EntityManager.SetComponentData(selection, new SelectionInfo
                {
                    m_AreaType = AreaType.MapTile,
                    m_SelectionType = SelectionType.MapTiles,
                });
                DynamicBuffer<SelectionElement> elements = EntityManager.GetBuffer<SelectionElement>(selection);
                foreach (Entity tile in selected)
                {
                    elements.Add(new SelectionElement(tile));
                }

                MapTilePurchaseSystem purchase = World.GetOrCreateSystemManaged<MapTilePurchaseSystem>();
                purchase.selecting = true;
                purchase.PurchaseSelection();
                purchase.selecting = false;

                var purchased = new List<object>();
                var failed = new List<object>();
                foreach (Entity tile in selected)
                {
                    int ordinal = entities.IndexOf(tile);
                    if (!EntityManager.HasComponent<Native>(tile))
                    {
                        purchased.Add(DescribeTile(tile, ordinal));
                    }
                    else
                    {
                        failed.Add(DescribeTile(tile, ordinal));
                    }
                }

                bool success = purchased.Count == selected.Count;
                return BridgeResponse.Json(new
                {
                    success,
                    dryRun = false,
                    purchased,
                    failed,
                    alreadyOwned = skippedOwned,
                    status = purchase.status.ToString(),
                    cost = purchase.cost,
                    upkeep = purchase.upkeep,
                    availableToPurchase = purchase.GetAvailableTiles(),
                    note = success
                        ? "purchase accepted by the native MapTilePurchaseSystem"
                        : "the native purchase system rejected one or more selections; inspect status and failed tiles",
                }, success ? 200 : 409);
            }
            finally
            {
                MapTilePurchaseSystem purchase = World.GetOrCreateSystemManaged<MapTilePurchaseSystem>();
                purchase.selecting = false;
                if (EntityManager.Exists(selection))
                {
                    EntityManager.DestroyEntity(selection);
                }
            }
        }
    }
}
