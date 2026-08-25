using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using Game.SceneFlow;
using Game.UI.Menu;

namespace CS2MCP
{
    /// <summary>
    /// Native save enumeration and load/rollback entry points.  The game owns
    /// the save catalog and load pipeline; this adapter only resolves a
    /// caller-selected SaveInfo and invokes MenuUISystem.SafeLoadGame.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private static readonly BindingFlags SaveReflectionFlags =
            BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;

        private BridgeResponse ListSaves(BridgeRequest request)
        {
            MenuUISystem menu = World.GetExistingSystemManaged<MenuUISystem>();
            if (menu == null)
            {
                return BridgeResponse.Error(503, "menu system unavailable; the game world has not finished initializing");
            }

            if (!TryGetSaveList(menu, out IList saves, out string listError))
            {
                return BridgeResponse.Error(503, listError);
            }

            string query = request.Query.TryGetValue("query", out string rawQuery)
                ? rawQuery?.Trim()
                : null;
            bool includeAuto = !request.TryGetBool("includeAuto", out bool requestedIncludeAuto)
                || requestedIncludeAuto;
            int page = request.TryGetInt("page", out int requestedPage) ? Math.Max(0, requestedPage) : 0;
            int pageSize = request.TryGetInt("pageSize", out int requestedPageSize)
                ? Math.Max(1, Math.Min(200, requestedPageSize))
                : 100;

            var matches = new List<object>();
            int totalMatches = 0;
            for (int i = 0; i < saves.Count; i++)
            {
                object save = saves[i];
                if (save == null)
                {
                    continue;
                }

                bool autoSave = ReadSaveValue(save, "autoSave", false);
                string displayName = ReadSaveValue<string>(save, "displayName", null);
                string saveId = ReadSaveValue<string>(save, "id", null);
                string cityName = ReadSaveValue<string>(save, "cityName", null);
                if (!includeAuto && autoSave)
                {
                    continue;
                }
                if (!string.IsNullOrEmpty(query)
                    && (displayName == null || displayName.IndexOf(query, StringComparison.OrdinalIgnoreCase) < 0)
                    && (saveId == null || saveId.IndexOf(query, StringComparison.OrdinalIgnoreCase) < 0)
                    && (cityName == null || cityName.IndexOf(query, StringComparison.OrdinalIgnoreCase) < 0))
                {
                    continue;
                }

                if (totalMatches++ < page * pageSize || totalMatches > (page + 1) * pageSize)
                {
                    continue;
                }

                DateTime lastModified = ReadSaveValue(save, "lastModified", DateTime.MinValue);
                matches.Add(new
                {
                    id = saveId,
                    displayName,
                    path = ReadSaveValue<string>(save, "path", null),
                    cityName,
                    mapName = ReadSaveValue<string>(save, "mapName", null),
                    gameMode = ReadSaveValue<string>(save, "gameMode", null),
                    population = ReadSaveValue(save, "population", 0),
                    money = ReadSaveValue(save, "money", 0),
                    simulationDate = ReadSaveValue<object>(save, "simulationDate", null),
                    lastModified,
                    autoSave,
                    isReadonly = ReadSaveValue(save, "isReadonly", false),
                    locked = ReadSaveValue(save, "locked", false),
                });
            }

            return BridgeResponse.Json(new
            {
                success = true,
                totalMatches,
                returned = matches.Count,
                page,
                pageSize,
                saves = matches.ToArray(),
                note = "native Game.Assets.SaveInfo catalog exposed through MenuUISystem.m_SavesBinding",
            });
        }

        private BridgeResponse LoadSave(BridgeRequest request)
        {
            MenuUISystem menu = World.GetExistingSystemManaged<MenuUISystem>();
            if (menu == null)
            {
                return BridgeResponse.Error(503, "menu system unavailable; the game world has not finished initializing");
            }

            string requestedId = request.Query.TryGetValue("saveId", out string rawId)
                ? rawId?.Trim()
                : null;
            string requestedName = request.Query.TryGetValue("name", out string rawName)
                ? rawName?.Trim()
                : null;
            if (string.IsNullOrEmpty(requestedId) && string.IsNullOrEmpty(requestedName))
            {
                return BridgeResponse.Error(400, "provide saveId=<native SaveInfo.id> or name=<exact display name>");
            }

            if (!TryGetSaveList(menu, out IList saves, out string listError))
            {
                return BridgeResponse.Error(503, listError);
            }

            object selected = null;
            int matches = 0;
            for (int i = 0; i < saves.Count; i++)
            {
                object save = saves[i];
                if (save == null)
                {
                    continue;
                }
                string saveId = ReadSaveValue<string>(save, "id", null);
                string displayName = ReadSaveValue<string>(save, "displayName", null);
                bool idMatches = !string.IsNullOrEmpty(requestedId)
                    && string.Equals(saveId, requestedId, StringComparison.Ordinal);
                bool nameMatches = !string.IsNullOrEmpty(requestedName)
                    && string.Equals(displayName, requestedName, StringComparison.Ordinal);
                if (idMatches || nameMatches)
                {
                    selected = save;
                    matches++;
                }
            }

            if (selected == null)
            {
                return BridgeResponse.Error(404,
                    $"save not found; use /game/saves and pass an exact native id or display name (requestedId={requestedId ?? "null"}, name={requestedName ?? "null"})");
            }
            if (matches != 1)
            {
                return BridgeResponse.Error(409,
                    "save selector was not unique; use the exact native saveId");
            }

            string saveIdValue = ReadSaveValue<string>(selected, "id", null);
            if (string.IsNullOrEmpty(saveIdValue))
            {
                return BridgeResponse.Error(409, "selected save has no native id; refusing to invoke the load pipeline");
            }

            Type argsType = typeof(MenuUISystem).GetNestedType("LoadGameArgs", SaveReflectionFlags);
            if (argsType == null)
            {
                return BridgeResponse.Error(503, "MenuUISystem.LoadGameArgs is not available in this game build");
            }
            object args;
            try
            {
                args = Activator.CreateInstance(argsType);
                SetField(argsType, args, "saveId", saveIdValue);
                SetField(argsType, args, "cityName", ReadSaveValue<string>(selected, "cityName", null));
                SetField(argsType, args, "options", ReadSaveValue<object>(selected, "options", null));
                SetField(argsType, args, "gameMode", ReadSaveValue<string>(selected, "gameMode", null) ?? "Game");

                MethodInfo loader = typeof(MenuUISystem).GetMethod(
                    "SafeLoadGame",
                    SaveReflectionFlags,
                    binder: null,
                    types: new[] { argsType, typeof(bool) },
                    modifiers: null);
                if (loader == null)
                {
                    return BridgeResponse.Error(503, "MenuUISystem.SafeLoadGame is not available in this game build");
                }

                bool dismiss = !request.TryGetBool("dismiss", out bool requestedDismiss) || requestedDismiss;
                loader.Invoke(menu, new object[] { args, dismiss });
                return BridgeResponse.Json(new
                {
                    success = true,
                    queued = true,
                    saveId = saveIdValue,
                    displayName = ReadSaveValue<string>(selected, "displayName", null),
                    cityName = ReadSaveValue<string>(selected, "cityName", null),
                    dismiss,
                    nativePath = "MenuUISystem.SafeLoadGame(LoadGameArgs) -> GameManager.Load",
                    note = "load was queued by the native menu pipeline; poll /ping and /state until isLoading=false and cityLoaded=true",
                });
            }
            catch (TargetInvocationException e)
            {
                return BridgeResponse.Error(500, $"native save load threw: {e.InnerException?.Message ?? e.Message}");
            }
            catch (Exception e)
            {
                return BridgeResponse.Error(500, $"cannot invoke native save load: {e.Message}");
            }
        }

        private bool TryGetSaveList(MenuUISystem menu, out IList saves, out string error)
        {
            saves = null;
            error = null;
            try
            {
                FieldInfo bindingField = typeof(MenuUISystem).GetField("m_SavesBinding", SaveReflectionFlags);
                object binding = bindingField?.GetValue(menu);
                PropertyInfo valueProperty = binding?.GetType().GetProperty("value", SaveReflectionFlags);
                object value = valueProperty?.GetValue(binding);
                saves = value as IList;
                if (saves == null)
                {
                    error = "native MenuUISystem.m_SavesBinding.value is unavailable; the save catalog may still be loading";
                    return false;
                }
                return true;
            }
            catch (Exception e)
            {
                error = $"cannot read native save catalog: {e.Message}";
                return false;
            }
        }

        private static T ReadSaveValue<T>(object save, string name, T fallback)
        {
            if (save == null)
            {
                return fallback;
            }
            try
            {
                PropertyInfo property = save.GetType().GetProperty(name, SaveReflectionFlags);
                if (property != null)
                {
                    object value = property.GetValue(save);
                    if (value is T typed)
                    {
                        return typed;
                    }
                    if (value == null)
                    {
                        return fallback;
                    }
                    return (T)Convert.ChangeType(value, typeof(T));
                }
                FieldInfo field = save.GetType().GetField(name, SaveReflectionFlags);
                if (field != null)
                {
                    object value = field.GetValue(save);
                    if (value is T typed)
                    {
                        return typed;
                    }
                    if (value == null)
                    {
                        return fallback;
                    }
                    return (T)Convert.ChangeType(value, typeof(T));
                }
            }
            catch
            {
                // A new game build may change an optional metadata property;
                // an unavailable field should not prevent listing other saves.
            }
            return fallback;
        }

        private static void SetField(Type type, object target, string name, object value)
        {
            FieldInfo field = type.GetField(name, SaveReflectionFlags);
            if (field == null)
            {
                return;
            }
            field.SetValue(target, value);
        }
    }
}
