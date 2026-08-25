using System;
using System.Collections.Generic;
using Colossal.Mathematics;
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
    /// Emits the same native terrain definition contract used by the game's
    /// TerrainToolSystem: CreationDefinition + BrushDefinition + Updated via
    /// ToolOutputBarrier. No terrain height component is edited directly.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private sealed class TerrainPoint
        {
            public float3 Position;
        }

        private sealed class TerrainOperation
        {
            public TerraformingType Type;
            public TerraformingTarget Target;
            public float Strength;
            public float3 Start;
            public float3 End;
            public float3 TargetPosition;
            public Entity TerraformPrefab;
            public TerraformingPrefab TerraformPrefabObject;
            public Entity BrushPrefab;
            public BrushPrefab BrushPrefabObject;
        }

        private static bool TryReadPoint(JToken token, out TerrainPoint point)
        {
            point = null;
            if (token is not JObject obj
                || !TryReadFloat(obj, "x", out float x)
                || !TryReadFloat(obj, "z", out float z))
            {
                return false;
            }

            float y = 0f;
            if (TryReadFloat(obj, "y", out float explicitY))
            {
                y = explicitY;
            }
            point = new TerrainPoint { Position = new float3(x, y, z) };
            return true;
        }

        private static bool TryReadFloat(JObject obj, string key, out float value)
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

        private bool TryFindTerrainOperation(
            string operation,
            List<TerrainPoint> points,
            float amount,
            out TerrainOperation result,
            out string error)
        {
            result = null;
            error = null;

            TerraformingType type;
            float sign = 1f;
            switch (operation)
            {
                case "raise":
                    type = TerraformingType.Shift;
                    sign = 1f;
                    break;
                case "lower":
                    type = TerraformingType.Shift;
                    sign = -1f;
                    break;
                case "level":
                    type = TerraformingType.Level;
                    break;
                case "slope":
                    type = TerraformingType.Slope;
                    break;
                case "smooth":
                case "soften":
                    type = TerraformingType.Soften;
                    break;
                default:
                    error = "operation must be raise, lower, level, slope, or smooth";
                    return false;
            }

            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            Entity terraformEntity = Entity.Null;
            TerraformingPrefab terraformPrefab = null;
            using (NativeArray<Entity> entities = TerraformPrefabQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    TerraformingPrefab candidate = prefabSystem.GetPrefab<TerraformingPrefab>(entity);
                    if (candidate == null || candidate.m_Type != type || candidate.m_Target != TerraformingTarget.Height)
                    {
                        continue;
                    }
                    if (IsLocked(entity))
                    {
                        continue;
                    }
                    terraformEntity = entity;
                    terraformPrefab = candidate;
                    break;
                }
            }

            if (terraformEntity == Entity.Null || terraformPrefab == null)
            {
                error = $"no unlocked height terraforming prefab for operation '{operation}' was discovered at runtime";
                return false;
            }

            Entity brushEntity = Entity.Null;
            BrushPrefab brushPrefab = null;
            using (NativeArray<Entity> entities = BrushPrefabQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    BrushPrefab candidate = prefabSystem.GetPrefab<BrushPrefab>(entity);
                    if (candidate == null || IsLocked(entity))
                    {
                        continue;
                    }
                    brushEntity = entity;
                    brushPrefab = candidate;
                    break;
                }
            }

            if (brushEntity == Entity.Null || brushPrefab == null)
            {
                error = "no unlocked terrain brush prefab was discovered at runtime";
                return false;
            }

            float strength = math.clamp(math.abs(amount), 0.01f, 1f) * sign;
            float3 start = points[0].Position;
            float3 end = points[points.Count - 1].Position;
            TerrainSystem terrain = World.GetOrCreateSystemManaged<TerrainSystem>();
            TerrainHeightData heightData = terrain.GetHeightData();
            for (int i = 0; i < points.Count; i++)
            {
                if (points[i].Position.y == 0f)
                {
                    points[i].Position.y = TerrainUtils.SampleHeight(ref heightData, points[i].Position);
                }
            }
            start = points[0].Position;
            end = points[points.Count - 1].Position;

            result = new TerrainOperation
            {
                Type = type,
                Target = TerraformingTarget.Height,
                Strength = strength,
                Start = start,
                End = end,
                TargetPosition = points[0].Position,
                TerraformPrefab = terraformEntity,
                TerraformPrefabObject = terraformPrefab,
                BrushPrefab = brushEntity,
                BrushPrefabObject = brushPrefab,
            };
            return true;
        }

        private BridgeResponse Terraform(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            string operation = request.Query.TryGetValue("operation", out string rawOperation)
                ? rawOperation.ToLowerInvariant()
                : string.Empty;
            float amount = request.TryGetFloat("amount", out float requestedAmount)
                ? requestedAmount
                : 0.5f;

            if (!request.Query.TryGetValue("points", out string rawPoints) || string.IsNullOrWhiteSpace(rawPoints))
            {
                return BridgeResponse.Error(400, "provide ?operation=raise|lower|level|slope|smooth&points=<JSON array>");
            }

            var points = new List<TerrainPoint>();
            try
            {
                JToken parsed = JToken.Parse(rawPoints);
                if (parsed is not JArray array || array.Count == 0 || array.Count > 256)
                {
                    return BridgeResponse.Error(400, "points must be a non-empty JSON array with at most 256 points");
                }
                foreach (JToken token in array)
                {
                    if (!TryReadPoint(token, out TerrainPoint point))
                    {
                        return BridgeResponse.Error(400, "each point must contain numeric x and z fields, with optional y");
                    }
                    points.Add(point);
                }
            }
            catch (Exception e)
            {
                return BridgeResponse.Error(400, $"invalid points JSON: {e.Message}");
            }

            if (!TryFindTerrainOperation(operation, points, amount, out TerrainOperation terrainOperation, out string operationError))
            {
                return BridgeResponse.Error(409, operationError);
            }

            bool dryRun = request.TryGetBool("dryRun", out bool requestedDryRun) && requestedDryRun;
            var preview = new
            {
                operation,
                type = terrainOperation.Type.ToString(),
                target = terrainOperation.Target.ToString(),
                strength = terrainOperation.Strength,
                start = new { x = terrainOperation.Start.x, y = terrainOperation.Start.y, z = terrainOperation.Start.z },
                end = new { x = terrainOperation.End.x, y = terrainOperation.End.y, z = terrainOperation.End.z },
                terraformPrefab = new
                {
                    entity = new { index = terrainOperation.TerraformPrefab.Index, version = terrainOperation.TerraformPrefab.Version },
                    name = terrainOperation.TerraformPrefabObject.name,
                },
                brushPrefab = new
                {
                    entity = new { index = terrainOperation.BrushPrefab.Index, version = terrainOperation.BrushPrefab.Version },
                    name = terrainOperation.BrushPrefabObject.name,
                },
            };

            if (dryRun)
            {
                return BridgeResponse.Json(new
                {
                    success = true,
                    dryRun = true,
                    preview,
                    note = "preview only; no native terrain definition was emitted",
                });
            }

            BridgeToolSystem tool = World.GetOrCreateSystemManaged<BridgeToolSystem>();
            if (!tool.TryQueueTerraform(
                terrainOperation.TerraformPrefab,
                terrainOperation.BrushPrefab,
                terrainOperation.BrushPrefabObject,
                terrainOperation.Start,
                terrainOperation.End,
                terrainOperation.TargetPosition,
                terrainOperation.Strength,
                preview,
                request))
            {
                return BridgeResponse.Error(409, "another build operation is in progress, retry shortly");
            }
            return null;
        }
    }
}
