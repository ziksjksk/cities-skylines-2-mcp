using System;
using System.Collections.Generic;
using Game.City;
using Game.Prefabs;
using Game.Simulation;
using Game.Tools;
using Unity.Collections;
using Unity.Entities;
using Unity.Mathematics;

namespace CS2MCP
{
    /// <summary>
    /// Management endpoints: loans (borrow/repay) and service fees
    /// (electricity/water/education... pricing), plus a generic standalone
    /// object listing (trees/props etc.) so placed decorations can be found,
    /// transformed through the native relocate path, and demolished again.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private EntityQuery m_StandaloneObjectQuery;
        private bool m_StandaloneObjectQueryCreated;
        private EntityQuery m_PlacedPropQuery;
        private bool m_PlacedPropQueryCreated;

        private EntityQuery StandaloneObjectQuery
        {
            get
            {
                if (!m_StandaloneObjectQueryCreated)
                {
                    m_StandaloneObjectQuery = EntityManager.CreateEntityQuery(new EntityQueryDesc
                    {
                        All = new[]
                        {
                            ComponentType.ReadOnly<Game.Objects.Static>(),
                            ComponentType.ReadOnly<Game.Objects.Transform>(),
                            ComponentType.ReadOnly<PrefabRef>(),
                        },
                        Any = new[]
                        {
                            ComponentType.ReadOnly<Game.Objects.Tree>(),
                            ComponentType.ReadOnly<Game.Objects.Plant>(),
                        },
                        None = new[]
                        {
                            ComponentType.ReadOnly<Game.Tools.Temp>(),
                            ComponentType.ReadOnly<Game.Common.Deleted>(),
                            ComponentType.ReadOnly<Game.Common.Owner>(),
                        },
                    });
                    m_StandaloneObjectQueryCreated = true;
                }
                return m_StandaloneObjectQuery;
            }
        }

        private EntityQuery PlacedPropQuery
        {
            get
            {
                if (!m_PlacedPropQueryCreated)
                {
                    // Props are generic static Object entities. Exclude the
                    // more specific object families so this endpoint remains
                    // useful for verifying explicit prop placement rather
                    // than duplicating /city/objects tree/plant results.
                    m_PlacedPropQuery = EntityManager.CreateEntityQuery(new EntityQueryDesc
                    {
                        All = new[]
                        {
                            ComponentType.ReadOnly<Game.Objects.Object>(),
                            ComponentType.ReadOnly<Game.Objects.Transform>(),
                            ComponentType.ReadOnly<PrefabRef>(),
                        },
                        None = new[]
                        {
                            ComponentType.ReadOnly<Game.Buildings.Building>(),
                            ComponentType.ReadOnly<Game.Objects.Tree>(),
                            ComponentType.ReadOnly<Game.Objects.Plant>(),
                            ComponentType.ReadOnly<Game.Net.Edge>(),
                            ComponentType.ReadOnly<Game.Tools.Temp>(),
                            ComponentType.ReadOnly<Game.Common.Deleted>(),
                            ComponentType.ReadOnly<Game.Common.Owner>(),
                        },
                    });
                    m_PlacedPropQueryCreated = true;
                }
                return m_PlacedPropQuery;
            }
        }

        private BridgeResponse GetLoan()
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            LoanSystem loans = World.GetOrCreateSystemManaged<LoanSystem>();
            LoanInfo current = loans.CurrentLoan;
            return BridgeResponse.Json(new
            {
                currentLoan = new
                {
                    amount = current.m_Amount,
                    dailyInterestRate = current.m_DailyInterestRate,
                    dailyPayment = current.m_DailyPayment,
                },
                creditworthiness = loans.Creditworthiness,
                note = "set the loan principal with /city/loan/set?amount=N (0 repays fully, max = creditworthiness)",
            });
        }

        private BridgeResponse SetLoan(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            if (!request.TryGetInt("amount", out int amount))
            {
                return BridgeResponse.Error(400, "provide ?amount=<int> (new loan principal; 0 repays fully)");
            }
            LoanSystem loans = World.GetOrCreateSystemManaged<LoanSystem>();
            int applied = math.clamp(amount, 0, loans.Creditworthiness);
            LoanInfo offer = loans.RequestLoanOffer(applied);
            loans.ChangeLoan(applied);
            LoanInfo current = loans.CurrentLoan;
            return BridgeResponse.Json(new
            {
                requestedAmount = amount,
                appliedAmount = applied,
                offer = new { offer.m_Amount, offer.m_DailyInterestRate, offer.m_DailyPayment },
                currentLoan = new { current.m_Amount, current.m_DailyInterestRate, current.m_DailyPayment },
            });
        }

        private BridgeResponse GetFees()
        {
            if (!TryGetCity(out Entity city, out BridgeResponse error))
            {
                return error;
            }
            ServiceFeeSystem feeSystem = World.GetOrCreateSystemManaged<ServiceFeeSystem>();
            DynamicBuffer<ServiceFee> fees = EntityManager.GetBuffer<ServiceFee>(city, isReadOnly: true);
            var result = new Dictionary<string, object>();
            foreach (PlayerResource resource in Enum.GetValues(typeof(PlayerResource)))
            {
                if ((int)resource < 0)
                {
                    continue;
                }
                if (ServiceFeeSystem.TryGetFee(resource, fees, out float fee))
                {
                    int3 limits = feeSystem.GetServiceFees(resource);
                    result[resource.ToString()] = new
                    {
                        fee,
                        estimatedMonthlyIncome = feeSystem.GetServiceFeeIncomeEstimate(resource, fee),
                        sliderRange = new { min = limits.x, max = limits.y, defaultValue = limits.z },
                    };
                }
            }
            return BridgeResponse.Json(new
            {
                note = "set with /city/fees/set?resource=<name>&fee=<float>; fees affect service income and citizen happiness",
                fees = result,
            });
        }

        private BridgeResponse SetFee(BridgeRequest request)
        {
            if (!TryGetCity(out Entity city, out BridgeResponse error))
            {
                return error;
            }
            if (!request.Query.TryGetValue("resource", out string resourceName)
                || !Enum.TryParse(resourceName, ignoreCase: true, out PlayerResource resource))
            {
                return BridgeResponse.Error(400,
                    $"provide ?resource=<{string.Join("|", Enum.GetNames(typeof(PlayerResource)))}>");
            }
            if (!request.TryGetFloat("fee", out float fee))
            {
                return BridgeResponse.Error(400, "provide ?fee=<float>");
            }
            DynamicBuffer<ServiceFee> fees = EntityManager.GetBuffer<ServiceFee>(city);
            if (!ServiceFeeSystem.TryGetFee(resource, fees, out float previous))
            {
                return BridgeResponse.Error(400, $"resource '{resource}' has no adjustable fee in this city");
            }
            ServiceFeeSystem.SetFee(resource, fees, fee);
            return BridgeResponse.Json(new
            {
                resource = resource.ToString(),
                previousFee = previous,
                newFee = fee,
            });
        }

        private BridgeResponse ListObjects(BridgeRequest request)
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
            using (NativeArray<Entity> entities = StandaloneObjectQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    Game.Objects.Transform transform = EntityManager.GetComponentData<Game.Objects.Transform>(entity);
                    if (hasCenter && math.distance(transform.m_Position.xz, center) > radius)
                    {
                        continue;
                    }
                    PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(EntityManager.GetComponentData<PrefabRef>(entity).m_Prefab);
                    string name = prefab != null ? prefab.name : "<unknown>";
                    if (!string.IsNullOrEmpty(search) && name.IndexOf(search, StringComparison.OrdinalIgnoreCase) < 0)
                    {
                        continue;
                    }
                    total++;
                    if (results.Count < limit)
                    {
                        results.Add(new
                        {
                            entity = new { index = entity.Index, version = entity.Version },
                            prefab = name,
                            position = new { x = transform.m_Position.x, y = transform.m_Position.y, z = transform.m_Position.z },
                        });
                    }
                }
            }
            return BridgeResponse.Json(new
            {
                totalMatches = total,
                returned = results.Count,
                note = "standalone trees/plants; use entity index+version with /build/demolish",
                objects = results,
            });
        }

        private BridgeResponse ListProps(BridgeRequest request)
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
            using (NativeArray<Entity> entities = PlacedPropQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    Game.Objects.Transform transform = EntityManager.GetComponentData<Game.Objects.Transform>(entity);
                    if (hasCenter && math.distance(transform.m_Position.xz, center) > radius)
                    {
                        continue;
                    }

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
                        results.Add(new
                        {
                            entity = new { index = entity.Index, version = entity.Version },
                            prefab = name,
                            position = new { x = transform.m_Position.x, y = transform.m_Position.y, z = transform.m_Position.z },
                        });
                    }
                }
            }

            return BridgeResponse.Json(new
            {
                totalMatches = total,
                returned = results.Count,
                note = "generic static props only; trees/plants remain under /city/objects; use entity index+version with /build/demolish",
                props = results,
            });
        }

        private BridgeResponse TransformObject(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            if (!request.TryGetInt("index", out int index) || !request.TryGetInt("version", out int version))
            {
                return BridgeResponse.Error(400, "provide ?index=<int>&version=<int> from /city/props, /city/objects, or /city/buildings");
            }
            Entity target = new Entity { Index = index, Version = version };
            if (!EntityManager.Exists(target))
            {
                return BridgeResponse.Error(404, $"entity {index}:{version} does not exist (stale id?)");
            }
            if (!EntityManager.HasComponent<Game.Objects.Transform>(target)
                || !EntityManager.HasComponent<PrefabRef>(target)
                || EntityManager.HasComponent<Game.Net.Edge>(target)
                || EntityManager.HasComponent<Game.Tools.Temp>(target)
                || EntityManager.HasComponent<Game.Common.Deleted>(target))
            {
                return BridgeResponse.Error(400, "entity is not a live transformable object; roads use the native road upgrade/demolish path");
            }
            if (!request.TryGetFloat("x", out float x) || !request.TryGetFloat("z", out float z))
            {
                return BridgeResponse.Error(400, "provide ?x=<float>&z=<float> world coordinates");
            }

            Game.Objects.Transform current = EntityManager.GetComponentData<Game.Objects.Transform>(target);
            float y = request.TryGetFloat("y", out float requestedY) ? requestedY : current.m_Position.y;
            float rotationDegrees = request.TryGetFloat("rotation", out float requestedRotation)
                ? requestedRotation
                : math.degrees(math.atan2(2f * (current.m_Rotation.value.w * current.m_Rotation.value.y + current.m_Rotation.value.x * current.m_Rotation.value.z), 1f - 2f * (current.m_Rotation.value.y * current.m_Rotation.value.y + current.m_Rotation.value.x * current.m_Rotation.value.x)));
            quaternion rotation = quaternion.RotateY(math.radians(rotationDegrees));
            float3 position = new float3(x, y, z);

            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(EntityManager.GetComponentData<PrefabRef>(target).m_Prefab);
            bool dryRun = request.TryGetBool("dryRun", out bool requestedDryRun) && requestedDryRun;
            object descriptor = new
            {
                entity = new { index, version },
                prefab = prefab != null ? prefab.name : null,
                current = new
                {
                    position = new { x = current.m_Position.x, y = current.m_Position.y, z = current.m_Position.z },
                    rotation = new { x = current.m_Rotation.value.x, y = current.m_Rotation.value.y, z = current.m_Rotation.value.z, w = current.m_Rotation.value.w },
                },
                target = new
                {
                    position = new { x = position.x, y = position.y, z = position.z },
                    rotation = new { x = rotation.value.x, y = rotation.value.y, z = rotation.value.z, w = rotation.value.w },
                },
            };
            if (dryRun)
            {
                return BridgeResponse.Json(new
                {
                    success = true,
                    dryRun = true,
                    preview = descriptor,
                    note = "preview only; no native relocation definition was emitted",
                });
            }

            BridgeToolSystem tool = World.GetOrCreateSystemManaged<BridgeToolSystem>();
            if (!tool.TryQueueRelocate(target, position, rotation, request))
            {
                return BridgeResponse.Error(409, "another build operation is in progress, retry shortly");
            }
            return null;
        }
    }
}
