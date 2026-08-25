import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  asTerrainSnapshot,
  Bounds,
  GeometryKind,
  InterchangePlan,
  makeInterchangePlan,
  makeMetropolisPlan,
  makeRoadPlan,
  parseBounds,
  PlanIssue,
  point,
  RoadAnchor,
  RoadPlan,
  summarizeTerrain,
  TerrainSnapshot,
  WorldPoint,
} from "./geometry.js";

const BRIDGE_URL = (process.env.CS2_BRIDGE_URL ?? "http://127.0.0.1:8642").replace(/\/+$/, "");

class BridgeCallError extends Error {
  readonly status?: number;
  readonly payload?: unknown;

  constructor(message: string, status?: number, payload?: unknown) {
    super(message);
    this.name = "BridgeCallError";
    this.status = status;
    this.payload = payload;
  }
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function jsonResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const bridgeError = error instanceof BridgeCallError ? error : undefined;
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        success: false,
        noSuccess: true,
        error: {
          message,
          status: bridgeError?.status ?? null,
          payload: bridgeError?.payload ?? null,
        },
        recommendedAction: "inspect the structured error and live capability/state response before retrying; no mutation success is implied",
      }, null, 2),
    }],
    isError: true,
  };
}

async function bridgeFetch(path: string, timeoutMs = 12_000): Promise<Response> {
  try {
    return await fetch(`${BRIDGE_URL}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new BridgeCallError(
      `Cannot reach the CS2 bridge at ${BRIDGE_URL} (${error instanceof Error ? error.message : String(error)}). ` +
        "Start Cities: Skylines II, load a city, and confirm that the CS2MCP mod is enabled.",
    );
  }
}

async function bridgeJson<T = unknown>(path: string, timeoutMs = 12_000): Promise<T> {
  const response = await bridgeFetch(path, timeoutMs);
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const record = asRecord(payload);
    throw new BridgeCallError(
      asString(record?.error) ?? `bridge returned HTTP ${response.status}`,
      response.status,
      payload,
    );
  }
  return payload as T;
}

async function bestEffort(path: string, timeoutMs = 12_000): Promise<{ ok: true; value: unknown } | { ok: false; error: string; status?: number }> {
  try {
    return { ok: true, value: await bridgeJson(path, timeoutMs) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      status: error instanceof BridgeCallError ? error.status : undefined,
    };
  }
}

function query(parameters: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const result = search.toString();
  return result ? `?${result}` : "";
}

function capability(payload: unknown, name: string): boolean {
  const root = asRecord(payload);
  const capabilities = asRecord(root?.capabilities);
  return capabilities?.[name] === true;
}

function capabilityMap(payload: unknown): JsonRecord {
  const root = asRecord(payload);
  return asRecord(root?.capabilities) ?? {};
}

function requireRecord(value: unknown, name: string): JsonRecord {
  const result = asRecord(value);
  if (!result) throw new Error(`${name} must be a JSON object`);
  return result;
}

function arrayPoints(value: unknown): WorldPoint[] {
  return asArray(value).map((entry) => point(entry));
}

function positionOf(value: unknown): WorldPoint | undefined {
  const record = asRecord(value);
  const position = record?.position;
  if (asRecord(position)) return point(position);
  if (typeof record?.x === "number" && typeof record?.z === "number") return point(record);
  return undefined;
}

function inside(pointValue: WorldPoint, bounds: Bounds): boolean {
  return pointValue.x >= bounds.minX && pointValue.x <= bounds.maxX && pointValue.z >= bounds.minZ && pointValue.z <= bounds.maxZ;
}

function roadTouchesBounds(value: unknown, bounds: Bounds): boolean {
  const record = asRecord(value);
  const start = positionOf(record?.start);
  const end = positionOf(record?.end);
  return Boolean((start && inside(start, bounds)) || (end && inside(end, bounds)));
}

function roadDesignSlope(designLevel: string | undefined): number {
  switch (designLevel) {
    case "highway":
    case "expressway":
      return 0.06;
    case "arterial":
      return 0.08;
    case "collector":
      return 0.1;
    default:
      return 0.12;
  }
}

function validPrefab(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const name = asString(record.name);
  if (!name || record.locked === true || record.available === false) return undefined;
  return name;
}

async function discoverPrefab(category: "road" | "tree" | "building" | "transport" | "prop" | "surface", search?: string): Promise<{ name: string; discovery: unknown; selection: string }> {
  const payload = await bridgeJson<JsonRecord>(`/prefabs${query({ category, query: search, page: 0, pageSize: 200 })}`, 20_000);
  const candidates = asArray(payload.prefabs);
  const selected = candidates.map(validPrefab).find((name): name is string => Boolean(name));
  if (!selected) {
    throw new BridgeCallError(
      `No unlocked ${category} prefab was discovered${search ? ` for query '${search}'` : ""}. ` +
        "Call cs2_discover_assets with a broader query and select an exact runtime name.",
      404,
      payload,
    );
  }
  return { name: selected, discovery: payload, selection: "runtime discovery query; native validation remains authoritative" };
}

function roadQueryForRole(role: string | undefined): string | undefined {
  if (!role) return undefined;
  const lower = role.toLowerCase();
  if (lower.includes("highway") || lower.includes("expressway")) return "highway";
  if (lower.includes("track") || lower.includes("rail")) return "track";
  return undefined;
}

async function selectRoadPrefab(explicit: string | undefined, role?: string): Promise<{ name: string; discovery?: unknown; selection: string }> {
  if (explicit) return { name: explicit, selection: "caller-selected exact runtime prefab" };
  const preferred = await discoverPrefab("road", roadQueryForRole(role));
  return { name: preferred.name, discovery: preferred.discovery, selection: "runtime discovery query; native validation remains authoritative" };
}

async function selectTransportPrefab(explicit: string | undefined, mode: string): Promise<{ name?: string; discovery: unknown; selection: string }> {
  if (explicit) return { name: explicit, discovery: undefined, selection: "caller-selected exact runtime transport prefab" };
  const payload = await bridgeJson<JsonRecord>(`/transport/prefabs${query({ limit: 200 })}`, 20_000);
  const candidates = asArray(payload.prefabs);
  const normalized = mode.toLowerCase();
  const selected = candidates.find((candidate) => {
    const record = asRecord(candidate);
    return validPrefab(record) !== undefined && asString(record?.transportType)?.toLowerCase() === normalized;
  }) ?? candidates.find((candidate) => validPrefab(candidate) !== undefined);
  const name = validPrefab(selected);
  if (!name) {
    throw new BridgeCallError(`No unlocked runtime transport prefab was discovered for mode '${mode}'.`, 404, payload);
  }
  return { name, discovery: payload, selection: "runtime transport prefab discovery; native route validation remains authoritative" };
}

async function selectTrackPrefab(explicit: string | undefined, mode: string): Promise<{ name: string; discovery?: unknown; selection: string }> {
  if (explicit) return { name: explicit, selection: "caller-selected exact runtime TrackPrefab" };

  const discovery = await bridgeJson<JsonRecord>(`/prefabs${query({ category: "net", query: "Track", page: 0, pageSize: 200 })}`, 20_000);
  const candidates = asArray(discovery.prefabs)
    .map(asRecord)
    .filter((candidate): candidate is JsonRecord => Boolean(candidate))
    .filter((candidate) => validPrefab(candidate) !== undefined && asString(candidate.type) === "TrackPrefab");
  const normalized = mode.toLowerCase();
  const modeCandidates = candidates.filter((candidate) => asString(candidate.name)?.toLowerCase().includes(`${normalized} track`));
  const selected = (modeCandidates.length > 0 ? modeCandidates : candidates)
    .find((candidate) => {
      const name = asString(candidate.name)?.toLowerCase() ?? "";
      return !name.includes("station side") && !name.includes("station middle") && !name.includes("bridge");
    }) ?? (modeCandidates[0] ?? candidates[0]);
  const name = validPrefab(selected);
  if (!name) {
    throw new BridgeCallError(`No unlocked runtime TrackPrefab was discovered for mode '${mode}'.`, 404, discovery);
  }
  return { name, discovery, selection: "runtime net-prefab discovery filtered by TrackPrefab and mode; native validation remains authoritative" };
}

async function selectFacilityPrefab(
  explicit: string | undefined,
  kind: "station" | "depot",
  mode: string,
): Promise<{ name: string; discovery?: unknown; selection: string }> {
  if (explicit) return { name: explicit, selection: "caller-selected exact runtime building prefab" };

  const queryText = kind === "station" ? "Station" : "Depot";
  let discovery = await bridgeJson<JsonRecord>(`/prefabs${query({ category: "building", query: queryText, page: 0, pageSize: 200 })}`, 20_000);
  const collectCandidates = (payload: JsonRecord): JsonRecord[] => asArray(payload.prefabs)
    .map(asRecord)
    .filter((candidate): candidate is JsonRecord => Boolean(candidate))
    .filter((candidate) => validPrefab(candidate) !== undefined && asString(candidate.type) === "BuildingPrefab")
    .filter((candidate) => {
      const name = asString(candidate.name)?.toLowerCase() ?? "";
      return !name.includes("extra")
        && !name.includes("upgrade")
        && !name.includes("services")
        && !name.includes("maintenance")
        && !name.includes("garage")
        && !name.includes("dispatch")
        && !name.includes("hall")
        && !name.includes("crane");
    });
  let candidates = collectCandidates(discovery);
  const normalized = mode.toLowerCase();
  const modeTerms: Record<string, string[]> = {
    bus: ["bus"],
    tram: ["tram"],
    subway: ["subway", "metro"],
    train: ["train"],
    ship: ["harbor", "harbour", "port", "ship"],
    ferry: ["ferry", "harbor", "harbour"],
    air: ["airport", "air"],
    cargo: ["cargo", "freight", "harbor", "harbour"],
  };
  const terms = modeTerms[normalized] ?? [normalized];
  let modeCandidates = candidates.filter((candidate) => {
    const name = asString(candidate.name)?.toLowerCase() ?? "";
    return terms.some((term) => name.includes(term));
  });
  if (modeCandidates.length === 0 && kind === "depot" && normalized === "subway") {
    const yardDiscovery = await bridgeJson<JsonRecord>(`/prefabs${query({ category: "building", query: "Yard", page: 0, pageSize: 200 })}`, 20_000);
    candidates = [...candidates, ...collectCandidates(yardDiscovery)];
    modeCandidates = candidates.filter((candidate) => {
      const name = asString(candidate.name)?.toLowerCase() ?? "";
      return terms.some((term) => name.includes(term));
    });
    discovery = { ...discovery, fallback: yardDiscovery };
  }
  const selected = (modeCandidates.length > 0 ? modeCandidates : candidates)[0];
  const name = validPrefab(selected);
  if (!name) {
    throw new BridgeCallError(`No unlocked runtime ${mode} ${kind} prefab was discovered.`, 404, discovery);
  }
  return { name, discovery, selection: `runtime building-prefab discovery filtered for ${mode} ${kind}; native validation remains authoritative` };
}

function roadQueryPath(
  prefab: string,
  segment: { start: WorldPoint; end: WorldPoint; control?: WorldPoint; level?: number; startAnchor?: RoadAnchor; endAnchor?: RoadAnchor },
  force = false,
): string {
  return `/build/road${query({
    prefab,
    x1: segment.start.x,
    z1: segment.start.z,
    x2: segment.end.x,
    z2: segment.end.z,
    cx: segment.control?.x,
    cz: segment.control?.z,
    e1: segment.start.y,
    e2: segment.end.y,
    startEntityIndex: segment.startAnchor?.entity.index,
    startEntityVersion: segment.startAnchor?.entity.version,
    startCurvePosition: segment.startAnchor?.curvePosition,
    endEntityIndex: segment.endAnchor?.entity.index,
    endEntityVersion: segment.endAnchor?.entity.version,
    endCurvePosition: segment.endAnchor?.curvePosition,
    force: force || undefined,
  })}`;
}

function networkSegmentMatches(value: JsonRecord | undefined, prefab: string, start: WorldPoint, end: WorldPoint, tolerance = 1.5): boolean {
  if (!value || asString(value.prefab)?.toLowerCase() !== prefab.toLowerCase()) return false;
  const actualStart = positionOf(value.start);
  const actualEnd = positionOf(value.end);
  if (!actualStart || !actualEnd) return false;
  const direct = Math.abs(actualStart.x - start.x) <= tolerance
    && Math.abs(actualStart.z - start.z) <= tolerance
    && Math.abs(actualEnd.x - end.x) <= tolerance
    && Math.abs(actualEnd.z - end.z) <= tolerance;
  const reverse = Math.abs(actualStart.x - end.x) <= tolerance
    && Math.abs(actualStart.z - end.z) <= tolerance
    && Math.abs(actualEnd.x - start.x) <= tolerance
    && Math.abs(actualEnd.z - start.z) <= tolerance;
  if (direct || reverse) return true;

  // Native network construction can extend a requested segment to an existing
  // node, then report the snapped segment instead of the exact requested end.
  // Accept that readback only when both requested endpoints lie on the same
  // short native segment, one native endpoint is close to a requested endpoint,
  // and the length delta is bounded.
  const pointSegmentDistance = (pointValue: WorldPoint, segmentStart: WorldPoint, segmentEnd: WorldPoint): number => {
    const dx = segmentEnd.x - segmentStart.x;
    const dz = segmentEnd.z - segmentStart.z;
    const lengthSquared = dx * dx + dz * dz;
    const t = lengthSquared <= 1e-9 ? 0 : Math.max(0, Math.min(1, ((pointValue.x - segmentStart.x) * dx + (pointValue.z - segmentStart.z) * dz) / lengthSquared));
    const projected = { x: segmentStart.x + t * dx, z: segmentStart.z + t * dz };
    return Math.hypot(pointValue.x - projected.x, pointValue.z - projected.z);
  };
  const requestLength = Math.hypot(end.x - start.x, end.z - start.z);
  const actualLength = Math.hypot(actualEnd.x - actualStart.x, actualEnd.z - actualStart.z);
  const snapTolerance = 16;
  const endpointSnap = Math.min(
    Math.hypot(actualStart.x - start.x, actualStart.z - start.z),
    Math.hypot(actualStart.x - end.x, actualStart.z - end.z),
    Math.hypot(actualEnd.x - start.x, actualEnd.z - start.z),
    Math.hypot(actualEnd.x - end.x, actualEnd.z - end.z),
  ) <= tolerance + 0.5;
  const endpointsOnSegment = pointSegmentDistance(start, actualStart, actualEnd) <= snapTolerance
    && pointSegmentDistance(end, actualStart, actualEnd) <= snapTolerance;
  return endpointSnap && endpointsOnSegment && Math.abs(actualLength - requestLength) <= snapTolerance;
}

/**
 * The native network tool is allowed to split one requested course at an
 * intersection or at a snapped node.  A single requested segment can
 * therefore be read back as two or more contiguous ECS edges.  Keep exact
 * matching for the fast path, but also recognise a complete same-prefab
 * chain so verification does not confuse a valid native construction with a
 * missing road.
 */
function networkSegmentChainMatches(
  rows: JsonRecord[],
  prefab: string,
  start: WorldPoint,
  end: WorldPoint,
  tolerance = 18,
): JsonRecord[] | undefined {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const length = Math.hypot(dx, dz);
  if (length < 8) return undefined;
  const ux = dx / length;
  const uz = dz / length;
  const normalX = -uz;
  const normalZ = ux;
  const candidates = rows
    .map((row) => {
      if (asString(row.prefab)?.toLowerCase() !== prefab.toLowerCase()) return undefined;
      const rowStart = positionOf(row.start);
      const rowEnd = positionOf(row.end);
      if (!rowStart || !rowEnd) return undefined;
      const startProjection = (rowStart.x - start.x) * ux + (rowStart.z - start.z) * uz;
      const endProjection = (rowEnd.x - start.x) * ux + (rowEnd.z - start.z) * uz;
      const startOffset = Math.abs((rowStart.x - start.x) * normalX + (rowStart.z - start.z) * normalZ);
      const endOffset = Math.abs((rowEnd.x - start.x) * normalX + (rowEnd.z - start.z) * normalZ);
      if (startOffset > tolerance || endOffset > tolerance) return undefined;
      const low = Math.min(startProjection, endProjection);
      const high = Math.max(startProjection, endProjection);
      if (high < -tolerance || low > length + tolerance || high - low < 1) return undefined;
      return { row, low, high };
    })
    .filter((value): value is { row: JsonRecord; low: number; high: number } => Boolean(value))
    .sort((a, b) => a.low - b.low || a.high - b.high);
  if (candidates.length === 0) return undefined;

  const gapTolerance = Math.max(8, Math.min(24, tolerance));
  let covered = 0;
  const selected: JsonRecord[] = [];
  for (const candidate of candidates) {
    if (candidate.high < covered - gapTolerance) continue;
    if (candidate.low > covered + gapTolerance) break;
    selected.push(candidate.row);
    covered = Math.max(covered, candidate.high);
    if (covered >= length - gapTolerance) return selected;
  }
  return undefined;
}

async function pollNetworkSegment(
  prefab: string,
  start: WorldPoint,
  end: WorldPoint,
  beforeKeys: Set<string>,
  attempts = 24,
): Promise<{ segment?: JsonRecord; segments?: JsonRecord[]; payload?: JsonRecord; attempts: number }> {
  const center = { x: (start.x + end.x) / 2, z: (start.z + end.z) / 2 };
  let latest: JsonRecord | undefined;
  let latestSegment: JsonRecord | undefined;
  let latestSegments: JsonRecord[] | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    latest = await bridgeJson<JsonRecord>(`/city/roads${query({ query: prefab, x: center.x, z: center.z, radius: Math.max(120, Math.hypot(end.x - start.x, end.z - start.z) + 80), limit: 500 })}`, 20_000);
    const rows = extractRows(latest, "roads").map(asRecord).filter((value): value is JsonRecord => Boolean(value));
    latestSegment = rows.find((row) => networkSegmentMatches(row, prefab, start, end)
      && (() => {
        const key = rowEntityKey(row);
        return key !== undefined && !beforeKeys.has(key);
      })());
    latestSegments = networkSegmentChainMatches(rows, prefab, start, end);
    const newChain = latestSegments?.filter((row) => {
      const key = rowEntityKey(row);
      return key !== undefined && !beforeKeys.has(key);
    });
    if (!latestSegment && (!newChain || newChain.length === 0)) latestSegments = undefined;
    if (latestSegment || latestSegments) {
      const matched = latestSegments ?? [latestSegment as JsonRecord];
      return { segment: latestSegment ?? matched[0], segments: matched, payload: latest, attempts: attempt };
    }
  }
  return { segment: latestSegment, segments: latestSegments, payload: latest, attempts };
}

async function executeRoadPlan(plan: RoadPlan, prefab: string, force = false): Promise<JsonRecord[]> {
  const results: JsonRecord[] = [];
  for (const [index, segment] of plan.segments.entries()) {
    const payload = await bridgeJson(roadQueryPath(prefab, segment, force), 20_000);
    results.push({ segment: index, result: payload });
  }
  return results;
}

function geometryIssues(plan: RoadPlan | InterchangePlan): PlanIssue[] {
  if (plan.kind === "road-plan") return plan.issues;
  return plan.conflicts;
}

function issueCounts(issues: PlanIssue[]) {
  return {
    errors: issues.filter((issue) => issue.severity === "error").length,
    warnings: issues.filter((issue) => issue.severity === "warning").length,
    infos: issues.filter((issue) => issue.severity === "info").length,
  };
}

function districtPolygon(center: WorldPoint, width: number, depth: number, rotationDegrees: number): WorldPoint[] {
  const angle = (rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [-1, 1, 1, -1].map((corner, index) => {
    const localX = corner * width * 0.5;
    const localZ = (index < 2 ? -1 : 1) * depth * 0.5;
    return { x: center.x + localX * cos - localZ * sin, z: center.z + localX * sin + localZ * cos };
  });
}

function districtQueryPath(nodes: WorldPoint[], prefab?: string): string {
  const encoded = nodes.map((node) => `${node.x},${node.z}`).join(";");
  return `/build/district${query({ nodes: encoded, prefab })}`;
}

function terrainPayloadFrom(value: unknown): TerrainSnapshot | undefined {
  return asTerrainSnapshot(value);
}

async function readTerrain(resolution = 64): Promise<{ raw: unknown; snapshot: TerrainSnapshot }> {
  const raw = await bridgeJson(`/city/terrain${query({ resolution })}`, 30_000);
  const snapshot = terrainPayloadFrom(raw);
  if (!snapshot) throw new Error("bridge returned terrain without a valid height/water grid");
  return { raw, snapshot };
}

async function captureScreenshot(width = 1280): Promise<boolean> {
  const response = await bridgeFetch(`/screenshot${query({ width })}`, 30_000);
  if (!response.ok) return false;
  await response.arrayBuffer();
  return true;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function entityKey(value: unknown): string | undefined {
  const entity = asRecord(value);
  return typeof entity?.index === "number" && typeof entity.version === "number" ? `${entity.index}:${entity.version}` : undefined;
}

function rowEntityKey(value: unknown): string | undefined {
  const row = asRecord(value);
  return entityKey(row?.entity) ?? entityKey(row);
}

function entityKeys(payload: unknown, key: string): Set<string> {
  return new Set(extractRows(payload, key).map(rowEntityKey).filter((value): value is string => Boolean(value)));
}

function centerOf(value: unknown): WorldPoint | undefined {
  const record = asRecord(value);
  return positionOf(record) ?? positionOf(record?.center) ?? positionOf(record?.centre) ?? positionOf(record?.position);
}

function numberField(value: unknown, key: string): number | undefined {
  const record = asRecord(value);
  return typeof record?.[key] === "number" && Number.isFinite(record[key]) ? record[key] as number : undefined;
}

function numericGridSummary(value: unknown): JsonRecord {
  const record = asRecord(value);
  const values = asArray(record?.values).filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry));
  if (values.length === 0) return { status: "observed", samples: 0, note: "native grid returned no numeric samples" };
  const total = values.reduce((sum, entry) => sum + entry, 0);
  return { status: "observed", samples: values.length, min: Math.min(...values), max: Math.max(...values), mean: total / values.length, positiveSamples: values.filter((entry) => entry > 0).length };
}

function boundedPoints(bounds: Bounds, spacing: number, jitter: number, maximum: number): WorldPoint[] {
  const result: WorldPoint[] = [];
  const safeSpacing = Math.max(8, spacing);
  let row = 0;
  for (let z = bounds.minZ + safeSpacing / 2; z <= bounds.maxZ && result.length < maximum; z += safeSpacing) {
    let col = 0;
    for (let x = bounds.minX + safeSpacing / 2; x <= bounds.maxX && result.length < maximum; x += safeSpacing) {
      const candidate = {
        x: x + Math.sin(row * 12.9898 + col * 78.233) * jitter,
        z: z + Math.cos(row * 39.3467 + col * 11.135) * jitter,
      };
      if (inside(candidate, bounds)) result.push(candidate);
      col++;
    }
    row++;
  }
  return result;
}

function rectangleAround(center: WorldPoint, width: number, depth: number, rotation = 0): WorldPoint[] {
  const angle = (rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [-1, 1, 1, -1].map((corner, index) => {
    const localX = corner * width * 0.5;
    const localZ = (index < 2 ? -1 : 1) * depth * 0.5;
    return { x: center.x + localX * cos - localZ * sin, z: center.z + localX * sin + localZ * cos };
  });
}

async function readCitySnapshot(roadLimit = 500, terrainResolution = 32): Promise<JsonRecord> {
  const requests: Record<string, Promise<{ ok: true; value: unknown } | { ok: false; error: string; status?: number }>> = {
    state: bestEffort("/state"),
    overview: bestEffort("/city/overview"),
    demand: bestEffort("/city/demand"),
    budget: bestEffort("/city/budget"),
    services: bestEffort("/city/services"),
    serviceBudgets: bestEffort("/city/service-budgets"),
    labor: bestEffort("/city/labor"),
    zoning: bestEffort("/city/zoning"),
    notifications: bestEffort("/city/notifications"),
    roads: bestEffort(`/city/roads${query({ limit: roadLimit })}`),
    buildings: bestEffort(`/city/buildings${query({ limit: roadLimit })}`),
    terrain: bestEffort(`/city/terrain${query({ resolution: terrainResolution })}`, 30_000),
    capabilities: bestEffort("/capabilities", 5_000),
  };
  const entries = await Promise.all(Object.entries(requests).map(async ([key, task]) => [key, await task] as const));
  const snapshot: JsonRecord = {};
  for (const [key, result] of entries) snapshot[key] = result.ok ? { status: "observed", data: result.value } : { status: "unavailable", error: result.error, httpStatus: result.status };
  return snapshot;
}

async function saveCheckpoint(label: string): Promise<JsonRecord> {
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 36);
  const saveName = `CS2MCP autonomous ${safeLabel} ${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const result = await bestEffort(`/game/save${query({ name: saveName })}`, 30_000);
  if (result.ok) await delay(6000);
  return { label, name: saveName, result };
}

async function rollbackCheckpoint(checkpoint: JsonRecord | undefined): Promise<JsonRecord> {
  const name = asString(checkpoint?.name);
  if (!name) {
    return {
      available: true,
      requested: false,
      success: false,
      reason: "no successful preflight checkpoint name was available",
    };
  }

  const load = await bestEffort(`/game/rollback${query({ name })}`, 30_000);
  if (!load.ok) {
    return { available: true, requested: true, success: false, checkpoint: name, load: load.error };
  }

  const observations: JsonRecord[] = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    await delay(1000);
    const stateResult = await bestEffort("/state", 5_000);
    if (!stateResult.ok) {
      observations.push({ attempt: attempt + 1, status: "bridge-unavailable", error: stateResult.error });
      continue;
    }
    const state = asRecord(stateResult.value);
    observations.push({
      attempt: attempt + 1,
      gameMode: state?.gameMode ?? null,
      isLoading: state?.isLoading ?? null,
      cityLoaded: state?.cityLoaded ?? null,
      cityName: state?.cityName ?? null,
    });
    if (state?.cityLoaded === true && state?.isLoading === false) {
      return {
        available: true,
        requested: true,
        success: true,
        checkpoint: name,
        load: load.value,
        verification: { status: "loaded", attempts: attempt + 1, state: stateResult.value },
        observations,
      };
    }
  }
  return {
    available: true,
    requested: true,
    success: false,
    checkpoint: name,
    load: load.value,
    verification: { status: "timeout", attempts: observations.length },
    observations,
  };
}

export async function executeVerifiedRoadPlan(
  plan: RoadPlan,
  prefab: string,
  force = false,
  maximumSegments = plan.segments.length,
): Promise<JsonRecord> {
  const results: JsonRecord[] = [];
  const segments = plan.segments.slice(0, maximumSegments);
  for (const [index, segment] of segments.entries()) {
    const center = { x: (segment.start.x + segment.end.x) / 2, z: (segment.start.z + segment.end.z) / 2 };
    const beforeResult = await bestEffort(`/city/roads${query({ query: prefab, x: center.x, z: center.z, radius: Math.max(120, Math.hypot(segment.end.x - segment.start.x, segment.end.z - segment.start.z) + 80), limit: 500 })}`, 20_000);
    const beforeKeys = beforeResult.ok ? entityKeys(beforeResult.value, "roads") : new Set<string>();
    const beforeRows = beforeResult.ok
      ? extractRows(beforeResult.value, "roads").map(asRecord).filter((value): value is JsonRecord => Boolean(value))
      : [];
    const alreadyPresent = beforeRows.find((row) => networkSegmentMatches(row, prefab, segment.start, segment.end));
    const alreadyPresentChain = alreadyPresent
      ? [alreadyPresent]
      : networkSegmentChainMatches(beforeRows, prefab, segment.start, segment.end);
    if (alreadyPresent || alreadyPresentChain) {
      const matchedRows = alreadyPresentChain ?? [alreadyPresent as JsonRecord];
      results.push({
        segment: index,
        nativeRequest: null,
        verification: { status: matchedRows.length > 1 ? "already-present-chain" : "already-present", attempts: 0, endpointMatches: true, entity: asRecord(matchedRows[0].entity) ?? null, matchedSegments: matchedRows.length },
        readback: matchedRows[0],
        readbackSegments: matchedRows,
      });
      continue;
    }
    let nativeRequest: unknown;
    try {
      nativeRequest = await bridgeJson(roadQueryPath(prefab, segment, force), 20_000);
    } catch (error) {
      results.push({ segment: index, nativeRequest: null, verification: { status: "native-request-error", endpointMatches: false }, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const verification = await pollNetworkSegment(prefab, segment.start, segment.end, beforeKeys, 12);
    const record: JsonRecord = {
      segment: index,
      nativeRequest,
      verification: {
        status: verification.segment ? (verification.segments && verification.segments.length > 1 ? "readback-chain" : "readback") : "missing-after-queue",
        attempts: verification.attempts,
        endpointMatches: Boolean(verification.segment),
        entity: verification.segment ? asRecord(verification.segment.entity) ?? null : null,
        matchedSegments: verification.segments?.length ?? (verification.segment ? 1 : 0),
      },
      readback: verification.segment ?? null,
      readbackSegments: verification.segments ?? (verification.segment ? [verification.segment] : []),
    };
    results.push(record);
  }
  const verifiedSegments = results.filter((entry) => asRecord(entry.verification)?.endpointMatches === true).length;
  return {
    success: verifiedSegments === segments.length && segments.length > 0,
    prefab,
    expectedSegments: segments.length,
    verifiedSegments,
    results,
    partial: verifiedSegments !== segments.length,
  };
}

const ROAD_UPGRADE_FLAGS: Record<string, { general?: string; side?: string }> = {
  grass: { side: "PrimaryBeautification" },
  trees: { side: "SecondaryBeautification" },
  wideSidewalk: { side: "WideSidewalk" },
  soundBarrier: { side: "SoundBarrier" },
  parking: { side: "ParkingSpaces" },
  lighting: { general: "Lighting" },
  medianGrass: { general: "PrimaryMiddleBeautification" },
  medianTrees: { general: "SecondaryMiddleBeautification" },
};

function hasCompositionFlag(value: unknown, expected: string): boolean {
  if (typeof value !== "string") return false;
  return value.toLowerCase().split(/[,|\s]+/).includes(expected.toLowerCase());
}

function roadUpgradeMatches(
  row: JsonRecord,
  requested: string[],
  side: "both" | "left" | "right",
): boolean {
  const upgrades = asRecord(row.upgrades);
  if (!upgrades) return false;
  return requested.every((name) => {
    const expected = ROAD_UPGRADE_FLAGS[name];
    if (!expected) return false;
    if (expected.general) return hasCompositionFlag(upgrades.general, expected.general);
    const sides = side === "both" ? ["left", "right"] : [side];
    return Boolean(expected.side) && sides.every((key) => hasCompositionFlag(upgrades[key], expected.side as string));
  });
}

export async function executeVerifiedRoadUpgrade(
  index: number,
  version: number,
  upgradesRaw: string,
  side: "both" | "left" | "right" = "both",
): Promise<JsonRecord> {
  const requested = upgradesRaw.split(",").map((value) => value.trim()).filter(Boolean);
  const unknown = requested.filter((name) => !ROAD_UPGRADE_FLAGS[name]);
  if (requested.length === 0 || unknown.length > 0) {
    return {
      success: false,
      noSuccess: true,
      verification: { status: "invalid-request", endpointMatches: false },
      error: unknown.length > 0 ? `unknown road upgrade(s): ${unknown.join(", ")}` : "at least one road upgrade is required",
    };
  }

  const target = await bridgeJson<JsonRecord>(`/entity/inspect${query({ index, version })}`, 20_000);
  const network = asRecord(target.network);
  const start = positionOf(network?.start);
  const end = positionOf(network?.end);
  const prefab = asString(target.prefab);
  if (!start || !end || !prefab) {
    return {
      success: false,
      noSuccess: true,
      verification: { status: "preflight-missing-network", endpointMatches: false },
      entity: { index, version },
      preflight: target,
      note: "no success claim: the target did not expose a live road prefab and curve before the upgrade",
    };
  }

  const center = { x: (start.x + end.x) / 2, z: (start.z + end.z) / 2 };
  const radius = Math.max(120, Math.hypot(end.x - start.x, end.z - start.z) + 80);
  const beforeResult = await bestEffort(`/city/roads${query({ query: prefab, x: center.x, z: center.z, radius, limit: 500 })}`, 20_000);
  const beforeRows = beforeResult.ok
    ? extractRows(beforeResult.value, "roads").map(asRecord).filter((value): value is JsonRecord => Boolean(value))
    : [];
  const beforeKeys = new Set(beforeRows.map(rowEntityKey).filter((value): value is string => Boolean(value)));

  const params = new URLSearchParams({ index: String(index), version: String(version), upgrades: upgradesRaw, side });
  const nativeRequest = await bridgeJson(`/build/upgrade?${params.toString()}`, 20_000);
  let latest: JsonRecord | undefined;
  let latestMatches: JsonRecord[] = [];
  const attempts = 24;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await delay(250);
    try {
      latest = await bridgeJson<JsonRecord>(`/city/roads${query({ query: prefab, x: center.x, z: center.z, radius, limit: 500 })}`, 20_000);
    } catch {
      continue;
    }
    const rows = extractRows(latest, "roads").map(asRecord).filter((value): value is JsonRecord => Boolean(value));
    latestMatches = rows.filter((row) => networkSegmentMatches(row, prefab, start, end) && roadUpgradeMatches(row, requested, side));
    const newMatch = latestMatches.find((row) => {
      const key = rowEntityKey(row);
      return key !== undefined && !beforeKeys.has(key);
    });
    if (newMatch || latestMatches.length > 0) {
      const matched = newMatch ?? latestMatches[0];
      return {
        success: true,
        nativeRequest,
        entity: asRecord(matched.entity) ?? null,
        readback: matched,
        verification: {
          status: newMatch ? "readback-new-entity" : "readback-existing-entity",
          attempts: attempt,
          endpointMatches: true,
          geometryMatches: true,
          upgradeFlagsMatch: true,
          requested: requested,
          side,
        },
        note: "the native road upgrade was accepted and the live road query read back matching geometry and CompositionFlags",
      };
    }
  }

  return {
    success: false,
    noSuccess: true,
    nativeRequest,
    entity: { index, version },
    verification: {
      status: "missing-after-upgrade",
      attempts,
      endpointMatches: false,
      geometryMatches: latestMatches.length > 0,
      upgradeFlagsMatch: false,
      requested,
      side,
    },
    readbackCandidates: latestMatches,
    note: "no success claim: the native request returned, but no road with matching geometry and requested upgrade flags was read back",
  };
}

export async function executeVerifiedTerraform(
  operation: "raise" | "lower" | "level" | "slope" | "smooth",
  points: WorldPoint[],
  amount = 0.5,
): Promise<JsonRecord> {
  const sampleQuery = query({ points: JSON.stringify(points.map((value) => ({ x: value.x, z: value.z }))), raw: true });
  const beforeResult = await bestEffort(`/city/terrain/sample${sampleQuery}`, 20_000);
  if (!beforeResult.ok) {
    return {
      success: false,
      noSuccess: true,
      executed: false,
      verification: { status: "preflight-sampling-unavailable", changed: false },
      reason: "native terrain sampling was unavailable before terraform; no mutation was attempted",
      preflight: beforeResult.error,
    };
  }

  const nativeRequest = await bridgeJson(`/terraform${query({ operation, points: JSON.stringify(points), amount })}`, 20_000);
  let latest: JsonRecord | undefined;
  const beforeSamples = asArray(asRecord(beforeResult.value)?.samples).map(asRecord).filter((value): value is JsonRecord => Boolean(value));
  let afterSamples: JsonRecord[] = [];
  const attempts = 20;
  const directionSatisfied = (delta: number): boolean => {
    if (operation === "raise") return delta > 0.02;
    if (operation === "lower") return delta < -0.02;
    return Math.abs(delta) > 0.02;
  };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await delay(250);
    const sampleResult = await bestEffort(`/city/terrain/sample${sampleQuery}`, 20_000);
    if (!sampleResult.ok) continue;
    latest = asRecord(sampleResult.value);
    if (!latest) continue;
    afterSamples = asArray(asRecord(latest)?.samples).map(asRecord).filter((value): value is JsonRecord => Boolean(value));
    const deltas = beforeSamples.map((sample, index) => {
      const beforeHeight = numberField(sample, "height");
      const afterHeight = numberField(afterSamples[index], "height");
      return beforeHeight !== undefined && afterHeight !== undefined ? afterHeight - beforeHeight : undefined;
    }).filter((value): value is number => value !== undefined);
    const changed = deltas.filter(directionSatisfied);
    if (changed.length > 0) {
      return {
        success: true,
        executed: true,
        nativeRequest,
        operation,
        amount,
        points,
        verification: {
          status: "terrain-readback",
          attempts: attempt,
          changedSamples: changed.length,
          sampleCount: deltas.length,
          maxDelta: deltas.length > 0 ? Math.max(...deltas.map((value) => Math.abs(value))) : 0,
          deltas,
        },
        before: beforeResult.value,
        after: latest,
        note: "native terrain definition completed and point samples changed in the requested operation direction",
      };
    }
  }

  return {
    success: false,
    noSuccess: true,
    executed: true,
    nativeRequest,
    operation,
    amount,
    points,
    verification: {
      status: "terrain-change-not-observed",
      attempts,
      changedSamples: 0,
      sampleCount: Math.min(beforeSamples.length, afterSamples.length),
    },
    before: beforeResult.value,
    after: latest ?? null,
    note: "the native terraform request was accepted but no directional terrain change was observed; no success is claimed",
  };
}

async function executeAdaptiveRoadPlan(
  plan: RoadPlan,
  selected: { name: string; discovery?: unknown; selection: string },
  force = false,
  maximumSegments = plan.segments.length,
): Promise<JsonRecord> {
  const primary = await executeVerifiedRoadPlan(plan, selected.name, force, maximumSegments);
  if (primary.success || selected.name.toLowerCase() === "small road") return { ...primary, selectedPrefab: selected, fallback: null };

  const attemptedSegments = plan.segments.slice(0, maximumSegments);
  const primaryResults = asArray(primary.results).map(asRecord);
  const failedSegments = attemptedSegments.filter((_segment, index) => asRecord(primaryResults[index]?.verification)?.endpointMatches !== true);
  if (failedSegments.length === 0) return { ...primary, selectedPrefab: selected, fallback: null };

  try {
    const fallback = await selectServiceAccessRoadPrefab();
    if (fallback.name.toLowerCase() === selected.name.toLowerCase()) return { ...primary, selectedPrefab: selected, fallback: null };
    const fallbackPlan: RoadPlan = { ...plan, segments: failedSegments };
    const fallbackResult = await executeVerifiedRoadPlan(fallbackPlan, fallback.name, force, failedSegments.length);
    const verifiedSegments = (numberField(primary, "verifiedSegments") ?? 0) + (numberField(fallbackResult, "verifiedSegments") ?? 0);
    return {
      ...primary,
      selectedPrefab: selected,
      fallback: { selectedPrefab: fallback, ...fallbackResult },
      verifiedSegments,
      success: verifiedSegments === attemptedSegments.length && attemptedSegments.length > 0,
      partial: verifiedSegments !== attemptedSegments.length,
    };
  } catch (error) {
    return { ...primary, selectedPrefab: selected, fallback: { success: false, error: error instanceof Error ? error.message : String(error) } };
  }
}

async function selectServiceAccessRoadPrefab(): Promise<{ name: string; discovery: unknown; selection: string }> {
  const discovery = await bridgeJson<JsonRecord>(`/prefabs${query({ category: "road", query: "Road", page: 0, pageSize: 200 })}`, 20_000);
  const candidates = asArray(discovery.prefabs)
    .map(asRecord)
    .filter((value): value is JsonRecord => Boolean(value))
    .filter((value) => validPrefab(value) !== undefined)
    .filter((value) => {
      const name = (asString(value.name) ?? "").toLowerCase();
      return !name.includes("highway") && !name.includes("track") && !name.includes("bridge") && !name.includes("oneway") && !name.includes("one-way") && !name.includes("tunnel");
    });
  const score = (value: JsonRecord) => {
    const name = (asString(value.name) ?? "").toLowerCase();
    return (name.includes("small") ? 20 : 0) + (name.includes("medium") ? 15 : 0) + (name.includes("road") ? 10 : 0) - (name.includes("avenue") ? 2 : 0);
  };
  const selected = [...candidates].sort((a, b) => score(b) - score(a))[0];
  const name = validPrefab(selected);
  if (!name) throw new BridgeCallError("No unlocked local service-access road prefab was discovered.", 404, discovery);
  return { name, discovery, selection: "runtime road discovery filtered for a non-highway service-access road" };
}

async function ensureServiceAccessRoad(plan: JsonRecord, force = false): Promise<JsonRecord> {
  const center = centerOf(plan.centre) ?? { x: 0, z: 0 };
  const selected = await selectServiceAccessRoadPrefab();
  const candidates = [
    { start: { x: center.x - 160, z: center.z + 80 }, end: { x: center.x + 160, z: center.z + 80 } },
    { start: { x: center.x - 160, z: center.z - 80 }, end: { x: center.x + 160, z: center.z - 80 } },
    { start: { x: center.x + 80, z: center.z - 160 }, end: { x: center.x + 80, z: center.z + 160 } },
    { start: { x: center.x - 80, z: center.z - 160 }, end: { x: center.x - 80, z: center.z + 160 } },
  ];
  const attempts: JsonRecord[] = [];
  for (const candidate of candidates) {
    const roadPlan = makeRoadPlan({ start: candidate.start, end: candidate.end, maxSegmentLength: 120, maxSlope: 0.12, role: "service access" });
    try {
      const result = await executeVerifiedRoadPlan(roadPlan, selected.name, force);
      attempts.push({ candidate, result });
      if (result.success) return { success: true, selected, candidate, result, attempts };
    } catch (error) {
      attempts.push({ candidate, success: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { success: false, selected, attempts, reason: "no service-access road candidate completed native readback" };
}

export async function executeVerifiedDistrict(
  polygon: WorldPoint[],
  name: string,
  prefab: string | undefined,
): Promise<JsonRecord> {
  const before = await bestEffort("/districts", 20_000);
  const beforeKeys = before.ok ? entityKeys(before.value, "districts") : new Set<string>();
  const target = polygon.reduce((sum, value) => ({ x: sum.x + value.x, z: sum.z + value.z }), { x: 0, z: 0 });
  target.x /= polygon.length;
  target.z /= polygon.length;
  const existing = before.ok
    ? extractRows(before.value, "districts").map(asRecord).find((row) => {
      if (!row) return false;
      const rowName = asString(row.name) ?? asString(row.displayName);
      const observedCenter = centerOf(row);
      return rowName === name || Boolean(observedCenter && Math.hypot(observedCenter.x - target.x, observedCenter.z - target.z) <= 180);
    })
    : undefined;
  if (existing) return { success: true, alreadyPresent: true, nativeRequest: null, verification: { status: "already-present", attempts: 0, entity: asRecord(existing.entity) ?? null }, readback: existing };
  const nativeRequest = await bridgeJson(`${districtQueryPath(polygon, prefab)}&name=${encodeURIComponent(name)}`, 20_000);
  let readback: JsonRecord | undefined;
  let latest: JsonRecord | undefined;
  let attempts = 0;
  for (attempts = 1; attempts <= 20; attempts++) {
    await delay(250);
    latest = await bridgeJson<JsonRecord>("/districts", 20_000);
    readback = extractRows(latest, "districts").map(asRecord).find((row) => {
      if (!row) return false;
      const key = rowEntityKey(row);
      if (!key || beforeKeys.has(key)) return false;
      const rowName = asString(row.name) ?? asString(row.displayName);
      const observedCenter = centerOf(row);
      return rowName === name || Boolean(observedCenter && Math.hypot(observedCenter.x - target.x, observedCenter.z - target.z) <= 180);
    });
    if (readback) break;
  }
  return {
    success: Boolean(readback),
    name,
    nativeRequest,
    verification: { status: readback ? "readback" : "missing-after-queue", attempts, entity: readback ? asRecord(readback.entity) ?? null : null },
    readback: readback ?? null,
    latest: latest ?? null,
  };
}

export async function executeVerifiedDemolish(entity: { index: number; version: number }): Promise<JsonRecord> {
  const before = await bridgeJson<JsonRecord>(`/entity/inspect${query({ index: entity.index, version: entity.version })}`, 20_000);
  const nativeRequest = await bridgeJson<JsonRecord>(`/build/demolish${query({ index: entity.index, version: entity.version })}`, 20_000);
  let latest: unknown;
  let attempts = 0;
  let absent = false;
  for (attempts = 1; attempts <= 12; attempts++) {
    await delay(250);
    const candidate = await bestEffort(`/entity/inspect${query({ index: entity.index, version: entity.version })}`, 20_000);
    if (!candidate.ok && candidate.status === 404) {
      absent = true;
      break;
    }
    if (candidate.ok) latest = candidate.value;
  }
  return {
    success: absent,
    executed: true,
    queued: true,
    demolished: absent,
    entity,
    nativeRequest,
    before,
    verification: {
      status: absent ? "absent" : "still-present-after-queue",
      attempts,
    },
    readback: latest ?? null,
    note: absent
      ? undefined
      : "the native bulldoze request was accepted but the entity remained present during the readback window; no success is claimed",
  };
}

async function selectZoneForDistrict(type: string): Promise<{ name: string; discovery: JsonRecord; selection: string }> {
  const discovery = await bridgeJson<JsonRecord>("/zones", 20_000);
  const candidates = extractRows(discovery, "zones")
    .map(asRecord)
    .filter((value): value is JsonRecord => Boolean(value))
    .filter((value) => value.locked !== true && value.available !== false && Boolean(asString(value.name)));
  const lower = type.toLowerCase();
  const terms = lower.includes("industrial") || lower.includes("logistics") ? ["industrial", "manufacturing", "storage"]
    : lower.includes("commercial") || lower.includes("cbd") || lower.includes("waterfront") ? ["commercial", "office"]
      : lower.includes("university") || lower.includes("civic") ? ["office", "commercial"]
        : ["residential"];
  const score = (candidate: JsonRecord) => {
    const name = (asString(candidate.name) ?? "").toLowerCase();
    return terms.reduce((value, term, index) => value + (name.includes(term) ? 10 - index : 0), 0);
  };
  const selected = [...candidates].sort((a, b) => score(b) - score(a))[0];
  const name = asString(selected?.name);
  if (!name) throw new BridgeCallError(`No unlocked zone type was discovered for district type '${type}'.`, 404, discovery);
  return { name, discovery, selection: "runtime zone discovery scored by district semantics; native zoning remains authoritative" };
}

export async function executeVerifiedZone(center: WorldPoint, radius: number, zone: string, force = false, options: { snapToGrid?: boolean; overwrite?: boolean; dezone?: boolean } = {}): Promise<JsonRecord> {
  const before = await bestEffort(`/city/zoning${query({ x: center.x, z: center.z, radius })}`, 20_000);
  const beforeCount = before.ok ? numberField(before.value, "zonedCells") ?? 0 : 0;
  const zoneCount = (payload: unknown): number => {
    const byZone = asRecord(asRecord(payload)?.byZone);
    const selected = asRecord(byZone?.[zone]);
    return typeof selected?.cells === "number" && Number.isFinite(selected.cells) ? selected.cells : 0;
  };
  const beforeZoneCount = before.ok ? zoneCount(before.value) : 0;
  const nativeRequest = await bridgeJson(`/build/zone${query({ zone, x: center.x, z: center.z, radius, force: force || undefined, snapToGrid: options.snapToGrid ?? true, overwrite: options.overwrite || undefined })}`, 20_000);
  let latest: JsonRecord | undefined;
  let afterCount = beforeCount;
  let afterZoneCount = beforeZoneCount;
  for (let attempt = 1; attempt <= 12; attempt++) {
    await delay(250);
    const result = await bestEffort(`/city/zoning${query({ x: center.x, z: center.z, radius })}`, 20_000);
    if (!result.ok) continue;
    latest = asRecord(result.value);
    afterCount = numberField(result.value, "zonedCells") ?? beforeCount;
    afterZoneCount = zoneCount(result.value);
    const changed = options.dezone ? afterCount < beforeCount : afterCount > beforeCount || afterZoneCount !== beforeZoneCount;
    if (changed) break;
  }
  const changed = options.dezone ? afterCount < beforeCount : afterCount > beforeCount || afterZoneCount !== beforeZoneCount;
  return {
    success: changed,
    center,
    radius,
    zone,
    nativeRequest,
    verification: { beforeZonedCells: beforeCount, afterZonedCells: afterCount, beforeZoneCells: beforeZoneCount, afterZoneCells: afterZoneCount, cellsAdded: Math.max(0, afterCount - beforeCount), changed, dezone: options.dezone === true },
    readback: latest ?? null,
    note: changed ? undefined : "the native zone pipeline completed without a measurable cell-count change; no full success is claimed",
  };
}

export async function executeVerifiedSurface(polygon: WorldPoint[], prefab: string | undefined, force = false): Promise<JsonRecord> {
  const center = polygon.reduce((sum, value) => ({ x: sum.x + value.x, z: sum.z + value.z }), { x: 0, z: 0 });
  center.x /= polygon.length;
  center.z /= polygon.length;
  const radius = Math.max(120, ...polygon.map((value) => Math.hypot(value.x - center.x, value.z - center.z) + 80));
  const before = await bestEffort(`/city/surfaces${query({ x: center.x, z: center.z, radius, page: 0, pageSize: 200 })}`, 20_000);
  const beforeKeys = before.ok ? entityKeys(before.value, "surfaces") : new Set<string>();
  const nativeRequest = await bridgeJson<JsonRecord>(`/surface${query({ polygon: JSON.stringify(polygon), prefab, force: force || undefined })}`, 20_000);
  let latest: JsonRecord | undefined;
  let readback: JsonRecord | undefined;
  let attempts = 0;
  for (attempts = 1; attempts <= 16; attempts++) {
    await delay(250);
    const result = await bestEffort(`/city/surfaces${query({ x: center.x, z: center.z, radius, page: 0, pageSize: 200 })}`, 20_000);
    if (!result.ok) continue;
    latest = asRecord(result.value);
    readback = extractRows(result.value, "surfaces").map(asRecord).find((row) => {
      if (!row) return false;
      const key = rowEntityKey(row);
      const observedCenter = centerOf(row.center) ?? centerOf(row);
      const actualPrefab = asString(row.prefab);
      return Boolean(key && !beforeKeys.has(key) && observedCenter
        && Math.hypot(observedCenter.x - center.x, observedCenter.z - center.z) <= radius
        && (!prefab || actualPrefab?.toLowerCase() === prefab.toLowerCase()));
    });
    if (readback) break;
  }
  return {
    success: Boolean(readback),
    executed: true,
    queued: true,
    polygon,
    prefab: prefab ?? null,
    nativeRequest,
    verification: {
      status: readback ? "readback" : "missing-after-queue",
      attempts,
      entity: readback ? asRecord(readback.entity) ?? null : null,
      nodeCount: readback ? numberField(readback, "nodeCount") ?? null : null,
    },
    readback: readback ?? null,
    latest: latest ?? null,
    note: readback ? undefined : "the native surface request was accepted but no new Surface entity matched the polygon area; no success is claimed",
  };
}

async function selectDecorationPrefab(category: "tree" | "prop" | "surface", search?: string): Promise<{ name: string; discovery: unknown; selection: string }> {
  const discovery = await bridgeJson<JsonRecord>(`/prefabs${query({ category, query: search, page: 0, pageSize: 200 })}`, 20_000);
  const candidates = asArray(discovery.prefabs)
    .map(asRecord)
    .filter((value): value is JsonRecord => Boolean(value))
    .filter((value) => validPrefab(value) !== undefined)
    .filter((value) => {
      const name = (asString(value.name) ?? "").toLowerCase();
      const type = asString(value.type) ?? "";
      if (category === "surface") return type === "SurfacePrefab";
      if (category === "tree") return type === "StaticObjectPrefab" && !name.includes("placeholder") && !name.includes("lod") && !name.includes("mesh");
      return type === "StaticObjectPrefab" && !name.includes("node") && !name.includes("placeholder") && !name.includes("lod") && !name.includes("mesh");
    });
  const selected = validPrefab(candidates[0]);
  if (!selected) throw new BridgeCallError(`No suitable unlocked ${category} prefab was discovered${search ? ` for query '${search}'` : ""}.`, 404, discovery);
  return { name: selected, discovery, selection: `runtime ${category} discovery filtered for native placeable assets` };
}

async function executeLandscapeStage(
  plan: JsonRecord,
  maximumTrees: number,
  maximumProps: number,
  roadAnchors: WorldPoint[] = [],
  force = false,
): Promise<JsonRecord> {
  const districts = asArray(plan.districts).map(asRecord).filter((value): value is JsonRecord => Boolean(value));
  const landscapeDistricts = districts.filter((district) => {
    const type = (asString(district.type) ?? "").toLowerCase();
    return type.includes("waterfront") || type.includes("park") || type.includes("green") || type.includes("civic");
  });
  const centers = landscapeDistricts.map((district) => centerOf(district.centre) ?? centerOf(district.center)).filter((value): value is WorldPoint => Boolean(value));
  if (centers.length === 0) {
    const fallback = centerOf(plan.centre) ?? { x: 0, z: 0 };
    centers.push(fallback);
  }
  const polygons = centers.slice(0, 4).map((center, index) => rectangleAround(center, 160 + index * 30, 70 + index * 20, index * 17));
  const surfaces: JsonRecord[] = [];
  try {
    const selectedSurface = await selectDecorationPrefab("surface", "Grass");
    for (const [index, polygon] of polygons.entries()) {
      try {
         surfaces.push({ index, polygon, prefab: selectedSurface.name, ...(await executeVerifiedSurface(polygon, selectedSurface.name, force)) });
      } catch (error) {
        surfaces.push({ index, polygon, prefab: selectedSurface.name, success: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  } catch (error) {
    surfaces.push({ success: false, stage: "surface-discovery", error: error instanceof Error ? error.message : String(error) });
  }

  const trees: JsonRecord[] = [];
  try {
    const selectedTree = await selectDecorationPrefab("tree");
    const candidateBases = [...roadAnchors.slice(0, 12), ...centers];
    const points: WorldPoint[] = [];
    const offsets = [{ x: 30, z: 0 }, { x: -30, z: 0 }, { x: 0, z: 30 }, { x: 0, z: -30 }, { x: 46, z: 18 }, { x: -46, z: -18 }];
    for (const base of candidateBases) {
      for (const offset of offsets) {
        const candidate = { x: base.x + offset.x, z: base.z + offset.z };
        if (!points.some((value) => Math.hypot(value.x - candidate.x, value.z - candidate.z) < 10)) points.push(candidate);
        if (points.length >= maximumTrees) break;
      }
      if (points.length >= maximumTrees) break;
    }
    for (const [index, position] of points.entries()) {
      try {
        const result = await placeDecorationObject("tree", position, selectedTree.name, (index * 137.507764) % 360, true, force === true);
        trees.push({ index, position, result, success: result.success === true });
      } catch (error) {
        trees.push({ index, position, success: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  } catch (error) {
    trees.push({ success: false, stage: "tree-discovery", error: error instanceof Error ? error.message : String(error) });
  }

  const props: JsonRecord[] = [];
  if (maximumProps > 0) {
    try {
      const selectedProp = await selectDecorationPrefab("prop", "Bench");
      for (const [index, center] of centers.slice(0, maximumProps).entries()) {
        try {
          const result = await placeDecorationObject("prop", center, selectedProp.name, (index * 90) % 360, true, force === true);
          props.push({ index, position: center, prefab: selectedProp.name, result, success: result.success === true });
        } catch (error) {
          props.push({ index, position: center, prefab: selectedProp.name, success: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      props.push({ success: false, stage: "prop-discovery", error: error instanceof Error ? error.message : String(error) });
    }
  }
  const screenshot = await captureScreenshot();
  const attempted = surfaces.length + trees.length + props.length;
  const verified = surfaces.filter((entry) => entry.success === true).length
    + trees.filter((entry) => entry.success === true).length
    + props.filter((entry) => entry.success === true).length;
  return {
    success: attempted > 0 && verified === attempted,
    centers,
    surfaces,
    trees,
    props,
    screenshotCaptured: screenshot,
    verification: { surfaceRequests: surfaces.filter((entry) => entry.success === true).length, treeRequests: trees.filter((entry) => entry.success === true).length, propRequests: props.filter((entry) => entry.success === true).length, attempted, verified, attemptedTrees: trees.length, attemptedProps: props.length, note: "surface areas now require a native Surface entity readback; tree/prop objects require their corresponding native list readback" },
  };
}

async function selectServiceBuilding(queries: string[]): Promise<{ name: string; discovery: unknown; selection: string }> {
  const discoveries: JsonRecord[] = [];
  const candidates: JsonRecord[] = [];
  for (const search of queries) {
    const discovery = await bridgeJson<JsonRecord>(`/prefabs${query({ category: "building", query: search, page: 0, pageSize: 200 })}`, 20_000);
    discoveries.push(discovery);
    candidates.push(...asArray(discovery.prefabs).map(asRecord).filter((value): value is JsonRecord => Boolean(value)));
    if (candidates.some((candidate) => validPrefab(candidate) !== undefined && asString(candidate.type) === "BuildingPrefab")) break;
  }
  const unique = new Map<string, JsonRecord>();
  for (const candidate of candidates) {
    const name = validPrefab(candidate);
    if (!name || asString(candidate.type) !== "BuildingPrefab") continue;
    const lower = name.toLowerCase();
    if (["extension", "upgrade", "sub01", "sub02", "extra", "additional", "storage", "transformer", "unit", "mesh", "lod"].some((term) => lower.includes(term))) continue;
    unique.set(name.toLowerCase(), candidate);
  }
  const queryText = queries.join(" ").toLowerCase();
  const score = (candidate: JsonRecord): number => {
    const name = (asString(candidate.name) ?? "").toLowerCase();
    let value = 0;
    if (queryText.includes("power")) {
      if (name.includes("solar")) value += 40;
      if (name.includes("small")) value += 30;
      if (name.includes("geothermal")) value -= 8;
      if (name.includes("hydro")) value -= 12;
      if (name.includes("nuclear")) value -= 20;
      if (name.includes("coal") || name.includes("gas")) value -= 5;
    }
    if (queryText.includes("wind")) {
      if (name.includes("windturbine") || name.includes("wind")) value += 80;
      if (name.includes("solar")) value -= 10;
    }
    if (queryText.includes("pumping") && name.includes("groundwater")) value += 8;
    if (queryText.includes("clinic") && name.includes("clinic")) value += 20;
    if (queryText.includes("fire") && name.includes("fire")) value += 20;
    if (queryText.includes("police") && name.includes("police")) value += 20;
    if (queryText.includes("elementary")) {
      if (name.includes("elementary")) value += 60;
      if (name.includes("highschool") || name.includes("high school")) value -= 30;
      // Prefer a compact native elementary-school variant for the bounded
      // blank-save layout.  The large 18x8 ElementarySchool01 footprint can
      // fail native overlap validation even when its frontage is road-adjacent.
      // Keep this as a score, not a hard-coded prefab, so runtime discovery
      // remains authoritative when a build exposes different variants.
      if (name === "elementaryschool03") value += 120;
      if (name === "elementaryschool02") value += 105;
      if (name === "elementaryschool01") value += 80;
    }
    if (queryText.includes("school") && name.includes("school")) value += 20;
    return value;
  };
  const selected = [...unique.values()].sort((a, b) => score(b) - score(a))[0];
  const name = validPrefab(selected);
  if (!name) throw new BridgeCallError(`No unlocked service building was discovered for queries ${queries.join(", ")}.`, 404, { discoveries });
  return { name, discovery: { queries, responses: discoveries }, selection: "runtime building discovery filtered for a base service building; native object validation remains authoritative" };
}

export async function executeVerifiedBuilding(
  prefab: string,
  anchor: WorldPoint,
  force = false,
  options: { requireRoad?: boolean; gridSnap?: boolean; rotation?: number } = {},
): Promise<JsonRecord> {
  const before = await bestEffort(`/city/buildings${query({ query: prefab, limit: 500 })}`, 20_000);
  const beforeKeys = before.ok ? entityKeys(before.value, "buildings") : new Set<string>();
  const nativeRequest = await bridgeJson(`/build/place${query({ prefab, x: anchor.x, y: anchor.y, z: anchor.z, rotation: options.rotation, force: force || undefined, requireRoad: options.requireRoad, gridSnap: options.gridSnap })}`, 20_000);
  let readback: JsonRecord | undefined;
  let latest: JsonRecord | undefined;
  let attempts = 0;
  for (attempts = 1; attempts <= 24; attempts++) {
    await delay(250);
    latest = await bridgeJson<JsonRecord>(`/city/buildings${query({ query: prefab, limit: 500 })}`, 20_000);
    readback = extractRows(latest, "buildings").map(asRecord).find((row) => {
      if (!row || asString(row.prefab)?.toLowerCase() !== prefab.toLowerCase()) return false;
      const key = rowEntityKey(row);
      const position = positionOf(row);
      return Boolean(key && !beforeKeys.has(key) && position && Math.hypot(position.x - anchor.x, position.z - anchor.z) <= 180);
    });
    if (readback) break;
  }
  return {
    success: Boolean(readback),
    prefab,
    anchor,
    nativeRequest,
    verification: { status: readback ? "readback" : "missing-after-queue", attempts, entity: readback ? asRecord(readback.entity) ?? null : null, position: readback ? positionOf(readback) ?? null : null },
    readback: readback ?? null,
    latest: latest ?? null,
  };
}

function notificationType(value: unknown): string {
  const row = asRecord(value);
  return asString(row?.type) ?? asString(row?.name) ?? asString(row?.notification) ?? "unknown";
}

function utilityNotificationSummary(payload: unknown): JsonRecord {
  const root = asRecord(payload);
  const rows = extractRows(payload, "notifications").map(asRecord).filter((value): value is JsonRecord => Boolean(value));
  const reportedCounts = asRecord(root?.countsByType);
  const countsByType: Record<string, number> = {};
  if (reportedCounts) {
    for (const [type, count] of Object.entries(reportedCounts)) {
      if (typeof count === "number" && Number.isFinite(count)) countsByType[type] = count;
    }
  }
  for (const row of rows) {
    const type = notificationType(row);
    if (!(type in countsByType)) countsByType[type] = 0;
  }

  const isUtilityType = (type: string): boolean => {
    const normalized = type.toLowerCase();
    return normalized.includes("water")
      || normalized.includes("sewage")
      || normalized.includes("electricity")
      || normalized.includes("powerline")
      || normalized.includes("pipeline")
      || normalized.includes("dirty water");
  };
  const utilityCounts = Object.fromEntries(Object.entries(countsByType).filter(([type]) => isUtilityType(type)));
  const detailedUtilityRows = rows.filter((row) => isUtilityType(notificationType(row))).slice(0, 200);
  const reportedTotal = typeof root?.total === "number" && Number.isFinite(root.total) ? root.total : rows.length;
  const utilityCount = Object.values(utilityCounts).reduce((sum, count) => sum + count, 0);
  return {
    status: "observed",
    totalNotifications: reportedTotal,
    returnedNotifications: rows.length,
    utilityWarningCount: utilityCount,
    utilityWarningsClear: utilityCount === 0,
    countsByType: utilityCounts,
    rows: detailedUtilityRows,
    source: "/city/notifications native Icon query",
  };
}

async function executeServiceStage(
  plan: JsonRecord,
  anchors: WorldPoint[],
  maximumBuildings: number,
  force = false,
): Promise<JsonRecord> {
  const descriptors: Array<{ id: string; queries: string[] }> = [
    // A small roadside wind turbine is a more reliable first utility on a
    // blank test save than a large power station: it has a 2x2 lot and the
    // native object validator can place it on the same road frontage used by
    // the other service buildings.  Keep the broader Power query as a live
    // runtime fallback for maps/builds where the wind prefabs are locked.
    { id: "electricity", queries: ["WindTurbine", "Wind", "Power"] },
    { id: "water", queries: ["Pumping", "Water"] },
    { id: "sewage", queries: ["Sewage", "Wastewater"] },
    { id: "garbage", queries: ["Landfill", "Recycling", "Waste"] },
    { id: "healthcare", queries: ["Clinic", "Hospital"] },
    { id: "fire", queries: ["Fire"] },
    { id: "police", queries: ["Police"] },
    { id: "education", queries: ["ElementarySchool", "Elementary", "School"] },
  ].slice(0, maximumBuildings);
  const center = centerOf(plan.centre) ?? { x: 0, z: 0 };
  const fallbackOffsets = [{ x: 24, z: 0 }, { x: -24, z: 0 }, { x: 0, z: 24 }, { x: 0, z: -24 }, { x: 42, z: 18 }, { x: -42, z: -18 }, { x: 58, z: -18 }, { x: -58, z: 18 }];
  const centerCandidates = fallbackOffsets.map((offset) => ({ x: center.x + offset.x, z: center.z + offset.z }));
  const placementAnchors = [...centerCandidates, ...anchors].filter((candidate, index, values) => !values.slice(0, index).some((value) => Math.hypot(value.x - candidate.x, value.z - candidate.z) < 8));
  const results: JsonRecord[] = [];
  const notificationsBefore = await bestEffort("/city/notifications?limit=500", 20_000);
  const utilityBefore = notificationsBefore.ok
    ? utilityNotificationSummary(notificationsBefore.value)
    : { status: "unavailable", error: notificationsBefore.error };
  for (const [index, descriptor] of descriptors.entries()) {
    try {
      const selected = await selectServiceBuilding(descriptor.queries);
      const attempts: JsonRecord[] = [];
      let placement: JsonRecord | undefined;
      const startIndex = (index * 5) % placementAnchors.length;
      for (let offset = 0; offset < Math.min(12, placementAnchors.length); offset++) {
        const anchor = placementAnchors[(startIndex + offset) % placementAnchors.length];
        try {
          const candidate = await executeVerifiedBuilding(selected.name, anchor, force, { requireRoad: true, gridSnap: true });
          attempts.push({ anchor, ...candidate });
          if (candidate.success) {
            placement = candidate;
            break;
          }
        } catch (error) {
          attempts.push({ anchor, success: false, error: error instanceof Error ? error.message : String(error) });
        }
        await delay(350);
      }
      results.push({ service: descriptor.id, selected, placement: placement ?? null, attempts, success: placement?.success === true });
    } catch (error) {
      results.push({ service: descriptor.id, success: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const serviceReadback = await bestEffort("/city/services", 20_000);
  const notificationsAfter = await bestEffort("/city/notifications?limit=500", 20_000);
  const utilityAfter = notificationsAfter.ok
    ? utilityNotificationSummary(notificationsAfter.value)
    : { status: "unavailable", error: notificationsAfter.error };
  const placementSuccess = results.length === 0 || results.some((entry) => asRecord(entry.placement)?.success === true);
  const utilityObserved = asString(asRecord(utilityAfter)?.status) === "observed";
  const utilityConnectivity = {
    before: utilityBefore,
    after: utilityAfter,
    observed: utilityObserved,
    success: utilityObserved && asRecord(utilityAfter)?.utilityWarningsClear === true,
    recommendedAction: utilityObserved && asRecord(utilityAfter)?.utilityWarningsClear === true
      ? undefined
      : "discover native utility connection points, build the required pipe/power network, then re-read /city/notifications before expanding the next district",
  };
  return {
    success: placementSuccess && utilityConnectivity.success === true,
    placementSuccess,
    utilityConnectivity,
    results,
    serviceReadback,
    notifications: { before: notificationsBefore, after: notificationsAfter },
  };
}

async function executeUtilityRepairStage(serviceStage: JsonRecord, force = false): Promise<JsonRecord> {
  const connectivity = asRecord(serviceStage.utilityConnectivity);
  const after = asRecord(connectivity?.after);
  if (after?.status !== "observed") {
    return {
      success: false,
      observed: false,
      attempted: [],
      reason: "native utility notification readback was unavailable; no connectivity claim is made",
    };
  }
  if (after.utilityWarningsClear === true) {
    return { success: true, observed: true, attempted: [], reason: "native water/sewage/electricity notifications were already clear" };
  }

  const rows = asArray(after.rows).map(asRecord).filter((value): value is JsonRecord => Boolean(value));
  const pointOfNotification = (row: JsonRecord): WorldPoint | undefined => positionOf(row.location) ?? positionOf(row.target);
  const groups: Array<{ kind: "combined" | "electricity"; rows: JsonRecord[] }> = [
    {
      kind: "combined",
      rows: rows.filter((row) => {
        const type = notificationType(row).toLowerCase();
        return type.includes("water") || type.includes("sewage") || type.includes("pipeline");
      }),
    },
    {
      kind: "electricity",
      rows: rows.filter((row) => {
        const type = notificationType(row).toLowerCase();
        return type.includes("electricity") || type.includes("powerline");
      }),
    },
  ];
  const attempted: JsonRecord[] = [];
  for (const group of groups) {
    const points = group.rows.map(pointOfNotification).filter((value): value is WorldPoint => Boolean(value));
    if (points.length < 2) {
      attempted.push({ kind: group.kind, attempted: false, reason: "fewer than two native warning locations were available for a bounded repair course" });
      continue;
    }
    let bestPair: [WorldPoint, WorldPoint] | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const distance = Math.hypot(points[i].x - points[j].x, points[i].z - points[j].z);
        if (distance >= 8 && distance <= 600 && distance < bestDistance) {
          bestDistance = distance;
          bestPair = [points[i], points[j]];
        }
      }
    }
    if (!bestPair) {
      attempted.push({ kind: group.kind, attempted: false, reason: "no bounded pair of native warning locations was suitable for a native utility course" });
      continue;
    }
    try {
      const result = await executeUtilityNetworkPlan(group.kind, bestPair, undefined, true, force, 300, 0.2);
      const connectivityResult = asRecord(result.connectivity);
      attempted.push({ kind: group.kind, points: bestPair, distance: bestDistance, attempted: true, result });
      if (connectivityResult?.improved === true) {
        // Re-read after the first successful improvement before attempting a
        // second repair. This keeps the automatic loop bounded and avoids
        // blindly adding a utility mesh when the game did not connect it.
        const latest = await bestEffort("/city/notifications?limit=500", 20_000);
        const latestSummary = latest.ok ? utilityNotificationSummary(latest.value) : undefined;
        return {
          success: latestSummary?.utilityWarningsClear === true,
          observed: Boolean(latestSummary),
          attempted,
          latest: latest.ok ? latestSummary : { status: "unavailable", error: latest.error },
          note: "one native repair course reduced the observed utility warning count; the cycle re-read notifications before continuing",
        };
      }
    } catch (error) {
      attempted.push({ kind: group.kind, points: bestPair, distance: bestDistance, attempted: true, success: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const latest = await bestEffort("/city/notifications?limit=500", 20_000);
  const latestSummary = latest.ok ? utilityNotificationSummary(latest.value) : undefined;
  return {
    success: latestSummary?.utilityWarningsClear === true,
    observed: Boolean(latestSummary),
    attempted,
    latest: latest.ok ? latestSummary : { status: "unavailable", error: latest.error },
    reason: "native utility repair candidates were bounded and read back; unresolved warnings remain explicit",
  };
}

async function selectTransportStopPrefab(mode: string): Promise<{ name?: string; discovery?: unknown; selection: string }> {
  const normalized = mode.toLowerCase();
  const search = normalized === "bus" ? "BusStop" : `${mode[0].toUpperCase()}${mode.slice(1).toLowerCase()}Stop`;
  const discovery = await bridgeJson<JsonRecord>(`/prefabs${query({ category: "all", query: search, page: 0, pageSize: 200 })}`, 20_000);
  const candidates = asArray(discovery.prefabs)
    .map(asRecord)
    .filter((value): value is JsonRecord => Boolean(value))
    .filter((value) => validPrefab(value) !== undefined && asString(value.type) === "StaticObjectPrefab")
    .filter((value) => {
      const name = (asString(value.name) ?? "").toLowerCase();
      return !name.includes("lod") && !name.includes("mesh") && !name.includes("placeholder") && !name.includes("marking");
    });
  const name = validPrefab(candidates[0]);
  return { name, discovery, selection: name ? "runtime stop prefab discovery filtered for native static stop assets" : "no exact stop prefab selected; native mode discovery will decide" };
}

async function executeVerifiedTransportStop(mode: string, anchor: WorldPoint, prefab?: string, force = false): Promise<JsonRecord> {
  const before = await bridgeJson<JsonRecord>(`/transport/analysis${query({ x: anchor.x, z: anchor.z, radius: 160, limit: 500 })}`, 20_000);
  const beforeKeys = new Set(transportStopRows(before).map(transportStopEntityKey).filter((value): value is string => Boolean(value)));
  let nativeRequest: unknown;
  try {
    nativeRequest = await bridgeJson(`/transport/stop/place${query({ mode, prefab, x: anchor.x, y: anchor.y, z: anchor.z, force: force || undefined })}`, 20_000);
  } catch (error) {
    return { success: false, mode, anchor, prefab: prefab ?? null, error: error instanceof Error ? error.message : String(error) };
  }
  let readback: JsonRecord | undefined;
  let latest: JsonRecord | undefined;
  let attempts = 0;
  for (attempts = 1; attempts <= 24; attempts++) {
    await delay(250);
    latest = await bridgeJson<JsonRecord>(`/transport/analysis${query({ x: anchor.x, z: anchor.z, radius: 160, limit: 500 })}`, 20_000);
    readback = transportStopRows(latest).find((stop) => {
      const key = transportStopEntityKey(stop);
      const actualPrefab = asString(stop.prefab);
      return Boolean(key && !beforeKeys.has(key) && transportStopMatchesAnchor(stop, anchor, 160) && (!prefab || actualPrefab?.toLowerCase() === prefab.toLowerCase()));
    });
    if (readback) break;
  }
  return { success: Boolean(readback), mode, anchor, prefab: prefab ?? null, nativeRequest, verification: { status: readback ? "readback" : "missing-after-queue", attempts, entity: readback ? asRecord(readback.entity) ?? null : null, position: readback ? positionOf(readback) ?? null : null }, readback: readback ?? null, latest: latest ?? null };
}

function stopEntityRef(value: JsonRecord | undefined): { index: number; version: number } | null {
  const entity = asRecord(value?.entity);
  return typeof entity?.index === "number" && typeof entity.version === "number" ? { index: entity.index, version: entity.version } : null;
}

async function executeVerifiedTransportLine(
  mode: string,
  points: WorldPoint[],
  stopEntities: Array<{ index: number; version: number } | null>,
  force = false,
): Promise<JsonRecord> {
  const selected = await selectTransportPrefab(undefined, mode);
  const existing = await bridgeJson<JsonRecord>(`/transport/lines${query({ query: selected.name, limit: 200 })}`, 20_000);
  const existingKeys = new Set(extractRows(existing, "lines").map(asRecord).map(transportLineEntityKey).filter((value): value is string => Boolean(value)));
  const alreadyBound = extractRows(existing, "lines").map(asRecord).find((line) => transportLineMatchesConnections(line, stopEntities));
  if (alreadyBound) {
    return {
      success: true,
      alreadyPresent: true,
      mode,
      selectedPrefab: selected,
      points,
      stopEntities,
      nativeRequest: null,
      createdLine: alreadyBound,
      readback: existing,
      verification: { status: "already-present", attempts: 0, bindingVerified: true, connections: transportLineConnections(alreadyBound) },
    };
  }
  const nativeRequest = await bridgeJson(`/transport/line${query({ mode, prefab: selected.name, points: JSON.stringify(points), connections: JSON.stringify(stopEntities), dryRun: false, force: force || undefined })}`, 20_000);
  let createdLine: JsonRecord | undefined;
  let latest: JsonRecord | undefined;
  let attempts = 0;
  for (attempts = 1; attempts <= 24; attempts++) {
    await delay(250);
    latest = await bridgeJson<JsonRecord>(`/transport/lines${query({ query: selected.name, limit: 200 })}`, 20_000);
    createdLine = extractRows(latest, "lines").map(asRecord).find((line) => {
      const key = transportLineEntityKey(line);
      return Boolean(key && !existingKeys.has(key) && transportLineMatchesConnections(line, stopEntities));
    });
    if (createdLine) break;
  }
  return { success: Boolean(createdLine), mode, selectedPrefab: selected, points, stopEntities, nativeRequest, createdLine: createdLine ?? null, readback: latest ?? null, verification: { status: createdLine ? "readback" : "missing-after-queue", attempts, bindingVerified: Boolean(createdLine && transportLineMatchesConnections(createdLine, stopEntities)), connections: createdLine ? transportLineConnections(createdLine) : [] } };
}

async function executeTransitStage(
  plan: JsonRecord,
  roadAnchors: WorldPoint[],
  includeTrack: boolean,
  force = false,
): Promise<JsonRecord> {
  const capabilityResult = await bestEffort("/capabilities", 5_000);
  const caps = capabilityResult.ok ? capabilityMap(capabilityResult.value) : {};
  const stage: JsonRecord = { capabilities: caps, stops: [], lines: [], track: null };
  if (caps.transit_stops !== true) {
    stage.available = false;
    stage.success = false;
    stage.reason = "transit_stops=false in the live bridge contract; no stop mutation was emitted";
    return stage;
  }
  const transportEntries = asArray(plan.transport).map(asRecord).filter((value): value is JsonRecord => Boolean(value));
  const transportPoints = arrayPoints(transportEntries[0]?.points);
  // A road endpoint can be geometrically valid but still be rejected by the
  // native ObjectToolBaseSystem (water, slope, overlap, protected entity,
  // etc.). Keep a pool of live road/transport anchors and try them in order;
  // the first and last endpoint are not a reliable pair across maps.
  const candidates: WorldPoint[] = [];
  for (const candidate of [...roadAnchors, ...transportPoints]) {
    if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.z)) continue;
    if (!candidates.some((value) => Math.hypot(value.x - candidate.x, value.z - candidate.z) < 12)) candidates.push(candidate);
  }
  const hasSeparatedPair = candidates.some((candidate, index) => candidates.slice(index + 1).some((other) => Math.hypot(candidate.x - other.x, candidate.z - other.z) >= 20));
  if (candidates.length < 2 || !hasSeparatedPair) {
    stage.available = true;
    stage.success = false;
    stage.reason = "no two separated road/transport anchors were available for an autonomous stop pair";
  } else {
    const mode = "bus";
    const stopPrefab = await selectTransportStopPrefab(mode);
    const stopResults: JsonRecord[] = [];
    const verifiedStopResults: JsonRecord[] = [];
    for (const anchor of candidates.slice(0, 24)) {
      const tooCloseToVerifiedStop = verifiedStopResults.some((result) => {
        const position = positionOf(asRecord(result.readback));
        return Boolean(position && Math.hypot(position.x - anchor.x, position.z - anchor.z) < 20);
      });
      if (tooCloseToVerifiedStop) {
        stopResults.push({ success: false, skipped: true, mode, anchor, prefab: stopPrefab.name ?? null, reason: "candidate is within 20m of an already verified stop" });
        continue;
      }
      const result = await executeVerifiedTransportStop(mode, anchor, stopPrefab.name, force);
      stopResults.push(result);
      if (result.success === true && asRecord(result.readback)) verifiedStopResults.push(result);
      if (verifiedStopResults.length >= 2) break;
      await delay(350);
    }
    stage.stopPrefab = stopPrefab;
    stage.stops = stopResults;
    const successfulStops = verifiedStopResults.map((result) => asRecord(result.readback)).filter((value): value is JsonRecord => Boolean(value));
    const stopEntities = successfulStops.map(stopEntityRef);
    const stopPoints = successfulStops.map(positionOf).filter((value): value is WorldPoint => Boolean(value));
    if (stopPoints.length >= 2 && stopEntities.length === stopPoints.length && stopEntities.every((value): value is { index: number; version: number } => value !== null) && caps.transit_lines === true && caps.transit_stop_attachment === true) {
      stage.lines = [await executeVerifiedTransportLine(mode, stopPoints, stopEntities, force)];
    } else {
      stage.lines = [{ success: false, skipped: true, reason: "two verified stops plus transit_lines and transit_stop_attachment capabilities are required for a bound route" }];
    }
    stage.available = true;
    const stopsVerified = successfulStops.length >= 2;
    const lineVerified = asArray(stage.lines).some((line) => asRecord(line)?.success === true);
    stage.success = stopsVerified && lineVerified;
  }

  if (includeTrack && caps.track_construction === true && transportEntries.length > 0) {
    try {
      const trackPoints = arrayPoints(transportEntries.find((entry) => (asString(entry.mode) ?? "").toLowerCase().includes("rail") || (asString(entry.mode) ?? "").toLowerCase().includes("metro"))?.points);
      if (trackPoints.length >= 2) {
        const selectedTrack = await selectTrackPrefab(undefined, "train");
        const trackPlan = makeRoadPlan({ start: trackPoints[0], end: trackPoints[trackPoints.length - 1], controlPoints: trackPoints.slice(1, -1), geometry: trackPoints.length > 2 ? "spline" : "straight", maxSegmentLength: 800, maxSlope: 0.06, role: "rail track" });
        stage.track = await executeVerifiedRoadPlan(trackPlan, selectedTrack.name, force, Math.min(8, trackPlan.segments.length));
        stage.success = stage.success === true && asRecord(stage.track)?.success === true;
      } else {
        stage.track = { success: false, skipped: true, reason: "no rail/metro transport spine with at least two points was present in the plan" };
        stage.success = false;
      }
    } catch (error) {
      stage.track = { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  } else if (includeTrack) {
    stage.track = { success: false, skipped: true, reason: "track_construction=false in the live bridge contract" };
    stage.success = false;
  }
  return stage;
}

async function runSimulationAndObserve(hours: number, speed = 4): Promise<JsonRecord> {
  if (hours <= 0) return { success: true, skipped: true, reason: "runSimulationHours was zero" };
  const request = await bridgeJson<JsonRecord>(`/sim/run${query({ hours, speed })}`, 20_000);
  let latest: unknown;
  // The native bridge reports frames, not wall-clock completion.  A fixed
  // 40-second window is enough for a smoke test but falsely fails longer
  // autonomous growth runs while the game is still progressing normally.
  const maxAttempts = Math.max(80, Math.min(2400, Math.ceil(hours * 80)));
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await delay(500);
    const state = await bestEffort("/state", 5_000);
    if (!state.ok) continue;
    latest = state.value;
    const simulation = asRecord(asRecord(state.value)?.simulation);
    if (simulation?.paused === true) return { success: true, request, completed: true, attempts: attempt, state: state.value };
  }
  const pause = await bestEffort(`/sim/control${query({ paused: true })}`, 10_000);
  return { success: false, request, completed: false, attempts: maxAttempts, state: latest ?? null, pause, reason: "simulation did not report paused at the requested target within the bounded observation window; the bridge was paused before validation continued" };
}

async function captureMultiAngleViews(center: WorldPoint, count: number, zoom: number): Promise<JsonRecord[]> {
  const views: JsonRecord[] = [];
  const angles = [0, 90, 180, 270].slice(0, Math.max(1, Math.min(4, count)));
  for (const angleX of angles) {
    const camera = await bestEffort(`/camera/set${query({ x: center.x, z: center.z, angleX, angleY: 55, zoom })}`, 20_000);
    const screenshotCaptured = await captureScreenshot();
    views.push({ angleX, camera, screenshotCaptured });
  }
  return views;
}

function linePoints(start: WorldPoint, end: WorldPoint, spacing: number, maximum: number): WorldPoint[] {
  const length = Math.hypot(end.x - start.x, end.z - start.z);
  const count = Math.max(2, Math.min(maximum, Math.ceil(length / Math.max(8, spacing)) + 1));
  return Array.from({ length: count }, (_, index) => {
    const t = index / Math.max(1, count - 1);
    return { x: start.x + (end.x - start.x) * t, z: start.z + (end.z - start.z) * t };
  });
}

function brushPoints(center: WorldPoint, radius: number, count: number): WorldPoint[] {
  const safeCount = Math.max(1, Math.min(500, count));
  return Array.from({ length: safeCount }, (_, index) => {
    const golden = Math.PI * (3 - Math.sqrt(5));
    const radial = radius * Math.sqrt((index + 0.5) / safeCount);
    const angle = index * golden;
    return { x: center.x + Math.cos(angle) * radial, z: center.z + Math.sin(angle) * radial };
  });
}

export async function placeDecorationObject(
  category: "tree" | "prop",
  position: WorldPoint,
  prefab: string | undefined,
  rotation: number,
  execute: boolean,
  force: boolean,
): Promise<JsonRecord> {
  const selected = prefab
    ? { name: prefab, selection: "caller-selected exact runtime prefab" }
    : await selectDecorationPrefab(category, category === "prop" ? "Bench" : undefined);
  const endpoint = category === "tree" ? "/build/place" : "/build/prop";
  const nativePreview = await bridgeJson<JsonRecord>(`${endpoint}${query({ prefab: selected.name, x: position.x, y: position.y, z: position.z, rotation, dryRun: true, force: force || undefined })}`, 20_000);
  if (!execute) return { success: true, dryRun: true, category, selected, position, nativePreview };
  const before = await bestEffort(`/city/${category === "tree" ? "objects" : "props"}${query({ query: selected.name, x: position.x, z: position.z, radius: 100, limit: 500 })}`, 20_000);
  const beforeKeys = before.ok ? entityKeys(before.value, category === "tree" ? "objects" : "props") : new Set<string>();
  const nativeRequest = await bridgeJson<JsonRecord>(`${endpoint}${query({ prefab: selected.name, x: position.x, y: position.y, z: position.z, rotation, force: force || undefined })}`, 20_000);
  let readback: JsonRecord | undefined;
  let latest: JsonRecord | undefined;
  for (let attempt = 1; attempt <= 16; attempt++) {
    await delay(250);
    const result = await bestEffort(`/city/${category === "tree" ? "objects" : "props"}${query({ query: selected.name, x: position.x, z: position.z, radius: 100, limit: 500 })}`, 20_000);
    if (!result.ok) continue;
    latest = asRecord(result.value);
    readback = extractRows(result.value, category === "tree" ? "objects" : "props").map(asRecord).find((row) => {
      const key = rowEntityKey(row);
      const actualPosition = positionOf(row);
      return Boolean(key && !beforeKeys.has(key) && actualPosition && Math.hypot(actualPosition.x - position.x, actualPosition.z - position.z) <= 100);
    });
    if (readback) break;
  }
  return { success: Boolean(readback), dryRun: false, category, selected, position, nativePreview, nativeRequest, readback: readback ?? null, latest: latest ?? null, verification: { entityReadback: Boolean(readback), prefab: selected.name } };
}

function roadAnchorsFromExecution(executedRoads: JsonRecord[]): WorldPoint[] {
  const result: WorldPoint[] = [];
  for (const entry of executedRoads) {
    for (const segmentValue of asArray(entry.results)) {
      const segment = asRecord(segmentValue);
      const readbacks = asArray(segment?.readbackSegments).map(asRecord).filter((value): value is JsonRecord => Boolean(value));
      const fallback = asRecord(segment?.readback);
      for (const readback of readbacks.length > 0 ? readbacks : (fallback ? [fallback] : [])) {
        const start = positionOf(readback.start);
        const end = positionOf(readback.end);
        if (start) result.push(start);
        if (end) result.push(end);
      }
    }
  }
  const unique: WorldPoint[] = [];
  for (const candidate of result) {
    if (!unique.some((value) => Math.hypot(value.x - candidate.x, value.z - candidate.z) < 8)) unique.push(candidate);
  }
  return unique;
}

function roadSideAnchorsFromExecution(executedRoads: JsonRecord[]): WorldPoint[] {
  const result: WorldPoint[] = [];
  for (const entry of executedRoads) {
    for (const segmentValue of asArray(entry.results)) {
      const segment = asRecord(segmentValue);
      const readbacks = asArray(segment?.readbackSegments).map(asRecord).filter((value): value is JsonRecord => Boolean(value));
      const fallback = asRecord(segment?.readback);
      for (const readback of readbacks.length > 0 ? readbacks : (fallback ? [fallback] : [])) {
        const start = positionOf(readback.start);
        const end = positionOf(readback.end);
        if (!start || !end) continue;
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const length = Math.hypot(dx, dz);
        if (length < 8) continue;
        const perpendicular = { x: -dz / length, z: dx / length };
        const midpoint = { x: (start.x + end.x) / 2, z: (start.z + end.z) / 2 };
        for (const offset of [18, 30, 44, 60]) {
          result.push({ x: midpoint.x + perpendicular.x * offset, z: midpoint.z + perpendicular.z * offset });
          result.push({ x: midpoint.x - perpendicular.x * offset, z: midpoint.z - perpendicular.z * offset });
        }
      }
    }
  }
  return result;
}

function uniqueWorldPoints(points: WorldPoint[], tolerance = 8): WorldPoint[] {
  const result: WorldPoint[] = [];
  for (const candidate of points) {
    if (!result.some((value) => Math.hypot(value.x - candidate.x, value.z - candidate.z) < tolerance)) result.push(candidate);
  }
  return result;
}

function scalePolygonAroundCentre(polygon: WorldPoint[], scale: number): WorldPoint[] {
  if (polygon.length === 0 || scale >= 0.999) return polygon;
  const centre = polygon.reduce((sum, value) => ({ x: sum.x + value.x, z: sum.z + value.z }), { x: 0, z: 0 });
  centre.x /= polygon.length;
  centre.z /= polygon.length;
  return polygon.map((value) => ({ x: centre.x + (value.x - centre.x) * scale, z: centre.z + (value.z - centre.z) * scale }));
}

interface MasterCycleOptions {
  execute: boolean;
  roadPrefab?: string;
  districtPrefab?: string;
  maxSegments: number;
  maxDistricts: number;
  maxTrees: number;
  maxProps: number;
  maxServiceBuildings: number;
  includeLandscape: boolean;
  includeTransit: boolean;
  includeServices: boolean;
  includeTrack: boolean;
  force: boolean;
  resume: boolean;
  runSimulationHours: number;
  screenshotViews: number;
  failFast: boolean;
}

async function runMasterPlanCycle(plan: JsonRecord, options: MasterCycleOptions): Promise<JsonRecord> {
  const corridorPlans = planCorridors(plan, options.maxSegments);
  const districts = asArray(plan.districts).slice(0, options.maxDistricts);
  const localRoadPlans = planDistrictLocalRoads(plan, options.maxDistricts);
  const corridorSegments = corridorPlans.reduce((sum, entry) => sum + entry.plan.segments.length, 0);
  const localSegments = localRoadPlans.reduce((sum, entry) => sum + entry.plan.segments.length, 0);
  // Always reserve a small local-street budget when districts were requested.
  // A long ring must not consume the entire budget before zoning has any road
  // frontage to work with. The native validator still decides every segment.
  const reservedLocalSegments = Math.min(
    localSegments,
    Math.min(districts.length, Math.max(0, options.maxSegments - 1)),
  );
  const corridorBudget = Math.max(0, options.maxSegments - reservedLocalSegments);
  const plannedSegments = Math.min(options.maxSegments, corridorBudget + reservedLocalSegments);
  const capabilitiesResult = await bestEffort("/capabilities", 5_000);
  const preview = {
    kind: "master-plan-execution-preview",
    corridorCount: corridorPlans.length,
    districtCount: districts.length,
    localRoadPlanCount: localRoadPlans.length,
    plannedSegments,
    segmentBudget: { total: options.maxSegments, corridor: corridorBudget, reservedLocal: reservedLocalSegments },
    stages: [
      "pause and create a named preflight save",
      "observe state, capabilities, terrain-adjacent readings, demand, services, labor, zoning, roads and buildings",
      "build hierarchical skeleton corridors with runtime road-prefab selection and per-segment native readback",
      "build two local streets per district within the segment budget",
      "create district polygons and verify district entities",
      "zone each district near the local street cross",
      "place runtime-discovered utility, safety, healthcare and education buildings when requested",
      "observe and, when native warning locations permit a bounded repair, build/read back utility network courses and re-check water/sewage/electricity notifications",
      "place native bus stops and bind a native route when the live capabilities permit it; optionally build physical rail track",
      "paint native surfaces, place trees and props, then inspect screenshots",
      "run the requested simulation interval, re-read demand/services/labor/notifications/road graph/transport analysis, and capture multi-angle screenshots",
      "create a final named save; resume only after validation when requested; load the preflight checkpoint if a later stage fails",
    ],
    corridors: corridorPlans.map((entry) => ({ name: entry.name, hierarchy: entry.hierarchy, segments: entry.plan.segments.length, length: entry.plan.length, issues: entry.plan.issues })),
    localRoads: localRoadPlans.map((entry) => ({ district: entry.district, segments: entry.plan.segments.length, length: entry.plan.length, issues: entry.plan.issues })),
    districtNames: districts.map((value) => asString(asRecord(value)?.name) ?? "unnamed district"),
    capabilities: capabilitiesResult.ok ? capabilitiesResult.value : { status: "unavailable", error: capabilitiesResult.error },
    safety: { dryRunDefault: true, failFast: options.failFast, automaticRollback: true, failurePolicy: "pause and return every completed stage; the preflight save is a native rollback target, while the final save is emitted only after validation" },
  };
  if (!options.execute) return { success: true, dryRun: true, preview };
  if (plannedSegments === 0 && districts.length === 0) return { success: false, dryRun: true, error: "master plan contains no executable corridors or districts", preview };

  const stages: JsonRecord[] = [];
  const checkpoints: JsonRecord[] = [];
  const executedRoads: JsonRecord[] = [];
  const executedDistricts: JsonRecord[] = [];
  const executedZones: JsonRecord[] = [];
  let pause: unknown;
  try {
    pause = await bridgeJson(`/sim/control${query({ paused: true })}`);
    checkpoints.push(await saveCheckpoint("preflight"));
    const survey = await readCitySnapshot();
    stages.push({ id: "survey", success: true, snapshot: survey });

    let remainingCorridorSegments = corridorBudget;
    for (const corridor of corridorPlans) {
      if (remainingCorridorSegments <= 0) break;
      const selected = await selectRoadPrefab(options.roadPrefab, corridor.hierarchy);
      const limited = Math.min(remainingCorridorSegments, corridor.plan.segments.length);
      const result = await executeAdaptiveRoadPlan(corridor.plan, selected, options.force, limited);
      executedRoads.push({ stage: "skeleton", corridor: corridor.name, hierarchy: corridor.hierarchy, ...result });
      remainingCorridorSegments -= Math.max(0, numberField(result, "verifiedSegments") ?? 0);
      if (!result.success && options.failFast) throw new Error(`skeleton corridor '${corridor.name}' failed native road readback`);
    }
    // Keep the local-street reservation independent from the corridor budget.
    // A corridor can consume its entire allowed share; it must not starve the
    // road frontage needed by the district/zoning stages.
    let remainingLocalSegments = reservedLocalSegments;
    if (remainingLocalSegments > 0 && localRoadPlans.length > 0) {
      // Prefer the discovered service-access road for local streets.  Some
      // native network intersections split a Medium Road into Small Road
      // edges; starting with the smaller unlocked road avoids needlessly
      // spending a retry on that conversion while keeping the exact runtime
      // prefab visible in the execution evidence.
      const selectedLocal = options.roadPrefab
        ? await selectRoadPrefab(options.roadPrefab, "local street")
        : await selectServiceAccessRoadPrefab();
      for (const local of localRoadPlans) {
        if (remainingLocalSegments <= 0) break;
        const candidatePlans = [local.plan, ...localRoadFallbackPlans(local.plan)];
        for (let candidateIndex = 0; candidateIndex < candidatePlans.length && remainingLocalSegments > 0; candidateIndex++) {
          const candidatePlan = candidatePlans[candidateIndex];
          const limited = Math.min(remainingLocalSegments, candidatePlan.segments.length);
          const result = await executeAdaptiveRoadPlan(candidatePlan, selectedLocal, options.force, limited);
          executedRoads.push({
            stage: "district-local",
            district: local.district,
            candidateIndex,
            candidate: {
              start: candidatePlan.segments[0]?.start ?? null,
              end: candidatePlan.segments[candidatePlan.segments.length - 1]?.end ?? null,
              role: candidatePlan.segments[0]?.role ?? "local street",
            },
            ...result,
          });
          remainingLocalSegments -= Math.max(0, numberField(result, "verifiedSegments") ?? 0);
          if (result.success === true) break;
          if (options.failFast) throw new Error(`local road plan for '${local.district}' failed native road readback`);
        }
      }
    }
    const remainingSegments = remainingCorridorSegments + remainingLocalSegments;
    stages.push({ id: "roads", success: executedRoads.some((entry) => (numberField(entry, "verifiedSegments") ?? 0) > 0), executed: executedRoads, remainingSegments });

    for (const districtValue of districts) {
      const district = asRecord(districtValue);
      const polygon = arrayPoints(district?.polygon);
      if (polygon.length < 3) continue;
      const districtName = asString(district?.name) ?? `CS2MCP district ${executedDistricts.length + 1}`;
      const attempts: JsonRecord[] = [];
      let verified: JsonRecord | undefined;
      for (const scale of [1, 0.65, 0.42]) {
        const candidatePolygon = scalePolygonAroundCentre(polygon, scale);
        try {
          const result = await executeVerifiedDistrict(candidatePolygon, districtName, options.districtPrefab);
          attempts.push({ scale, polygon: candidatePolygon, result });
          if (result.success === true) {
            verified = { ...result, polygon: candidatePolygon, scale };
            break;
          }
        } catch (error) {
          attempts.push({ scale, polygon: candidatePolygon, success: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (verified) {
        executedDistricts.push({ name: districtName, attempts, ...verified });
      } else {
        executedDistricts.push({ name: districtName, success: false, attempts, error: "native district validation rejected every bounded polygon candidate" });
        if (options.failFast) throw new Error(`district '${districtName}' failed native readback`);
      }
    }
    stages.push({ id: "districts", success: executedDistricts.some((entry) => entry.success === true), executed: executedDistricts });

    const planCenter = centerOf(plan.centre) ?? { x: 0, z: 0 };
    const planBounds = parseBounds(plan.bounds);
    const observedRoadsForZoning = await bestEffort(`/city/roads${query({ x: planCenter.x, z: planCenter.z, radius: planBounds ? Math.hypot(planBounds.maxX - planBounds.minX, planBounds.maxZ - planBounds.minZ) / 2 : 1000, limit: 500 })}`);
    const observedRoadExecutionForZoning: JsonRecord[] = observedRoadsForZoning.ok
      ? [{ results: extractRows(observedRoadsForZoning.value, "roads").map((row) => ({ readback: row })) }]
      : [];
    const zoningRoadSources = [...executedRoads, ...observedRoadExecutionForZoning];
    const zoningRoadAnchors = roadAnchorsFromExecution(zoningRoadSources);
    const zoningSideAnchors = roadSideAnchorsFromExecution(zoningRoadSources);

    const zoneSelections = new Map<string, { name: string; discovery: JsonRecord; selection: string }>();
    for (const districtValue of districts) {
      const district = asRecord(districtValue);
      const center = centerOf(district?.centre) ?? centerOf(district?.center);
      if (!center) continue;
      const type = asString(district?.type) ?? "residential";
      try {
        let selected = zoneSelections.get(type);
        if (!selected) {
          selected = await selectZoneForDistrict(type);
          zoneSelections.set(type, selected);
        }
        const districtName = asString(district?.name) ?? type;
        const nearbyAnchors = uniqueWorldPoints([center, ...zoningRoadAnchors, ...zoningSideAnchors])
          .filter((candidate) => Math.hypot(candidate.x - center.x, candidate.z - center.z) <= 360)
          .sort((a, b) => Math.hypot(a.x - center.x, a.z - center.z) - Math.hypot(b.x - center.x, b.z - center.z))
          .slice(0, 12);
        const zoneAttempts: JsonRecord[] = [];
        let zoneResult: JsonRecord | undefined;
        for (const anchor of nearbyAnchors.length > 0 ? nearbyAnchors : [center]) {
          const attempt = await executeVerifiedZone(anchor, 86, selected.name, options.force);
          zoneAttempts.push({ anchor, result: attempt });
          if (attempt.success === true) {
            zoneResult = attempt;
            break;
          }
        }
        const finalZoneResult = zoneResult ?? zoneAttempts[zoneAttempts.length - 1]?.result ?? await executeVerifiedZone(center, 86, selected.name, options.force);
        executedZones.push({ district: districtName, selected, anchorAttempts: zoneAttempts, ...finalZoneResult });
      } catch (error) {
        executedZones.push({ district: asString(district?.name) ?? type, success: false, error: error instanceof Error ? error.message : String(error) });
        if (options.failFast) throw error;
      }
    }
    stages.push({ id: "zoning", success: executedZones.some((entry) => entry.success === true), executed: executedZones });

    const observedRoads = await bestEffort(`/city/roads${query({ x: planCenter.x, z: planCenter.z, radius: planBounds ? Math.hypot(planBounds.maxX - planBounds.minX, planBounds.maxZ - planBounds.minZ) / 2 : 1000, limit: 500 })}`);
    const observedRoadExecution: JsonRecord[] = observedRoads.ok ? [{ results: extractRows(observedRoads.value, "roads").map((row) => ({ readback: row })) }] : [];
    const anchorSources = [...executedRoads, ...observedRoadExecution];
    const serviceAccess = options.includeServices ? await ensureServiceAccessRoad(plan, options.force) : { success: true, skipped: true, reason: "includeServices=false" };
    if (serviceAccess.success === true) executedRoads.push({ stage: "service-access", ...serviceAccess });
    const serviceAnchorSources = serviceAccess.success === true ? [...anchorSources, { results: asArray(asRecord(serviceAccess.result)?.results) }] : anchorSources;
    const anchors = roadAnchorsFromExecution(serviceAnchorSources);
    const sideAnchors = roadSideAnchorsFromExecution(serviceAnchorSources);
    const serviceStage = options.includeServices ? await executeServiceStage(plan, [...sideAnchors, ...anchors], options.maxServiceBuildings, options.force) : { success: true, skipped: true, reason: "includeServices=false" };
    stages.push({ id: "services", accessRoad: serviceAccess, ...serviceStage });

    const utilityStage = options.includeServices
      ? await executeUtilityRepairStage(serviceStage, options.force)
      : { success: true, skipped: true, reason: "includeServices=false" };
    stages.push({ id: "utility-network", ...utilityStage });

    const transitStage = options.includeTransit ? await executeTransitStage(plan, anchors, options.includeTrack, options.force) : { success: true, skipped: true, reason: "includeTransit=false" };
    stages.push({ id: "transit", ...transitStage });

    const landscapeStage = options.includeLandscape ? await executeLandscapeStage(plan, options.maxTrees, options.maxProps, [...sideAnchors, ...anchors], options.force) : { success: true, skipped: true, reason: "includeLandscape=false" };
    stages.push({ id: "landscape", ...landscapeStage });

    const simulationStage = await runSimulationAndObserve(options.runSimulationHours);
    stages.push({ id: "simulation", ...simulationStage });

    const preRevisionSnapshot = await readCitySnapshot();
    const preRevisionNotifications = asRecord(asRecord(preRevisionSnapshot.notifications)?.data);
    const preRevisionNotificationRows = preRevisionNotifications ? extractRows(preRevisionNotifications, "notifications") : [];
    const revisionActions: JsonRecord[] = [];
    const successfulZonesBeforeRevision = executedZones.filter((entry) => entry.success === true).length;
    if (successfulZonesBeforeRevision < districts.length || preRevisionNotificationRows.length > 0 || serviceStage.success !== true || utilityStage.success !== true) {
      for (const districtValue of districts) {
        const district = asRecord(districtValue);
        const districtName = asString(district?.name) ?? asString(district?.type) ?? "district";
        const alreadyZoned = executedZones.some((entry) => entry.success === true && entry.district === districtName);
        if (alreadyZoned) continue;
        const anchor = anchors[revisionActions.length % Math.max(1, anchors.length)] ?? centerOf(district?.centre) ?? centerOf(plan.centre) ?? { x: 0, z: 0 };
        try {
          const selected = await selectZoneForDistrict(asString(district?.type) ?? "residential");
          const repair = await executeVerifiedZone(anchor, 72, selected.name, options.force);
          revisionActions.push({ kind: "zoning-repair", district: districtName, anchor, selected, repair });
          if (repair.success) executedZones.push({ district: districtName, revision: true, selected, ...repair });
        } catch (error) {
          revisionActions.push({ kind: "zoning-repair", district: districtName, success: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
      if ((serviceStage.success !== true || utilityStage.success !== true) && options.includeServices) {
        try {
          const serviceRepair = await executeServiceStage(plan, [...sideAnchors, ...anchors], Math.min(2, options.maxServiceBuildings), options.force);
          revisionActions.push({ kind: "service-repair", serviceRepair });
        } catch (error) {
          revisionActions.push({ kind: "service-repair", success: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    const revisionSimulation = revisionActions.length > 0 ? await runSimulationAndObserve(options.runSimulationHours) : { success: true, skipped: true, reason: "no observed notification or incomplete-zone/service gate required a repair" };
    stages.push({ id: "revision", triggered: revisionActions.length > 0 || preRevisionNotificationRows.length > 0, observedNotifications: preRevisionNotificationRows.length, actions: revisionActions, simulation: revisionSimulation });

    const finalSnapshot = await readCitySnapshot();
    const finalCaps = asRecord(asRecord(finalSnapshot.capabilities)?.data);
    const graph = finalCaps && capability(finalCaps, "road_graph") ? await bestEffort(`/road/graph${query({ pageSize: 500, includeLanes: false })}`, 30_000) : { ok: false as const, error: "road_graph=false or capabilities unavailable" };
    const transport = finalCaps && capability(finalCaps, "transport_analysis") ? await bestEffort(`/transport/analysis${query({ limit: 500 })}`, 20_000) : { ok: false as const, error: "transport_analysis=false or capabilities unavailable" };
    const notifications = asRecord(asRecord(finalSnapshot.notifications)?.data);
    const notificationRows = notifications ? extractRows(notifications, "notifications") : [];
    const validation = {
      snapshot: finalSnapshot,
      roadGraph: graph.ok ? { status: "observed", data: graph.value } : { status: "unavailable", error: graph.error },
      transportAnalysis: transport.ok ? { status: "observed", data: transport.value } : { status: "unavailable", error: transport.error },
      findings: notificationRows.length > 0 ? [{ code: "active_notifications", severity: "warning", count: notificationRows.length, recommendedAction: "inspect notifications before expanding the next district" }] : [],
    };
    const center = centerOf(plan.centre) ?? { x: 0, z: 0 };
    const screenshots = await captureMultiAngleViews(center, options.screenshotViews, Math.max(650, Math.min(2500, Math.hypot((asRecord(plan.bounds)?.maxX as number ?? center.x + 1000) - (asRecord(plan.bounds)?.minX as number ?? center.x - 1000), (asRecord(plan.bounds)?.maxZ as number ?? center.z + 1000) - (asRecord(plan.bounds)?.minZ as number ?? center.z - 1000)) * 0.35)));
    stages.push({ id: "validation", ...validation, screenshots });
    checkpoints.push(await saveCheckpoint("final"));

    const verifiedRoads = executedRoads.reduce((sum, entry) => sum + (numberField(entry, "verifiedSegments") ?? 0), 0);
    const successfulDistricts = executedDistricts.filter((entry) => entry.success === true).length;
    const successfulZones = executedZones.filter((entry) => entry.success === true).length;
    const qualityGates = {
      roadReadback: verifiedRoads === plannedSegments || corridorPlans.length === 0,
      districtReadback: successfulDistricts === districts.length || districts.length === 0,
      zoningReadback: successfulZones === districts.length || districts.length === 0,
      services: !options.includeServices || serviceStage.success === true,
      utilityConnectivity: !options.includeServices || utilityStage.success === true,
      transit: !options.includeTransit || transitStage.success === true,
      landscape: !options.includeLandscape || landscapeStage.success === true,
      simulation: simulationStage.success && revisionSimulation.success,
      multiAngleScreenshots: screenshots.filter((view) => view.screenshotCaptured === true).length >= Math.min(2, options.screenshotViews),
      nativeTrafficObservation: graph.ok,
      nativeTransportObservation: transport.ok,
    };
    if (options.resume) await bridgeJson(`/sim/control${query({ paused: false })}`);
    return {
      success: qualityGates.roadReadback && qualityGates.districtReadback && qualityGates.zoningReadback && qualityGates.services && qualityGates.utilityConnectivity && qualityGates.transit && qualityGates.landscape && qualityGates.simulation && qualityGates.multiAngleScreenshots && qualityGates.nativeTrafficObservation && qualityGates.nativeTransportObservation,
      dryRun: false,
      executed: true,
      pause,
      preview,
      stages,
      checkpoints,
      qualityGates,
      counts: { plannedSegments, verifiedRoads, plannedDistricts: districts.length, successfulDistricts, successfulZones },
      rollback: { available: true, preflightAndCheckpoints: checkpoints.map((checkpoint) => ({ label: checkpoint.label, name: checkpoint.name })), note: "native /game/rollback is available; the preflight checkpoint is retained as the recovery target" },
      resumed: options.resume,
      revisionHint: notificationRows.length > 0 || !graph.ok ? "inspect validation evidence and repair the highest-severity observed issue before the next autonomous cycle" : "quality gates passed for the requested bounded cycle; expand one district at a time and re-run the same observe/validate loop",
    };
  } catch (error) {
    await bestEffort(`/sim/control${query({ paused: true })}`);
    const preflightCheckpoint = checkpoints.find((checkpoint) => checkpoint.label === "preflight"
      && asRecord(checkpoint.result)?.ok === true);
    const rollback = await rollbackCheckpoint(preflightCheckpoint);
    return {
      success: false,
      dryRun: false,
      executed: true,
      pause,
      preview,
      stages,
      checkpoints,
      completedBeforeFailure: { roads: executedRoads, districts: executedDistricts, zones: executedZones },
      error: error instanceof Error ? error.message : String(error),
      rollback,
      failurePolicy: rollback.success
        ? "the native preflight checkpoint was loaded after the failure; verify /state before issuing another mutation"
        : "simulation was paused; the native rollback attempt did not complete, so inspect the returned checkpoint and load it with cs2_rollback_save",
    };
  }
}

function extractRows(payload: unknown, key: string): unknown[] {
  const record = asRecord(payload);
  return asArray(record?.[key]);
}

/**
 * Derive useful, page-aware road-network facts without discarding the native
 * graph payload.  The bridge remains the source of truth for every entity,
 * lane, connection, curve, and traffic field; this helper only aggregates
 * values that are already present in the response.  In particular,
 * bottleneckCandidates are signals, not a claim that a segment is congested.
 */
export function summarizeRoadGraphPayload(payload: unknown): JsonRecord {
  const root = asRecord(payload) ?? {};
  const segments = extractRows(payload, "segments")
    .map(asRecord)
    .filter((value): value is JsonRecord => Boolean(value));
  const nodes = extractRows(payload, "nodes")
    .map(asRecord)
    .filter((value): value is JsonRecord => Boolean(value));

  const degreeForNode = (node: JsonRecord): number => {
    const reported = numberField(node, "degree");
    if (reported !== undefined) return Math.max(0, reported);
    return asArray(node.connectedEdges).length;
  };
  const nodeEntity = (node: JsonRecord): JsonRecord | null => {
    const entity = asRecord(node.entity) ?? {};
    return typeof entity.index === "number" && typeof entity.version === "number"
      ? { index: entity.index, version: entity.version }
      : null;
  };
  const segmentEntity = (segment: JsonRecord): JsonRecord | null => {
    const entity = asRecord(segment.entity) ?? {};
    return typeof entity.index === "number" && typeof entity.version === "number"
      ? { index: entity.index, version: entity.version }
      : null;
  };

  const junctions = nodes
    .map((node) => ({ node, degree: degreeForNode(node) }))
    .filter(({ degree }) => degree > 2)
    .sort((left, right) => right.degree - left.degree)
    .slice(0, 32)
    .map(({ node, degree }) => ({
      entity: nodeEntity(node),
      position: asRecord(node.position) ?? null,
      degree,
      connectedEdges: asArray(node.connectedEdges),
      outsideConnection: node.outsideConnection === true,
    }));
  const deadEnds = nodes
    .map((node) => ({ node, degree: degreeForNode(node) }))
    .filter(({ degree }) => degree <= 1)
    .slice(0, 64)
    .map(({ node, degree }) => ({ entity: nodeEntity(node), position: asRecord(node.position) ?? null, degree }));

  const outsideConnectionSegments = segments.filter((segment) => segment.outsideConnection === true);
  const candidates = segments
    .map((segment, index) => {
      const traffic = asRecord(segment.traffic);
      const density = numberField(traffic, "density");
      const laneObjectCount = numberField(traffic, "laneObjectCount");
      const laneCount = numberField(segment, "laneCount");
      const occupancyPerLane = laneObjectCount !== undefined && laneCount !== undefined && laneCount > 0
        ? laneObjectCount / laneCount
        : undefined;
      const pressureScore = (density ?? 0) + (occupancyPerLane ?? 0);
      if (density === undefined && laneObjectCount === undefined) return undefined;
      return {
        rankSourceIndex: index,
        entity: segmentEntity(segment),
        prefab: asString(segment.prefab) ?? null,
        startNode: asRecord(segment.startNode) ?? null,
        endNode: asRecord(segment.endNode) ?? null,
        length: numberField(segment, "length") ?? null,
        laneCount: laneCount ?? null,
        density: density ?? null,
        laneObjectCount: laneObjectCount ?? null,
        occupancyPerLane: occupancyPerLane ?? null,
        pressureScore,
        outsideConnection: segment.outsideConnection === true,
        interpretation: "candidate ranked from native density and/or instantaneous lane-object count; validate with simulation-time observations before calling it congestion",
      };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort((left, right) => right.pressureScore - left.pressureScore)
    .slice(0, 20);

  const totalEdges = numberField(root, "totalEdges");
  const totalNodes = numberField(root, "totalNodes");
  const totalLanes = numberField(root, "totalLanes") ?? segments.reduce((sum, segment) => sum + (numberField(segment, "laneCount") ?? 0), 0);
  const observations: string[] = [];
  if (totalEdges !== undefined && totalEdges > segments.length) observations.push("the response is paged; request additional pages before making city-wide topology claims");
  if (deadEnds.length > 0) observations.push("one or more returned nodes have degree <= 1; inspect their connectedEdges and native geometry before labeling them as defects");
  if (junctions.length > 0) observations.push("junction candidates are nodes with native degree > 2; use their connectedEdges to answer intersection-topology questions");
  if (candidates.length === 0) observations.push("no native density or lane-object signal was returned for the selected page");
  if (observations.length === 0) observations.push("the selected native graph page contains topology and traffic fields but no derived warning signal");

  return {
    scope: {
      page: numberField(root, "page") ?? 0,
      pageSize: numberField(root, "pageSize") ?? null,
      returnedEdges: segments.length,
      returnedNodes: nodes.length,
      totalEdges: totalEdges ?? segments.length,
      totalNodes: totalNodes ?? nodes.length,
      pageScoped: totalEdges !== undefined ? totalEdges > segments.length : false,
    },
    segmentCount: segments.length,
    nodeCount: nodes.length,
    laneCount: totalLanes,
    junctionCount: junctions.length,
    deadEndCount: deadEnds.length,
    outsideConnectionSegmentCount: outsideConnectionSegments.length,
    outsideConnectionNodeCount: nodes.filter((node) => node.outsideConnection === true).length,
    junctions,
    deadEnds,
    bottleneckCandidates: candidates,
    trafficSignals: {
      segmentsWithDensity: segments.filter((segment) => numberField(asRecord(segment.traffic), "density") !== undefined).length,
      segmentsWithLaneObjectCount: segments.filter((segment) => numberField(asRecord(segment.traffic), "laneObjectCount") !== undefined).length,
      cityTraffic: asRecord(root.traffic) ?? null,
    },
    observations,
  };
}

function transportLineByIndex(payload: unknown, index: number): JsonRecord | undefined {
  return extractRows(payload, "lines")
    .map(asRecord)
    .find((line) => asRecord(line?.entity)?.index === index);
}

function transportLineEntityKey(line: JsonRecord | undefined): string | undefined {
  const entity = asRecord(line?.entity);
  return typeof entity?.index === "number" && typeof entity?.version === "number" ? `${entity.index}:${entity.version}` : undefined;
}

function transportStopEntityKey(stop: JsonRecord | undefined): string | undefined {
  const entity = asRecord(stop?.entity);
  return typeof entity?.index === "number" && typeof entity.version === "number" ? `${entity.index}:${entity.version}` : undefined;
}

function transportStopRows(payload: unknown): JsonRecord[] {
  const root = asRecord(payload);
  return asArray(root?.stops).map(asRecord).filter((value): value is JsonRecord => Boolean(value));
}

function transportStopMatchesAnchor(stop: JsonRecord, anchor: WorldPoint, radius: number): boolean {
  const position = positionOf(stop);
  return Boolean(position && Math.hypot(position.x - anchor.x, position.z - anchor.z) <= radius);
}

function transportLinePoints(line: JsonRecord | undefined): WorldPoint[] {
  return asArray(line?.waypoints).map(positionOf).filter((value): value is WorldPoint => Boolean(value));
}

function transportLineConnections(line: JsonRecord | undefined): Array<string | undefined> {
  return asArray(line?.waypoints).map((waypoint) => {
    const connection = asRecord(asRecord(waypoint)?.connection);
    return typeof connection?.index === "number" && typeof connection.version === "number" ? `${connection.index}:${connection.version}` : undefined;
  });
}

function transportLineMatchesConnections(line: JsonRecord | undefined, target: Array<{ index: number; version: number } | null>): boolean {
  const current = transportLineConnections(line);
  return current.length === target.length && current.every((key, index) => {
    const expected = target[index];
    return expected === null ? key === undefined : key === `${expected.index}:${expected.version}`;
  });
}

function transportLineMatchesPoints(line: JsonRecord | undefined, target: WorldPoint[], tolerance = 0.75): boolean {
  const current = transportLinePoints(line);
  return current.length === target.length && current.every((pointValue, index) => {
    const targetPoint = target[index];
    return Math.abs(pointValue.x - targetPoint.x) <= tolerance && Math.abs(pointValue.z - targetPoint.z) <= tolerance;
  });
}

async function pollTransportLine(
  index: number,
  predicate: (line: JsonRecord | undefined) => boolean,
  attempts = 24,
): Promise<{ line?: JsonRecord; payload?: JsonRecord; attempts: number }> {
  let latest: JsonRecord | undefined;
  let latestLine: JsonRecord | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    latest = await bridgeJson<JsonRecord>(`/transport/lines${query({ limit: 200 })}`, 20_000);
    latestLine = transportLineByIndex(latest, index);
    if (predicate(latestLine)) return { line: latestLine, payload: latest, attempts: attempt };
  }
  return { line: latestLine, payload: latest, attempts };
}

function transportAnalysisLineRows(payload: unknown): JsonRecord[] {
  const root = asRecord(payload);
  return asArray(root?.lineAnalytics)
    .map(asRecord)
    .filter((value): value is JsonRecord => Boolean(value));
}

function transportAnalysisLineByEntity(payload: unknown, entity: { index: number; version: number }): JsonRecord | undefined {
  const expected = `${entity.index}:${entity.version}`;
  return transportAnalysisLineRows(payload).find((line) => entityKey(line.entity) === expected);
}

function transportAnalysisVehicleKeys(line: JsonRecord | undefined): Set<string> {
  return new Set(asArray(line?.vehicleEntities)
    .map(entityKey)
    .filter((value): value is string => Boolean(value)));
}

async function pollTransportAnalysisLine(
  entity: { index: number; version: number },
  predicate: (line: JsonRecord | undefined) => boolean,
  attempts = 32,
): Promise<{ line?: JsonRecord; payload?: JsonRecord; attempts: number }> {
  let latest: JsonRecord | undefined;
  let latestLine: JsonRecord | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await delay(250);
    latest = await bridgeJson<JsonRecord>(`/transport/analysis${query({ limit: 500, lineLimit: 500 })}`, 20_000);
    latestLine = transportAnalysisLineByEntity(latest, entity);
    if (predicate(latestLine)) return { line: latestLine, payload: latest, attempts: attempt };
  }
  return { line: latestLine, payload: latest, attempts };
}

function planCorridors(plan: JsonRecord, maximumSegments: number): Array<{ name: string; hierarchy: string; plan: RoadPlan }> {
  const corridors = asArray(plan.corridors);
  const result: Array<{ name: string; hierarchy: string; plan: RoadPlan }> = [];
  for (const corridorValue of corridors) {
    const corridor = asRecord(corridorValue);
    const points = arrayPoints(corridor?.points);
    if (points.length < 2) continue;
    const name = asString(corridor?.name) ?? "unnamed corridor";
    const hierarchy = asString(corridor?.hierarchy) ?? name;
    const path = makeRoadPlan({
      start: points[0],
      end: points[points.length - 1],
      controlPoints: points.slice(1, -1),
      geometry: points.length > 2 ? "spline" : "straight",
      maxSegmentLength: 1200,
      maxSlope: roadDesignSlope(hierarchy),
      role: hierarchy,
    });
    result.push({ name, hierarchy, plan: path });
    if (result.reduce((sum, entry) => sum + entry.plan.segments.length, 0) >= maximumSegments) break;
  }
  return result;
}

function planDistrictLocalRoads(plan: JsonRecord, maximumDistricts: number): Array<{ district: string; plan: RoadPlan }> {
  const districts = asArray(plan.districts).slice(0, maximumDistricts);
  // Reserve the first local frontage for every district before spending the
  // remaining local-road budget on second cross streets.  The master cycle
  // intentionally keeps a bounded total segment budget; interleaving the
  // horizontal and vertical plans would let one district consume both slots
  // while a later district receives no road frontage at all.
  const horizontalPlans: Array<{ district: string; plan: RoadPlan }> = [];
  const verticalPlans: Array<{ district: string; plan: RoadPlan }> = [];
  for (const districtValue of districts) {
    const district = asRecord(districtValue);
    const polygon = arrayPoints(district?.polygon);
    if (polygon.length < 3) continue;
    const minX = Math.min(...polygon.map((value) => value.x));
    const maxX = Math.max(...polygon.map((value) => value.x));
    const minZ = Math.min(...polygon.map((value) => value.z));
    const maxZ = Math.max(...polygon.map((value) => value.z));
    const center = centerOf(district?.centre) ?? centerOf(district?.center) ?? { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
    const marginX = Math.min(100, Math.max(24, (maxX - minX) * 0.18));
    const marginZ = Math.min(100, Math.max(24, (maxZ - minZ) * 0.18));
    const horizontal = makeRoadPlan({ start: { x: minX + marginX, z: center.z }, end: { x: maxX - marginX, z: center.z }, maxSegmentLength: 650, maxSlope: 0.12, role: "local street" });
    const vertical = makeRoadPlan({ start: { x: center.x, z: minZ + marginZ }, end: { x: center.x, z: maxZ - marginZ }, maxSegmentLength: 650, maxSlope: 0.12, role: "local street" });
    const name = asString(district?.name) ?? `district-${horizontalPlans.length + 1}`;
    horizontalPlans.push({ district: name, plan: horizontal });
    verticalPlans.push({ district: name, plan: vertical });
  }
  return [...horizontalPlans, ...verticalPlans];
}

function localRoadFallbackPlans(plan: RoadPlan): RoadPlan[] {
  const first = plan.segments[0]?.start ?? plan.points[0];
  const last = plan.segments[plan.segments.length - 1]?.end ?? plan.points[plan.points.length - 1];
  if (!first || !last) return [];
  const dx = last.x - first.x;
  const dz = last.z - first.z;
  const length = Math.hypot(dx, dz);
  if (!Number.isFinite(length) || length < 8) return [];
  const perpendicular = { x: -dz / length, z: dx / length };
  // Native network validation commonly rejects a frontage that crosses an
  // existing highway, ramp, protected entity, or a newly created junction.
  // Try short, parallel offsets so the planner can preserve the district's
  // intended orientation without inventing an unverified road or mutating
  // the failed entity.  The offsets are deliberately bounded and the caller
  // still applies the global segment budget and native readback gates.
  return [72, -72, 120, -120].map((offset) => makeRoadPlan({
    start: { x: first.x + perpendicular.x * offset, z: first.z + perpendicular.z * offset },
    end: { x: last.x + perpendicular.x * offset, z: last.z + perpendicular.z * offset },
    maxSegmentLength: plan.constraints.maxSegmentLength,
    maxSlope: plan.constraints.maxSlope,
    role: "local street fallback",
    level: plan.segments[0]?.level,
  }));
}

const pointSchema = z.object({
  x: z.number().describe("world X in meters"),
  z: z.number().describe("world Z in meters"),
  y: z.number().optional().describe("optional world elevation in meters"),
});

const entityRefSchema = z.object({
  index: z.number().int().min(0),
  version: z.number().int().min(0),
});

const nullableEntityRefSchema = entityRefSchema.nullable();

const boundsSchema = z.object({
  minX: z.number(),
  maxX: z.number(),
  minZ: z.number(),
  maxZ: z.number(),
});

const geometrySchema = z.enum(["straight", "bezier", "arc", "spline", "polyline"]);

async function selectUtilityPrefab(
  explicit: string | undefined,
  kind: "water" | "sewage" | "electricity" | "combined",
): Promise<{ name: string; discovery: JsonRecord; selection: string }> {
  if (explicit) {
    return { name: explicit, discovery: {}, selection: "caller-selected exact runtime utility prefab" };
  }
  const search = kind === "electricity"
    ? "High-voltage"
    : kind === "water"
      ? "Water Pipe"
      : kind === "sewage"
        ? "Sewage Pipe"
        : "Pipe";
  const discovery = await bridgeJson<JsonRecord>(`/prefabs${query({ category: "net", query: search, page: 0, pageSize: 200 })}`, 20_000);
  const candidates = asArray(discovery.prefabs)
    .map(asRecord)
    .filter((value): value is JsonRecord => Boolean(value))
    .filter((value) => validPrefab(value) !== undefined)
    .filter((value) => {
      const name = (asString(value.name) ?? "").toLowerCase();
      const type = (asString(value.type) ?? "").toLowerCase();
      if (kind === "electricity") return type.includes("powerline") || name.includes("voltage") || name.includes("ground cable");
      if (kind === "water") return type.includes("pipeline") && name.includes("water");
      if (kind === "sewage") return type.includes("pipeline") && name.includes("sewage");
      return type.includes("pipeline") && !name.includes("marker");
    });
  const score = (value: JsonRecord): number => {
    const name = (asString(value.name) ?? "").toLowerCase();
    return (name.includes("combined") ? 30 : 0)
      + (name.includes("small") ? 20 : 0)
      + (name.includes("ground cable") ? 20 : 0)
      - (name.includes("marker") ? 100 : 0);
  };
  const selected = [...candidates].sort((a, b) => score(b) - score(a))[0];
  const name = validPrefab(selected);
  if (!name) throw new BridgeCallError(`No unlocked runtime ${kind} utility prefab was discovered.`, 404, discovery);
  return { name, discovery, selection: "runtime PipelinePrefab/PowerLinePrefab discovery; native network validation remains authoritative" };
}

async function executeUtilityNetworkPlan(
  kind: "water" | "sewage" | "electricity" | "combined",
  points: WorldPoint[],
  prefab: string | undefined,
  execute: boolean,
  force: boolean,
  maxSegmentLength?: number,
  maxSlope?: number,
): Promise<JsonRecord> {
  const selected = await selectUtilityPrefab(prefab, kind);
  const plan = makeRoadPlan({
    start: points[0],
    end: points[points.length - 1],
    controlPoints: points.slice(1, -1),
    geometry: points.length > 2 ? "spline" : "straight",
    maxSegmentLength: maxSegmentLength ?? 600,
    maxSlope: maxSlope ?? 0.2,
    role: `${kind} utility network`,
  });
  const issueCountsValue = issueCounts(plan.issues);
  const preview = { kind, selected, points, plan, issueCounts: issueCountsValue };
  if (!execute || issueCountsValue.errors > 0) {
    return {
      success: issueCountsValue.errors === 0,
      dryRun: true,
      executed: false,
      executable: issueCountsValue.errors === 0,
      ...preview,
      note: issueCountsValue.errors > 0 ? "native utility construction was not attempted because the geometry plan has blocking issues" : "preview only; no utility network definition was emitted",
    };
  }

  const beforeNotifications = await bestEffort("/city/notifications?limit=500", 20_000);
  const beforeUtilities = await bestEffort(`/city/utilities${query({ kind })}`, 20_000);
  const network = await executeVerifiedRoadPlan(plan, selected.name, force);
  const afterNotifications = await bestEffort("/city/notifications?limit=500", 20_000);
  const afterUtilities = await bestEffort(`/city/utilities${query({ kind })}`, 20_000);
  const beforeSummary = beforeNotifications.ok ? utilityNotificationSummary(beforeNotifications.value) : { status: "unavailable", error: beforeNotifications.error };
  const afterSummary = afterNotifications.ok ? utilityNotificationSummary(afterNotifications.value) : { status: "unavailable", error: afterNotifications.error };
  const beforeCount = numberField(beforeSummary, "utilityWarningCount");
  const afterCount = numberField(afterSummary, "utilityWarningCount");
  return {
    success: network.success,
    dryRun: false,
    executed: true,
    ...preview,
    network,
    connectivity: {
      observed: beforeCount !== undefined && afterCount !== undefined,
      beforeWarningCount: beforeCount ?? null,
      afterWarningCount: afterCount ?? null,
      warningCountDelta: beforeCount !== undefined && afterCount !== undefined ? afterCount - beforeCount : null,
      improved: beforeCount !== undefined && afterCount !== undefined && afterCount < beforeCount,
      note: "native network readback proves the edge was created; connectivity is only considered improved when the native notification count decreases",
    },
    utilityObservation: {
      before: beforeUtilities.ok ? beforeUtilities.value : { status: "unavailable", error: beforeUtilities.error },
      after: afterUtilities.ok ? afterUtilities.value : { status: "unavailable", error: afterUtilities.error },
    },
  };
}

async function selectGreenwayPrefab(explicit: string | undefined): Promise<{ name: string; discovery: JsonRecord; selection: string }> {
  if (explicit) return { name: explicit, discovery: {}, selection: "caller-selected exact runtime PathwayPrefab" };
  const discovery = await bridgeJson<JsonRecord>(`/prefabs${query({ category: "net", query: "Path", page: 0, pageSize: 200 })}`, 20_000);
  const candidates = asArray(discovery.prefabs)
    .map(asRecord)
    .filter((value): value is JsonRecord => Boolean(value))
    .filter((value) => validPrefab(value) !== undefined)
    .filter((value) => {
      const name = (asString(value.name) ?? "").toLowerCase();
      const type = (asString(value.type) ?? "").toLowerCase();
      return type.includes("pathway") && !name.includes("invisible") && !name.includes("marker");
    });
  const selected = candidates.find((value) => (asString(value.name) ?? "").toLowerCase().includes("pavement")) ?? candidates[0];
  const name = validPrefab(selected);
  if (!name) throw new BridgeCallError("No unlocked runtime PathwayPrefab was discovered for a greenway.", 404, discovery);
  return { name, discovery, selection: "runtime PathwayPrefab discovery; native network validation remains authoritative" };
}

async function relocateObjectVerified(
  entity: { index: number; version: number },
  position: WorldPoint,
  rotation: number | undefined,
  execute: boolean,
): Promise<JsonRecord> {
  const capabilities = await bridgeJson<JsonRecord>("/capabilities", 5_000);
  if (!capability(capabilities, "object_transform")) {
    return { success: false, executed: false, available: false, capability: "object_transform", entity, position, rotation: rotation ?? null, reason: "object_transform=false in the live bridge contract; no relocation was emitted" };
  }
  const nativeRequest = await bridgeJson<JsonRecord>(`/object/transform${query({
    index: entity.index,
    version: entity.version,
    x: position.x,
    y: position.y,
    z: position.z,
    rotation,
    dryRun: !execute,
  })}`, 20_000);
  if (!execute) return { success: true, dryRun: true, executed: false, available: true, capability: "object_transform", entity, position, rotation: rotation ?? null, nativePreview: nativeRequest };
  let readback: unknown;
  let readbackError: string | undefined;
  let attempts = 0;
  for (attempts = 1; attempts <= 12; attempts++) {
    await delay(250);
    const candidate = await bestEffort(`/entity/inspect${query({ index: entity.index, version: entity.version })}`, 20_000);
    if (candidate.ok) {
      readback = candidate.value;
      break;
    }
    readbackError = candidate.error;
  }
  const observedPosition = positionOf(readback);
  const positionMatches = Boolean(observedPosition
    && Math.abs(observedPosition.x - position.x) <= 0.5
    && Math.abs(observedPosition.z - position.z) <= 0.5
    && (position.y === undefined || Math.abs((observedPosition.y ?? position.y) - position.y) <= 0.5));
  return {
    success: positionMatches,
    dryRun: false,
    executed: true,
    available: true,
    capability: "object_transform",
    entity,
    position,
    rotation: rotation ?? null,
    nativeRequest,
    readback: readback ?? { status: "unverified", error: readbackError ?? "entity readback did not complete" },
    verification: { attempts, entityReadback: readback !== undefined, positionMatches },
    note: positionMatches ? undefined : "native relocation was queued but the entity did not read back at the requested position",
  };
}

function yawFromQuaternion(value: unknown): number | undefined {
  const rotation = asRecord(value);
  if (!rotation || typeof rotation.x !== "number" || typeof rotation.y !== "number" || typeof rotation.z !== "number" || typeof rotation.w !== "number") return undefined;
  return Math.atan2(2 * (rotation.w * rotation.y + rotation.x * rotation.z), 1 - 2 * (rotation.y * rotation.y + rotation.x * rotation.x)) * 180 / Math.PI;
}

async function copyObjectVerified(
  source: { index: number; version: number },
  position: WorldPoint,
  rotation: number | undefined,
  execute: boolean,
  force: boolean,
): Promise<JsonRecord> {
  const inspected = await bridgeJson<JsonRecord>(`/entity/inspect${query({ index: source.index, version: source.version })}`, 20_000);
  const prefab = asString(inspected.prefab);
  if (!prefab) throw new BridgeCallError("source entity has no live PrefabRef; native copy cannot select a prefab", 400, inspected);
  const sourceRotation = rotation ?? yawFromQuaternion(inspected.rotation) ?? 0;
  const endpoints = [
    { key: "buildings", path: "/city/buildings" },
    { key: "props", path: "/city/props" },
    { key: "objects", path: "/city/objects" },
  ];
  const beforeKeys = new Set<string>();
  for (const endpoint of endpoints) {
    const before = await bestEffort(`${endpoint.path}${query({ query: prefab, x: position.x, z: position.z, radius: 180, limit: 500 })}`, 20_000);
    if (before.ok) for (const key of entityKeys(before.value, endpoint.key)) beforeKeys.add(key);
  }
  const nativePreview = await bridgeJson<JsonRecord>(`/build/place${query({ prefab, x: position.x, y: position.y, z: position.z, rotation: sourceRotation, dryRun: true, force: force || undefined })}`, 20_000);
  if (!execute) return { success: true, dryRun: true, executed: false, source, prefab, position, rotation: sourceRotation, nativePreview };
  const nativeRequest = await bridgeJson<JsonRecord>(`/build/place${query({ prefab, x: position.x, y: position.y, z: position.z, rotation: sourceRotation, force: force || undefined })}`, 20_000);
  let readback: JsonRecord | undefined;
  let readbackCategory: string | undefined;
  let attempts = 0;
  for (attempts = 1; attempts <= 16 && !readback; attempts++) {
    await delay(250);
    for (const endpoint of endpoints) {
      const latest = await bestEffort(`${endpoint.path}${query({ query: prefab, x: position.x, z: position.z, radius: 180, limit: 500 })}`, 20_000);
      if (!latest.ok) continue;
      readback = extractRows(latest.value, endpoint.key).map(asRecord).find((row) => {
        const key = rowEntityKey(row);
        const actual = positionOf(row);
        return Boolean(key && !beforeKeys.has(key) && actual && Math.hypot(actual.x - position.x, actual.z - position.z) <= 120);
      });
      if (readback) {
        readbackCategory = endpoint.key;
        break;
      }
    }
  }
  return {
    success: Boolean(readback),
    dryRun: false,
    executed: true,
    source,
    prefab,
    position,
    rotation: sourceRotation,
    nativePreview,
    nativeRequest,
    readback: readback ?? null,
    verification: { attempts, category: readbackCategory ?? null, entityReadback: Boolean(readback), positionMatches: Boolean(readback && positionOf(readback) && Math.hypot((positionOf(readback) as WorldPoint).x - position.x, (positionOf(readback) as WorldPoint).z - position.z) <= 120) },
    note: readback ? undefined : "native copy was queued but no new object/building readback matched the destination",
  };
}

export function registerAutonomyTools(server: McpServer): void {
  server.registerTool(
    "cs2_capabilities",
    {
      title: "Read actual CS2 MCP capabilities",
      description:
        "Query the bridge before using advanced construction. The response separates implemented native paths from unsupported operations; " +
        "an unsupported capability is never silently emulated by direct ECS mutation.",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonResult(await bridgeJson("/capabilities", 5_000));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_coordinate_info",
    {
      title: "Read the CS2 world coordinate contract",
      description: "Return the shared x/y/z, meters, rotation, world-bounds, terrain-sampling, and paging convention used by all advanced tools.",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonResult(await bridgeJson("/coordinate/info", 5_000));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_discover_assets",
    {
      title: "Discover runtime CS2 prefabs",
      description:
        "Search the currently running game's PrefabSystem and native zone/district catalogs without a fixed asset allow-list. Semantic categories such as highway, track, bridge, path, station, depot, park, signature, utility, and decoration are mapped to the appropriate runtime catalog and retain the exact returned prefab names.",
      inputSchema: {
        category: z.enum(["all", "building", "road", "net", "tree", "terraform", "brush", "prop", "surface", "transport", "zone", "district", "highway", "track", "bridge", "path", "utility", "station", "depot", "park", "signature", "decoration"]).optional(),
        query: z.string().optional().describe("case-insensitive runtime name substring"),
        page: z.number().int().min(0).optional(),
        pageSize: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ category, query: search, page, pageSize }) => {
      try {
        const semanticCatalog: Record<string, { category?: string; query?: string }> = {
          highway: { category: "road", query: "highway" },
          track: { category: "net", query: "track" },
          bridge: { category: "net", query: "bridge" },
          path: { category: "net", query: "path" },
          utility: { category: "net" },
          station: { category: "building", query: "station" },
          depot: { category: "building", query: "depot" },
          park: { category: "building", query: "park" },
          signature: { category: "building", query: "signature" },
          decoration: { category: "prop" },
        };
        if (category === "zone") {
          const payload = await bridgeJson<JsonRecord>(`/zones${query({ page, pageSize })}`, 20_000);
          return jsonResult({ assetCategory: category, ...payload });
        }
        if (category === "district") {
          const payload = await bridgeJson<JsonRecord>("/districts", 20_000);
          return jsonResult({ assetCategory: category, query: search ?? null, ...payload });
        }
        const semantic = semanticCatalog[category ?? ""];
        const discoveryCategory = semantic?.category ?? category ?? "all";
        const discoveryQuery = search ?? semantic?.query;
        const payload = await bridgeJson<JsonRecord>(`/prefabs${query({ category: discoveryCategory, query: discoveryQuery, page, pageSize })}`, 20_000);
        return jsonResult({ assetCategory: category ?? discoveryCategory, discoveryCategory, ...payload });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_query_entities",
    {
      title: "Query placed CS2 objects with spatial paging",
      description:
        "Query the native ECS through one bounded, paged surface. Filter by category (building, road, tree, object, prop, district, or all), exact world bounds or center/radius, and an optional prefab substring. Every row includes the runtime entity index/version needed by inspect, transform, upgrade, or demolish tools.",
      inputSchema: {
        category: z.enum(["all", "building", "road", "tree", "object", "prop", "district"]).optional(),
        query: z.string().optional(),
        bounds: boundsSchema.optional(),
        x: z.number().optional(),
        z: z.number().optional(),
        radius: z.number().min(1).max(20000).optional(),
        page: z.number().int().min(0).optional(),
        pageSize: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ category, query: search, bounds, x, z: zCoordinate, radius, page, pageSize }) => {
      try {
        if (bounds && (x !== undefined || zCoordinate !== undefined || radius !== undefined)) {
          return jsonResult({
            success: false,
            reason: "choose bounds or x/z/radius, not both",
            recommendedAction: "use the bounds object for a rectangular query or provide x, z, and optional radius for a circular query",
          });
        }
        if ((x === undefined) !== (zCoordinate === undefined)) {
          return jsonResult({ success: false, reason: "x and z must be supplied together", recommendedAction: "provide both center coordinates or use bounds" });
        }
        const params: Record<string, string | number | boolean | undefined> = {
          category: category ?? "all",
          query: search,
          page: page ?? 0,
          pageSize: pageSize ?? 100,
          x,
          z: zCoordinate,
          radius,
          minX: bounds?.minX,
          maxX: bounds?.maxX,
          minZ: bounds?.minZ,
          maxZ: bounds?.maxZ,
        };
        return jsonResult(await bridgeJson(`/city/entities${query(params)}`, 30_000));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_list_surfaces",
    {
      title: "List native surface areas",
      description: "Read native Game.Areas.Surface entities and their Area.Node polygons with bounded paging and optional center/radius filtering. Use the entity ids and polygon as post-paint evidence.",
      inputSchema: {
        query: z.string().optional(),
        x: z.number().optional(),
        z: z.number().optional(),
        radius: z.number().min(1).max(20000).optional(),
        page: z.number().int().min(0).optional(),
        pageSize: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ query: search, x, z: zCoordinate, radius, page, pageSize }) => {
      try {
        return jsonResult(await bridgeJson(`/city/surfaces${query({ query: search, x, z: zCoordinate, radius, page, pageSize })}`, 20_000));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_query_utilities",
    {
      title: "Read native water, sewage, and electricity networks",
      description:
        "Read PipelinePrefab/PowerLinePrefab edges and the native building connection components. A line being present is not treated as connected; use the returned graph references and utility notifications to decide whether repair is needed.",
      inputSchema: {
        kind: z.enum(["all", "pipeline", "water", "electricity", "power"]).optional(),
        x: z.number().optional(),
        z: z.number().optional(),
        radius: z.number().min(0).max(20000).optional(),
        page: z.number().int().min(0).optional(),
        pageSize: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ kind, x, z: zCoordinate, radius, page, pageSize }) => {
      try {
        const capabilities = await bridgeJson<JsonRecord>("/capabilities", 5_000);
        if (!capability(capabilities, "utility_network_observation")) {
          return jsonResult({ success: false, available: false, capability: "utility_network_observation", reason: "utility_network_observation=false in the live bridge contract; no utility values were inferred" });
        }
        return jsonResult(await bridgeJson(`/city/utilities${query({ kind, x, z: zCoordinate, radius, page, pageSize })}`, 30_000));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_build_utility_network",
    {
      title: "Build and verify a native utility network",
      description:
        "Build a bounded water, sewage, combined-pipe, or electricity course through the native network tool. The result includes per-segment ECS readback and before/after native utility notifications; construction success does not silently imply service connectivity.",
      inputSchema: {
        kind: z.enum(["water", "sewage", "electricity", "combined"]),
        points: z.array(pointSchema).min(2).max(128),
        prefab: z.string().optional().describe("exact runtime PipelinePrefab or PowerLinePrefab; omitted means dynamic discovery"),
        execute: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        force: z.boolean().optional(),
        maxSegmentLength: z.number().min(8).max(1500).optional(),
        maxSlope: z.number().min(0.001).max(1).optional(),
      },
    },
    async ({ kind, points, prefab, execute, dryRun, force, maxSegmentLength, maxSlope }) => {
      try {
        return jsonResult(await executeUtilityNetworkPlan(kind, points, prefab, execute === true && dryRun !== true, force === true, maxSegmentLength, maxSlope));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_analyze_map",
    {
      title: "Analyze map terrain and water",
      description:
        "Read the native height/water grid and return a compact terrain summary: elevation range, slope distribution, water coverage, buildable share, and planning observations. Use includeGrid only when raw samples are actually needed.",
      inputSchema: {
        resolution: z.number().int().min(16).max(256).optional(),
        slopeThreshold: z.number().min(0.01).max(1).optional(),
        includeGrid: z.boolean().optional(),
        includeEnvironment: z.boolean().optional().describe("also summarize native pollution/groundwater grids, outside-connection observations, and explicit resource/wind availability"),
      },
    },
    async ({ resolution, slopeThreshold, includeGrid, includeEnvironment }) => {
      try {
        const terrain = await readTerrain(resolution ?? 64);
        const summary = summarizeTerrain(terrain.snapshot, slopeThreshold ?? 0.12);
        let environment: JsonRecord | undefined;
        if (includeEnvironment ?? true) {
          const layers = ["groundWater", "groundWaterPollution", "groundPollution", "airPollution", "noisePollution"];
          const layerResults = await Promise.all(layers.map(async (layer) => [layer, await bestEffort(`/city/gridmap${query({ layer })}`, 30_000)] as const));
          const grids: JsonRecord = {};
          for (const [layer, result] of layerResults) grids[layer] = result.ok ? numericGridSummary(result.value) : { status: "unavailable", error: result.error };
          const capabilitiesResult = await bestEffort("/capabilities", 5_000);
          const caps = capabilitiesResult.ok ? capabilityMap(capabilitiesResult.value) : {};
          const [outside, directOutside, resources, wind, utilities] = await Promise.all([
            caps.transport_analysis === true ? bestEffort(`/transport/analysis${query({ limit: 500 })}`, 20_000) : { ok: false as const, error: "transport_analysis=false or capabilities unavailable" },
            caps.outside_connections === true ? bestEffort(`/city/outside-connections${query({ limit: 500 })}`, 20_000) : { ok: false as const, error: "outside_connections=false or capabilities unavailable" },
            caps.natural_resources === true ? bestEffort(`/city/resources${query({ resolution: Math.min(resolution ?? 64, 64), pageSize: 1024 })}`, 30_000) : { ok: false as const, error: "natural_resources=false or capabilities unavailable" },
            caps.wind_observation === true ? bestEffort(`/city/wind${query({ resolution: Math.min(resolution ?? 64, 32), pageSize: 1024 })}`, 30_000) : { ok: false as const, error: "wind_observation=false or capabilities unavailable" },
            caps.utility_network_observation === true ? bestEffort("/city/utilities?kind=all&pageSize=1024", 30_000) : { ok: false as const, error: "utility_network_observation=false or capabilities unavailable" },
          ]);
          const graph = caps.road_graph === true ? await bestEffort(`/road/graph${query({ pageSize: 500, includeLanes: false })}`, 30_000) : { ok: false as const, error: "road_graph=false or capabilities unavailable" };
          const outsideRoot = outside.ok ? asRecord(outside.value) : undefined;
          const outsideRows = outsideRoot ? [...extractRows(outsideRoot, "stations"), ...extractRows(outsideRoot, "depots"), ...extractRows(outsideRoot, "stops")].filter((entry) => (asString(asRecord(entry)?.prefab) ?? "").toLowerCase().includes("outside")) : [];
          const graphRoot = graph.ok ? asRecord(graph.value) : undefined;
          const outsideGraphRows = graphRoot ? [...extractRows(graphRoot, "edges"), ...extractRows(graphRoot, "nodes")].filter((entry) => asRecord(entry)?.outsideConnection === true) : [];
          environment = {
            grids,
            outsideConnections: directOutside.ok
              ? { status: "observed", nativeNodeObservation: directOutside.value, transportRows: outsideRows.length, graphRows: outsideGraphRows.length, transportAnalysis: outside.ok ? outside.value : undefined }
              : { status: outside.ok ? "observed" : "unavailable", nativeNodeObservation: outside.ok ? undefined : undefined, transportRows: outsideRows.length, graphRows: outsideGraphRows.length, transportAnalysis: outside.ok ? outside.value : undefined, error: directOutside.error },
            resources: resources.ok ? resources.value : { status: "unavailable", error: resources.error },
            wind: wind.ok ? wind.value : { status: "unavailable", error: wind.error },
            utilities: utilities.ok ? utilities.value : { status: "unavailable", error: utilities.error },
          };
        }
        return jsonResult({
          success: true,
          summary,
          rawGrid: includeGrid ? terrain.raw : undefined,
          environment,
          observation: "Terrain and environment fields are labeled by native observation status. Groundwater/pollution, native natural resources, wind, outside connections, road graph, and transport topology are queried when enabled; unsupported layers remain explicit unavailable observations.",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_query_resources",
    {
      title: "Query native natural resources",
      description:
        "Sample the live NaturalResourceSystem map for fertility, oil, ore, and fish. Results are paged and include native base/used/available values; forest is not inferred as zero because it is a separate tree/wood layer.",
      inputSchema: {
        resolution: z.number().int().min(4).max(128).optional(),
        x: z.number().optional(),
        z: z.number().optional(),
        radius: z.number().min(1).max(10000).optional(),
        page: z.number().int().min(0).optional(),
        pageSize: z.number().int().min(1).max(1024).optional(),
      },
    },
    async ({ resolution, x, z: zCoordinate, radius, page, pageSize }) => {
      try {
        return jsonResult(await bridgeJson(`/city/resources${query({ resolution, x, z: zCoordinate, radius, page, pageSize })}`, 30_000));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_query_wind",
    {
      title: "Query native wind field",
      description:
        "Sample the live WindSystem map and return observed wind-vector components, magnitudes, and derived directions with paged coverage.",
      inputSchema: {
        resolution: z.number().int().min(4).max(64).optional(),
        x: z.number().optional(),
        z: z.number().optional(),
        radius: z.number().min(1).max(10000).optional(),
        page: z.number().int().min(0).optional(),
        pageSize: z.number().int().min(1).max(1024).optional(),
      },
    },
    async ({ resolution, x, z: zCoordinate, radius, page, pageSize }) => {
      try {
        return jsonResult(await bridgeJson(`/city/wind${query({ resolution, x, z: zCoordinate, radius, page, pageSize })}`, 30_000));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_query_outside_connections",
    {
      title: "Query native outside connections",
      description:
        "Read native road/network outside-connection nodes and transfer metadata, spatially filtered and paged by limit.",
      inputSchema: {
        x: z.number().optional(),
        z: z.number().optional(),
        radius: z.number().min(1).max(20000).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ x, z: zCoordinate, radius, limit }) => {
      try {
        return jsonResult(await bridgeJson(`/city/outside-connections${query({ x, z: zCoordinate, radius, limit })}`, 20_000));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_analyze_area",
    {
      title: "Analyze one bounded city area",
      description:
        "Combine bounded building, road, object, and zoning observations for a planning area. Counts and returned rows are spatially filtered; missing bridge endpoints are reported rather than treated as empty areas.",
      inputSchema: {
        bounds: boundsSchema,
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ bounds, limit }) => {
      try {
        const maxRows = limit ?? 200;
        const centerX = (bounds.minX + bounds.maxX) / 2;
        const centerZ = (bounds.minZ + bounds.maxZ) / 2;
        const radius = Math.hypot(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2;
        const [buildingsResult, roadsResult, objectsResult, zoningResult] = await Promise.all([
          bestEffort(`/city/buildings${query({ limit: maxRows })}`),
          bestEffort(`/city/roads${query({ limit: maxRows })}`),
          bestEffort(`/city/objects${query({ x: centerX, z: centerZ, radius, limit: maxRows })}`),
          bestEffort(`/city/zoning${query({ x: centerX, z: centerZ, radius })}`),
        ]);
        const buildings = buildingsResult.ok ? extractRows(buildingsResult.value, "buildings").filter((entry) => {
          const position = positionOf(entry);
          return position ? inside(position, bounds) : false;
        }) : [];
        const roads = roadsResult.ok ? extractRows(roadsResult.value, "roads").filter((entry) => roadTouchesBounds(entry, bounds)) : [];
        const objects = objectsResult.ok ? extractRows(objectsResult.value, "objects").filter((entry) => {
          const position = positionOf(entry);
          return position ? inside(position, bounds) : false;
        }) : [];
        return jsonResult({
          success: true,
          bounds,
          counts: { buildings: buildings.length, roads: roads.length, objects: objects.length },
          buildings,
          roads,
          objects,
          zoning: zoningResult.ok ? zoningResult.value : { unavailable: zoningResult.error },
          observability: {
            buildings: buildingsResult.ok ? "observed" : buildingsResult.error,
            roads: roadsResult.ok ? "observed by endpoint row intersection" : roadsResult.error,
            objects: objectsResult.ok ? "observed" : objectsResult.error,
            zoning: zoningResult.ok ? "observed" : zoningResult.error,
          },
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_analyze_city",
    {
      title: "Analyze the current city",
      description:
        "Create one structured city snapshot from overview, demand, budget, services, labor, zoning, notifications, roads, terrain, and (by default) native road/traffic, transport, utility, resource, wind, and outside-connection readings. Every reading carries an observed/unavailable status so the planner can distinguish a missing endpoint from a healthy zero.",
      inputSchema: {
        terrainResolution: z.number().int().min(16).max(128).optional(),
        roadLimit: z.number().int().min(1).max(500).optional(),
        includeEnvironment: z.boolean().optional().describe("include native utility/resource/wind/outside-connection/road-graph/transport observations (default true)"),
      },
    },
    async ({ terrainResolution, roadLimit, includeEnvironment }) => {
      const requests: Record<string, Promise<{ ok: true; value: unknown } | { ok: false; error: string; status?: number }>> = {
        overview: bestEffort("/city/overview"),
        demand: bestEffort("/city/demand"),
        budget: bestEffort("/city/budget"),
        services: bestEffort("/city/services"),
        labor: bestEffort("/city/labor"),
        zoning: bestEffort("/city/zoning"),
        notifications: bestEffort("/city/notifications"),
        roads: bestEffort(`/city/roads${query({ limit: roadLimit ?? 500 })}`),
        terrain: bestEffort(`/city/terrain${query({ resolution: terrainResolution ?? 32 })}`, 30_000),
      };
      if (includeEnvironment ?? true) {
        Object.assign(requests, {
          resources: bestEffort("/city/resources?pageSize=128", 20_000),
          wind: bestEffort("/city/wind?pageSize=128", 20_000),
          outsideConnections: bestEffort("/city/outside-connections?pageSize=128", 20_000),
          utilities: bestEffort("/city/utilities?kind=all&pageSize=200", 30_000),
          roadGraph: bestEffort("/road/graph?pageSize=200&includeLanes=false", 30_000),
          transportAnalysis: bestEffort("/transport/analysis?limit=200", 20_000),
        });
      }
      const entries = await Promise.all(Object.entries(requests).map(async ([key, task]) => [key, await task] as const));
      const readings: JsonRecord = {};
      for (const [key, result] of entries) readings[key] = result.ok ? { status: "observed", data: result.value } : { status: "unavailable", error: result.error, httpStatus: result.status };
      const terrain = entries.find(([key]) => key === "terrain")?.[1];
      const terrainSnapshot = terrain && terrain.ok ? terrainPayloadFrom(terrain.value) : undefined;
      return jsonResult({
        success: true,
        readings,
        derived: terrainSnapshot ? { terrain: summarizeTerrain(terrainSnapshot) } : { terrain: { status: "unavailable" } },
        nextActions: [
          "use cs2_validate_city to convert this snapshot into prioritized findings",
          "use cs2_plan_metropolis or cs2_plan_road_network before large construction",
          "re-run after simulation time has advanced; demand and traffic-adjacent readings are time-dependent",
          "inspect readings.resources, readings.wind, readings.utilities, readings.roadGraph, and readings.transportAnalysis before issuing a large autonomous mutation",
        ],
      });
    },
  );

  server.registerTool(
    "cs2_plan_road_network",
    {
      title: "Plan a validated road geometry",
      description:
        "Generate a dry-run road path using straight, Bezier, arc, spline, or polyline geometry. Long paths are split into native-sized segments and checked for segment length, grade, and world bounds before any construction is attempted.",
      inputSchema: {
        start: pointSchema,
        end: pointSchema,
        controlPoints: z.array(pointSchema).max(16).optional(),
        geometry: geometrySchema.optional(),
        maxSegmentLength: z.number().min(8).max(1500).optional(),
        maxSlope: z.number().min(0.001).max(1).optional(),
        bounds: boundsSchema.optional(),
        role: z.string().optional(),
      },
    },
    async ({ start, end, controlPoints, geometry, maxSegmentLength, maxSlope, bounds, role }) => {
      const plan = makeRoadPlan({ start, end, controlPoints, geometry: geometry as GeometryKind | undefined, maxSegmentLength, maxSlope, bounds, role });
      return jsonResult({ success: true, plan, issueCounts: issueCounts(plan.issues), executable: plan.issues.every((issue) => issue.severity !== "error") });
    },
  );

  server.registerTool(
    "cs2_plan_metropolis",
    {
      title: "Create a terrain-aware metropolitan master plan",
      description:
        "Produce a plan/preview only: one primary centre, secondary centres, hierarchical corridors, district polygons, transport spines, greenways, phases, and quality gates. It queries native terrain by default; if the game is unreachable the response labels the plan provisional instead of pretending terrain was observed.",
      inputSchema: {
        bounds: boundsSchema.optional(),
        center: pointSchema.optional(),
        density: z.enum(["medium", "high"]).optional(),
        waterfront: z.boolean().optional(),
        fetchTerrain: z.boolean().optional(),
        terrain: z.record(z.unknown()).optional().describe("optional previously observed /city/terrain payload"),
      },
    },
    async ({ bounds, center, density, waterfront, fetchTerrain, terrain: suppliedTerrain }) => {
      let terrainSnapshot = terrainPayloadFrom(suppliedTerrain);
      let terrainObservation: JsonRecord = terrainSnapshot ? { status: "observed", source: "caller-supplied native terrain payload" } : { status: "not-requested" };
      if (!terrainSnapshot && (fetchTerrain ?? true)) {
        try {
          const terrain = await readTerrain(64);
          terrainSnapshot = terrain.snapshot;
          terrainObservation = { status: "observed", source: "live bridge /city/terrain" };
        } catch (error) {
          terrainObservation = { status: "unavailable", error: error instanceof Error ? error.message : String(error) };
        }
      }
      let resolvedCenter = center;
      let centerObservation: JsonRecord = center ? { status: "observed", source: "caller-supplied center" } : { status: "not-requested" };
      if (!resolvedCenter) {
        const roads = await bestEffort(`/city/roads${query({ limit: 500 })}`);
        const endpoints = roads.ok ? extractRows(roads.value, "roads").flatMap((row) => {
            const record = asRecord(row);
            return [positionOf(record?.start), positionOf(record?.end)].filter((value): value is WorldPoint => Boolean(value));
        }).filter((value) => !bounds || inside(value, bounds)) : [];
        if (endpoints.length > 0) {
          resolvedCenter = { x: endpoints.reduce((sum, value) => sum + value.x, 0) / endpoints.length, z: endpoints.reduce((sum, value) => sum + value.z, 0) / endpoints.length };
          centerObservation = { status: "observed", source: "centroid of live road endpoints", samples: endpoints.length };
        } else {
          centerObservation = { status: "unavailable", reason: roads.ok ? "no live road endpoints were returned" : roads.error };
        }
      }
      const plan = makeMetropolisPlan({ bounds, center: resolvedCenter, density, waterfront, terrain: terrainSnapshot });
      return jsonResult({ success: true, observation: terrainObservation, centerObservation, plan, provisional: terrainObservation.status !== "observed" || centerObservation.status === "unavailable" });
    },
  );

  server.registerTool(
    "cs2_plan_district",
    {
      title: "Plan a staged district",
      description:
        "Return a district polygon and a density/buffer/TOD plan without mutating the game. Construction is deliberately separate so an agent can inspect, preview, and validate the site first.",
      inputSchema: {
        name: z.string(),
        type: z.enum(["CBD", "secondary-centre", "residential", "commercial", "industrial-logistics", "university", "waterfront", "park", "airport", "port", "civic"]).optional(),
        center: pointSchema,
        width: z.number().min(40).max(10000),
        depth: z.number().min(40).max(10000),
        rotation: z.number().optional(),
        density: z.enum(["low", "medium", "high", "gradient"]).optional(),
        tod: z.boolean().optional(),
      },
    },
    async ({ name, type, center, width, depth, rotation, density, tod }) => {
      const polygon = districtPolygon(center, width, depth, rotation ?? 0);
      return jsonResult({
        success: true,
        plan: {
          kind: "district-plan",
          name,
          type: type ?? "mixed-use",
          centre: center,
          polygon,
          density: density ?? "gradient",
          tod: tod ?? false,
          buffers: type === "industrial-logistics" ? ["freight corridor", "green buffer", "office/commercial separation", "no direct heavy-freight frontage to residential core"] : ["local streets", "public space", "service access", "walking connections"],
          staging: ["road hierarchy", "utilities/services", "zoning", "key buildings", "transit", "landscape", "simulation check"],
        },
      });
    },
  );

  server.registerTool(
    "cs2_plan_transport",
    {
      title: "Plan a public transport corridor",
      description:
        "Create a stop/station/catchment proposal and check actual transport capabilities. When transit_stops and transit_stop_attachment are true, the returned waypoints can be paired with native stop entities and passed to cs2_create_transport_line; station/depot placement remains separately capability-gated.",
      inputSchema: {
        mode: z.enum(["bus", "tram", "subway", "train", "taxi", "ship", "ferry", "air", "cargo"]),
        points: z.array(pointSchema).min(2).max(32),
        stopSpacing: z.number().min(50).max(3000).optional(),
        name: z.string().optional(),
      },
    },
    async ({ mode, points, stopSpacing, name }) => {
      try {
        const capabilityPayload = await bridgeJson("/capabilities", 5_000);
        const canExecute = capability(capabilityPayload, "transit_lines");
        const spacing = stopSpacing ?? (mode === "subway" || mode === "train" ? 1200 : 450);
        const stops: WorldPoint[] = [points[0]];
        let carry = 0;
        for (let index = 0; index < points.length - 1; index++) {
          const start = points[index];
          const end = points[index + 1];
          const segmentLength = Math.hypot(end.x - start.x, end.z - start.z);
          const count = Math.max(1, Math.floor((carry + segmentLength) / spacing));
          for (let stop = 1; stop <= count; stop++) {
            const distanceAlong = stop * spacing - carry;
            if (distanceAlong < segmentLength) {
              const ratio = distanceAlong / segmentLength;
              stops.push({ x: start.x + (end.x - start.x) * ratio, z: start.z + (end.z - start.z) * ratio });
            }
          }
          carry = (carry + segmentLength) % spacing;
        }
        stops.push(points[points.length - 1]);
        return jsonResult({
          success: true,
          planOnly: !canExecute,
          executable: canExecute,
          capability: canExecute ? "transit_lines" : "transit_lines=false",
          name: name ?? `${mode} corridor`,
          mode,
          alignment: points,
          stops,
          catchmentMeters: mode === "subway" || mode === "train" ? 900 : 450,
          limitation: canExecute ? "The plan contains route waypoints; use cs2_place_stop for native stop entities and cs2_create_transport_line with stopEntities for verified waypoint binding. Station/depot placement, scheduling, and transit analytics remain separately capability-gated." : "transit_lines=false: no line was created.",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  async function buildCorridor(args: {
    start: WorldPoint;
    end: WorldPoint;
    controlPoints?: WorldPoint[];
    geometry?: GeometryKind;
    roadPrefab?: string;
    designLevel?: string;
    maxSegmentLength?: number;
    maxSlope?: number;
    bounds?: Bounds;
    preview?: boolean;
    dryRun?: boolean;
    force?: boolean;
  }) {
    const plan = makeRoadPlan({
      start: args.start,
      end: args.end,
      controlPoints: args.controlPoints,
      geometry: args.geometry,
      maxSegmentLength: args.maxSegmentLength,
      maxSlope: args.maxSlope ?? roadDesignSlope(args.designLevel),
      bounds: args.bounds,
      role: args.designLevel,
    });
    const issueCountsValue = issueCounts(plan.issues);
    if (args.preview || args.dryRun) {
      return { success: true, dryRun: true, executable: issueCountsValue.errors === 0, plan, issueCounts: issueCountsValue };
    }
    if (issueCountsValue.errors > 0) {
      return { success: false, dryRun: true, executable: false, plan, issueCounts: issueCountsValue, error: "road plan has blocking geometry errors; no native construction was attempted" };
    }
    const selected = await selectRoadPrefab(args.roadPrefab, args.designLevel);
    const execution = await executeAdaptiveRoadPlan(plan, selected, args.force === true);
    return {
      success: execution.success === true,
      dryRun: false,
      executable: execution.success === true,
      prefab: selected.name,
      prefabSelection: selected.selection,
      plan,
      executed: execution.results ?? [],
      verification: execution,
      issueCounts: issueCountsValue,
      note: execution.success === true ? undefined : "one or more native corridor segments did not pass endpoint readback; no full success is claimed",
    };
  }

  server.registerTool(
    "cs2_build_highway_corridor",
    {
      title: "Plan or build a highway corridor",
      description:
        "Generate an engineering-style highway alignment, split it into native-sized segments, validate grade/bounds, and only then execute through the bridge's native road construction path. The prefab is selected at runtime when omitted; no fixed asset list is used.",
      inputSchema: {
        start: pointSchema,
        end: pointSchema,
        controlPoints: z.array(pointSchema).max(8).optional(),
        geometry: geometrySchema.optional(),
        roadPrefab: z.string().optional().describe("exact name from cs2_discover_assets; omitted means runtime discovery"),
        maxSegmentLength: z.number().min(8).max(1500).optional(),
        preview: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        force: z.boolean().optional(),
      },
    },
    async ({ start, end, controlPoints, geometry, roadPrefab, maxSegmentLength, preview, dryRun, force }) => {
      try {
        return jsonResult(await buildCorridor({ start, end, controlPoints, geometry: geometry as GeometryKind | undefined, roadPrefab, designLevel: "highway", maxSegmentLength, preview, dryRun, force }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_build_expressway",
    {
      title: "Plan or build an urban expressway",
      description:
        "Build a terrain-aware expressway/urban ring/radial corridor using the same plan-preview-execute validation contract as the highway tool. It will not silently fall back to uncontrolled grid streets.",
      inputSchema: {
        start: pointSchema,
        end: pointSchema,
        controlPoints: z.array(pointSchema).max(8).optional(),
        geometry: geometrySchema.optional(),
        roadPrefab: z.string().optional(),
        maxSegmentLength: z.number().min(8).max(1500).optional(),
        maxSlope: z.number().min(0.001).max(1).optional(),
        preview: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        force: z.boolean().optional(),
      },
    },
    async ({ start, end, controlPoints, geometry, roadPrefab, maxSegmentLength, maxSlope, preview, dryRun, force }) => {
      try {
        return jsonResult(await buildCorridor({ start, end, controlPoints, geometry: geometry as GeometryKind | undefined, roadPrefab, designLevel: "expressway", maxSegmentLength, maxSlope, preview, dryRun, force }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  async function executeInterchange(plan: InterchangePlan, roadPrefab: string | undefined, force: boolean | undefined, dryRun: boolean | undefined) {
    const issues = geometryIssues(plan);
    const counts = issueCounts(issues);
    if (dryRun) return { success: true, dryRun: true, executable: counts.errors === 0, plan, issueCounts: counts };
    if (counts.errors > 0) return { success: false, dryRun: true, executable: false, plan, issueCounts: counts, error: "interchange has blocking geometry issues; no native construction was attempted" };
    const selected = await selectRoadPrefab(roadPrefab, "interchange");
    const executed: JsonRecord[] = [];
    for (const [index, road] of plan.roads.entries()) {
      const nativePlan = makeRoadPlan({ start: road.start, end: road.end, controlPoints: road.control ? [road.control] : undefined, geometry: road.control ? "bezier" : "straight", maxSegmentLength: 1200, maxSlope: 0.08, role: road.role, level: road.level });
      if (nativePlan.issues.some((issue) => issue.severity === "error")) {
        return { success: false, dryRun: false, executable: false, plan, failedRoad: index, nativePlan, executed, error: "a generated interchange road failed local validation; earlier native segments, if any, remain committed" };
      }
      const roadResult = await executeAdaptiveRoadPlan(nativePlan, selected, force === true);
      executed.push({ road: index, ...roadResult });
      if (roadResult.success !== true) {
        return { success: false, dryRun: false, executable: false, plan, failedRoad: index, issueCounts: counts, prefab: selected.name, prefabSelection: selected.selection, executed, error: "a generated interchange road did not pass native network readback; earlier native segments, if any, remain committed" };
      }
    }
    return { success: true, dryRun: false, executable: true, plan, issueCounts: counts, prefab: selected.name, prefabSelection: selected.selection, executed };
  }

  server.registerTool(
    "cs2_build_interchange",
    {
      title: "Preview or build an interchange",
      description:
        "Generate Diamond, SPUI, roundabout, cloverleaf/turbine, stack, or custom-style interchange geometry from a centre and orientation. The tool reports footprint and conflicts first; execution uses only the selected runtime road prefab and native validation.",
      inputSchema: {
        center: pointSchema,
        type: z.enum(["diamond", "diverging-diamond", "trumpet", "cloverleaf", "partial-cloverleaf", "stack", "three-level-stack", "four-level-stack", "turbine", "semi-turbine", "directional", "roundabout", "spui", "hybrid", "custom"]).optional(),
        angle: z.number().optional(),
        mainLength: z.number().min(120).max(1500).optional(),
        crossLength: z.number().min(100).max(1500).optional(),
        elevatedCrossing: z.number().min(-30).max(60).optional(),
        roadPrefab: z.string().optional(),
        preview: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        force: z.boolean().optional(),
      },
    },
    async ({ center, type, angle, mainLength, crossLength, elevatedCrossing, roadPrefab, preview, dryRun, force }) => {
      try {
        const plan = makeInterchangePlan({ center, type, angle, mainLength, crossLength, elevatedCrossing });
        if (preview) return jsonResult({ success: true, dryRun: true, executable: plan.conflicts.every((issue) => issue.severity !== "error"), plan, issueCounts: issueCounts(plan.conflicts) });
        return jsonResult(await executeInterchange(plan, roadPrefab, force, dryRun));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_generate_interchange",
    {
      title: "Generate a custom interchange graph",
      description:
        "Generate a constrained custom interchange preview from the same road topology inputs as cs2_build_interchange. It optimizes for smooth, compact, low-conflict ramps within this planner's geometry model, and never claims that unsupported mid-segment merges or native traffic validation succeeded.",
      inputSchema: {
        center: pointSchema,
        type: z.string().optional(),
        angle: z.number().optional(),
        mainLength: z.number().min(120).max(1500).optional(),
        crossLength: z.number().min(100).max(1500).optional(),
        elevatedCrossing: z.number().min(-30).max(60).optional(),
        roadPrefab: z.string().optional(),
        dryRun: z.boolean().optional(),
        force: z.boolean().optional(),
      },
    },
    async ({ center, type, angle, mainLength, crossLength, elevatedCrossing, roadPrefab, dryRun, force }) => {
      try {
        const plan = makeInterchangePlan({ center, type: type ?? "custom", angle, mainLength, crossLength, elevatedCrossing });
        return jsonResult(await executeInterchange(plan, roadPrefab, force, dryRun ?? true));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_build_district",
    {
      title: "Build and verify a native district",
      description:
        "Execute a polygon returned by cs2_plan_district through the game's native district CreationDefinition path, then verify the new district entity. Dry-run returns the exact polygon and native path without mutating the city.",
      inputSchema: {
        name: z.string().min(1).max(128),
        nodes: z.array(pointSchema).min(3).max(32),
        prefab: z.string().optional(),
        execute: z.boolean().optional(),
        dryRun: z.boolean().optional(),
      },
    },
    async ({ name, nodes, prefab, execute, dryRun }) => {
      try {
        const plan = { kind: "district-build", name, polygon: nodes, nativePath: "/build/district -> CreationDefinition + Areas.Node -> native district apply" };
        if (execute !== true || dryRun === true) return jsonResult({ success: true, dryRun: true, executed: false, plan, prefab: prefab ?? null });
        return jsonResult({ ...await executeVerifiedDistrict(nodes, name, prefab), dryRun: false, executed: true, plan });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_build_greenway",
    {
      title: "Build and verify a native greenway",
      description:
        "Build a runtime-discovered pedestrian PathwayPrefab along a validated alignment, then optionally add a bounded native tree layer. Each path segment is read back from the live network graph; tree failures remain visible in the result.",
      inputSchema: {
        points: z.array(pointSchema).min(2).max(128),
        pathPrefab: z.string().optional(),
        geometry: geometrySchema.optional(),
        maxSegmentLength: z.number().min(8).max(1500).optional(),
        includeTrees: z.boolean().optional(),
        treePrefab: z.string().optional(),
        execute: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        force: z.boolean().optional(),
      },
    },
    async ({ points, pathPrefab, geometry, maxSegmentLength, includeTrees, treePrefab, execute, dryRun, force }) => {
      try {
        const selected = await selectGreenwayPrefab(pathPrefab);
        const plan = makeRoadPlan({
          start: points[0],
          end: points[points.length - 1],
          controlPoints: points.slice(1, -1),
          geometry: geometry as GeometryKind | undefined,
          maxSegmentLength: maxSegmentLength ?? 300,
          maxSlope: 0.12,
          role: "greenway pedestrian path",
        });
        const counts = issueCounts(plan.issues);
        if (execute !== true || dryRun === true || counts.errors > 0) {
          return jsonResult({ success: counts.errors === 0, dryRun: true, executed: false, selected, plan, issueCounts: counts, note: counts.errors > 0 ? "native greenway construction was not attempted because the alignment has blocking issues" : "preview only; no greenway definitions were emitted" });
        }
        const network = await executeVerifiedRoadPlan(plan, selected.name, force === true);
        const treeResults: JsonRecord[] = [];
        if (includeTrees === true) {
          const treeSelected = treePrefab ? { name: treePrefab, selection: "caller-selected exact runtime tree prefab" } : await discoverPrefab("tree");
          const treePoints = points.filter((value, index, values) => !values.slice(0, index).some((other) => Math.hypot(other.x - value.x, other.z - value.z) < 12));
          for (const [index, position] of treePoints.entries()) {
            treeResults.push({ index, position, result: await placeDecorationObject("tree", position, treeSelected.name, (index * 137.507764) % 360, true, force === true) });
          }
        }
        const treesSuccess = includeTrees !== true || treeResults.length > 0 && treeResults.every((entry) => asRecord(entry.result)?.success === true);
        return jsonResult({ success: network.success && treesSuccess, dryRun: false, executed: true, selected, plan, issueCounts: counts, network, trees: treeResults, note: network.success && treesSuccess ? undefined : "one or more native greenway layers did not pass readback; no full success is claimed" });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_terraform",
    {
      title: "Execute and verify native CS2 terraforming",
      description:
        "Preview or emit a native terrain-tool definition for raise/lower/level/slope/smooth. The bridge uses runtime-discovered TerraformingPrefab and BrushPrefab entities and the game's ToolOutputBarrier; execution is accepted only after native point-terrain readback observes a directional change.",
      inputSchema: {
        operation: z.enum(["raise", "lower", "level", "slope", "smooth"]),
        points: z.array(pointSchema).min(1).max(256),
        amount: z.number().optional(),
        dryRun: z.boolean().optional(),
      },
    },
    async ({ operation, points, amount, dryRun }) => {
      try {
        const payload = await bridgeJson("/capabilities", 5_000);
        if (!capability(payload, "terraform")) {
          return jsonResult({
            success: false,
            capability: "terraform",
            available: false,
            reason: "terraform=false in the live bridge contract; no terrain mutation was attempted",
            recommendedAction: "implement and verify a native terrain-tool integration before enabling this operation",
          });
        }
        if (dryRun === true) {
          const endpoint = `/terraform${query({ operation, points: JSON.stringify(points), amount, dryRun: true })}`;
          return jsonResult(await bridgeJson(endpoint, 20_000));
        }
        return jsonResult(await executeVerifiedTerraform(operation, points, amount ?? 0.5));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_purchase_tiles",
    {
      title: "Request native CS2 tile purchase",
      description:
        "Preview or purchase map tiles through the game's native MapTilePurchaseSystem. Requests use runtime-discovered tile entity IDs, ordinals, or nearest x/z coordinates; funds, permits, milestones, and ownership remain game-controlled.",
      inputSchema: {
        tiles: z.array(z.record(z.unknown())).min(1).max(64),
        dryRun: z.boolean().optional(),
      },
    },
    async ({ tiles, dryRun }) => {
      try {
        const payload = await bridgeJson("/capabilities", 5_000);
        if (!capability(payload, "tile_purchase")) {
          return jsonResult({
            success: false,
            capability: "tile_purchase",
            available: false,
            reason: "tile_purchase=false in the live bridge contract; no purchase was attempted",
            currentTileInfo: await bestEffort("/city/tiles?details=true"),
          });
        }
        const endpoint = `/city/tiles/purchase${query({
          tiles: JSON.stringify(tiles),
          dryRun: dryRun ?? false,
        })}`;
        return jsonResult(await bridgeJson(endpoint, 20_000));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_list_tiles",
    {
      title: "List native map tiles",
      description: "Read the native paged map-tile catalog, including ownership, purchase availability, cost, upkeep, and tile entity references.",
      inputSchema: {
        query: z.string().optional(),
        details: z.boolean().optional(),
        page: z.number().int().min(0).optional(),
        pageSize: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ query: search, details, page, pageSize }) => {
      try {
        return jsonResult(await bridgeJson(`/city/tiles${query({ query: search, details, page, pageSize })}`, 20_000));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_purchase_tile",
    {
      title: "Purchase one native map tile",
      description: "Resolve one runtime tile by entity, ordinal, or nearest x/z and pass it through the native MapTilePurchaseSystem. The result includes ownership readback and native purchase status.",
      inputSchema: {
        tile: z.record(z.unknown()),
        dryRun: z.boolean().optional(),
      },
    },
    async ({ tile, dryRun }) => {
      try {
        const capabilities = await bridgeJson<JsonRecord>("/capabilities", 5_000);
        if (!capability(capabilities, "tile_purchase")) {
          return jsonResult({ success: false, available: false, capability: "tile_purchase", reason: "tile_purchase=false in the live bridge contract; no purchase was attempted" });
        }
        return jsonResult(await bridgeJson(`/city/tiles/purchase${query({ tiles: JSON.stringify([tile]), dryRun: dryRun === true })}`, 20_000));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  function treePoints(bounds: Bounds, spacing: number, jitter: number): WorldPoint[] {
    const result: WorldPoint[] = [];
    const safeSpacing = Math.max(8, spacing);
    let row = 0;
    for (let z = bounds.minZ + safeSpacing / 2; z <= bounds.maxZ; z += safeSpacing) {
      let col = 0;
      for (let x = bounds.minX + safeSpacing / 2; x <= bounds.maxX; x += safeSpacing) {
        const offsetX = Math.sin(row * 12.9898 + col * 78.233) * jitter;
        const offsetZ = Math.cos(row * 39.3467 + col * 11.135) * jitter;
        const candidate = { x: x + offsetX, z: z + offsetZ };
        if (inside(candidate, bounds)) result.push(candidate);
        col++;
        if (result.length >= 500) return result;
      }
      row++;
    }
    return result;
  }

  server.registerTool(
    "cs2_decorate_area",
    {
      title: "Plan or place runtime-discovered tree detailing",
      description:
        "Fill a bounded area with deterministic, reviewable tree placement points. The actual operation uses a dynamically discovered unlocked tree prefab and the game's native placement path. Use cs2_place_prop and cs2_paint_surface for explicit prop/surface stages; each remains native and separately verifiable.",
      inputSchema: {
        bounds: boundsSchema,
        treePrefab: z.string().optional(),
        spacing: z.number().min(8).max(200).optional(),
        jitter: z.number().min(0).max(50).optional(),
        rotation: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        force: z.boolean().optional(),
      },
    },
    async ({ bounds, treePrefab, spacing, jitter, rotation, dryRun, force }) => {
      try {
        const points = treePoints(bounds, spacing ?? 24, jitter ?? 5);
        if (dryRun) return jsonResult({ success: true, dryRun: true, points, count: points.length, bounds, next: "select an exact runtime tree prefab, then execute this same plan" });
        const selected = treePrefab ? { name: treePrefab, selection: "caller-selected exact runtime prefab" } : await discoverPrefab("tree");
        const placed: JsonRecord[] = [];
        for (const [index, position] of points.entries()) {
          const turn = rotation ? ((index * 137.507764) % 360) : 0;
          placed.push({ index, position, result: await placeDecorationObject("tree", position, selected.name, turn, true, force === true) });
        }
        const success = placed.length > 0 && placed.every((entry) => asRecord(entry.result)?.success === true);
        return jsonResult({ success, dryRun: false, prefab: selected.name, prefabSelection: selected.selection, count: placed.length, placed, bounds, note: success ? undefined : "one or more tree placements did not pass native object readback" });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_create_greenbelt",
    {
      title: "Create a staged greenbelt plan",
      description:
        "Generate a tree/detailing plan for a greenbelt, then optionally execute it through the native tree placement path. Surface painting and prop placement are separate explicit stages, so the plan stays auditable and does not claim to create them implicitly.",
      inputSchema: {
        bounds: boundsSchema,
        spacing: z.number().min(8).max(200).optional(),
        treePrefab: z.string().optional(),
        dryRun: z.boolean().optional(),
        force: z.boolean().optional(),
      },
    },
    async ({ bounds, spacing, treePrefab, dryRun, force }) => {
      try {
        const points = treePoints(bounds, spacing ?? 30, 8);
        if (dryRun ?? true) return jsonResult({ success: true, dryRun: true, kind: "greenbelt-plan", bounds, points, count: points.length, capabilitiesRequired: ["trees"], next: "stage surface polygons with cs2_paint_surface and individual decorations with cs2_place_prop when required" });
        const selected = treePrefab ? { name: treePrefab, selection: "caller-selected exact runtime prefab" } : await discoverPrefab("tree");
        const placed: JsonRecord[] = [];
        for (const [index, position] of points.entries()) {
          placed.push({ index, position, result: await placeDecorationObject("tree", position, selected.name, (index * 137.507764) % 360, true, force === true) });
        }
        const success = placed.length > 0 && placed.every((entry) => asRecord(entry.result)?.success === true);
        return jsonResult({ success, dryRun: false, kind: "greenbelt", bounds, prefab: selected.name, placed, count: placed.length, next: "optionally stage and verify surface polygons and props as separate native operations", note: success ? undefined : "one or more tree placements did not pass native object readback" });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_place_tree",
    {
      title: "Place one runtime-discovered tree",
      description: "Preview or place one tree through the native object placement path. The tree prefab is discovered from the running game unless the caller supplies an exact runtime name; execution is verified against /city/objects.",
      inputSchema: {
        position: pointSchema,
        prefab: z.string().optional(),
        rotation: z.number().optional(),
        execute: z.boolean().optional(),
        force: z.boolean().optional(),
      },
    },
    async ({ position, prefab, rotation, execute, force }) => {
      try {
        return jsonResult(await placeDecorationObject("tree", position, prefab, rotation ?? 0, execute === true, force === true));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_draw_tree_line",
    {
      title: "Draw a native tree line",
      description: "Place a deterministic line of runtime-discovered trees with bounded spacing. Dry-run is the default and every executed point uses the native tree placement path with object readback.",
      inputSchema: {
        start: pointSchema,
        end: pointSchema,
        spacing: z.number().min(8).max(200).optional(),
        prefab: z.string().optional(),
        execute: z.boolean().optional(),
        force: z.boolean().optional(),
      },
    },
    async ({ start, end, spacing, prefab, execute, force }) => {
      try {
        const points = linePoints(start, end, spacing ?? 24, 200);
        if (execute !== true) return jsonResult({ success: true, dryRun: true, points, count: points.length, prefab: prefab ?? "runtime discovery" });
        const placed: JsonRecord[] = [];
        for (const [index, position] of points.entries()) placed.push({ index, ...(await placeDecorationObject("tree", position, prefab, (index * 137.507764) % 360, true, force === true)) });
        return jsonResult({ success: placed.every((entry) => entry.success === true), dryRun: false, points, placed, count: placed.length });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_draw_prop_line",
    {
      title: "Draw a native prop line",
      description: "Place a deterministic line of runtime-discovered static props. Dry-run is the default; execution uses the native prop path and /city/props readback.",
      inputSchema: {
        start: pointSchema,
        end: pointSchema,
        spacing: z.number().min(8).max(200).optional(),
        prefab: z.string().optional(),
        execute: z.boolean().optional(),
        force: z.boolean().optional(),
      },
    },
    async ({ start, end, spacing, prefab, execute, force }) => {
      try {
        const points = linePoints(start, end, spacing ?? 30, 128);
        if (execute !== true) return jsonResult({ success: true, dryRun: true, points, count: points.length, prefab: prefab ?? "runtime discovery (semantic query: Bench)" });
        const placed: JsonRecord[] = [];
        for (const [index, position] of points.entries()) placed.push({ index, ...(await placeDecorationObject("prop", position, prefab, (index * 137.507764) % 360, true, force === true)) });
        return jsonResult({ success: placed.every((entry) => entry.success === true), dryRun: false, points, placed, count: placed.length });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_tree_brush",
    {
      title: "Paint a native tree brush",
      description: "Generate deterministic points in a circular brush and place runtime-discovered trees through the native object path. The brush is bounded to 500 points and dry-run is the default.",
      inputSchema: {
        center: pointSchema,
        radius: z.number().min(4).max(500).optional(),
        count: z.number().int().min(1).max(500).optional(),
        prefab: z.string().optional(),
        execute: z.boolean().optional(),
        force: z.boolean().optional(),
      },
    },
    async ({ center, radius, count, prefab, execute, force }) => {
      try {
        const points = brushPoints(center, radius ?? 80, count ?? 24);
        if (execute !== true) return jsonResult({ success: true, dryRun: true, points, count: points.length, prefab: prefab ?? "runtime discovery" });
        const placed: JsonRecord[] = [];
        for (const [index, position] of points.entries()) placed.push({ index, ...(await placeDecorationObject("tree", position, prefab, (index * 137.507764) % 360, true, force === true)) });
        const verifiedCount = placed.filter((entry) => entry.success === true).length;
        return jsonResult({ success: placed.length > 0 && verifiedCount === placed.length, dryRun: false, points, placed, count: placed.length, verifiedCount, partial: verifiedCount > 0 && verifiedCount < placed.length, note: verifiedCount === placed.length ? undefined : "one or more native tree placements did not pass entity readback" });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_prop_brush",
    {
      title: "Paint a native prop brush",
      description: "Generate deterministic points in a circular brush and place runtime-discovered static props through the native object path. The brush is bounded to 128 points and dry-run is the default.",
      inputSchema: {
        center: pointSchema,
        radius: z.number().min(4).max(500).optional(),
        count: z.number().int().min(1).max(128).optional(),
        prefab: z.string().optional(),
        execute: z.boolean().optional(),
        force: z.boolean().optional(),
      },
    },
    async ({ center, radius, count, prefab, execute, force }) => {
      try {
        const points = brushPoints(center, radius ?? 60, Math.min(128, count ?? 16));
        if (execute !== true) return jsonResult({ success: true, dryRun: true, points, count: points.length, prefab: prefab ?? "runtime discovery (semantic query: Bench)" });
        const placed: JsonRecord[] = [];
        for (const [index, position] of points.entries()) placed.push({ index, ...(await placeDecorationObject("prop", position, prefab, (index * 137.507764) % 360, true, force === true)) });
        const verifiedCount = placed.filter((entry) => entry.success === true).length;
        return jsonResult({ success: placed.length > 0 && verifiedCount === placed.length, dryRun: false, points, placed, count: placed.length, verifiedCount, partial: verifiedCount > 0 && verifiedCount < placed.length, note: verifiedCount === placed.length ? undefined : "one or more native prop placements did not pass entity readback" });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  for (const contextName of ["cs2_decorate_road", "cs2_decorate_interchange", "cs2_decorate_waterfront", "cs2_decorate_district"]) {
    server.registerTool(
      contextName,
      {
        title: `Decorate a ${contextName.replace("cs2_decorate_", "")}`,
        description: "Contextual native tree detailing helper. It plans a bounded deterministic set of trees for the caller-provided area and executes only when execute=true; use cs2_paint_surface and cs2_place_prop for complementary native landscape layers.",
        inputSchema: {
          bounds: boundsSchema,
          spacing: z.number().min(8).max(200).optional(),
          treePrefab: z.string().optional(),
          execute: z.boolean().optional(),
          force: z.boolean().optional(),
        },
      },
      async ({ bounds, spacing, treePrefab, execute, force }) => {
        try {
          const points = boundedPoints(bounds, spacing ?? 28, 5, 128);
          if (execute !== true) return jsonResult({ success: true, dryRun: true, context: contextName, bounds, points, count: points.length });
          const placed: JsonRecord[] = [];
          for (const [index, position] of points.entries()) placed.push({ index, ...(await placeDecorationObject("tree", position, treePrefab, (index * 137.507764) % 360, true, force === true)) });
          const verifiedCount = placed.filter((entry) => entry.success === true).length;
          return jsonResult({ success: placed.length > 0 && verifiedCount === placed.length, dryRun: false, context: contextName, bounds, placed, count: placed.length, verifiedCount, partial: verifiedCount > 0 && verifiedCount < placed.length, note: verifiedCount === placed.length ? undefined : "one or more native contextual tree placements did not pass entity readback" });
        } catch (error) {
          return errorResult(error);
        }
      },
    );
  }

  server.registerTool(
    "cs2_analyze_road_graph",
    {
      title: "Read the native road, lane, junction, and traffic graph",
      description:
        "Read the live Edge/Node/Curve/SubLane network graph with lane direction, speed, connections, junction degree, elevation/slope/curvature, outside-connection flags, Density/LaneFlow/LaneObject snapshots, and city-wide TrafficFlowSystem averages. This is read-only and paged.",
      inputSchema: {
        x: z.number().optional(),
        z: z.number().optional(),
        radius: z.number().min(1).max(20000).optional(),
        query: z.string().optional().describe("case-insensitive runtime network prefab filter"),
        page: z.number().int().min(0).optional(),
        pageSize: z.number().int().min(1).max(500).optional(),
        laneLimit: z.number().int().min(1).max(10000).optional(),
        includeLanes: z.boolean().optional(),
        includeLaneObjects: z.boolean().optional(),
      },
    },
    async ({ x, z: zCoordinate, radius, query: search, page, pageSize, laneLimit, includeLanes, includeLaneObjects }) => {
      try {
        const capabilities = await bridgeJson<JsonRecord>("/capabilities", 5_000);
        if (!capability(capabilities, "road_graph")) {
          return jsonResult({ success: false, available: false, capability: "road_graph", reason: "road_graph=false in the live bridge contract; no graph values were inferred" });
        }
        const graph = await bridgeJson<JsonRecord>(`/road/graph${query({ x, z: zCoordinate, radius, query: search, page, pageSize, laneLimit, includeLanes, includeLaneObjects })}`, 30_000);
        return jsonResult({ ...graph, analysis: summarizeRoadGraphPayload(graph) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_validate_city",
    {
      title: "Validate city state and construction quality",
      description:
        "Run a structured post-build audit over live city readings, terrain, the native road/traffic graph, and native transport topology. Findings retain evidence status and severity; an unavailable endpoint is never scored as a healthy zero.",
      inputSchema: {
        terrainResolution: z.number().int().min(16).max(128).optional(),
        roadLimit: z.number().int().min(1).max(500).optional(),
        includeScreenshots: z.boolean().optional(),
      },
    },
    async ({ terrainResolution, roadLimit, includeScreenshots }) => {
      try {
        const [city, capabilitiesResult] = await Promise.all([bestEffort(`/city/overview`), bestEffort(`/capabilities`)]);
        const analysis = await (async () => {
          const requests = await Promise.all([
            bestEffort(`/city/demand`),
            bestEffort(`/city/services`),
            bestEffort(`/city/notifications`),
            bestEffort(`/city/roads${query({ limit: roadLimit ?? 500 })}`),
            bestEffort(`/city/terrain${query({ resolution: terrainResolution ?? 32 })}`, 30_000),
          ]);
          return { demand: requests[0], services: requests[1], notifications: requests[2], roads: requests[3], terrain: requests[4] };
        })();
        const findings: PlanIssue[] = [];
        const notificationRows = analysis.notifications.ok ? extractRows(analysis.notifications.value, "notifications") : [];
        if (notificationRows.length > 0) findings.push({ code: "active_notifications", severity: "warning", message: `${notificationRows.length} active notification rows were reported by the game`, recommendedAction: "inspect each notification and repair the underlying service, road, or building before expanding" });
        if (!analysis.services.ok) findings.push({ code: "services_unobserved", severity: "warning", message: "city service status could not be observed", recommendedAction: "retry after the save has finished loading" });
        if (!analysis.roads.ok) findings.push({ code: "roads_unobserved", severity: "warning", message: "road listing could not be observed", recommendedAction: "retry the bridge query; do not infer a healthy road graph" });
        const terrainSnapshot = analysis.terrain.ok ? terrainPayloadFrom(analysis.terrain.value) : undefined;
        if (terrainSnapshot) {
          const terrainSummary = summarizeTerrain(terrainSnapshot);
          if (terrainSummary.water.coverage > 0.35) findings.push({ code: "waterfront_constraint", severity: "info", message: "water covers a substantial share of the sampled map; protect public shoreline space and plan crossings deliberately" });
          if (terrainSummary.slope.steepCells > 0.25 * Math.max(1, terrainSnapshot.resolution * terrainSnapshot.resolution)) findings.push({ code: "steep_terrain", severity: "info", message: "steep terrain remains significant in the sampled grid", recommendedAction: "prefer contour-following roads and validate every bridge/ramp alignment" });
        }
        const caps = capabilitiesResult.ok ? capabilityMap(capabilitiesResult.value) : {};
        const graphResult = caps.road_graph === true ? await bestEffort(`/road/graph${query({ pageSize: 500, includeLanes: false })}`, 30_000) : { ok: false as const, error: "road_graph=false or capabilities unavailable" };
        const transportResult = caps.transport_analysis === true ? await bestEffort(`/transport/analysis${query({ limit: 500 })}`, 20_000) : { ok: false as const, error: "transport_analysis=false or capabilities unavailable" };
        const graphSummary = graphResult.ok ? summarizeRoadGraphPayload(graphResult.value) : null;
        if (caps.road_graph === true && !graphResult.ok) findings.push({ code: "road_graph_unobserved", severity: "warning", message: "road_graph is enabled but the post-build graph read failed", recommendedAction: "retry the native graph read after construction settles" });
        if (caps.transport_analysis === true && !transportResult.ok) findings.push({ code: "transport_analysis_unobserved", severity: "warning", message: "transport_analysis is enabled but the post-build transport read failed", recommendedAction: "retry the native transport read and do not infer stop/route health" });
        for (const unsupported of ["rollback"]) {
          if (caps[unsupported] === false) findings.push({ code: `capability_${unsupported}_unavailable`, severity: "info", message: `${unsupported} is explicitly unavailable in the live bridge contract`, recommendedAction: "keep the related step in plan-only mode until a native implementation is verified" });
        }
        const screenshot = includeScreenshots ? await captureScreenshot() : false;
        return jsonResult({
          success: true,
          evidence: { city: city.ok ? "observed" : city.error, analysis, capabilities: capabilitiesResult.ok ? "observed" : capabilitiesResult.error, nativeRoadGraph: graphResult.ok ? graphResult.value : graphResult.error, nativeRoadGraphSummary: graphSummary, nativeTransportAnalysis: transportResult.ok ? transportResult.value : transportResult.error, screenshotCaptured: screenshot },
          findings,
          issueCounts: issueCounts(findings),
          verdict: findings.some((finding) => finding.severity === "error") ? "blocked" : findings.some((finding) => finding.severity === "warning") ? "needs-attention" : "no-blocking-findings-from-observed-data",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_optimize_traffic",
    {
      title: "Diagnose traffic and execute a bounded repair",
      description:
        "Use the native road graph, lane occupancy, density, and flow observations to rank congestion candidates. Preview proposes a repair; execute=true performs one bounded parallel-road repair with two native connectors, verifies every segment, and leaves broader alternatives for the next cycle. It never claims that widening or a single repair solved the whole city.",
      inputSchema: {
        bounds: boundsSchema.optional(),
        execute: z.boolean().optional(),
      },
    },
    async ({ bounds, execute }) => {
      try {
        const [capabilitiesResult, roadsResult, stateResult] = await Promise.all([bestEffort("/capabilities"), bestEffort(`/city/roads${query({ limit: 500 })}`), bestEffort("/state")]);
        const roadGraphAvailable = capabilitiesResult.ok && capability(capabilitiesResult.value, "road_graph");
        const graphScope = bounds
          ? { x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2, radius: Math.hypot(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2 }
          : {};
        const graphResult = roadGraphAvailable
          ? await bestEffort(`/road/graph${query({ ...graphScope, pageSize: 500, includeLanes: true, laneLimit: 5000, includeLaneObjects: false })}`, 30_000)
          : { ok: false as const, error: "road_graph=false in the live bridge contract" };
        const roads = roadsResult.ok ? extractRows(roadsResult.value, "roads") : [];
        const boundedRoads = bounds ? roads.filter((road) => roadTouchesBounds(road, bounds)) : roads;
        const graph = graphResult.ok ? asRecord(graphResult.value) : undefined;
        const candidates = asArray(graph?.segments)
          .map(asRecord)
          .filter((segment): segment is JsonRecord => Boolean(segment))
          .map((segment) => {
            const traffic = asRecord(segment.traffic);
            const lanes = asArray(segment.lanes).map(asRecord).filter((lane): lane is JsonRecord => Boolean(lane));
            const hasCarLane = lanes.some((lane) => asArray(lane.kinds).some((kind) => kind === "car") || asRecord(lane.car) !== undefined);
            const laneCount = numberField(segment, "laneCount") ?? 0;
            const laneObjectCount = numberField(traffic, "laneObjectCount") ?? 0;
            const density = numberField(traffic, "density") ?? 0;
            const geometry = asRecord(segment.geometry);
            const start = positionOf(geometry?.start);
            const end = positionOf(geometry?.end);
            return {
              segment,
              prefab: asString(segment.prefab),
              start,
              end,
              laneCount,
              laneObjectCount,
              density,
              hasCarLane,
              congestionScore: laneObjectCount / Math.max(1, laneCount) + density,
            };
          })
          .filter((candidate) => candidate.prefab && candidate.start && candidate.end && candidate.hasCarLane && (candidate.laneObjectCount > 0 || candidate.density > 0))
          .sort((left, right) => right.congestionScore - left.congestionScore);
        const topCandidate = candidates[0];
        const proposal = topCandidate
          ? {
              strategy: "parallel-road-with-end-connectors",
              reason: "highest observed native lane occupancy/density among bounded car-road segments",
              target: {
                entity: asRecord(topCandidate.segment.entity) ?? null,
                prefab: topCandidate.prefab,
                start: topCandidate.start,
                end: topCandidate.end,
                laneCount: topCandidate.laneCount,
                laneObjectCount: topCandidate.laneObjectCount,
                density: topCandidate.density,
                congestionScore: topCandidate.congestionScore,
              },
              alternatives: [
                "add or improve transit along the corridor",
                "build a grade-separated or ring alternative after checking junction conflicts",
                "move freight through a dedicated rail or outside-connection route",
              ],
            }
          : null;
        const evidence = {
          roadCount: boundedRoads.length,
          roads: boundedRoads.slice(0, 100),
          graph: graphResult.ok ? graphResult.value : graphResult.error,
          graphSummary: graphResult.ok ? summarizeRoadGraphPayload(graphResult.value) : null,
          state: stateResult.ok ? stateResult.value : stateResult.error,
        };
        if (execute !== true) {
          return jsonResult({
            success: true,
            executed: false,
            requestedExecute: execute ?? false,
            observability: { roadGraph: roadGraphAvailable && graphResult.ok, roadRows: roadsResult.ok, gameState: stateResult.ok },
            evidence,
            findings: roadGraphAvailable && graphResult.ok ? [] : [{ code: "traffic_graph_unavailable", severity: "warning", message: "native traffic graph data could not be observed for this request", recommendedAction: "retry the graph read after the save finishes loading; do not widen roads blindly" }],
            proposal,
          });
        }
        if (!roadGraphAvailable || !graphResult.ok) {
          return jsonResult({
            success: false,
            noSuccess: true,
            executed: false,
            requestedExecute: true,
            observability: { roadGraph: false, roadRows: roadsResult.ok, gameState: stateResult.ok },
            reason: "no native road graph readback was available; no traffic repair was attempted",
            evidence,
          });
        }
        if (!topCandidate || !topCandidate.start || !topCandidate.end || !topCandidate.prefab) {
          return jsonResult({
            success: false,
            noSuccess: true,
            executed: false,
            requestedExecute: true,
            reason: "the native graph exposed no bounded car segment with measurable occupancy or density; no repair was attempted",
            proposal,
            evidence,
          });
        }

        const start = topCandidate.start;
        const end = topCandidate.end;
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const length = Math.hypot(dx, dz);
        if (length < 40) {
          return jsonResult({ success: false, noSuccess: true, executed: false, requestedExecute: true, reason: "the observed bottleneck is too short for a safe bounded parallel-road repair", proposal, evidence });
        }
        const offset = Math.max(16, Math.min(28, length * 0.08));
        const normal = { x: -dz / length, z: dx / length };
        const parallelStart = { x: start.x + normal.x * offset, y: start.y, z: start.z + normal.z * offset };
        const parallelEnd = { x: end.x + normal.x * offset, y: end.y, z: end.z + normal.z * offset };
        const repairPlans = [
          makeRoadPlan({ start, end: parallelStart, maxSegmentLength: 300, maxSlope: 0.12, role: "traffic repair connector" }),
          makeRoadPlan({ start: parallelStart, end: parallelEnd, maxSegmentLength: 300, maxSlope: 0.12, role: "traffic repair parallel road" }),
          makeRoadPlan({ start: parallelEnd, end, maxSegmentLength: 300, maxSlope: 0.12, role: "traffic repair connector" }),
        ];
        const repairIssues = repairPlans.flatMap((plan) => plan.issues);
        if (repairIssues.some((issue) => issue.severity === "error")) {
          return jsonResult({ success: false, noSuccess: true, executed: false, requestedExecute: true, proposal, repairPlans, issueCounts: issueCounts(repairIssues), reason: "the bounded parallel-road repair failed local geometry validation; no native mutation was attempted" });
        }
        const repairResults: JsonRecord[] = [];
        for (const [planIndex, plan] of repairPlans.entries()) {
          const result = await executeVerifiedRoadPlan(plan, topCandidate.prefab, false);
          repairResults.push({ plan: planIndex, ...result });
          if (result.success !== true) {
            return jsonResult({ success: false, noSuccess: true, executed: true, requestedExecute: true, proposal, repairPlans, repairResults, issueCounts: issueCounts(repairIssues), reason: "a native traffic repair segment failed network readback; later segments were not attempted" });
          }
        }
        const postGraph = await bestEffort(`/road/graph${query({ ...graphScope, pageSize: 500, includeLanes: false })}`, 30_000);
        return jsonResult({
          success: true,
          executed: true,
          requestedExecute: true,
          observability: { roadGraph: true, postRepairRoadGraph: postGraph.ok, roadRows: roadsResult.ok, gameState: stateResult.ok },
          proposal,
          repair: { strategy: "parallel-road-with-end-connectors", offset, prefab: topCandidate.prefab, start, parallelStart, parallelEnd, end },
          repairPlans,
          repairResults,
          postRepairEvidence: postGraph.ok ? postGraph.value : postGraph.error,
          note: "one bounded parallel-road repair passed native segment readback; run simulation and cs2_optimize_traffic again before claiming city-wide improvement",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_build_track",
    {
      title: "Build a native rail, tram, or subway track course",
      description:
        "Discover an unlocked runtime TrackPrefab, validate a track alignment, and optionally build it through the same native network tool used by the game. " +
        "Execution is opt-in and each segment must be read back from /city/roads with a new entity and matching endpoints before success is reported. " +
        "This creates physical track segments; it does not claim that stations, stops, route attachment, vehicles, or traffic analytics are available.",
      inputSchema: {
        mode: z.enum(["train", "tram", "subway"]),
        points: z.array(pointSchema).min(2).max(128).describe("ordered world waypoints for the track alignment"),
        prefab: z.string().optional().describe("optional exact runtime TrackPrefab from cs2_discover_assets(category=net, query=Track)"),
        geometry: geometrySchema.optional(),
        maxSegmentLength: z.number().min(8).max(1500).optional(),
        maxSlope: z.number().min(0.001).max(1).optional(),
        execute: z.boolean().optional().describe("true commits native track segments; omitted/false returns a plan only"),
        preview: z.boolean().optional().describe("alias for plan-only mode"),
        dryRun: z.boolean().optional().describe("alias for plan-only mode"),
        force: z.boolean().optional().describe("pass the game's force flag for a locked runtime prefab"),
      },
    },
    async ({ mode, points, prefab, geometry, maxSegmentLength, maxSlope, execute, preview, dryRun, force }) => {
      try {
        const capabilities = await bridgeJson<JsonRecord>("/capabilities", 5_000);
        if (!capability(capabilities, "track_construction")) {
          return jsonResult({
            success: false,
            executed: false,
            capability: "track_construction",
            available: false,
            mode,
            points,
            reason: "track_construction=false in the live bridge contract; no network mutation was emitted",
            recommendedAction: "keep the track operation in plan-only mode until the installed bridge reports track_construction=true",
          });
        }

        const selected = await selectTrackPrefab(prefab, mode);
        const plan = makeRoadPlan({
          start: points[0],
          end: points[points.length - 1],
          controlPoints: points.slice(1, -1),
          geometry: geometry as GeometryKind | undefined,
          maxSegmentLength,
          maxSlope,
          role: `${mode} track`,
        });
        const issues = plan.issues;
        const blocking = issues.filter((issue) => issue.severity === "error");
        const planOnly = preview === true || dryRun === true || execute !== true;
        if (planOnly || blocking.length > 0) {
          return jsonResult({
            success: blocking.length === 0,
            dryRun: true,
            executed: false,
            capability: "track_construction",
            available: true,
            mode,
            selectedPrefab: selected,
            plan,
            issueCounts: issueCounts(issues),
            note: blocking.length > 0 ? "native track construction was not attempted because the alignment has blocking geometry issues" : "preview only; no native track definitions were emitted",
          });
        }

        const center = {
          x: (points[0].x + points[points.length - 1].x) / 2,
          z: (points[0].z + points[points.length - 1].z) / 2,
        };
        const before = await bridgeJson<JsonRecord>(`/city/roads${query({ query: selected.name, x: center.x, z: center.z, radius: 2000, limit: 500 })}`, 20_000);
        const beforeKeys = new Set(extractRows(before, "roads")
          .map(asRecord)
          .map((row) => {
            const entity = asRecord(row?.entity);
            return typeof entity?.index === "number" && typeof entity.version === "number" ? `${entity.index}:${entity.version}` : undefined;
          })
          .filter((key): key is string => Boolean(key)));

        const executedSegments: JsonRecord[] = [];
        for (const [index, segment] of plan.segments.entries()) {
          const nativeRequest = await bridgeJson<JsonRecord>(roadQueryPath(selected.name, segment, force), 20_000);
          const verification = await pollNetworkSegment(selected.name, segment.start, segment.end, beforeKeys);
          executedSegments.push({
            segment: index,
            nativeRequest,
            verification: {
              status: verification.segment ? "readback" : "missing-after-queue",
              attempts: verification.attempts,
              entity: verification.segment ? asRecord(verification.segment.entity) ?? null : null,
              endpointMatches: Boolean(verification.segment),
            },
            readback: verification.segment ?? null,
          });
          if (!verification.segment) break;
        }
        const verified = executedSegments.length === plan.segments.length
          && executedSegments.every((entry) => asRecord(entry.verification)?.endpointMatches === true);
        return jsonResult({
          success: verified,
          dryRun: false,
          executed: true,
          queued: true,
          capability: "track_construction",
          available: true,
          mode,
          selectedPrefab: selected,
          plan,
          executedSegments,
          verification: {
            status: verified ? "readback" : "partial-or-missing-readback",
            expectedSegments: plan.segments.length,
            verifiedSegments: executedSegments.filter((entry) => asRecord(entry.verification)?.endpointMatches === true).length,
          },
          limitation: "physical track segments are verified; station/stop attachment, transport-line binding, vehicle scheduling, and transit analytics remain separate capabilities",
          note: verified ? undefined : "one or more native track segments were accepted without matching new road-entity readback; no full success is claimed and any partial construction must be cleaned up through cs2_demolish or a saved-state recovery",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  async function executeFacilityPlacement(args: {
    kind: "station" | "depot";
    mode: string;
    anchor: WorldPoint;
    rotation?: number;
    prefab?: string;
    execute?: boolean;
    preview?: boolean;
    dryRun?: boolean;
    force?: boolean;
  }): Promise<JsonRecord> {
    const capabilities = await bridgeJson<JsonRecord>("/capabilities", 5_000);
    const selected = await selectFacilityPrefab(args.prefab, args.kind, args.mode);
    const planOnly = args.preview === true || args.dryRun === true || args.execute !== true;
    const capabilityName = "transport_facility_placement";
    const preview = {
      kind: args.kind,
      mode: args.mode,
      prefab: selected,
      anchor: args.anchor,
      rotation: args.rotation ?? 0,
      nativePath: "/build/place -> ObjectToolBaseSystem.CreateDefinitions -> native building validation/apply",
    };
    if (planOnly) {
      return {
        success: true,
        dryRun: true,
        executed: false,
        capability: capabilityName,
        available: capability(capabilities, capabilityName),
        preview,
        note: "preview only; no transport facility definition was emitted",
      };
    }
    if (!capability(capabilities, capabilityName)) {
      return {
        success: false,
        dryRun: false,
        executed: false,
        capability: capabilityName,
        available: false,
        preview,
        reason: `${capabilityName}=false in the live bridge contract; no facility mutation was emitted`,
        recommendedAction: "use preview mode until a fresh-save native station/depot placement and readback has enabled this capability",
      };
    }

    const before = await bridgeJson<JsonRecord>(`/city/buildings${query({ query: selected.name, limit: 500 })}`, 20_000);
    const beforeKeys = new Set(extractRows(before, "buildings")
      .map(asRecord)
      .map((row) => {
        const entity = asRecord(row?.entity);
        return typeof entity?.index === "number" && typeof entity.version === "number" ? `${entity.index}:${entity.version}` : undefined;
      })
      .filter((key): key is string => Boolean(key)));
    const nativeRequest = await bridgeJson<JsonRecord>(`/build/place${query({
      prefab: selected.name,
      x: args.anchor.x,
      y: args.anchor.y,
      z: args.anchor.z,
      rotation: args.rotation ?? 0,
      force: args.force || undefined,
    })}`, 20_000);
    const center = args.anchor;
    let latest: JsonRecord | undefined;
    let readback: JsonRecord | undefined;
    let attempts = 0;
    for (attempts = 1; attempts <= 24; attempts++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      latest = await bridgeJson<JsonRecord>(`/city/buildings${query({ query: selected.name, limit: 500 })}`, 20_000);
      readback = extractRows(latest, "buildings")
        .map(asRecord)
        .find((row) => {
          const entity = asRecord(row?.entity);
          const position = positionOf(row);
          const key = typeof entity?.index === "number" && typeof entity.version === "number" ? `${entity.index}:${entity.version}` : undefined;
          return key !== undefined && !beforeKeys.has(key) && Boolean(position)
            && Math.hypot((position as WorldPoint).x - center.x, (position as WorldPoint).z - center.z) <= 120;
        });
      if (readback) break;
    }
    return {
      success: Boolean(readback),
      dryRun: false,
      executed: true,
      queued: true,
      capability: capabilityName,
      available: true,
      preview,
      nativeRequest,
      verification: {
        status: readback ? "readback" : "missing-after-queue",
        attempts,
        entity: readback ? asRecord(readback.entity) ?? null : null,
        prefab: readback ? asString(readback.prefab) ?? null : null,
        position: readback ? positionOf(readback) ?? null : null,
      },
      readback: readback ?? null,
      note: readback ? undefined : "no new facility entity matched the requested prefab and anchor; do not claim placement success",
    };
  }

  server.registerTool(
    "cs2_transport_analysis",
    {
      title: "Analyze native transport facilities and stops",
      description:
        "Read the live ECS transport topology plus native line analytics: station roots, depots/yards, stop entities, waiting passengers, RouteVehicle counts, VehicleTiming, active schedule, vehicle interval, ticket price, and connected route waypoints. This is read-only and never treats a missing binding as a healthy zero.",
      inputSchema: {
        x: z.number().optional(),
        z: z.number().optional(),
        radius: z.number().min(1).max(20000).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ x, z: zCoordinate, radius, limit }) => {
      try {
        const capabilities = await bridgeJson<JsonRecord>("/capabilities", 5_000);
        if (!capability(capabilities, "transport_analysis")) {
          return jsonResult({ success: false, available: false, capability: "transport_analysis", reason: "transport_analysis=false in the live bridge contract" });
        }
        return jsonResult(await bridgeJson(`/transport/analysis${query({ x, z: zCoordinate, radius, limit })}`, 20_000));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_dispatch_transport_vehicle",
    {
      title: "Dispatch a vehicle through the native transport request pipeline",
      description:
        "Preview or request one additional vehicle for an existing native Route + TransportLine. Execution emits the same ServiceRequest + TransportVehicleRequest + RequestGroup request used by the game's TransportLineSystem, then polls native transport analytics. A queued request is not reported as success: success requires RouteVehicle count or vehicle-entity readback to increase within the bounded wait window.",
      inputSchema: {
        entity: entityRefSchema.describe("live route entity from cs2_list_transport_lines"),
        priority: z.number().min(0).max(100).optional().describe("native dispatch priority, clamped by the bridge to 0..100; default 1"),
        waitSeconds: z.number().min(0).max(30).optional().describe("maximum native readback wait after queueing; default 8 seconds"),
        execute: z.boolean().optional().describe("false/default = native dry-run preview; true = emit the vehicle request and verify RouteVehicle readback"),
      },
    },
    async ({ entity, priority, waitSeconds, execute }) => {
      try {
        const capabilities = await bridgeJson<JsonRecord>("/capabilities", 5_000);
        if (!capability(capabilities, "transport_vehicle_dispatch")) {
          return jsonResult({
            success: false,
            noSuccess: true,
            executed: false,
            capability: "transport_vehicle_dispatch",
            available: false,
            entity,
            reason: "transport_vehicle_dispatch=false in the live bridge contract; no vehicle request was emitted",
            recommendedAction: "use cs2_list_transport_lines and cs2_transport_analysis for observation, or wait for a runtime bridge that exposes the native dispatch capability",
          });
        }

        const requestedPriority = priority ?? 1;
        const nativePath = "ServiceRequest + TransportVehicleRequest(route, priority) + RequestGroup -> TransportPathfindSetupSystem -> TransportVehicleDispatchSystem";
        const requestPath = `/transport/line/dispatch${query({
          index: entity.index,
          version: entity.version,
          priority: requestedPriority,
          dryRun: !(execute ?? false),
        })}`;
        if (!(execute ?? false)) {
          const nativePreview = await bridgeJson<JsonRecord>(requestPath, 20_000);
          return jsonResult({
            success: true,
            dryRun: true,
            executed: false,
            capability: "transport_vehicle_dispatch",
            available: true,
            entity,
            priority: requestedPriority,
            nativePath,
            nativePreview,
            note: "preview only; no vehicle request entity was emitted",
          });
        }

        const before = await bridgeJson<JsonRecord>(`/transport/analysis${query({ limit: 500, lineLimit: 500 })}`, 20_000);
        const beforeLine = transportAnalysisLineByEntity(before, entity);
        if (!beforeLine) {
          return jsonResult({
            success: false,
            noSuccess: true,
            dryRun: false,
            executed: false,
            queued: false,
            dispatched: false,
            capability: "transport_vehicle_dispatch",
            available: true,
            entity,
            priority: requestedPriority,
            verification: { status: "route-missing-from-analysis-before-dispatch", attempts: 0 },
            readback: before,
            note: "the target route was not present in the pre-dispatch analytics readback; no native vehicle request was emitted",
          });
        }

        const beforeCount = numberField(beforeLine, "routeVehicleCount");
        const beforeVehicleKeys = transportAnalysisVehicleKeys(beforeLine);
        const nativeRequest = await bridgeJson<JsonRecord>(requestPath, 20_000);
        const requestedWaitSeconds = waitSeconds ?? 8;
        const attempts = Math.max(1, Math.min(120, Math.ceil(requestedWaitSeconds * 4)));
        const verification = await pollTransportAnalysisLine(entity, (line) => {
          if (!line) return false;
          const afterCount = numberField(line, "routeVehicleCount");
          const newVehicle = [...transportAnalysisVehicleKeys(line)].some((key) => !beforeVehicleKeys.has(key));
          return (beforeCount !== undefined && afterCount !== undefined && afterCount > beforeCount) || newVehicle;
        }, attempts);
        const afterCount = numberField(verification.line, "routeVehicleCount");
        const afterVehicleKeys = transportAnalysisVehicleKeys(verification.line);
        const newVehicleEntities = [...afterVehicleKeys].filter((key) => !beforeVehicleKeys.has(key));
        const countIncreased = beforeCount !== undefined && afterCount !== undefined && afterCount > beforeCount;
        const dispatched = countIncreased || newVehicleEntities.length > 0;
        return jsonResult({
          success: dispatched,
          noSuccess: !dispatched,
          dryRun: false,
          executed: true,
          queued: true,
          dispatched,
          capability: "transport_vehicle_dispatch",
          available: true,
          entity,
          priority: requestedPriority,
          nativePath,
          nativeRequest,
          verification: {
            status: dispatched ? "route-vehicle-readback" : "queued-without-route-vehicle-readback",
            attempts: verification.attempts,
            waitSeconds: requestedWaitSeconds,
            beforeRouteVehicleCount: beforeCount ?? null,
            afterRouteVehicleCount: afterCount ?? null,
            countIncreased,
            newVehicleEntities,
            pendingVehicleRequest: asRecord(asRecord(verification.line)?.native)?.vehicleRequest ?? null,
          },
          readback: verification.line ?? null,
          note: dispatched
            ? "native RouteVehicle readback confirms that an additional vehicle was dispatched"
            : "the native request was queued but no additional RouteVehicle was observed within the wait window; this may indicate missing depot capacity, route/pathfinding prerequisites, inactive service, or a longer native spawn delay",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_place_station",
    {
      title: "Place a native transport station",
      description:
        "Preview or place a runtime-discovered transport station through the game's native object tool. Execution is capability-gated and only reports success after a new station building entity is read back near the requested road-side anchor.",
      inputSchema: {
        mode: z.enum(["bus", "tram", "subway", "train", "ship", "ferry", "air", "cargo"]),
        anchor: pointSchema,
        prefab: z.string().optional().describe("exact runtime station building prefab; omit for mode-filtered discovery"),
        rotation: z.number().optional(),
        execute: z.boolean().optional(),
        preview: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        force: z.boolean().optional(),
      },
    },
    async ({ mode, anchor, prefab, rotation, execute, preview, dryRun, force }) => {
      try {
        return jsonResult(await executeFacilityPlacement({ kind: "station", mode, anchor, prefab, rotation, execute, preview, dryRun, force }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_place_depot",
    {
      title: "Place a native transport depot or yard",
      description:
        "Preview or place a runtime-discovered transport depot/yard through the game's native object tool. Execution is capability-gated and only reports success after a new depot entity is read back near the requested road-side anchor.",
      inputSchema: {
        mode: z.enum(["bus", "tram", "subway", "train", "ship", "ferry", "air", "cargo"]),
        anchor: pointSchema,
        prefab: z.string().optional().describe("exact runtime depot/yard building prefab; omit for mode-filtered discovery"),
        rotation: z.number().optional(),
        execute: z.boolean().optional(),
        preview: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        force: z.boolean().optional(),
      },
    },
    async ({ mode, anchor, prefab, rotation, execute, preview, dryRun, force }) => {
      try {
        return jsonResult(await executeFacilityPlacement({ kind: "depot", mode, anchor, prefab, rotation, execute, preview, dryRun, force }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_place_stop",
    {
      title: "Place or attach a native transport stop",
      description:
        "Preview or place a runtime-discovered transport-stop prefab through the game's native object path. Execution is capability-gated and only reports success after a new TransportStop entity is read back near the requested road/track anchor. A station entity is accepted for planning metadata but station-subobject attachment remains a separate capability.",
      inputSchema: {
        mode: z.enum(["bus", "tram", "subway", "train", "ship", "ferry", "air", "cargo"]),
        anchor: pointSchema,
        station: entityRefSchema.optional().describe("optional existing station entity; native subobject attachment is not claimed by this endpoint"),
        prefab: z.string().optional().describe("optional exact runtime stop prefab; omit for native mode-filtered discovery"),
        rotation: z.number().optional(),
        force: z.boolean().optional(),
        execute: z.boolean().optional(),
        preview: z.boolean().optional(),
        dryRun: z.boolean().optional(),
      },
    },
    async ({ mode, anchor, station, prefab, rotation, force, execute, preview, dryRun }) => {
      try {
        const capabilities = await bridgeJson<JsonRecord>("/capabilities", 5_000);
        const available = capability(capabilities, "transit_stops");
        const planOnly = preview === true || dryRun === true || execute !== true;
        const stationAttachmentRequested = station !== undefined;
        const request = { mode, anchor, station, prefab, rotation: rotation ?? 0, force: force ?? false };
        if (stationAttachmentRequested && !planOnly) {
          return jsonResult({
            success: false,
            dryRun: false,
            executed: false,
            capability: "transport_stop_station_attachment",
            available: false,
            request,
            reason: "station-subobject attachment is not implemented; no standalone stop was placed because the caller requested a station binding",
            recommendedAction: "use cs2_transport_analysis to select an existing native stop, then pass it through cs2_create_transport_line.stopEntities for a verified route binding",
          });
        }

        const nativePreview = await bridgeJson<JsonRecord>(`/transport/stop/place${query({
          mode,
          prefab,
          x: anchor.x,
          y: anchor.y,
          z: anchor.z,
          rotation: rotation ?? 0,
          dryRun: true,
          force: force || undefined,
        })}`, 20_000);
        if (planOnly) {
          return jsonResult({
            success: true,
            dryRun: true,
            executed: false,
            capability: "transit_stops",
            available,
            request,
            nativePreview,
            stationAttachment: stationAttachmentRequested ? "plan-only metadata; not executed" : "not requested",
            note: "preview only; no stop definition was emitted",
          });
        }
        if (!available) {
          return jsonResult({
            success: false,
            dryRun: false,
            executed: false,
            capability: "transit_stops",
            available: false,
            request,
            nativePreview,
            reason: "transit_stops=false in the live bridge contract; no stop mutation was emitted",
            recommendedAction: "keep execution disabled until a fresh-save native TransportStop readback enables this capability",
          });
        }

        const before = await bridgeJson<JsonRecord>(`/transport/analysis${query({ x: anchor.x, z: anchor.z, radius: 120, limit: 500 })}`, 20_000);
        const beforeKeys = new Set(transportStopRows(before).map(transportStopEntityKey).filter((key): key is string => Boolean(key)));
        const nativeRequest = await bridgeJson<JsonRecord>(`/transport/stop/place${query({
          mode,
          prefab,
          x: anchor.x,
          y: anchor.y,
          z: anchor.z,
          rotation: rotation ?? 0,
          force: force || undefined,
        })}`, 20_000);
        let latest: JsonRecord | undefined;
        let readback: JsonRecord | undefined;
        let attempts = 0;
        for (attempts = 1; attempts <= 24; attempts++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          latest = await bridgeJson<JsonRecord>(`/transport/analysis${query({ x: anchor.x, z: anchor.z, radius: 120, limit: 500 })}`, 20_000);
          readback = transportStopRows(latest).find((stop) => {
            const key = transportStopEntityKey(stop);
            const actualPrefab = asString(stop.prefab);
            return key !== undefined
              && !beforeKeys.has(key)
              && transportStopMatchesAnchor(stop, anchor, 120)
              && (!prefab || actualPrefab?.toLowerCase() === prefab.toLowerCase());
          });
          if (readback) break;
        }
        return jsonResult({
          success: Boolean(readback),
          dryRun: false,
          executed: true,
          queued: true,
          capability: "transit_stops",
          available: true,
          request,
          nativePreview,
          nativeRequest,
          verification: { status: readback ? "readback" : "missing-after-queue", attempts, entity: readback ? asRecord(readback.entity) ?? null : null, position: readback ? positionOf(readback) ?? null : null },
          readback: readback ?? null,
          note: readback ? undefined : "the native request was accepted but no new TransportStop entity matched the anchor; no placement success is claimed",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_list_transport_lines",
    {
      title: "List native transport lines",
      description:
        "Read live Route + TransportLine entities and their native waypoint positions. This is an observation endpoint; it does not infer lines from planned stops.",
      inputSchema: {
        query: z.string().optional().describe("case-insensitive runtime transport prefab filter"),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ query: search, limit }) => {
      try {
        return jsonResult(await bridgeJson(`/transport/lines${query({ query: search, limit })}`, 20_000));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_set_transport_line_settings",
    {
      title: "Set native transport-line settings",
      description:
        "Preview or apply the game's native day/night/inactive schedule and active state, plus the live TransportLine vehicle interval, unbunching factor, ticket price, and name. Execution is verified from native ECS/UI projections; no settings are invented when the route entity is stale.",
      inputSchema: {
        entity: entityRefSchema.describe("live route entity from cs2_list_transport_lines"),
        schedule: z.union([z.enum(["day", "night", "inactive"]), z.number().int().min(0).max(2)]).optional(),
        active: z.boolean().optional(),
        name: z.string().min(1).max(128).optional(),
        vehicleInterval: z.number().positive().max(3600).optional().describe("seconds between vehicles"),
        unbunchingFactor: z.number().min(0).max(1).optional(),
        ticketPrice: z.number().int().min(0).max(65535).optional(),
        execute: z.boolean().optional().describe("false/default = native dry-run preview; true = apply and verify"),
      },
    },
    async ({ entity, schedule, active, name, vehicleInterval, unbunchingFactor, ticketPrice, execute }) => {
      try {
        const capabilities = await bridgeJson("/capabilities", 5_000);
        if (!capability(capabilities, "transit_line_settings")) {
          return jsonResult({ success: false, executed: false, capability: "transit_line_settings", available: false, entity, reason: "transit_line_settings=false in the live bridge contract; no line settings were changed" });
        }
        return jsonResult(await bridgeJson(`/transport/line/settings${query({
          index: entity.index,
          version: entity.version,
          schedule,
          active,
          name,
          vehicleInterval,
          unbunchingFactor,
          ticketPrice,
          dryRun: !(execute ?? false),
        })}`, 20_000));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_create_transport_line",
    {
      title: "Create a transport line when natively supported",
      description:
        "Create a transport route through the game's native route-definition pipeline when transit_lines is available. The points are treated as route waypoints; native route and waypoint entities are read back after execution. Stops/stations are not silently simulated and remain a separate capability.",
      inputSchema: {
        mode: z.enum(["bus", "tram", "subway", "train", "taxi", "ship", "ferry", "air", "cargo"]),
        stops: z.array(pointSchema).min(2).max(128),
        stopEntities: z.array(nullableEntityRefSchema).min(2).max(128).optional().describe("optional native TransportStop entity per waypoint; cardinality must match stops, null leaves that waypoint unbound"),
        name: z.string().optional(),
        prefab: z.string().optional().describe("optional exact runtime transport prefab from cs2_discover_assets(category=transport) or the dedicated transport discovery endpoint"),
        execute: z.boolean().optional(),
        force: z.boolean().optional(),
      },
    },
    async ({ mode, stops, stopEntities, name, prefab, execute, force }) => {
      try {
        const payload = await bridgeJson("/capabilities", 5_000);
        if (!capability(payload, "transit_lines")) {
          return jsonResult({ success: false, executed: false, requestedExecute: execute ?? true, capability: "transit_lines", available: false, mode, name: name ?? `${mode} line`, stops, reason: "transit_lines=false in the live bridge contract; no line was created", recommendedAction: "use cs2_plan_transport for a plan-only corridor and keep execution disabled until the installed bridge reports transit_lines=true" });
        }
        if (stopEntities && stopEntities.length !== stops.length) {
          return jsonResult({ success: false, executed: false, capability: "transit_stop_attachment", available: capability(payload, "transit_stop_attachment"), mode, stops, stopEntities, reason: `stopEntities must contain exactly ${stops.length} entries so every native waypoint has an explicit binding or null`, recommendedAction: "pass one native TransportStop entity or null for each route waypoint" });
        }
        if (stopEntities && !capability(payload, "transit_stop_attachment")) {
          return jsonResult({ success: false, executed: false, capability: "transit_stop_attachment", available: false, mode, stops, stopEntities, reason: "transit_stop_attachment=false in the live bridge contract; no route binding was emitted", recommendedAction: "use cs2_transport_analysis to obtain native stop entities and wait for a verified attachment capability" });
        }
        const selected = await selectTransportPrefab(prefab, mode);
        const requestPath = `/transport/line${query({
          mode,
          prefab: selected.name,
          points: JSON.stringify(stops),
          connections: stopEntities ? JSON.stringify(stopEntities) : undefined,
          dryRun: !(execute ?? false),
          force: force || undefined,
        })}`;
        const existing = await bridgeJson<JsonRecord>(`/transport/lines${query({ query: selected.name, limit: 200 })}`, 20_000);
        const existingKeys = new Set(extractRows(existing, "lines").map(asRecord).map(transportLineEntityKey).filter((key): key is string => Boolean(key)));
        const requestResult = await bridgeJson<JsonRecord>(requestPath, 20_000);
        if (!(execute ?? false)) {
          return jsonResult({ success: true, dryRun: true, executed: false, capability: "transit_lines", available: true, mode, name: name ?? `${mode} line`, selectedPrefab: selected, stops, stopEntities: stopEntities ?? null, nativePreview: requestResult });
        }

        let readback: JsonRecord | undefined;
        let createdLine: JsonRecord | undefined;
        for (let attempt = 0; attempt < 24; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const candidate = await bridgeJson<JsonRecord>(`/transport/lines${query({ query: selected.name, limit: 200 })}`, 20_000);
            const newLine = asArray(candidate.lines)
              .map(asRecord)
              .find((line) => {
                const key = transportLineEntityKey(line);
                return key !== undefined
                  && !existingKeys.has(key)
                  && (!stopEntities || transportLineMatchesConnections(line, stopEntities));
              });
           if (newLine) {
             readback = candidate;
             createdLine = newLine;
             break;
          }
        }
        return jsonResult({
           success: Boolean(createdLine) && (!stopEntities || transportLineMatchesConnections(createdLine, stopEntities)),
          dryRun: false,
          executed: true,
          queued: true,
          capability: "transit_lines",
          available: true,
          mode,
          name: name ?? `${mode} line`,
           selectedPrefab: selected,
           stops,
           stopEntities: stopEntities ?? null,
           nativeRequest: requestResult,
           createdLine: createdLine ?? null,
           readback: readback ?? { status: "pending", note: "route definition was accepted but no new route entity was observed during the readback window; no success is claimed" },
           bindingVerification: stopEntities ? { requested: true, verified: Boolean(createdLine && transportLineMatchesConnections(createdLine, stopEntities)), connections: createdLine ? transportLineConnections(createdLine) : [] } : { requested: false },
           limitation: "native line creation, same-cardinality modification, cardinality-changing waypoint insertion/removal, and deletion are verified through Route + TransportLine entities; scheduling/settings and read-only analytics are exposed through their own native paths",
          note: createdLine ? undefined : "the native request was accepted but the live readback did not contain a new route entity; poll cs2_list_transport_lines before proceeding",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_modify_transport_line",
    {
      title: "Modify a native transport line",
        description:
        "Preview or commit a waypoint change for an existing native Route + TransportLine entity. Same-cardinality updates reuse the existing waypoint entities; insertion/removal is supported when waypointEntities supplies one existing waypoint entity or null for each target point. Execution uses the game's native CreationDefinition(m_Original route, optional Recreate) + WaypointDefinition(m_Original waypoint/null) path and only reports success after route coordinates/readback match. Use cs2_set_transport_line_settings for schedule/state/interval control and cs2_transport_analysis for native analytics.",
      inputSchema: {
        entity: z.object({
          index: z.number().int().min(0).describe("runtime route entity index from cs2_list_transport_lines"),
          version: z.number().int().min(0).describe("runtime route entity version paired with index"),
        }),
        points: z.array(pointSchema).min(2).max(128).describe("replacement route waypoints; may insert/remove points when waypointEntities is supplied"),
        waypointEntities: z.array(nullableEntityRefSchema).min(2).max(128).optional().describe("optional existing native waypoint entity per target point; use null for an inserted waypoint and omit removed waypoints"),
        stopEntities: z.array(nullableEntityRefSchema).min(2).max(128).optional().describe("optional native TransportStop entity per waypoint; cardinality must match points"),
        execute: z.boolean().optional().describe("false/default = native dry-run preview; true = commit and verify the route mutation"),
      },
    },
    async ({ entity, points, waypointEntities, stopEntities, execute }) => {
      try {
        const capabilities = await bridgeJson("/capabilities", 5_000);
        if (!capability(capabilities, "transit_line_mutation")) {
          return jsonResult({
            success: false,
            executed: false,
            requestedExecute: execute ?? false,
            capability: "transit_line_mutation",
            available: false,
            entity,
            points,
            reason: "transit_line_mutation=false in the live bridge contract; no route was modified",
            recommendedAction: "use cs2_list_transport_lines for observation and keep this operation in preview/plan-only mode until the installed bridge reports transit_line_mutation=true",
          });
        }
        if (stopEntities && stopEntities.length !== points.length) {
          return jsonResult({ success: false, executed: false, capability: "transit_stop_attachment", available: capability(capabilities, "transit_stop_attachment"), entity, points, stopEntities, reason: `stopEntities must contain exactly ${points.length} entries`, recommendedAction: "pass one native TransportStop entity or null for each route waypoint" });
        }
        if (waypointEntities && waypointEntities.length !== points.length) {
          return jsonResult({ success: false, executed: false, capability: "transit_line_mutation", available: true, entity, points, waypointEntities, reason: `waypointEntities must contain exactly ${points.length} entries`, recommendedAction: "pass one existing native waypoint entity or null for each target point" });
        }
        if (stopEntities && !capability(capabilities, "transit_stop_attachment")) {
          return jsonResult({ success: false, executed: false, capability: "transit_stop_attachment", available: false, entity, points, stopEntities, reason: "transit_stop_attachment=false in the live bridge contract; no route binding was emitted", recommendedAction: "use cs2_transport_analysis and keep the operation in preview mode until native binding is verified" });
        }

        const requestPath = `/transport/line/modify${query({
          index: entity.index,
          version: entity.version,
          points: JSON.stringify(points),
          originalWaypoints: waypointEntities ? JSON.stringify(waypointEntities) : undefined,
          connections: stopEntities ? JSON.stringify(stopEntities) : undefined,
          dryRun: !(execute ?? false),
        })}`;
        const requestResult = await bridgeJson<JsonRecord>(requestPath, 20_000);
        if (!(execute ?? false)) {
          return jsonResult({
            success: true,
            dryRun: true,
            executed: false,
            capability: "transit_line_mutation",
            available: true,
            entity,
            points,
            waypointEntities: waypointEntities ?? null,
            stopEntities: stopEntities ?? null,
            nativePreview: requestResult,
          });
        }

        const verification = await pollTransportLine(entity.index, (line) => transportLineMatchesPoints(line, points)
          && (!stopEntities || transportLineMatchesConnections(line, stopEntities)));
        if (!verification.line) {
          return jsonResult({
            success: false,
            dryRun: false,
            executed: true,
            queued: true,
            modified: false,
            capability: "transit_line_mutation",
            available: true,
            entity,
            points,
            waypointEntities: waypointEntities ?? null,
            nativeRequest: requestResult,
            verification: { status: "missing-after-queue", attempts: verification.attempts },
            readback: verification.payload ?? null,
            note: "the native request was accepted but the target route was not present during the readback window; no success is claimed",
          });
        }
        const actualPoints = transportLinePoints(verification.line);
        const positionMatches = transportLineMatchesPoints(verification.line, points);
        const bindingMatches = !stopEntities || transportLineMatchesConnections(verification.line, stopEntities);
        const verified = positionMatches && bindingMatches;
        return jsonResult({
          success: verified,
          dryRun: false,
          executed: true,
          queued: true,
          modified: verified,
          capability: "transit_line_mutation",
          available: true,
          entity: asRecord(verification.line.entity) ?? entity,
          points,
          waypointEntities: waypointEntities ?? null,
          stopEntities: stopEntities ?? null,
          nativeRequest: requestResult,
          verification: {
            status: verified ? "readback" : "mismatch-after-queue",
            attempts: verification.attempts,
            pointCount: actualPoints.length,
            positionMatches,
            bindingMatches,
            connections: transportLineConnections(verification.line),
          },
          readback: verification.line,
          note: verified ? undefined : "the route still exists but its readback coordinates or bindings did not match the requested points; no success is claimed",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_delete_transport_line",
    {
      title: "Delete a native transport line",
      description:
        "Preview or commit deletion of an existing native Route + TransportLine entity. Execution uses the game's native CreationDefinition(Delete, m_Original route) + WaypointDefinition(m_Original waypoint) path and only reports success after the route entity is absent from live readback.",
      inputSchema: {
        entity: z.object({
          index: z.number().int().min(0).describe("runtime route entity index from cs2_list_transport_lines"),
          version: z.number().int().min(0).describe("runtime route entity version paired with index"),
        }),
        execute: z.boolean().optional().describe("false/default = native dry-run preview; true = commit and verify deletion"),
      },
    },
    async ({ entity, execute }) => {
      try {
        const capabilities = await bridgeJson("/capabilities", 5_000);
        if (!capability(capabilities, "transit_line_mutation")) {
          return jsonResult({
            success: false,
            executed: false,
            requestedExecute: execute ?? false,
            capability: "transit_line_mutation",
            available: false,
            entity,
            reason: "transit_line_mutation=false in the live bridge contract; no route was deleted",
            recommendedAction: "use cs2_list_transport_lines for observation and keep this operation in preview/plan-only mode until the installed bridge reports transit_line_mutation=true",
          });
        }

        const requestPath = `/transport/line/delete${query({
          index: entity.index,
          version: entity.version,
          dryRun: !(execute ?? false),
        })}`;
        const requestResult = await bridgeJson<JsonRecord>(requestPath, 20_000);
        if (!(execute ?? false)) {
          return jsonResult({
            success: true,
            dryRun: true,
            executed: false,
            capability: "transit_line_mutation",
            available: true,
            entity,
            nativePreview: requestResult,
          });
        }

        const verification = await pollTransportLine(entity.index, (line) => line === undefined);
        const deleted = verification.line === undefined;
        return jsonResult({
          success: deleted,
          dryRun: false,
          executed: true,
          queued: true,
          deleted,
          capability: "transit_line_mutation",
          available: true,
          entity,
          nativeRequest: requestResult,
          verification: {
            status: deleted ? "absent" : "still-present-after-queue",
            attempts: verification.attempts,
          },
          readback: verification.payload ?? null,
          note: deleted ? undefined : "the native request was accepted but the route remained present during the readback window; no success is claimed",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_transform_object",
    {
      title: "Relocate a live object through the native tool pipeline",
      description:
        "Preview or commit a position/yaw change for a live transformable object identified by entity index and version. Execution uses CreationDefinition(Relocate) + ObjectDefinition on the game's main-thread tool pipeline, then reads the entity back to verify the new position. Roads remain on their native road upgrade/demolish paths.",
      inputSchema: {
        entity: z.object({
          index: z.number().int().min(0).describe("runtime entity index from cs2_list_props/cs2_query_entities/cs2_list_buildings"),
          version: z.number().int().min(0).describe("runtime entity version paired with index"),
        }),
        position: pointSchema.describe("target world position; y is optional and defaults to the current elevation"),
        rotation: z.number().optional().describe("target yaw in degrees around world Y; omitted preserves the current yaw"),
        execute: z.boolean().optional().describe("false/default = dry-run preview; true = commit the native relocation"),
      },
    },
    async ({ entity, position, rotation, execute }) => {
      try {
        const capabilities = await bridgeJson("/capabilities", 5_000);
        if (!capability(capabilities, "object_transform")) {
          return jsonResult({
            success: false,
            executed: false,
            requestedExecute: execute ?? false,
            capability: "object_transform",
            available: false,
            entity,
            position,
            rotation,
            reason: "object_transform=false in the live bridge contract; no relocation was emitted",
            recommendedAction: "keep the operation in plan-only mode until the installed bridge reports object_transform=true",
          });
        }

        const nativeRequest = await bridgeJson<JsonRecord>(`/object/transform${query({
          index: entity.index,
          version: entity.version,
          x: position.x,
          y: position.y,
          z: position.z,
          rotation,
          dryRun: !(execute ?? false),
        })}`, 20_000);
        if (!(execute ?? false)) {
          return jsonResult({
            success: true,
            dryRun: true,
            executed: false,
            capability: "object_transform",
            available: true,
            entity,
            position,
            rotation,
            nativePreview: nativeRequest,
          });
        }

        let readback: unknown;
        let readbackError: string | undefined;
        for (let attempt = 0; attempt < 6; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const candidate = await bestEffort(`/entity/inspect${query({ index: entity.index, version: entity.version })}`, 20_000);
          if (candidate.ok) {
            readback = candidate.value;
            break;
          }
          readbackError = candidate.error;
        }
        const observedPosition = positionOf(readback);
        const positionMatches = Boolean(
          observedPosition &&
            Math.abs(observedPosition.x - position.x) <= 0.5 &&
            Math.abs(observedPosition.z - position.z) <= 0.5 &&
            (position.y === undefined || Math.abs((observedPosition.y ?? position.y) - position.y) <= 0.5),
        );
        return jsonResult({
          success: positionMatches,
          dryRun: false,
          executed: true,
          capability: "object_transform",
          available: true,
          entity,
          position,
          rotation,
          nativeRequest,
          readback: readback ?? { status: "unverified", error: readbackError ?? "entity readback did not complete" },
          verification: { entityReadback: readback !== undefined, positionMatches },
          limitation: "the native relocation path applies to live objects with Transform + PrefabRef; roads use dedicated network mutation paths",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_move_object",
    {
      title: "Move a live object",
      description: "Alias for the native object relocation path with explicit movement semantics. Execution is verified by entity position readback.",
      inputSchema: {
        entity: entityRefSchema,
        position: pointSchema,
        rotation: z.number().optional(),
        execute: z.boolean().optional(),
      },
    },
    async ({ entity, position, rotation, execute }) => {
      try {
        return jsonResult(await relocateObjectVerified(entity, position, rotation, execute === true));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_rotate_object",
    {
      title: "Rotate a live object",
      description: "Read the current entity position, then apply a native yaw-only relocation and verify the entity remains at the same position.",
      inputSchema: {
        entity: entityRefSchema,
        rotation: z.number(),
        execute: z.boolean().optional(),
      },
    },
    async ({ entity, rotation, execute }) => {
      try {
        const inspected = await bridgeJson<JsonRecord>(`/entity/inspect${query({ index: entity.index, version: entity.version })}`, 20_000);
        const position = positionOf(inspected);
        if (!position) return jsonResult({ success: false, executed: false, entity, rotation, reason: "entity did not expose a native Transform position" });
        return jsonResult(await relocateObjectVerified(entity, position, rotation, execute === true));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_copy_object",
    {
      title: "Copy a live object through native placement",
      description: "Read a source object's runtime prefab and place a new instance through the native building/object placement path. The result is successful only after a new entity readback at the requested destination; sub-objects and service attachments are not silently cloned.",
      inputSchema: {
        source: entityRefSchema,
        position: pointSchema,
        rotation: z.number().optional(),
        execute: z.boolean().optional(),
        force: z.boolean().optional(),
      },
    },
    async ({ source, position, rotation, execute, force }) => {
      try {
        return jsonResult(await copyObjectVerified(source, position, rotation, execute === true, force === true));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_recolor_object",
    {
      title: "Recolor a live object",
      description: "Expose the optional object recolor contract without pretending that a generic native ColorDefinition exists for arbitrary placed objects. The current game bridge leaves this operation plan-only and performs no mutation.",
      inputSchema: {
        entity: entityRefSchema,
        color: z.object({ r: z.number().min(0).max(1), g: z.number().min(0).max(1), b: z.number().min(0).max(1), a: z.number().min(0).max(1).optional() }),
        execute: z.boolean().optional(),
      },
    },
    async ({ entity, color, execute }) => jsonResult({
      success: false,
      executed: false,
      requestedExecute: execute === true,
      available: false,
      capability: "object_recolor",
      entity,
      color,
      reason: "the installed CS2 object tool exposes no generic native recolor definition for arbitrary placed objects; no ECS color field was written",
      recommendedAction: "use the prefab's native variant or a transport-line color setting when the game exposes that specific native contract",
    }),
  );

  server.registerTool(
    "cs2_execute_master_plan",
    {
      title: "Execute a staged metropolitan master plan",
      description:
        "Run the complete observe -> plan -> pause/save -> build -> native readback -> zone/service/transit/landscape -> simulate -> diagnose -> screenshot -> checkpoint loop for a previously returned cs2_plan_metropolis plan. Dry-run is the default. Roads, districts, zones, service buildings, native bus stops/routes, physical track segments, trees, props, and surfaces are each staged independently; unsupported capabilities remain explicit, failures pause the game, and the named preflight checkpoint is loaded through the native rollback path when a later stage fails.",
      inputSchema: {
        plan: z.record(z.unknown()).describe("master-plan JSON returned by cs2_plan_metropolis"),
        execute: z.boolean().optional().describe("false/default = preview only; true = mutate the game"),
        roadPrefab: z.string().optional().describe("optional exact runtime road prefab; otherwise select per corridor through discovery"),
        districtPrefab: z.string().optional().describe("optional exact runtime district prefab"),
        maxSegments: z.number().int().min(1).max(200).optional(),
        maxDistricts: z.number().int().min(0).max(32).optional(),
        maxTrees: z.number().int().min(0).max(500).optional(),
        maxProps: z.number().int().min(0).max(64).optional(),
        maxServiceBuildings: z.number().int().min(0).max(16).optional(),
        includeLandscape: z.boolean().optional().describe("include native surface, tree, and prop stages (default true)"),
        includeTransit: z.boolean().optional().describe("include native stop/route stage when capabilities are true (default true)"),
        includeServices: z.boolean().optional().describe("include runtime-discovered utility/safety/health/education buildings (default true)"),
        includeTrack: z.boolean().optional().describe("also build a bounded physical rail/metro track spine when track_construction is true"),
        force: z.boolean().optional().describe("pass force=true to native operations; native validation still controls the result"),
        resume: z.boolean().optional().describe("resume simulation after final validation; failures always stay paused"),
        runSimulationHours: z.number().min(0).max(96).optional(),
        screenshotViews: z.number().int().min(1).max(4).optional(),
        failFast: z.boolean().optional().describe("stop at the first failed native readback instead of returning partial stages"),
      },
    },
    async ({ plan: planValue, execute, roadPrefab, districtPrefab, maxSegments, maxDistricts, maxTrees, maxProps, maxServiceBuildings, includeLandscape, includeTransit, includeServices, includeTrack, force, resume, runSimulationHours, screenshotViews, failFast }) => {
      try {
        const plan = requireRecord(planValue, "plan");
        return jsonResult(await runMasterPlanCycle(plan, {
          execute: execute === true,
          roadPrefab,
          districtPrefab,
          maxSegments: maxSegments ?? 120,
          maxDistricts: maxDistricts ?? 16,
          maxTrees: maxTrees ?? 48,
          maxProps: maxProps ?? 4,
          maxServiceBuildings: maxServiceBuildings ?? 6,
          includeLandscape: includeLandscape ?? true,
          includeTransit: includeTransit ?? true,
          includeServices: includeServices ?? true,
          includeTrack: includeTrack ?? false,
          force: force ?? false,
          resume: resume ?? false,
          runSimulationHours: runSimulationHours ?? 0,
          screenshotViews: screenshotViews ?? 3,
          failFast: failFast ?? false,
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cs2_run_autonomous_city_cycle",
    {
      title: "Plan and build a city autonomously",
      description:
        "Single-call autonomous entry point for the complete city-building loop. It observes the live save, discovers the runtime asset/capability contract, infers a centre from existing roads when possible, creates a terrain-aware metropolitan plan, and then delegates to the same guarded staged executor used by cs2_execute_master_plan. Say what you want built; the default remains dry-run until execute=true.",
      inputSchema: {
        bounds: boundsSchema.optional(),
        center: pointSchema.optional(),
        density: z.enum(["medium", "high"]).optional(),
        waterfront: z.boolean().optional(),
        fetchTerrain: z.boolean().optional(),
        execute: z.boolean().optional().describe("false/default = observe and preview only; true = mutate the loaded save"),
        roadPrefab: z.string().optional(),
        districtPrefab: z.string().optional(),
        maxSegments: z.number().int().min(1).max(200).optional(),
        maxDistricts: z.number().int().min(0).max(32).optional(),
        maxTrees: z.number().int().min(0).max(500).optional(),
        maxProps: z.number().int().min(0).max(64).optional(),
        maxServiceBuildings: z.number().int().min(0).max(16).optional(),
        includeLandscape: z.boolean().optional(),
        includeTransit: z.boolean().optional(),
        includeServices: z.boolean().optional(),
        includeTrack: z.boolean().optional(),
        force: z.boolean().optional(),
        resume: z.boolean().optional(),
        runSimulationHours: z.number().min(0).max(96).optional(),
        screenshotViews: z.number().int().min(1).max(4).optional(),
        failFast: z.boolean().optional(),
      },
    },
    async ({ bounds, center, density, waterfront, fetchTerrain, execute, roadPrefab, districtPrefab, maxSegments, maxDistricts, maxTrees, maxProps, maxServiceBuildings, includeLandscape, includeTransit, includeServices, includeTrack, force, resume, runSimulationHours, screenshotViews, failFast }) => {
      try {
        let terrainSnapshot: TerrainSnapshot | undefined;
        let terrainObservation: JsonRecord = { status: "not-requested" };
        if (fetchTerrain ?? true) {
          try {
            const terrain = await readTerrain(64);
            terrainSnapshot = terrain.snapshot;
            terrainObservation = { status: "observed", source: "live bridge /city/terrain" };
          } catch (error) {
            terrainObservation = { status: "unavailable", error: error instanceof Error ? error.message : String(error) };
          }
        }
        let resolvedCenter = center;
        let centerObservation: JsonRecord = center ? { status: "observed", source: "caller-supplied center" } : { status: "not-requested" };
        if (!resolvedCenter) {
          const roads = await bestEffort(`/city/roads${query({ limit: 500 })}`);
          const endpoints = roads.ok ? extractRows(roads.value, "roads").flatMap((row) => {
            const record = asRecord(row);
            return [positionOf(record?.start), positionOf(record?.end)].filter((value): value is WorldPoint => Boolean(value));
          }).filter((value) => !bounds || inside(value, bounds)) : [];
          if (endpoints.length > 0) {
            resolvedCenter = { x: endpoints.reduce((sum, value) => sum + value.x, 0) / endpoints.length, z: endpoints.reduce((sum, value) => sum + value.z, 0) / endpoints.length };
            centerObservation = { status: "observed", source: "centroid of live road endpoints", samples: endpoints.length };
          } else centerObservation = { status: "unavailable", reason: roads.ok ? "no live road endpoints were returned" : roads.error };
        }
        const plan = makeMetropolisPlan({ bounds, center: resolvedCenter, density, waterfront, terrain: terrainSnapshot });
        const cycle = await runMasterPlanCycle(plan, {
          execute: execute === true,
          roadPrefab,
          districtPrefab,
          maxSegments: maxSegments ?? 120,
          maxDistricts: maxDistricts ?? 16,
          maxTrees: maxTrees ?? 48,
          maxProps: maxProps ?? 4,
          maxServiceBuildings: maxServiceBuildings ?? 6,
          includeLandscape: includeLandscape ?? true,
          includeTransit: includeTransit ?? true,
          includeServices: includeServices ?? true,
          includeTrack: includeTrack ?? false,
          force: force ?? false,
          resume: resume ?? false,
          runSimulationHours: runSimulationHours ?? 0,
          screenshotViews: screenshotViews ?? 3,
          failFast: failFast ?? false,
        });
        return jsonResult({ success: asRecord(cycle)?.success === true, autonomous: true, observation: terrainObservation, centerObservation, plan, cycle });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
