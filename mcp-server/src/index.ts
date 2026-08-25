#!/usr/bin/env node
/**
 * cs2-mcp - MCP server for Cities: Skylines II.
 *
 * Translates MCP tool calls into HTTP requests against the CS2MCP bridge mod
 * running inside the game (default http://127.0.0.1:8642, override with the
 * CS2_BRIDGE_URL environment variable).
 */
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { makeRoadPlan, GeometryKind, offsetWorldPath, RoadAnchor, snapRoadPath } from "./geometry.js";
import {
  executeVerifiedBuilding,
  executeVerifiedDemolish,
  executeVerifiedDistrict,
  executeVerifiedRoadPlan,
  executeVerifiedRoadUpgrade,
  executeVerifiedSurface,
  executeVerifiedTerraform,
  executeVerifiedZone,
  placeDecorationObject,
  registerAutonomyTools,
} from "./autonomy.js";

const BRIDGE_URL = (process.env.CS2_BRIDGE_URL ?? "http://127.0.0.1:8642").replace(/\/+$/, "");

class BridgeError extends Error {}

async function bridgeFetch(path: string, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(`${BRIDGE_URL}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new BridgeError(
      `Cannot reach the CS2 bridge at ${BRIDGE_URL} (${(err as Error).message}). ` +
        `Make sure Cities: Skylines II is running and the CS2MCP mod is enabled.`,
    );
  }
}

async function bridgeJson<T = unknown>(path: string, timeoutMs = 12_000): Promise<T> {
  const res = await bridgeFetch(path, timeoutMs);
  const text = await res.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    const message = (payload as { error?: string })?.error ?? `bridge returned HTTP ${res.status}`;
    throw new BridgeError(String(message));
  }
  return payload as T;
}

function jsonResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        success: false,
        noSuccess: true,
        error: { message },
        recommendedAction: "inspect the structured error and live capability/state response before retrying; no mutation success is implied",
      }, null, 2),
    }],
    isError: true,
  };
}

function parsePolygonNodes(raw: string): Array<{ x: number; z: number }> {
  const pairs = raw.split(";").map((value) => value.trim());
  if (pairs.length < 3) throw new BridgeError("polygon needs at least 3 corners");
  if (pairs.length > 32) throw new BridgeError("polygon has too many corners (maximum 32)");
  return pairs.map((pair) => {
    const parts = pair.split(",").map((value) => Number(value.trim()));
    if (parts.length !== 2 || !parts.every((value) => Number.isFinite(value))) {
      throw new BridgeError(`cannot parse polygon corner '${pair}'; expected x,z`);
    }
    return { x: parts[0], z: parts[1] };
  });
}

type RoadPointInput = { x: number; z: number; y?: number; elevation?: number };

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function roadRowsOf(value: unknown): unknown[] {
  const record = recordOf(value);
  return Array.isArray(record?.roads) ? record.roads : [];
}

function roadQueryScope(points: RoadPointInput[], tolerance: number): { x: number; z: number; radius: number } {
  const minX = Math.min(...points.map((value) => value.x));
  const maxX = Math.max(...points.map((value) => value.x));
  const minZ = Math.min(...points.map((value) => value.z));
  const maxZ = Math.max(...points.map((value) => value.z));
  const x = (minX + maxX) / 2;
  const z = (minZ + maxZ) / 2;
  return { x, z, radius: Math.max(120, Math.hypot(maxX - minX, maxZ - minZ) * 0.75 + tolerance + 96) };
}

async function prepareRoadGeometry(
  points: RoadPointInput[],
  options: { nodeSnap?: boolean; roadSnap?: boolean; angleSnap?: boolean; snapTolerance?: number },
) {
  const wantsRoadRows = options.nodeSnap === true || options.roadSnap === true;
  const tolerance = Math.max(0.5, options.snapTolerance ?? 16);
  let roads: unknown[] = [];
  let nativeRoadObservation: unknown = null;
  if (wantsRoadRows) {
    const scope = roadQueryScope(points, tolerance);
    nativeRoadObservation = await bridgeJson(`/city/roads${new URLSearchParams({
      x: String(scope.x),
      z: String(scope.z),
      radius: String(scope.radius),
      limit: "500",
    }).toString()}`, 20_000);
    roads = roadRowsOf(nativeRoadObservation);
  }
  const snap = snapRoadPath(points, roads, {
    nodeSnap: options.nodeSnap,
    roadSnap: options.roadSnap,
    angleSnap: options.angleSnap,
    tolerance,
  });
  return { ...snap, tolerance, nativeRoadObservation };
}

function countLaneFlags(lanes: unknown[], flag: string): number {
  return lanes.filter((value) => String(recordOf(value)?.flags ?? "").toLowerCase().split(/[,|\s]+/).includes(flag.toLowerCase())).length;
}

async function validateLaneConfiguration(prefab: string, requested: Record<string, unknown>): Promise<Record<string, unknown>> {
  const discovery = await bridgeJson<Record<string, unknown>>(`/prefabs?category=road&query=${encodeURIComponent(prefab)}&page=0&pageSize=200`, 20_000);
  const rows = Array.isArray(discovery.prefabs) ? discovery.prefabs : [];
  const match = rows
    .map(recordOf)
    .find((value) => String(value?.name ?? "").toLowerCase() === prefab.toLowerCase());
  const roadData = recordOf(match?.roadData);
  const actualLanes = Array.isArray(roadData?.lanes) ? roadData.lanes : [];
  const actualCount = finiteNumber(roadData?.laneCount) ?? actualLanes.length;
  if (!match || !roadData || actualCount <= 0) {
    return {
      success: false,
      noSuccess: true,
      reason: "lane_configuration_not_observable",
      prefab,
      requested,
      recommendedAction: "discover an exact RoadPrefab and inspect its native roadData.lanes before retrying",
      discovery,
    };
  }

  const requestedCount = finiteNumber(requested.laneCount)
    ?? finiteNumber(requested.total)
    ?? (typeof requested.lanes === "number" ? requested.lanes : undefined);
  const requestedForward = finiteNumber(requested.forward);
  const requestedBackward = finiteNumber(requested.backward);
  const requestedRoad = finiteNumber(requested.road);
  const requestedPedestrian = finiteNumber(requested.pedestrian);
  const requestedParking = finiteNumber(requested.parking);
  const requestedTrack = finiteNumber(requested.track);
  const requestedUtility = finiteNumber(requested.utility);
  const actual = {
    laneCount: actualCount,
    forward: actualLanes.filter((value) => !String(recordOf(value)?.flags ?? "").toLowerCase().includes("invert")).length,
    backward: countLaneFlags(actualLanes, "invert"),
    road: countLaneFlags(actualLanes, "road"),
    pedestrian: countLaneFlags(actualLanes, "pedestrian"),
    parking: countLaneFlags(actualLanes, "parking"),
    track: countLaneFlags(actualLanes, "track"),
    utility: countLaneFlags(actualLanes, "utility"),
    roadFlags: roadData.roadFlags ?? null,
    lanes: actualLanes,
  };
  const mismatches: Record<string, unknown> = {};
  const comparisons: Array<[string, number | undefined, number]> = [
    ["laneCount", requestedCount, actual.laneCount],
    ["forward", requestedForward, actual.forward],
    ["backward", requestedBackward, actual.backward],
    ["road", requestedRoad, actual.road],
    ["pedestrian", requestedPedestrian, actual.pedestrian],
    ["parking", requestedParking, actual.parking],
    ["track", requestedTrack, actual.track],
    ["utility", requestedUtility, actual.utility],
  ];
  for (const [key, expected, observed] of comparisons) {
    if (expected !== undefined && Math.trunc(expected) !== observed) mismatches[key] = { requested: expected, observed };
  }
  const requiredFlagsRaw = requested.requiredFlags;
  const requiredFlags = Array.isArray(requiredFlagsRaw)
    ? requiredFlagsRaw.filter((value): value is string => typeof value === "string")
    : typeof requiredFlagsRaw === "string" ? requiredFlagsRaw.split(/[,|\s]+/).filter(Boolean) : [];
  const observedFlags = actualLanes.flatMap((value) => String(recordOf(value)?.flags ?? "").split(/[,|\s]+/).filter(Boolean).map((flag) => flag.toLowerCase()));
  const missingFlags = requiredFlags.filter((flag) => !observedFlags.includes(flag.toLowerCase()));
  if (missingFlags.length > 0) mismatches.requiredFlags = { requested: requiredFlags, missing: missingFlags };
  return {
    success: Object.keys(mismatches).length === 0,
    noSuccess: Object.keys(mismatches).length > 0,
    prefab,
    requested,
    observed: actual,
    mismatches,
    source: "live native RoadPrefab/SubNet/NetLaneData discovery",
    note: Object.keys(mismatches).length === 0
      ? "laneConfiguration matched the native lane composition; no arbitrary lane rewrite was emitted"
      : "the requested composition did not match the exact runtime prefab; no road definition was emitted",
    discovery: { totalMatches: discovery.totalMatches, returned: discovery.returned },
  };
}

function attachRoadAnchors(plan: ReturnType<typeof makeRoadPlan>, anchors: Array<RoadAnchor | undefined>) {
  if (plan.segments.length === 0) return plan;
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (first) plan.segments[0].startAnchor = first;
  if (last) plan.segments[plan.segments.length - 1].endAnchor = last;
  return plan;
}

const server = new McpServer({ name: "cs2-mcp", version: "0.9.0" });

server.registerTool(
  "cs2_ping",
  {
    title: "Ping the game bridge",
    description:
      "Check that Cities: Skylines II is running with the CS2MCP bridge mod loaded. " +
      "Returns mod version, current game mode (MainMenu / Game / Editor) and whether a save is loading. " +
      "Works even while a save is still loading; use this first to diagnose connection issues.",
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResult(await bridgeJson("/ping", 3_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_game_state",
  {
    title: "Get game state",
    description:
      "Get the current game state: game mode, whether a city is loaded, city name, " +
      "simulation pause/speed and the in-game date/time.",
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResult(await bridgeJson("/state"));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_city_overview",
  {
    title: "Get city overview",
    description:
      "Key statistics of the loaded city: population (plus citizens currently moving in), " +
      "average happiness and health, city treasury money, XP, in-game date and simulation speed. " +
      "Requires a loaded city.",
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResult(await bridgeJson("/city/overview"));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_demand",
  {
    title: "Get RCI zoning demand",
    description:
      "Residential (low/medium/high density), commercial, industrial, office and storage demand " +
      "of the loaded city (0-100), including the demand factors that explain WHY demand is high or low " +
      "(e.g. Taxes, Unemployment, EmptyZones, Homelessness). Positive factor values push demand up, " +
      "negative values push it down.",
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResult(await bridgeJson("/city/demand"));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_set_simulation",
  {
    title: "Pause / set simulation speed",
    description:
      "Control the simulation clock: pause/unpause the game and/or set the simulation speed " +
      "(0 = paused, 1 = normal, 2 = double, 4 = fastest UI speed; values up to 8 are accepted). " +
      "Returns the resulting state.",
    inputSchema: {
      paused: z.boolean().optional().describe("true to pause, false to resume"),
      speed: z.number().min(0).max(8).optional().describe("simulation speed multiplier (0-8)"),
    },
  },
  async ({ paused, speed }) => {
    if (paused === undefined && speed === undefined) {
      return errorResult(new Error("provide at least one of: paused, speed"));
    }
    const params = new URLSearchParams();
    if (speed !== undefined) params.set("speed", String(speed));
    if (paused !== undefined) params.set("paused", String(paused));
    try {
      return jsonResult(await bridgeJson(`/sim/control?${params.toString()}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_screenshot",
  {
    title: "Take a screenshot",
    description:
      "Capture the current game view as a PNG image. Useful for seeing the city layout, " +
      "checking what the player is looking at, or verifying the result of an action. " +
      "Returns the image directly.",
    inputSchema: {
      width: z
        .number()
        .int()
        .min(64)
        .max(3840)
        .optional()
        .describe("Downscale the image to this width in pixels (default 1280, keeps aspect ratio)"),
    },
  },
  async ({ width }) => {
    const w = width ?? 1280;
    try {
      const res = await bridgeFetch(`/screenshot?width=${w}`, 30_000);
      if (!res.ok) {
        const text = await res.text();
        let message = `bridge returned HTTP ${res.status}`;
        try {
          message = (JSON.parse(text) as { error?: string })?.error ?? message;
        } catch {
          // keep default message
        }
        return errorResult(new BridgeError(message));
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      return {
        content: [
          { type: "image" as const, data: buffer.toString("base64"), mimeType: "image/png" },
        ],
      };
    } catch (err) {
      return errorResult(err);
    }
  },
);

/** Register a parameter-less tool that returns bridge JSON. */
function registerJsonTool(name: string, title: string, description: string, path: string) {
  server.registerTool(name, { title, description, inputSchema: {} }, async () => {
    try {
      return jsonResult(await bridgeJson(path));
    } catch (err) {
      return errorResult(err);
    }
  });
}

registerJsonTool(
  "cs2_budget",
  "Get budget breakdown",
  "Detailed city budget: total income/expenses, balance, and a per-source breakdown " +
    "(residential/commercial/industrial/office taxes, service fees, subsidies, service upkeep, " +
    "loan interest, electricity/water import-export, map tile upkeep). Values are monthly rates; " +
    "expenses are positive costs.",
  "/city/budget",
);

registerJsonTool(
  "cs2_city_services",
  "Get utility service status",
  "Electricity (production/consumption/battery/trade), water & sewage (capacity/consumption/trade) " +
    "and garbage accumulation of the loaded city. Compare production vs consumption to spot shortages.",
  "/city/services",
);

registerJsonTool(
  "cs2_labor",
  "Get labor market",
  "Employment data: employed citizens, unemployment rate, homelessness, total/free jobs broken down " +
    "by required education level, and the population age structure (children/teens/adults/seniors).",
  "/city/labor",
);

server.registerTool(
  "cs2_statistics",
  {
    title: "Get statistic history",
    description:
      "Time series of a city statistic (sampled 32x per in-game day). Useful types: Population, Money, " +
      "Income, Expense, HouseholdCount, WorkerCount, Unemployed, TouristCount, CrimeRate, BirthRate, " +
      "DeathRate, CitizensMovedIn, CitizensMovedAway, ResidentialTaxableIncome, TrafficFlow-style passenger " +
      "counts (PassengerCountBus/Subway/Train...). An invalid type returns the full list of valid names.",
    inputSchema: {
      type: z.string().describe("StatisticType enum name, e.g. 'Population' or 'Money'"),
      parameter: z.number().int().optional().describe("Sub-index for parameterized statistics (default 0)"),
      samples: z.number().int().min(1).max(512).optional().describe("How many recent samples to return (default 64)"),
    },
  },
  async ({ type, parameter, samples }) => {
    const params = new URLSearchParams({ type });
    if (parameter !== undefined) params.set("parameter", String(parameter));
    if (samples !== undefined) params.set("samples", String(samples));
    try {
      return jsonResult(await bridgeJson(`/city/statistics?${params.toString()}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

registerJsonTool(
  "cs2_get_taxes",
  "Get tax rates",
  "Current tax rate and allowed range for each tax area: Residential, Commercial, Industrial, Office.",
  "/city/taxes",
);

server.registerTool(
  "cs2_set_tax",
  {
    title: "Set a tax rate",
    description:
      "Set the tax rate (integer percent) for one tax area. The rate is clamped to the game's allowed " +
      "range (returned in the response). Higher taxes raise income but lower demand and happiness.",
    inputSchema: {
      area: z.enum(["Residential", "Commercial", "Industrial", "Office"]).describe("Tax area to change"),
      rate: z.number().int().describe("New tax rate in percent"),
    },
  },
  async ({ area, rate }) => {
    try {
      return jsonResult(await bridgeJson(`/city/taxes/set?area=${area}&rate=${rate}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

registerJsonTool(
  "cs2_policies",
  "List city policies",
  "All city-wide policies with their internal name, localized title, active state, locked state and " +
    "whether they take a slider adjustment value (e.g. Recycling, Education Subsidies, speed limits).",
  "/city/policies",
);

server.registerTool(
  "cs2_set_policy",
  {
    title: "Toggle a city policy",
    description:
      "Activate or deactivate a city-wide policy by its internal name (from cs2_policies). " +
      "Slider policies additionally accept an adjustment value. Locked policies cannot be set.",
    inputSchema: {
      name: z.string().describe("Policy internal name from cs2_policies"),
      active: z.boolean().describe("true to activate, false to deactivate"),
      adjustment: z.number().optional().describe("Slider value for slider policies (optional)"),
    },
  },
  async ({ name, active, adjustment }) => {
    const params = new URLSearchParams({ name, active: String(active) });
    if (adjustment !== undefined) params.set("adjustment", String(adjustment));
    try {
      return jsonResult(await bridgeJson(`/city/policies/set?${params.toString()}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

registerJsonTool(
  "cs2_service_budgets",
  "Get service budgets",
  "Per-service budget sliders (50-150%, 100 = default) with current efficiency, estimated upkeep cost " +
    "and building count for every city service (police, healthcare, education, transport, ...).",
  "/city/service-budgets",
);

server.registerTool(
  "cs2_set_service_budget",
  {
    title: "Set a service budget",
    description:
      "Set the budget percentage (50-150) for one city service by name (from cs2_service_budgets). " +
      "Lower budgets save money but reduce service efficiency; higher budgets do the opposite.",
    inputSchema: {
      service: z.string().describe("Service name from cs2_service_budgets"),
      percentage: z.number().int().min(50).max(150).describe("Budget percentage, 100 = default"),
    },
  },
  async ({ service, percentage }) => {
    const params = new URLSearchParams({ service, percentage: String(percentage) });
    try {
      return jsonResult(await bridgeJson(`/city/service-budgets/set?${params.toString()}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_find_prefabs",
  {
    title: "Search placeable prefabs",
    description:
      "Search the game's building or road prefabs by name substring. Returns exact prefab names " +
      "needed by cs2_place_building, plus their type and locked state. Example queries: 'school', " +
      "'FireHouse', 'WindTurbine', 'Highway'. Prop, surface, and transport categories expose " +
      "runtime-discovered assets for cs2_place_prop, cs2_paint_surface, and transport-line tools.",
    inputSchema: {
      category: z
        .enum(["building", "road", "net", "tree", "terraform", "brush", "prop", "surface", "transport"])
        .optional()
        .describe("Prefab category (default building); 'net' = all networks incl. train tracks, pipes, power lines, pedestrian paths; terraform/brush/prop/surface/transport are runtime tool, decoration, and route assets"),
      query: z.string().optional().describe("Case-insensitive name substring filter"),
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)"),
    },
  },
  async ({ category, query, limit }) => {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (query) params.set("query", query);
    if (limit) params.set("limit", String(limit));
    try {
      return jsonResult(await bridgeJson(`/prefabs?${params.toString()}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_place_building",
  {
    title: "Place a building",
    description:
      "Place a building in the world at the given map coordinates (x, z in meters; the map is roughly " +
      "-7000 to +7000 on each axis, use cs2_list_buildings to see coordinates of existing buildings for " +
      "reference). Building positions are snapped to the native 8m zoning grid by default, and prefabs " +
      "whose native BuildingData requires road access are rejected before mutation when no live road edge " +
      "is within the native anchor range. Height is sampled from terrain automatically. The game's native " +
      "tool validates collisions, terrain, water, lot occupancy, and access; the result is not successful " +
      "unless a new building entity is read back.",
    inputSchema: {
      prefab: z.string().describe("Exact prefab name from cs2_find_prefabs"),
      x: z.number().describe("World X coordinate (meters)"),
      z: z.number().describe("World Z coordinate (meters)"),
      rotation: z.number().optional().describe("Rotation around Y axis in degrees (default 0)"),
      gridSnap: z.boolean().optional().describe("Snap ordinary buildings to the native 8m grid (default true; transport facilities/stops keep road-anchor placement)"),
      requireRoad: z.boolean().optional().describe("Require a live road anchor even when the prefab flags do not require one"),
      dryRun: z.boolean().optional().describe("Return native placement preview without mutating the game"),
      force: z.boolean().optional().describe("Place even if the prefab is milestone-locked"),
    },
  },
  async ({ prefab, x, z, rotation, gridSnap, requireRoad, dryRun, force }) => {
    try {
      if (dryRun === true) {
        return jsonResult(await bridgeJson(`/build/place?${new URLSearchParams({
          prefab,
          x: String(x),
          z: String(z),
          ...(rotation === undefined ? {} : { rotation: String(rotation) }),
          ...(gridSnap === undefined ? { gridSnap: "true" } : { gridSnap: String(gridSnap) }),
          ...(requireRoad === undefined ? {} : { requireRoad: String(requireRoad) }),
          ...(force ? { force: "true" } : {}),
          dryRun: "true",
        }).toString()}`, 15_000));
      }
      return jsonResult(await executeVerifiedBuilding(
        prefab,
        { x, z },
        force === true,
        { rotation, gridSnap: gridSnap ?? true, requireRoad },
      ));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_build_road",
  {
    title: "Build a road segment or validated path",
    description:
      "Build any network segment between two world coordinates (terrain-following): roads, train tracks, " +
      "pedestrian paths, power lines, pipes 鈥?any prefab from cs2_find_prefabs category 'road' or 'net'. " +
      "Straight by default; pass cx/cz for a curved segment through that control point. For a larger operation, " +
      "pass points[] plus geometry to preview/validate/split a polyline, Bezier, arc, or spline before execution. " +
      "Every native mutation is still performed one segment at a time through the game's validation path.",
    inputSchema: {
      prefab: z.string().describe("Exact prefab name from cs2_find_prefabs (category road or net)"),
      x1: z.number().optional().describe("Start X for one segment (meters); omit when points[] is supplied"),
      z1: z.number().optional().describe("Start Z for one segment (meters); omit when points[] is supplied"),
      x2: z.number().optional().describe("End X for one segment (meters); omit when points[] is supplied"),
      z2: z.number().optional().describe("End Z for one segment (meters); omit when points[] is supplied"),
      start: z.object({ x: z.number(), z: z.number(), y: z.number().optional(), elevation: z.number().optional() }).optional().describe("Start world point; alternate to x1/z1"),
      end: z.object({ x: z.number(), z: z.number(), y: z.number().optional(), elevation: z.number().optional() }).optional().describe("End world point; alternate to x2/z2"),
      controlPoints: z.array(z.object({ x: z.number(), z: z.number(), y: z.number().optional(), elevation: z.number().optional() })).max(16).optional().describe("Bezier/arc/spline control points; alternate compound-path form"),
      cx: z.number().optional().describe("Curve control point X (with cz: builds a curve through it)"),
      cz: z.number().optional().describe("Curve control point Z"),
      e1: z.number().optional().describe("Elevation at start in meters (bridges/elevated; negative = tunnel-ish)"),
      e2: z.number().optional().describe("Elevation at end in meters"),
      elevation: z.number().optional().describe("Common elevation offset in meters when startElevation/endElevation are omitted"),
      startElevation: z.number().optional().describe("Explicit start elevation offset in meters"),
      endElevation: z.number().optional().describe("Explicit end elevation offset in meters"),
      points: z
        .array(z.object({ x: z.number(), z: z.number(), y: z.number().optional(), elevation: z.number().optional() }))
        .min(2)
        .max(128)
        .optional()
        .describe("World x/z/y path points for a validated compound path"),
      geometry: z.enum(["straight", "bezier", "arc", "spline", "polyline"]).optional(),
      maxSegmentLength: z.number().min(8).max(1500).optional(),
      maxSlope: z.number().min(0.001).max(1).optional(),
      targetSlope: z.number().min(0.001).max(1).optional().describe("Alias for maxSlope; used by the geometry validator"),
      parallelOffset: z.number().min(-2000).max(2000).optional().describe("Planar offset from the alignment's left-hand normal in meters"),
      snapMode: z.enum(["native", "none"]).optional().describe("native = rely on the game's native network validation; none is plan metadata only"),
      nodeSnap: z.boolean().optional().describe("Snap each requested endpoint to a live native road node and bind that node entity into CoursePos"),
      roadSnap: z.boolean().optional().describe("Project each requested endpoint onto a live native road curve and bind the edge plus normalized curve position"),
      angleSnap: z.boolean().optional().describe("Quantize each path leg to the standard 15-degree construction angle before native validation"),
      snapTolerance: z.number().min(0.5).max(80).optional().describe("Maximum endpoint-to-road distance for explicit snapping (meters; default 16)"),
      laneConfiguration: z.record(z.unknown()).optional().describe("Validate laneCount/forward/backward/road/pedestrian/parking/track/utility against the exact runtime RoadPrefab; no arbitrary lane rewrite is emitted"),
      preview: z.boolean().optional().describe("Return geometry and issues without mutating the game"),
      dryRun: z.boolean().optional().describe("Alias for preview"),
      force: z.boolean().optional().describe("Build even if the prefab is milestone-locked"),
    },
  },
  async ({ prefab, x1, z1, x2, z2, start, end, controlPoints, cx, cz, e1, e2, elevation, startElevation, endElevation, points, geometry, maxSegmentLength, maxSlope, targetSlope, parallelOffset, snapMode, nodeSnap, roadSnap, angleSnap, snapTolerance, laneConfiguration, preview, dryRun, force }) => {
    if (snapMode === "none" && (preview !== true && dryRun !== true)) {
      return jsonResult({ success: false, noSuccess: true, reason: "snapMode_none_is_plan_only", recommendedAction: "use snapMode=native for a native construction request or set preview=true" });
    }
    let laneCheck: Record<string, unknown> | null = null;
    if (laneConfiguration !== undefined) {
      try {
        laneCheck = await validateLaneConfiguration(prefab, laneConfiguration);
      } catch (err) {
        return errorResult(err);
      }
      if (laneCheck.success !== true) {
        return jsonResult({
          ...laneCheck,
          requestedExecute: preview !== true && dryRun !== true,
          recommendedAction: "choose a runtime road prefab whose native lane composition matches laneConfiguration, or omit the constraint",
        });
      }
    }
    const commonElevation = startElevation ?? e1 ?? elevation;
    const finalElevation = endElevation ?? e2 ?? elevation;
    const normalizePoint = (value: { x: number; z: number; y?: number; elevation?: number }, fallbackElevation?: number) => {
      const vertical = value.y ?? value.elevation ?? fallbackElevation;
      return { x: value.x, z: value.z, ...(vertical === undefined ? {} : { y: vertical }) };
    };
    const compoundPoints = points
      ?? (start && end ? [start, ...(controlPoints ?? []), end] : undefined);
    const makePreparedPlan = async (rawPoints: RoadPointInput[]) => {
      const shifted = offsetWorldPath(rawPoints, parallelOffset ?? 0);
      const prepared = await prepareRoadGeometry(shifted, { nodeSnap, roadSnap, angleSnap, snapTolerance });
      const plan = makeRoadPlan({
        start: prepared.points[0],
        end: prepared.points[prepared.points.length - 1],
        controlPoints: prepared.points.slice(1, -1),
        geometry: geometry as GeometryKind | undefined,
        maxSegmentLength,
        maxSlope: maxSlope ?? targetSlope,
      });
      attachRoadAnchors(plan, prepared.anchors);
      const snapEvidence = {
        requested: { nodeSnap: nodeSnap ?? false, roadSnap: roadSnap ?? false, angleSnap: angleSnap ?? false },
        tolerance: prepared.tolerance,
        applied: prepared.applied,
        unresolved: prepared.unresolved,
        observedRoads: roadRowsOf(prepared.nativeRoadObservation).length,
      };
      return { plan, snapEvidence };
    };
    if (compoundPoints) {
      const normalized = compoundPoints.map((value, index) => normalizePoint(value, index === 0 ? commonElevation : index === compoundPoints.length - 1 ? finalElevation : undefined));
      let preparedPlan: Awaited<ReturnType<typeof makePreparedPlan>>;
      try {
        preparedPlan = await makePreparedPlan(normalized);
      } catch (err) {
        return errorResult(err);
      }
      const { plan, snapEvidence } = preparedPlan;
      const blocking = plan.issues.filter((issue) => issue.severity === "error");
      const snapBlocking = snapEvidence.unresolved.length > 0;
      if (preview || dryRun || blocking.length > 0 || snapBlocking) {
        return jsonResult({ success: blocking.length === 0 && !snapBlocking, dryRun: true, executable: blocking.length === 0 && !snapBlocking, plan, laneCheck, snap: snapEvidence, requested: { snapMode: snapMode ?? "native", parallelOffset: parallelOffset ?? 0, targetSlope: targetSlope ?? maxSlope ?? null }, issueCounts: { errors: blocking.length + (snapBlocking ? snapEvidence.unresolved.length : 0), warnings: plan.issues.filter((issue) => issue.severity === "warning").length } });
      }
      try {
        const verification = await executeVerifiedRoadPlan(plan, prefab, force === true);
        return jsonResult({
          ...verification,
          dryRun: false,
          prefab,
          plan,
          laneCheck,
          snap: snapEvidence,
          success: verification.success === true,
          note: verification.success === true
            ? "every requested segment was read back from the live native network query"
            : "one or more native requests completed without a matching live network-segment readback; inspect results before retrying",
        });
      } catch (err) {
        return errorResult(err);
      }
    }
    if (x1 === undefined || z1 === undefined || x2 === undefined || z2 === undefined) {
      return errorResult(new Error("provide x1,z1,x2,z2, start/end, or points[] for a compound path"));
    }
    if ((cx === undefined) !== (cz === undefined)) {
      return errorResult(new Error("cx and cz must be supplied together for a curved segment"));
    }
    const legacyPath = [
      normalizePoint({ x: x1, z: z1 }, commonElevation),
      ...(cx === undefined ? [] : [normalizePoint({ x: cx, z: cz as number })]),
      normalizePoint({ x: x2, z: z2 }, finalElevation),
    ];
    let preparedPlan: Awaited<ReturnType<typeof makePreparedPlan>>;
    try {
      preparedPlan = await makePreparedPlan(legacyPath);
    } catch (err) {
      return errorResult(err);
    }
    const { plan, snapEvidence } = preparedPlan;
    const blocking = plan.issues.filter((issue) => issue.severity === "error");
    const snapBlocking = snapEvidence.unresolved.length > 0;
    if (preview || dryRun || blocking.length > 0 || snapBlocking) {
      return jsonResult({
        success: blocking.length === 0 && !snapBlocking,
        dryRun: true,
        executable: blocking.length === 0 && !snapBlocking,
        prefab,
        plan,
        laneCheck,
        snap: snapEvidence,
        requested: { snapMode: snapMode ?? "native", parallelOffset: parallelOffset ?? 0, targetSlope: targetSlope ?? maxSlope ?? null },
        issueCounts: { errors: blocking.length + (snapBlocking ? snapEvidence.unresolved.length : 0), warnings: plan.issues.filter((issue) => issue.severity === "warning").length },
      });
    }
    try {
      const verification = await executeVerifiedRoadPlan(plan, prefab, force === true);
      return jsonResult({
        ...verification,
        dryRun: false,
        prefab,
        plan,
        laneCheck,
        snap: snapEvidence,
        success: verification.success === true,
        note: verification.success === true
          ? "the requested native network segment was read back with an entity id"
          : "native construction did not produce a matching live network readback; no full success is claimed",
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_place_prop",
  {
    title: "Place a runtime-discovered prop",
    description:
      "Preview or place a static decoration prop through the game's native object creation path. " +
      "Use cs2_find_prefabs with category=prop to obtain an exact prefab name, then verify with " +
      "cs2_list_props or cs2_screenshot. Placement still obeys native terrain/collision validation.",
    inputSchema: {
      prefab: z.string().describe("Exact placeable prop prefab name from cs2_find_prefabs(category=prop)"),
      x: z.number().describe("World X coordinate (meters)"),
      z: z.number().describe("World Z coordinate (meters)"),
      y: z.number().optional().describe("Optional world height; terrain height is sampled when omitted"),
      rotation: z.number().optional().describe("Rotation around Y axis in degrees (default 0)"),
      dryRun: z.boolean().optional().describe("Return the native placement preview without creating the prop"),
      force: z.boolean().optional().describe("Place even if the prefab is milestone-locked"),
    },
  },
  async ({ prefab, x, z: zCoord, y, rotation, dryRun, force }) => {
    try {
      return jsonResult(await placeDecorationObject(
        "prop",
        { x, z: zCoord, ...(y === undefined ? {} : { y }) },
        prefab,
        rotation ?? 0,
        dryRun !== true,
        force === true,
      ));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_paint_surface",
  {
    title: "Paint a native surface area",
    description:
      "Preview or paint a polygon with a runtime-discovered SurfacePrefab through the game's native area " +
      "creation path. Use cs2_find_prefabs with category=surface for exact prefab names. The polygon is " +
      "an array of world points with x and z fields and optional y.",
    inputSchema: {
      polygon: z.array(z.object({ x: z.number(), z: z.number(), y: z.number().optional() })).min(3).max(256),
      prefab: z.string().optional().describe("Exact surface prefab name; if omitted, choose the first unlocked runtime surface"),
      dryRun: z.boolean().optional().describe("Return the native area preview without creating the surface"),
      force: z.boolean().optional().describe("Use a locked surface prefab when the game exposes one"),
    },
  },
  async ({ polygon, prefab, dryRun, force }) => {
    try {
      if (dryRun) {
        const params = new URLSearchParams({ polygon: JSON.stringify(polygon) });
        if (prefab) params.set("prefab", prefab);
        params.set("dryRun", "true");
        if (force) params.set("force", "true");
        return jsonResult(await bridgeJson(`/surface?${params.toString()}`, 20_000));
      }
      return jsonResult(await executeVerifiedSurface(polygon, prefab, force === true));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_list_props",
  {
    title: "List placed props",
    description:
      "Return generic static prop entities currently present in the city, with prefab names and world " +
      "positions. Trees and plants remain in cs2_list_objects. Use this endpoint to verify native prop placement.",
    inputSchema: {
      query: z.string().optional().describe("Case-insensitive prefab name filter"),
      x: z.number().optional().describe("Optional center X for radius filtering"),
      z: z.number().optional().describe("Optional center Z for radius filtering"),
      radius: z.number().optional().describe("Radius in meters when x and z are supplied"),
      limit: z.number().int().min(1).max(500).optional().describe("Maximum returned props (default 100)"),
    },
  },
  async ({ query, x, z: zCoord, radius, limit }) => {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (x !== undefined) params.set("x", String(x));
    if (zCoord !== undefined) params.set("z", String(zCoord));
    if (radius !== undefined) params.set("radius", String(radius));
    if (limit !== undefined) params.set("limit", String(limit));
    try {
      return jsonResult(await bridgeJson(`/city/props?${params.toString()}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_list_buildings",
  {
    title: "List placed buildings",
    description:
      "List buildings existing in the city with their prefab name, world position and entity id " +
      "(index+version, needed for cs2_demolish). Filter by name substring to find specific buildings.",
    inputSchema: {
      query: z.string().optional().describe("Case-insensitive prefab-name substring filter"),
      limit: z.number().int().min(1).max(500).optional().describe("Max results (default 100)"),
    },
  },
  async ({ query, limit }) => {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (limit) params.set("limit", String(limit));
    try {
      return jsonResult(await bridgeJson(`/city/buildings?${params.toString()}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

registerJsonTool(
  "cs2_list_zones",
  "List zone types",
  "All zone types (residential low/medium/high, commercial, industrial, office...) with their " +
    "internal name, area type and locked state. Use the exact name with cs2_zone_area.",
  "/zones",
);

server.registerTool(
  "cs2_zone_area",
  {
    title: "Zone an area",
    description:
      "Paint zoning on all zonable cells within a radius around a point. Zone cells only exist " +
      "along roads (build a road first). Pass zone='None' to remove zoning. Buildings grow on zoned " +
      "cells while the simulation runs, driven by RCI demand (check cs2_demand).",
    inputSchema: {
      zone: z.string().describe("Exact zone name from cs2_list_zones, or 'None' to dezone"),
      x: z.number().describe("Center X (meters)"),
      z: z.number().describe("Center Z (meters)"),
      radius: z.number().min(8).max(200).optional().describe("Radius in meters (default 32)"),
      snapToGrid: z.boolean().optional().describe("Snap center/radius to the native 8m zoning grid (default true)"),
      overwrite: z.boolean().optional().describe("Allow the native zone tool to replace existing zoning where supported"),
      dryRun: z.boolean().optional().describe("Return the native zone preview without changing cells"),
      force: z.boolean().optional().describe("Zone even if the zone type is milestone-locked"),
    },
  },
  async ({ zone, x, z: zCoord, radius, snapToGrid, overwrite, dryRun, force }) => {
    try {
      if (dryRun === true) {
        return jsonResult(await bridgeJson(`/build/zone?${new URLSearchParams({
          zone,
          x: String(x),
          z: String(zCoord),
          ...(radius === undefined ? {} : { radius: String(radius) }),
          snapToGrid: String(snapToGrid ?? true),
          ...(overwrite ? { overwrite: "true" } : {}),
          ...(force ? { force: "true" } : {}),
          dryRun: "true",
        }).toString()}`, 15_000));
      }
      return jsonResult(await executeVerifiedZone(
        { x, z: zCoord },
        radius ?? 32,
        zone,
        force === true,
        { snapToGrid: snapToGrid ?? true, overwrite: overwrite === true, dezone: zone.toLowerCase() === "none" },
      ));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_upgrade_road",
  {
    title: "Upgrade a road segment",
    description:
      "Apply upgrades to an existing road segment (from cs2_list_roads): grass, trees, wideSidewalk, " +
      "soundBarrier, parking, lighting, medianGrass, medianTrees. Combine multiple with commas. " +
      "The segment is recreated with the new composition via the game's tool pipeline, then the live road " +
      "query is checked for matching geometry and CompositionFlags. Use dryRun or execute=false to preview.",
    inputSchema: {
      index: z.number().int().describe("Road segment entity index"),
      version: z.number().int().describe("Road segment entity version"),
      upgrades: z.string().describe("Comma-separated upgrade names, e.g. 'grass,lighting'"),
      side: z.enum(["both", "left", "right"]).optional().describe("Which side for side upgrades (default both)"),
      dryRun: z.boolean().optional().describe("Preview through the native handler without mutation"),
      execute: z.boolean().optional().describe("Execute the native upgrade; defaults to true"),
    },
  },
  async ({ index, version, upgrades, side, dryRun, execute }) => {
    const params = new URLSearchParams({ index: String(index), version: String(version), upgrades });
    if (side) params.set("side", side);
    if (dryRun === true || execute === false) params.set("dryRun", "true");
    try {
      if (dryRun === true || execute === false) return jsonResult(await bridgeJson(`/build/upgrade?${params.toString()}`, 15_000));
      return jsonResult(await executeVerifiedRoadUpgrade(index, version, upgrades, side ?? "both"));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_list_roads",
  {
    title: "List road segments",
    description:
      "List road segments (edges) with entity id, prefab name, start/end coordinates and length. " +
      "Filter spatially with x/z/radius or by prefab-name substring. Use the entity id with cs2_demolish.",
    inputSchema: {
      query: z.string().optional().describe("Prefab-name substring filter"),
      x: z.number().optional().describe("Center X for spatial filter"),
      z: z.number().optional().describe("Center Z for spatial filter"),
      radius: z.number().optional().describe("Radius in meters for spatial filter (default 250)"),
      limit: z.number().int().min(1).max(500).optional().describe("Max results (default 100)"),
    },
  },
  async ({ query, x, z: zCoord, radius, limit }) => {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (x !== undefined) params.set("x", String(x));
    if (zCoord !== undefined) params.set("z", String(zCoord));
    if (radius !== undefined) params.set("radius", String(radius));
    if (limit) params.set("limit", String(limit));
    try {
      return jsonResult(await bridgeJson(`/city/roads?${params.toString()}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_demolish",
  {
    title: "Demolish a building or road segment",
    description:
      "Demolish (bulldoze) one building (from cs2_list_buildings) or road segment (from cs2_list_roads) " +
      "identified by its entity index and version. The game bulldoze pipeline performs the deletion, and " +
      "execution is successful only after the exact entity disappears from native inspection. Irreversible 鈥?double-check the target first.",
    inputSchema: {
      index: z.number().int().describe("Entity index from cs2_list_buildings"),
      version: z.number().int().describe("Entity version from cs2_list_buildings"),
    },
  },
  async ({ index, version }) => {
    try {
      return jsonResult(await executeVerifiedDemolish({ index, version }));
    } catch (err) {
      return errorResult(err);
    }
  },
);

registerJsonTool(
  "cs2_get_camera",
  "Get camera state",
  "Current gameplay camera: pivot (look-at point), position, compass/tilt angles and zoom distance.",
  "/camera",
);

server.registerTool(
  "cs2_set_camera",
  {
    title: "Move the camera",
    description:
      "Point the gameplay camera: set the pivot (look-at world coordinates; height auto-sampled from " +
      "terrain unless y given), compass rotation angleX (degrees), tilt angleY (0-89) and zoom distance. " +
      "Combine with cs2_screenshot to LOOK at any place in the city 鈥?the AI's own eyes.",
    inputSchema: {
      x: z.number().optional().describe("Pivot X (requires z)"),
      z: z.number().optional().describe("Pivot Z (requires x)"),
      y: z.number().optional().describe("Pivot height (optional, terrain height used if omitted)"),
      angleX: z.number().optional().describe("Compass rotation in degrees"),
      angleY: z.number().optional().describe("Tilt in degrees (0 = horizontal, 89 = top-down)"),
      zoom: z.number().optional().describe("Camera distance (10-10000, larger = further out)"),
    },
  },
  async ({ x, z: zCoord, y, angleX, angleY, zoom }) => {
    const params = new URLSearchParams();
    if (x !== undefined) params.set("x", String(x));
    if (zCoord !== undefined) params.set("z", String(zCoord));
    if (y !== undefined) params.set("y", String(y));
    if (angleX !== undefined) params.set("angleX", String(angleX));
    if (angleY !== undefined) params.set("angleY", String(angleY));
    if (zoom !== undefined) params.set("zoom", String(zoom));
    try {
      return jsonResult(await bridgeJson(`/camera/set?${params.toString()}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_terrain",
  {
    title: "Get terrain & water map",
    description:
      "Sampled heightmap and water-depth grid of the whole map (14336x14336m). Returns row-major arrays; " +
      "waterDepths > 0 marks rivers/lakes/sea. Use to understand geography before planning construction. " +
      "Set raw=true for unrounded native float heights when validating small terrain edits.",
    inputSchema: {
      resolution: z.number().int().min(16).max(256).optional().describe("Grid resolution per axis (default 64)"),
      raw: z.boolean().optional().describe("Return native float heights instead of the default 0.1m rounding"),
    },
  },
  async ({ resolution, raw }) => {
    const params = new URLSearchParams();
    if (resolution) params.set("resolution", String(resolution));
    if (raw) params.set("raw", "true");
    try {
      return jsonResult(await bridgeJson(`/city/terrain?${params.toString()}`, 30_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_gridmap",
  {
    title: "Get data-layer grid",
    description:
      "The game's native cell-map grids as row-major arrays: landValue, groundPollution, airPollution, " +
      "noisePollution, groundWater, groundWaterPollution. Use to pick good locations (cheap land, clean " +
      "air, water for pumps) like a player reading infoviews.",
    inputSchema: {
      layer: z
        .enum(["landValue", "groundPollution", "airPollution", "noisePollution", "groundWater", "groundWaterPollution"])
        .describe("Which data layer to export"),
    },
  },
  async ({ layer }) => {
    try {
      return jsonResult(await bridgeJson(`/city/gridmap?layer=${layer}`, 30_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_zoning",
  {
    title: "Read current zoning",
    description:
      "Summary of painted zones: cells per zone type with occupied/empty split, whole-city or within a " +
      "radius. Empty zoned cells are where buildings will grow.",
    inputSchema: {
      x: z.number().optional().describe("Center X for area filter"),
      z: z.number().optional().describe("Center Z for area filter"),
      radius: z.number().optional().describe("Radius in meters (with x/z)"),
    },
  },
  async ({ x, z: zCoord, radius }) => {
    const params = new URLSearchParams();
    if (x !== undefined) params.set("x", String(x));
    if (zCoord !== undefined) params.set("z", String(zCoord));
    if (radius !== undefined) params.set("radius", String(radius));
    try {
      return jsonResult(await bridgeJson(`/city/zoning?${params.toString()}`, 20_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_notifications",
  {
    title: "List warning notifications",
    description:
      "All active in-world warning icons (no electricity, no water, garbage piling up, abandoned buildings, " +
      "high rent...) with type counts, locations and target entities. The primary way to discover problems.",
    inputSchema: {
      limit: z.number().int().min(1).max(500).optional().describe("Max detailed items (default 100)"),
    },
  },
  async ({ limit }) => {
    const params = new URLSearchParams();
    if (limit) params.set("limit", String(limit));
    try {
      return jsonResult(await bridgeJson(`/city/notifications?${params.toString()}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_inspect",
  {
    title: "Inspect an entity",
    description:
      "Detail view of one entity (building/road) by index+version: prefab, position, status flags " +
      "(abandoned/condemned/destroyed), renters with citizen/employee counts. Like clicking a building in game.",
    inputSchema: {
      index: z.number().int().describe("Entity index"),
      version: z.number().int().describe("Entity version"),
    },
  },
  async ({ index, version }) => {
    try {
      return jsonResult(await bridgeJson(`/entity/inspect?index=${index}&version=${version}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

registerJsonTool(
  "cs2_get_loan",
  "Get city loan state",
  "Current loan principal, daily interest rate, daily payment and the city's creditworthiness (max borrowable).",
  "/city/loan",
);

server.registerTool(
  "cs2_set_loan",
  {
    title: "Borrow / repay loan",
    description:
      "Set the city's loan principal: higher than current = borrow more (cash added to treasury), " +
      "lower = repay, 0 = repay fully. Clamped to creditworthiness. Interest accrues daily.",
    inputSchema: {
      amount: z.number().int().min(0).describe("New total loan principal"),
    },
  },
  async ({ amount }) => {
    try {
      return jsonResult(await bridgeJson(`/city/loan/set?amount=${amount}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

registerJsonTool(
  "cs2_get_fees",
  "Get service fees",
  "Current price the city charges per service (electricity, water, healthcare, education levels, garbage, " +
    "parking, public transport...) with slider ranges and estimated monthly income per fee.",
  "/city/fees",
);

server.registerTool(
  "cs2_set_fee",
  {
    title: "Set a service fee",
    description:
      "Set the fee/price for one service resource (name from cs2_get_fees). Higher fees raise income " +
      "but reduce usage and citizen happiness.",
    inputSchema: {
      resource: z.string().describe("Resource name from cs2_get_fees, e.g. 'Electricity'"),
      fee: z.number().describe("New fee value"),
    },
  },
  async ({ resource, fee }) => {
    const params = new URLSearchParams({ resource, fee: String(fee) });
    try {
      return jsonResult(await bridgeJson(`/city/fees/set?${params.toString()}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_list_objects",
  {
    title: "List standalone trees/plants",
    description:
      "List standalone trees and plants (not building sub-objects) with entity ids and positions. " +
      "Filter by name or spatially. Use the entity id with cs2_demolish to remove them.",
    inputSchema: {
      query: z.string().optional().describe("Prefab-name substring filter"),
      x: z.number().optional().describe("Center X for spatial filter"),
      z: z.number().optional().describe("Center Z for spatial filter"),
      radius: z.number().optional().describe("Radius meters (default 250 with x/z)"),
      limit: z.number().int().min(1).max(500).optional().describe("Max results (default 100)"),
    },
  },
  async ({ query, x, z: zCoord, radius, limit }) => {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (x !== undefined) params.set("x", String(x));
    if (zCoord !== undefined) params.set("z", String(zCoord));
    if (radius !== undefined) params.set("radius", String(radius));
    if (limit) params.set("limit", String(limit));
    try {
      return jsonResult(await bridgeJson(`/city/objects?${params.toString()}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_run_simulation",
  {
    title: "Run simulation for N in-game hours",
    description:
      "Unpause and run the simulation at the given speed, auto-pausing after the requested number of " +
      "in-game hours. Returns immediately with the target frame; poll cs2_game_state (frameIndex) to " +
      "track progress. Use cancel=true to stop early. The core loop for autonomous mayoring: " +
      "act, run time forward, observe results.",
    inputSchema: {
      hours: z.number().min(0.1).max(96).optional().describe("In-game hours to run (required unless cancel)"),
      speed: z.number().min(0.5).max(8).optional().describe("Simulation speed while running (default 4)"),
      cancel: z.boolean().optional().describe("true to cancel a timed run and pause now"),
    },
  },
  async ({ hours, speed, cancel }) => {
    const params = new URLSearchParams();
    if (cancel) params.set("cancel", "true");
    if (hours !== undefined) params.set("hours", String(hours));
    if (speed !== undefined) params.set("speed", String(speed));
    try {
      return jsonResult(await bridgeJson(`/sim/run?${params.toString()}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_save_game",
  {
    title: "Save the game",
    description:
      "Trigger a manual save (asynchronous). Use before large construction batches as a safety net. " +
      "Default name is timestamped 'CS2MCP ...'.",
    inputSchema: {
      name: z.string().optional().describe("Save name (default: timestamped)"),
    },
  },
  async ({ name }) => {
    const params = new URLSearchParams();
    if (name) params.set("name", name);
    try {
      return jsonResult(await bridgeJson(`/game/save?${params.toString()}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_list_saves",
  {
    title: "List native game saves",
    description:
      "Read the game's native SaveInfo catalog with stable save ids, exact display names, city/map metadata, population, " +
      "simulation date and modification time. Use the returned id for an unambiguous load or rollback request.",
    inputSchema: {
      query: z.string().optional().describe("case-insensitive substring matched against save id, display name or city name"),
      includeAuto: z.boolean().optional().describe("include autosaves (default true)"),
      page: z.number().int().min(0).optional().describe("zero-based result page"),
      pageSize: z.number().int().min(1).max(200).optional().describe("rows per page (default 100)"),
    },
  },
  async ({ query: searchQuery, includeAuto, page, pageSize }) => {
    const params = new URLSearchParams();
    if (searchQuery) params.set("query", searchQuery);
    if (includeAuto !== undefined) params.set("includeAuto", String(includeAuto));
    if (page !== undefined) params.set("page", String(page));
    if (pageSize !== undefined) params.set("pageSize", String(pageSize));
    try {
      return jsonResult(await bridgeJson(`/game/saves?${params.toString()}`, 20_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_load_save",
  {
    title: "Load a native game save",
    description:
      "Queue the game's native MenuUISystem load pipeline for an exact save id or exact display name. " +
      "This is a real state-changing operation: poll cs2_ping and cs2_game_state until isLoading=false and cityLoaded=true.",
    inputSchema: {
      saveId: z.string().optional().describe("exact native SaveInfo.id from cs2_list_saves"),
      name: z.string().optional().describe("exact SaveInfo.displayName; use saveId when names could be ambiguous"),
      dismiss: z.boolean().optional().describe("dismiss the menu while loading (default true)"),
    },
  },
  async ({ saveId, name, dismiss }) => {
    if (!saveId && !name) return errorResult(new Error("provide saveId or exact name"));
    const params = new URLSearchParams();
    if (saveId) params.set("saveId", saveId);
    if (name) params.set("name", name);
    if (dismiss !== undefined) params.set("dismiss", String(dismiss));
    try {
      return jsonResult(await bridgeJson(`/game/load?${params.toString()}`, 30_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_rollback_save",
  {
    title: "Rollback to a named save",
    description:
      "Load a previously created native save checkpoint through the same verified game load pipeline. " +
      "Use this after a failed autonomous cycle or a destructive experiment; the operation is queued and must be verified with cs2_game_state.",
    inputSchema: {
      saveId: z.string().optional().describe("exact native SaveInfo.id from cs2_list_saves"),
      name: z.string().optional().describe("exact checkpoint display name"),
    },
  },
  async ({ saveId, name }) => {
    if (!saveId && !name) return errorResult(new Error("provide saveId or exact checkpoint name"));
    const params = new URLSearchParams();
    if (saveId) params.set("saveId", saveId);
    if (name) params.set("name", name);
    try {
      return jsonResult(await bridgeJson(`/game/rollback?${params.toString()}`, 30_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

registerJsonTool(
  "cs2_tiles_info",
  "Get map tile info",
  "Owned/total map tiles, paged runtime tile descriptors, purchase availability and upkeep settings. Tile purchase uses the native selection/economy path when the live capability is enabled.",
  "/city/tiles",
);

registerJsonTool(
  "cs2_list_districts",
  "List districts",
  "All districts with entity id, center position, polygon size and active policy count.",
  "/districts",
);

server.registerTool(
  "cs2_create_district",
  {
    title: "Create a district",
    description:
      "Draw a district over an area by polygon corners (3-32 points, world meters). Buildings and roads " +
      "inside get assigned to it; district policies can then be applied to just that area. By default the " +
      "native district definition is executed and the new district is verified through /districts. Set " +
      "execute=false or dryRun=true for a non-mutating preview.",
    inputSchema: {
      nodes: z.string().describe("Polygon corners 'x1,z1;x2,z2;x3,z3;...' (counter-clockwise)"),
      prefab: z.string().optional().describe("District prefab name (default: the standard district)"),
      execute: z.boolean().optional().describe("Execute by default; set false for a native construction preview"),
      dryRun: z.boolean().optional().describe("Alias for execute=false"),
    },
  },
  async ({ nodes, prefab, execute, dryRun }) => {
    try {
      const polygon = parsePolygonNodes(nodes);
      const target = polygon.reduce((sum, value) => ({ x: sum.x + value.x, z: sum.z + value.z }), { x: 0, z: 0 });
      target.x /= polygon.length;
      target.z /= polygon.length;
      const plan = {
        kind: "district-build",
        polygon,
        prefab: prefab ?? null,
        nativePath: "/build/district -> CreationDefinition + Areas.Node -> native district apply",
      };
      if (dryRun === true || execute === false) {
        return jsonResult({ success: true, dryRun: true, executed: false, plan, target });
      }
      return jsonResult({
        ...await executeVerifiedDistrict(polygon, `CS2MCP district ${target.x.toFixed(1)},${target.z.toFixed(1)}`, prefab),
        dryRun: false,
        executed: true,
        plan,
        target,
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_district_policies",
  {
    title: "List district policies",
    description:
      "Policies available for one district (speed limits, parking fees, combustion ban...) with " +
      "active/locked state. District from cs2_list_districts.",
    inputSchema: {
      index: z.number().int().describe("District entity index"),
      version: z.number().int().describe("District entity version"),
    },
  },
  async ({ index, version }) => {
    try {
      return jsonResult(await bridgeJson(`/district/policies?index=${index}&version=${version}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_set_district_policy",
  {
    title: "Toggle a district policy",
    description: "Activate/deactivate a policy on one district (policy name from cs2_district_policies).",
    inputSchema: {
      index: z.number().int().describe("District entity index"),
      version: z.number().int().describe("District entity version"),
      name: z.string().describe("Policy internal name"),
      active: z.boolean().describe("true to activate"),
      adjustment: z.number().optional().describe("Slider value for slider policies"),
    },
  },
  async ({ index, version, name, active, adjustment }) => {
    const params = new URLSearchParams({
      index: String(index),
      version: String(version),
      name,
      active: String(active),
    });
    if (adjustment !== undefined) params.set("adjustment", String(adjustment));
    try {
      return jsonResult(await bridgeJson(`/district/policies/set?${params.toString()}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

registerAutonomyTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`cs2-mcp 0.9.0 running on stdio (bridge: ${BRIDGE_URL})`);
