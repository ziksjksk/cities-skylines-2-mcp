export type GeometryKind = "straight" | "bezier" | "arc" | "spline" | "polyline";

export interface WorldPoint {
  x: number;
  z: number;
  y?: number;
}

export interface NativeEntityRef {
  index: number;
  version: number;
}

/**
 * A native network anchor returned by the bridge.  `curvePosition` is the
 * normalized position on an existing edge; for a node anchor it is retained
 * as metadata because the native pipeline resolves the node entity directly.
 */
export interface RoadAnchor {
  mode: "node" | "road";
  entity: NativeEntityRef;
  curvePosition: number;
  distance: number;
}

export interface RoadObservation {
  entity?: NativeEntityRef;
  start?: WorldPoint;
  end?: WorldPoint;
  curve?: {
    a: WorldPoint;
    b: WorldPoint;
    c: WorldPoint;
    d: WorldPoint;
  };
  startNode?: NativeEntityRef;
  endNode?: NativeEntityRef;
}

export interface RoadSnapResult {
  points: WorldPoint[];
  anchors: Array<RoadAnchor | undefined>;
  applied: Array<{
    pointIndex: number;
    mode: "node" | "road" | "angle";
    distance: number;
    position: WorldPoint;
    entity?: NativeEntityRef;
    curvePosition?: number;
  }>;
  unresolved: Array<{
    pointIndex: number;
    mode: "node" | "road";
    nearestDistance: number | null;
  }>;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface PlanIssue {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  segment?: number;
  recommendedAction?: string;
}

export interface RoadSegmentPlan {
  start: WorldPoint;
  end: WorldPoint;
  control?: WorldPoint;
  role?: string;
  level?: number;
  startAnchor?: RoadAnchor;
  endAnchor?: RoadAnchor;
}

export interface RoadPlan {
  kind: "road-plan";
  geometry: GeometryKind;
  points: WorldPoint[];
  segments: RoadSegmentPlan[];
  length: number;
  issues: PlanIssue[];
  constraints: {
    maxSegmentLength: number;
    maxSlope: number;
    bounds?: Bounds;
  };
}

export interface TerrainSnapshot {
  resolution: number;
  worldMin: number;
  worldMax: number;
  cellSize: number;
  heights: number[];
  waterDepths: number[];
}

export interface TerrainSummary {
  resolution: number;
  worldBounds: Bounds;
  cellSize: number;
  height: { min: number; max: number; mean: number };
  slope: { min: number; max: number; mean: number; flatCells: number; steepCells: number };
  water: { wetCells: number; dryCells: number; deepest: number; coverage: number };
  buildable: { cells: number; coverage: number; slopeThreshold: number };
  observations: string[];
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function terrainCell(snapshot: TerrainSnapshot, value: WorldPoint): { row: number; col: number; index: number; water: number } | undefined {
  const resolution = Math.max(1, Math.floor(snapshot.resolution));
  const cellSize = Math.max(1, snapshot.cellSize);
  const col = Math.floor((value.x - snapshot.worldMin) / cellSize);
  const row = Math.floor((value.z - snapshot.worldMin) / cellSize);
  if (row < 0 || col < 0 || row >= resolution || col >= resolution) return undefined;
  const index = row * resolution + col;
  return { row, col, index, water: Math.max(0, finite(snapshot.waterDepths[index])) };
}

function terrainDryNeighbourhood(snapshot: TerrainSnapshot, row: number, col: number, radius = 1): number {
  const resolution = Math.max(1, Math.floor(snapshot.resolution));
  let samples = 0;
  let dry = 0;
  for (let candidateRow = row - radius; candidateRow <= row + radius; candidateRow++) {
    for (let candidateCol = col - radius; candidateCol <= col + radius; candidateCol++) {
      if (candidateRow < 0 || candidateCol < 0 || candidateRow >= resolution || candidateCol >= resolution) continue;
      samples++;
      const index = candidateRow * resolution + candidateCol;
      if (Math.max(0, finite(snapshot.waterDepths[index])) <= 0.05) dry++;
    }
  }
  return dry / Math.max(1, samples);
}

function buildablePlanningCentre(requested: WorldPoint, bounds: Bounds, terrain?: TerrainSnapshot): WorldPoint {
  if (!terrain) return requested;
  const requestedCell = terrainCell(terrain, requested);
  if (!requestedCell) return requested;
  const searchRadius = 5;
  const cellSize = Math.max(1, terrain.cellSize);
  let best = requested;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let row = requestedCell.row - searchRadius; row <= requestedCell.row + searchRadius; row++) {
    for (let col = requestedCell.col - searchRadius; col <= requestedCell.col + searchRadius; col++) {
      const candidate: WorldPoint = {
        x: terrain.worldMin + (col + 0.5) * cellSize,
        z: terrain.worldMin + (row + 0.5) * cellSize,
      };
      if (candidate.x < bounds.minX || candidate.x > bounds.maxX || candidate.z < bounds.minZ || candidate.z > bounds.maxZ) continue;
      const cell = terrainCell(terrain, candidate);
      if (!cell) continue;
      const dryFraction = terrainDryNeighbourhood(terrain, cell.row, cell.col, 1);
      const distancePenalty = distance(requested, candidate) / cellSize;
      const waterPenalty = cell.water > 0.05 ? 100 : 0;
      const score = dryFraction * 100 - distancePenalty * 4 - waterPenalty;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
  }
  return best;
}

export function point(value: unknown, fallback: WorldPoint = { x: 0, z: 0 }): WorldPoint {
  if (!value || typeof value !== "object") return { ...fallback };
  const raw = value as Record<string, unknown>;
  const result: WorldPoint = { x: finite(raw.x, fallback.x), z: finite(raw.z, fallback.z) };
  if (typeof raw.y === "number" && Number.isFinite(raw.y)) result.y = raw.y;
  if (typeof raw.elevation === "number" && Number.isFinite(raw.elevation)) result.y = raw.elevation;
  return result;
}

export function distance(a: WorldPoint, b: WorldPoint): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

export function interpolate(a: WorldPoint, b: WorldPoint, t: number): WorldPoint {
  const result: WorldPoint = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
  if (a.y !== undefined || b.y !== undefined) result.y = (a.y ?? 0) + ((b.y ?? 0) - (a.y ?? 0)) * t;
  return result;
}

/**
 * Offset a planar alignment along the left-hand normal of its end-to-end
 * direction.  Vertical elevations are intentionally preserved.  This is a
 * geometry operation used before native validation; it does not bypass the
 * game's road snapping, collision, or slope rules.
 */
export function offsetWorldPath(points: WorldPoint[], offset = 0): WorldPoint[] {
  const safeOffset = finite(offset);
  if (points.length < 2 || Math.abs(safeOffset) < 1e-6) return points.map((value) => ({ ...value }));
  const first = points[0];
  const last = points[points.length - 1];
  const length = Math.hypot(last.x - first.x, last.z - first.z);
  if (length < 1e-6) return points.map((value) => ({ ...value }));
  const normalX = -(last.z - first.z) / length;
  const normalZ = (last.x - first.x) / length;
  return points.map((value) => ({ ...value, x: value.x + normalX * safeOffset, z: value.z + normalZ * safeOffset }));
}

function entityRef(value: unknown): NativeEntityRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  return typeof raw.index === "number" && Number.isInteger(raw.index)
    && typeof raw.version === "number" && Number.isInteger(raw.version)
    ? { index: raw.index, version: raw.version }
    : undefined;
}

function worldPointOrUndefined(value: unknown): WorldPoint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.x !== "number" || !Number.isFinite(raw.x) || typeof raw.z !== "number" || !Number.isFinite(raw.z)) return undefined;
  const result: WorldPoint = { x: raw.x, z: raw.z };
  if (typeof raw.y === "number" && Number.isFinite(raw.y)) result.y = raw.y;
  return result;
}

function cubicPoint(a: WorldPoint, b: WorldPoint, c: WorldPoint, d: WorldPoint, t: number): WorldPoint {
  const u = 1 - t;
  const result: WorldPoint = {
    x: u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x,
    z: u ** 3 * a.z + 3 * u * u * t * b.z + 3 * u * t * t * c.z + t ** 3 * d.z,
  };
  if (a.y !== undefined || b.y !== undefined || c.y !== undefined || d.y !== undefined) {
    result.y = u ** 3 * (a.y ?? 0) + 3 * u * u * t * (b.y ?? 0) + 3 * u * t * t * (c.y ?? 0) + t ** 3 * (d.y ?? 0);
  }
  return result;
}

function projectPointToSegment(value: WorldPoint, start: WorldPoint, end: WorldPoint): { position: WorldPoint; t: number; distance: number } {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  const rawT = lengthSquared <= 1e-9
    ? 0
    : ((value.x - start.x) * dx + (value.z - start.z) * dz) / lengthSquared;
  const t = Math.max(0, Math.min(1, rawT));
  const position: WorldPoint = {
    x: start.x + dx * t,
    z: start.z + dz * t,
  };
  if (start.y !== undefined || end.y !== undefined) position.y = (start.y ?? 0) + ((end.y ?? 0) - (start.y ?? 0)) * t;
  return { position, t, distance: distance(value, position) };
}

function normalizedRoadObservation(value: unknown): RoadObservation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const start = worldPointOrUndefined(raw.start);
  const end = worldPointOrUndefined(raw.end);
  const curveRaw = raw.curve && typeof raw.curve === "object" && !Array.isArray(raw.curve)
    ? raw.curve as Record<string, unknown>
    : undefined;
  const a = worldPointOrUndefined(curveRaw?.a);
  const b = worldPointOrUndefined(curveRaw?.b);
  const c = worldPointOrUndefined(curveRaw?.c);
  const d = worldPointOrUndefined(curveRaw?.d);
  const normalizedStart = start ?? a;
  const normalizedEnd = end ?? d;
  if (!normalizedStart || !normalizedEnd) return undefined;
  return {
    entity: entityRef(raw.entity),
    start: normalizedStart,
    end: normalizedEnd,
    curve: a && b && c && d ? { a, b, c, d } : undefined,
    startNode: entityRef(raw.startNode),
    endNode: entityRef(raw.endNode),
  };
}

function nearestRoadProjection(value: WorldPoint, road: RoadObservation): { position: WorldPoint; t: number; distance: number } {
  if (!road.curve) return projectPointToSegment(value, road.start as WorldPoint, road.end as WorldPoint);
  const samples = 32;
  let best = projectPointToSegment(value, road.curve.a, road.curve.b);
  let bestCurveT = 0;
  for (let index = 0; index < samples; index++) {
    const t0 = index / samples;
    const t1 = (index + 1) / samples;
    const p0 = cubicPoint(road.curve.a, road.curve.b, road.curve.c, road.curve.d, t0);
    const p1 = cubicPoint(road.curve.a, road.curve.b, road.curve.c, road.curve.d, t1);
    const projected = projectPointToSegment(value, p0, p1);
    const curveT = t0 + (t1 - t0) * projected.t;
    if (projected.distance < best.distance) {
      best = projected;
      bestCurveT = curveT;
    }
  }
  return { ...best, t: bestCurveT };
}

function angleSnappedPath(points: WorldPoint[], incrementDegrees: number): WorldPoint[] {
  const increment = Math.max(1, incrementDegrees) * Math.PI / 180;
  if (points.length < 2) return points.map((value) => ({ ...value }));
  const result = points.map((value) => ({ ...value }));
  for (let index = 1; index < result.length; index++) {
    const previous = result[index - 1];
    const current = result[index];
    const length = distance(previous, current);
    if (length < 1e-6) continue;
    const angle = Math.atan2(current.z - previous.z, current.x - previous.x);
    const snapped = Math.round(angle / increment) * increment;
    result[index] = {
      ...current,
      x: previous.x + Math.cos(snapped) * length,
      z: previous.z + Math.sin(snapped) * length,
    };
  }
  return result;
}

/**
 * Apply explicit endpoint snapping against the bridge's live road rows.
 * This is a read/transform step: the returned RoadAnchor values are forwarded
 * to the native NetCourse so the game's own network pipeline still validates
 * the connection, slope, collision, and legal road layers.
 */
export function snapRoadPath(
  points: WorldPoint[],
  roads: unknown[],
  options: { nodeSnap?: boolean; roadSnap?: boolean; angleSnap?: boolean; tolerance?: number; angleIncrementDegrees?: number } = {},
): RoadSnapResult {
  const tolerance = Math.max(0.5, finite(options.tolerance, 16));
  const candidates = roads.map(normalizedRoadObservation).filter((value): value is RoadObservation => Boolean(value));
  let result = points.map((value) => ({ ...value }));
  const applied: RoadSnapResult["applied"] = [];
  const unresolved: RoadSnapResult["unresolved"] = [];
  const anchors: Array<RoadAnchor | undefined> = Array.from({ length: result.length });

  if (options.angleSnap) {
    const angled = angleSnappedPath(result, options.angleIncrementDegrees ?? 15);
    for (let index = 1; index < result.length; index++) {
      const change = distance(result[index], angled[index]);
      if (change > 1e-6) applied.push({ pointIndex: index, mode: "angle", distance: change, position: angled[index] });
    }
    result = angled;
  }

  const endpointIndexes = result.length < 2 ? [0] : [0, result.length - 1];
  for (const pointIndex of endpointIndexes) {
    const requested = result[pointIndex];
    let best: { position: WorldPoint; distance: number; t: number; mode: "node" | "road"; entity?: NativeEntityRef } | undefined;

    if (options.nodeSnap) {
      for (const road of candidates) {
        const nodeOptions: Array<{ position: WorldPoint; entity?: NativeEntityRef; t: number }> = [
          { position: road.start as WorldPoint, entity: road.startNode, t: 0 },
          { position: road.end as WorldPoint, entity: road.endNode, t: 1 },
        ];
        for (const node of nodeOptions) {
          if (!node.entity) continue;
          const candidateDistance = distance(requested, node.position);
          if (!best || candidateDistance < best.distance) best = { position: node.position, distance: candidateDistance, t: node.t, mode: "node", entity: node.entity };
        }
      }
    }

    if (!best && options.roadSnap) {
      for (const road of candidates) {
        if (!road.entity) continue;
        const projection = nearestRoadProjection(requested, road);
        if (!best || projection.distance < best.distance) best = { ...projection, mode: "road", entity: road.entity };
      }
    }

    if (!best || !best.entity || best.distance > tolerance) {
      if (options.nodeSnap || options.roadSnap) unresolved.push({ pointIndex, mode: options.nodeSnap ? "node" : "road", nearestDistance: best?.distance ?? null });
      continue;
    }
    result[pointIndex] = { ...best.position, ...(requested.y !== undefined && best.position.y === undefined ? { y: requested.y } : {}) };
    anchors[pointIndex] = { mode: best.mode, entity: best.entity, curvePosition: Math.max(0, Math.min(1, best.t)), distance: best.distance };
    applied.push({ pointIndex, mode: best.mode, distance: best.distance, position: result[pointIndex], entity: best.entity, curvePosition: best.t });
  }

  return { points: result, anchors, applied, unresolved };
}

function quadratic(a: WorldPoint, b: WorldPoint, c: WorldPoint, t: number): WorldPoint {
  const u = 1 - t;
  const result: WorldPoint = {
    x: u * u * a.x + 2 * u * t * b.x + t * t * c.x,
    z: u * u * a.z + 2 * u * t * b.z + t * t * c.z,
  };
  if (a.y !== undefined || b.y !== undefined || c.y !== undefined) {
    result.y = u * u * (a.y ?? 0) + 2 * u * t * (b.y ?? 0) + t * t * (c.y ?? 0);
  }
  return result;
}

function cubic(a: WorldPoint, b: WorldPoint, c: WorldPoint, d: WorldPoint, t: number): WorldPoint {
  const u = 1 - t;
  const result: WorldPoint = {
    x: u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x,
    z: u ** 3 * a.z + 3 * u * u * t * b.z + 3 * u * t * t * c.z + t ** 3 * d.z,
  };
  if (a.y !== undefined || b.y !== undefined || c.y !== undefined || d.y !== undefined) {
    result.y = u ** 3 * (a.y ?? 0) + 3 * u * u * t * (b.y ?? 0) + 3 * u * t * t * (c.y ?? 0) + t ** 3 * (d.y ?? 0);
  }
  return result;
}

function catmullRom(a: WorldPoint, b: WorldPoint, c: WorldPoint, d: WorldPoint, t: number): WorldPoint {
  const t2 = t * t;
  const t3 = t2 * t;
  const result: WorldPoint = {
    x: 0.5 * ((2 * b.x) + (-a.x + c.x) * t + (2 * a.x - 5 * b.x + 4 * c.x - d.x) * t2 + (-a.x + 3 * b.x - 3 * c.x + d.x) * t3),
    z: 0.5 * ((2 * b.z) + (-a.z + c.z) * t + (2 * a.z - 5 * b.z + 4 * c.z - d.z) * t2 + (-a.z + 3 * b.z - 3 * c.z + d.z) * t3),
  };
  if (a.y !== undefined || b.y !== undefined || c.y !== undefined || d.y !== undefined) {
    result.y = 0.5 * ((2 * (b.y ?? 0)) + (-(a.y ?? 0) + (c.y ?? 0)) * t + (2 * (a.y ?? 0) - 5 * (b.y ?? 0) + 4 * (c.y ?? 0) - (d.y ?? 0)) * t2 + (-(a.y ?? 0) + 3 * (b.y ?? 0) - 3 * (c.y ?? 0) + (d.y ?? 0)) * t3);
  }
  return result;
}

function sampleArc(a: WorldPoint, b: WorldPoint, c: WorldPoint, count: number): WorldPoint[] {
  const determinant = 2 * (a.x * (b.z - c.z) + b.x * (c.z - a.z) + c.x * (a.z - b.z));
  if (Math.abs(determinant) < 1e-6) {
    return Array.from({ length: count + 1 }, (_, i) => quadratic(a, b, c, i / count));
  }
  const centerX = ((a.x * a.x + a.z * a.z) * (b.z - c.z) + (b.x * b.x + b.z * b.z) * (c.z - a.z) + (c.x * c.x + c.z * c.z) * (a.z - b.z)) / determinant;
  const centerZ = ((a.x * a.x + a.z * a.z) * (c.x - b.x) + (b.x * b.x + b.z * b.z) * (a.x - c.x) + (c.x * c.x + c.z * c.z) * (b.x - a.x)) / determinant;
  const startAngle = Math.atan2(a.z - centerZ, a.x - centerX);
  let endAngle = Math.atan2(c.z - centerZ, c.x - centerX);
  const throughAngle = Math.atan2(b.z - centerZ, b.x - centerX);
  let delta = endAngle - startAngle;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  const throughOnArc = (throughAngle - startAngle + 2 * Math.PI) % (2 * Math.PI);
  if (delta > 0 && throughOnArc > delta) delta -= 2 * Math.PI;
  if (delta < 0 && throughOnArc < 2 * Math.PI + delta) delta += 2 * Math.PI;
  const radius = Math.hypot(a.x - centerX, a.z - centerZ);
  return Array.from({ length: count + 1 }, (_, i) => {
    const t = i / count;
    const angle = startAngle + delta * t;
    return {
      x: centerX + radius * Math.cos(angle),
      z: centerZ + radius * Math.sin(angle),
      y: a.y !== undefined || c.y !== undefined ? (a.y ?? 0) + ((c.y ?? 0) - (a.y ?? 0)) * t : undefined,
    };
  });
}

function samplePath(points: WorldPoint[], geometry: GeometryKind): WorldPoint[] {
  if (points.length < 2) return points;
  if (geometry === "straight" || geometry === "polyline") return points.map((p) => ({ ...p }));
  if (geometry === "arc" && points.length >= 3) return sampleArc(points[0], points[1], points[2], 24);
  if (geometry === "bezier") {
    const start = points[0];
    const end = points[points.length - 1];
    const controls = points.slice(1, -1);
    const count = Math.max(12, Math.min(64, Math.ceil((distance(start, end) + controls.reduce((s, p, i) => s + distance(p, points[i]), 0)) / 50)));
    return Array.from({ length: count + 1 }, (_, i) => {
      const t = i / count;
      return controls.length >= 2 ? cubic(start, controls[0], controls[1], end, t) : quadratic(start, controls[0] ?? interpolate(start, end, 0.5), end, t);
    });
  }
  const anchors = points;
  const sampled: WorldPoint[] = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[Math.max(0, i - 1)];
    const b = anchors[i];
    const c = anchors[i + 1];
    const d = anchors[Math.min(anchors.length - 1, i + 2)];
    const count = Math.max(4, Math.ceil(distance(b, c) / 60));
    for (let j = 0; j < count; j++) sampled.push(catmullRom(a, b, c, d, j / count));
  }
  sampled.push({ ...anchors[anchors.length - 1] });
  return sampled;
}

function addSplitSegments(points: WorldPoint[], maxLength: number): RoadSegmentPlan[] {
  const segments: RoadSegmentPlan[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const length = distance(a, b);
    const pieces = Math.max(1, Math.ceil(length / maxLength));
    for (let j = 0; j < pieces; j++) {
      segments.push({ start: interpolate(a, b, j / pieces), end: interpolate(a, b, (j + 1) / pieces) });
    }
  }
  return segments;
}

function mergeShortSegments(segments: RoadSegmentPlan[], minimumLength = 8): RoadSegmentPlan[] {
  if (segments.length < 2) return segments;
  const result: RoadSegmentPlan[] = [];
  for (let index = 0; index < segments.length; index++) {
    const current = segments[index];
    const length = distance(current.start, current.end);
    if (length >= minimumLength || (index === segments.length - 1 && result.length === 0)) {
      result.push({ ...current });
      continue;
    }
    const next = segments[index + 1];
    if (next) {
      segments[index + 1] = { ...next, start: current.start };
    } else if (result.length > 0) {
      result[result.length - 1] = { ...result[result.length - 1], end: current.end };
    } else {
      result.push({ ...current });
    }
  }
  return result;
}

export function makeRoadPlan(options: {
  start: unknown;
  end: unknown;
  controlPoints?: unknown[];
  geometry?: GeometryKind;
  maxSegmentLength?: number;
  maxSlope?: number;
  bounds?: Bounds;
  role?: string;
  level?: number;
}): RoadPlan {
  const start = point(options.start);
  const end = point(options.end, start);
  const controls = (options.controlPoints ?? []).map((value) => point(value));
  const geometry = options.geometry ?? (controls.length > 0 ? "bezier" : "straight");
  const maxSegmentLength = Math.max(8, options.maxSegmentLength ?? 1500);
  const maxSlope = Math.max(0.001, options.maxSlope ?? 0.08);
  const sampled = samplePath([start, ...controls, end], geometry);
  const segments = mergeShortSegments(addSplitSegments(sampled, maxSegmentLength)).map((segment) => ({ ...segment, role: options.role, level: options.level }));
  const issues: PlanIssue[] = [];
  let length = 0;
  segments.forEach((segment, index) => {
    const segmentLength = distance(segment.start, segment.end);
    length += segmentLength;
    const elevationDelta = Math.abs((segment.end.y ?? 0) - (segment.start.y ?? 0));
    const slope = segmentLength === 0 ? Infinity : elevationDelta / segmentLength;
    if (segmentLength < 8) {
      issues.push({ code: "segment_too_short", severity: "error", segment: index, message: `segment length ${segmentLength.toFixed(1)}m is below the 8m native minimum`, recommendedAction: "move the control point or merge adjacent points" });
    }
    if (slope > maxSlope) {
      issues.push({ code: "slope_too_steep", severity: "warning", segment: index, message: `planned grade ${(slope * 100).toFixed(1)}% exceeds ${(maxSlope * 100).toFixed(1)}%`, recommendedAction: "increase the vertical run, add a switchback, or use a bridge/tunnel-capable prefab" });
    }
    if (options.bounds && (segment.start.x < options.bounds.minX || segment.start.x > options.bounds.maxX || segment.start.z < options.bounds.minZ || segment.start.z > options.bounds.maxZ || segment.end.x < options.bounds.minX || segment.end.x > options.bounds.maxX || segment.end.z < options.bounds.minZ || segment.end.z > options.bounds.maxZ)) {
      issues.push({ code: "outside_map_bounds", severity: "error", segment: index, message: "segment leaves the declared world bounds", recommendedAction: "clip the corridor to the owned map or purchase a tile if the bridge capability exists" });
    }
  });
  return { kind: "road-plan", geometry, points: sampled, segments, length, issues, constraints: { maxSegmentLength, maxSlope, bounds: options.bounds } };
}

export function summarizeTerrain(snapshot: TerrainSnapshot, slopeThreshold = 0.12): TerrainSummary {
  const resolution = Math.max(1, Math.floor(snapshot.resolution));
  const expected = resolution * resolution;
  const heights = snapshot.heights.slice(0, expected).map((value) => finite(value));
  const waterDepths = snapshot.waterDepths.slice(0, expected).map((value) => Math.max(0, finite(value)));
  const validHeights = heights.length ? heights : [0];
  const min = Math.min(...validHeights);
  const max = Math.max(...validHeights);
  const mean = validHeights.reduce((sum, value) => sum + value, 0) / validHeights.length;
  const slopes: number[] = [];
  for (let row = 0; row < resolution; row++) {
    for (let col = 0; col < resolution; col++) {
      const index = row * resolution + col;
      const h = heights[index] ?? mean;
      if (col + 1 < resolution) slopes.push(Math.abs((heights[index + 1] ?? h) - h) / Math.max(1, snapshot.cellSize));
      if (row + 1 < resolution) slopes.push(Math.abs((heights[index + resolution] ?? h) - h) / Math.max(1, snapshot.cellSize));
    }
  }
  const slopeValues = slopes.length ? slopes : [0];
  const wetCells = waterDepths.filter((value) => value > 0.05).length;
  const flatCells = slopeValues.filter((value) => value <= 0.04).length;
  const steepCells = slopeValues.filter((value) => value > slopeThreshold).length;
  const buildableCells = heights.reduce((count, height, index) => count + ((waterDepths[index] ?? 0) <= 0.05 && height >= min && (slopes[index] ?? 0) <= slopeThreshold ? 1 : 0), 0);
  const observations: string[] = [];
  if (wetCells > 0) observations.push("water cells are present; keep primary roads and heavy industry out of the waterfront buffer until a shoreline plan is made");
  if (steepCells / slopeValues.length > 0.25) observations.push("a substantial share of sampled terrain is steep; prefer contour-following corridors, bridges, and staged grading");
  if (buildableCells / Math.max(1, heights.length) < 0.35) observations.push("flat dry land is constrained; a full-map grid would create excessive grading and should be avoided");
  if (observations.length === 0) observations.push("sampled terrain is broadly buildable; preserve natural variation instead of flattening the map");
  return {
    resolution,
    worldBounds: { minX: snapshot.worldMin, maxX: snapshot.worldMax, minZ: snapshot.worldMin, maxZ: snapshot.worldMax },
    cellSize: snapshot.cellSize,
    height: { min, max, mean },
    slope: { min: Math.min(...slopeValues), max: Math.max(...slopeValues), mean: slopeValues.reduce((sum, value) => sum + value, 0) / slopeValues.length, flatCells, steepCells },
    water: { wetCells, dryCells: Math.max(0, heights.length - wetCells), deepest: waterDepths.length ? Math.max(...waterDepths) : 0, coverage: wetCells / Math.max(1, heights.length) },
    buildable: { cells: buildableCells, coverage: buildableCells / Math.max(1, heights.length), slopeThreshold },
    observations,
  };
}

function localToWorld(center: WorldPoint, angle: number, localX: number, localZ: number, y?: number): WorldPoint {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: center.x + localX * cos - localZ * sin, z: center.z + localX * sin + localZ * cos, ...(y === undefined ? {} : { y }) };
}

function polygon(center: WorldPoint, width: number, depth: number, angle: number): WorldPoint[] {
  return [
    localToWorld(center, angle, -width / 2, -depth / 2),
    localToWorld(center, angle, width / 2, -depth / 2),
    localToWorld(center, angle, width / 2, depth / 2),
    localToWorld(center, angle, -width / 2, depth / 2),
  ];
}

function ring(center: WorldPoint, radiusX: number, radiusZ: number, angle: number, count = 24): WorldPoint[] {
  return Array.from({ length: count }, (_, index) => {
    const t = (index / count) * Math.PI * 2;
    const warp = 1 + 0.08 * Math.sin(3 * t + angle);
    return localToWorld(center, angle, Math.cos(t) * radiusX * warp, Math.sin(t) * radiusZ * (1 + 0.05 * Math.cos(2 * t)));
  });
}

export interface InterchangePlan {
  kind: "interchange-plan";
  type: string;
  center: WorldPoint;
  roads: RoadSegmentPlan[];
  conflicts: PlanIssue[];
  estimatedFootprint: Bounds;
}

export function makeInterchangePlan(options: {
  center: unknown;
  type?: string;
  angle?: number;
  mainLength?: number;
  crossLength?: number;
  elevatedCrossing?: number;
}): InterchangePlan {
  const center = point(options.center);
  const type = (options.type ?? "diamond").toLowerCase();
  const angle = ((options.angle ?? 0) * Math.PI) / 180;
  const mainLength = Math.max(120, options.mainLength ?? 420);
  const crossLength = Math.max(100, options.crossLength ?? 300);
  const crossY = options.elevatedCrossing ?? (type.includes("stack") || type.includes("spui") ? 8 : 0);
  const roads: RoadSegmentPlan[] = [];
  const mainStart = localToWorld(center, angle, -mainLength / 2, 0, 0);
  const mainEnd = localToWorld(center, angle, mainLength / 2, 0, 0);
  const crossStart = localToWorld(center, angle, 0, -crossLength / 2, crossY);
  const crossEnd = localToWorld(center, angle, 0, crossLength / 2, crossY);
  roads.push({ start: mainStart, end: mainEnd, role: "interchange-mainline", level: 0 });
  roads.push({ start: crossStart, end: crossEnd, role: "interchange-crossing", level: crossY === 0 ? 0 : 1 });
  const rampOffset = Math.min(mainLength * 0.34, 170);
  const crossOffset = Math.min(crossLength * 0.30, 110);
  if (type.includes("roundabout")) {
    const roundaboutRadius = Math.min(mainLength, crossLength) * 0.18;
    const loop = ring(center, roundaboutRadius, roundaboutRadius, angle, 16);
    for (let i = 0; i < loop.length; i++) roads.push({ start: loop[i], end: loop[(i + 1) % loop.length], role: "roundabout-ring", level: 0 });
    roads.push({ start: localToWorld(center, angle, -mainLength / 2, 0), end: localToWorld(center, angle, -roundaboutRadius, 0), role: "roundabout-approach", level: 0 });
    roads.push({ start: localToWorld(center, angle, roundaboutRadius, 0), end: localToWorld(center, angle, mainLength / 2, 0), role: "roundabout-approach", level: 0 });
    roads.push({ start: localToWorld(center, angle, 0, -crossLength / 2), end: localToWorld(center, angle, 0, -roundaboutRadius), role: "roundabout-approach", level: 0 });
    roads.push({ start: localToWorld(center, angle, 0, roundaboutRadius), end: localToWorld(center, angle, 0, crossLength / 2), role: "roundabout-approach", level: 0 });
  } else if (type.includes("clover") || type.includes("turbine")) {
    const radius = Math.min(mainLength, crossLength) * 0.28;
    for (const signX of [-1, 1]) {
      for (const signZ of [-1, 1]) {
        const start = localToWorld(center, angle, signX * rampOffset, 0, 0);
        const control = localToWorld(center, angle, signX * (rampOffset + radius), signZ * radius, crossY / 2);
        const end = localToWorld(center, angle, 0, signZ * crossOffset, crossY);
        roads.push({ start, end, control, role: `${type}-ramp`, level: Math.abs(crossY) > 0 ? 1 : 0 });
      }
    }
  } else {
    for (const signX of [-1, 1]) {
      for (const signZ of [-1, 1]) {
        const start = localToWorld(center, angle, signX * rampOffset, 0, 0);
        const end = localToWorld(center, angle, 0, signZ * crossOffset, crossY);
        const control = localToWorld(center, angle, signX * rampOffset * 0.64, signZ * crossOffset * 0.62, crossY * 0.5);
        roads.push({ start, end, control, role: `${type}-ramp`, level: Math.abs(crossY) > 0 ? 1 : 0 });
      }
    }
  }
  const all = roads.flatMap((road) => [road.start, road.end, ...(road.control ? [road.control] : [])]);
  const footprint: Bounds = { minX: Math.min(...all.map((p) => p.x)), maxX: Math.max(...all.map((p) => p.x)), minZ: Math.min(...all.map((p) => p.z)), maxZ: Math.max(...all.map((p) => p.z)) };
  const conflicts: PlanIssue[] = [];
  if (type.includes("diamond") && crossY === 0) conflicts.push({ code: "at_grade_crossing", severity: "warning", message: "the diamond preview uses an at-grade crossing; choose a compatible elevated/bridge prefab or a stack/SPUI variant before execution", recommendedAction: "use a bridge-capable prefab and set elevatedCrossing, or keep this as a preview-only geometry" });
  if (type.includes("stack") && Math.abs(crossY) < 1) conflicts.push({ code: "missing_level_separation", severity: "error", message: "stack interchange requires a non-zero crossing elevation", recommendedAction: "set elevatedCrossing to a safe value and verify the selected prefab supports it" });
  return { kind: "interchange-plan", type, center, roads, conflicts, estimatedFootprint: footprint };
}

export function makeMetropolisPlan(options: { bounds?: Bounds; center?: unknown; terrain?: TerrainSnapshot; density?: "medium" | "high"; waterfront?: boolean }): Record<string, unknown> {
  const bounds = options.bounds ?? { minX: -7168, maxX: 7168, minZ: -7168, maxZ: 7168 };
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxZ - bounds.minZ;
  const requestedCentre = point(options.center, { x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2 });
  const center = buildablePlanningCentre(requestedCentre, bounds, options.terrain);
  const radius = Math.min(width, depth) * (options.density === "high" ? 0.19 : 0.16);
  const subcenters = [
    { name: "north-east secondary centre", role: "mixed-use", point: { x: center.x + width * 0.19, z: center.z - depth * 0.16 } },
    { name: "south-west secondary centre", role: "innovation-and-university", point: { x: center.x - width * 0.20, z: center.z + depth * 0.14 } },
    { name: "waterfront civic centre", role: "waterfront-cultural", point: { x: center.x + width * 0.04, z: center.z + depth * 0.27 } },
  ];
  const primaryRing = ring(center, radius * 1.45, radius, 0.13);
  const outerRing = ring(center, radius * 2.65, radius * 1.85, -0.09);
  const corridors: Array<Record<string, unknown>> = [
    { name: "inner urban ring", hierarchy: "urban-expressway-or-arterial", points: primaryRing, purpose: "distribute CBD traffic without cutting through the civic core" },
    { name: "outer growth ring", hierarchy: "arterial-or-expressway", points: outerRing, purpose: "stage expansion and protect neighbourhood streets from through traffic" },
  ];
  for (const [index, secondary] of subcenters.entries()) {
    const bend = { x: (center.x + secondary.point.x) / 2 + Math.sin(index * 1.7) * width * 0.035, z: (center.z + secondary.point.z) / 2 + Math.cos(index * 1.3) * depth * 0.045 };
    corridors.push({ name: `radial corridor ${index + 1}`, hierarchy: "major-arterial-or-expressway", points: [center, bend, secondary.point], purpose: `connect primary centre to ${secondary.name}` });
  }
  const districts = [
    { name: "central business district", type: "CBD", centre: center, density: "highest", polygon: polygon(center, radius * 1.1, radius * 0.82, 0.10), buffer: "civic public space and mixed-use streets" },
    { name: "inner residential belt", type: "residential", centre: { x: center.x - radius * 1.35, z: center.z + radius * 0.45 }, density: "high-to-medium", polygon: polygon({ x: center.x - radius * 1.35, z: center.z + radius * 0.45 }, radius * 1.7, radius * 1.15, -0.16), buffer: "local parks, schools, and collectors" },
    { name: "industrial and logistics corridor", type: "industry-logistics", centre: { x: bounds.minX + width * 0.18, z: center.z - depth * 0.12 }, density: "low", polygon: polygon({ x: bounds.minX + width * 0.18, z: center.z - depth * 0.12 }, width * 0.20, depth * 0.18, 0.22), buffer: "freight road/rail and planted separation from homes" },
    { name: "waterfront park and culture", type: "waterfront", centre: subcenters[2].point, density: "mixed", polygon: polygon(subcenters[2].point, radius * 1.7, radius * 0.85, 0.04), buffer: "continuous greenway and public shoreline" },
    ...subcenters.slice(0, 2).map((secondary) => ({ name: secondary.name, type: secondary.role, centre: secondary.point, density: "medium-to-high", polygon: polygon(secondary.point, radius * 1.1, radius * 0.85, -0.18), buffer: "TOD walking catchment and local parks" })),
  ];
  const localRoads = districts.flatMap((district) => {
    const xs = district.polygon.map((value) => value.x);
    const zs = district.polygon.map((value) => value.z);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const centre = district.centre;
    const marginX = Math.min(100, Math.max(24, (maxX - minX) * 0.18));
    const marginZ = Math.min(100, Math.max(24, (maxZ - minZ) * 0.18));
    return [
      { name: `${district.name} east-west local street`, hierarchy: "local-street", points: [{ x: minX + marginX, z: centre.z }, { x: maxX - marginX, z: centre.z }], purpose: "walkable local distribution inside the district" },
      { name: `${district.name} north-south local street`, hierarchy: "local-street", points: [{ x: centre.x, z: minZ + marginZ }, { x: centre.x, z: maxZ - marginZ }], purpose: "cross connection for services, zoning and transit access" },
    ];
  });
  const greenways = [
    { name: "waterfront greenway", points: [subcenters[2].point, { x: subcenters[2].point.x - width * 0.12, z: subcenters[2].point.z + depth * 0.02 }, { x: subcenters[2].point.x + width * 0.14, z: subcenters[2].point.z + depth * 0.03 }] },
    { name: "diagonal regional park", points: [{ x: bounds.minX + width * 0.16, z: bounds.minZ + depth * 0.18 }, center, { x: bounds.maxX - width * 0.18, z: bounds.maxZ - depth * 0.14 }] },
  ];
  const transport = subcenters.map((secondary, index) => ({ name: `transit spine ${index + 1}`, mode: index === 0 ? "bus-or-tram" : "metro-or-rail", points: [center, secondary.point], interchange: index === 0 }));
  return {
    schemaVersion: 1,
    kind: "master-plan",
    planner: "cs2-autonomy",
    coordinateSystem: "CS2 world x/y/z; planar routes use x/z and optional y elevations",
    bounds,
    centre: center,
    requestedCentre,
    centreSelection: {
      status: options.terrain ? "terrain-scored" : "requested-or-bounds-centre",
      moved: distance(requestedCentre, center) > 1,
      reason: options.terrain ? "structural corridors are biased toward a dry native terrain neighbourhood; waterfront districts remain separately planned" : "no native terrain snapshot was supplied",
    },
    assumptions: [
      "prefab names are selected at runtime through discovery; this plan contains no asset allow-list",
      "construction is staged and each phase must be validated before the next phase",
      "unknown capabilities remain disabled and are not emulated by mutating ECS directly",
      options.waterfront === false ? "waterfront treatment was disabled by the caller" : "waterfront treatment is conditional on observed water cells and shoreline access",
    ],
    terrainSummary: options.terrain ? summarizeTerrain(options.terrain) : null,
    structure: "one primary centre, multiple secondary centres, growth rings, local district streets, transport spines, and connected greenways",
    districts,
    corridors,
    localRoads,
    transport,
    greenways,
    phases: [
      { id: "survey", order: 1, actions: ["ping", "capabilities", "discover-prefabs", "terrain", "map-analysis"] },
      { id: "skeleton", order: 2, actions: ["purchase only if capability is true", "build outer/inner corridors", "validate road geometry"] },
      { id: "nodes", order: 3, actions: ["place only compatible discovered interchange roads", "preview and validate each interchange"] },
      { id: "districts", order: 4, actions: ["create district polygons", "zone in measured increments", "place services after demand/capacity checks"] },
      { id: "transit", order: 5, actions: ["execute only if transport capabilities are true", "otherwise return a precise limitation"] },
      { id: "landscape", order: 6, actions: ["greenways", "tree lines", "public spaces", "screenshot review"] },
      { id: "simulation-loop", order: 7, actions: ["run simulation", "inspect traffic/service/demand", "repair or extend one district at a time"] },
    ],
    qualityGates: ["hierarchical roads", "no residential adjacency to heavy freight without buffers", "connected green space", "no high-severity geometry issue", "post-build screenshot review", "simulation and service validation"],
  };
}

export function parseBounds(value: unknown): Bounds | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const result = { minX: finite(raw.minX), maxX: finite(raw.maxX), minZ: finite(raw.minZ), maxZ: finite(raw.maxZ) };
  if (result.maxX <= result.minX || result.maxZ <= result.minZ) return undefined;
  return result;
}

export function asTerrainSnapshot(value: unknown): TerrainSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.heights) || !Array.isArray(raw.waterDepths)) return undefined;
  return {
    resolution: Math.max(1, Math.floor(finite(raw.resolution, Math.sqrt(raw.heights.length)))),
    worldMin: finite(raw.worldMin, -7168),
    worldMax: finite(raw.worldMax, 7168),
    cellSize: Math.max(1, finite(raw.cellSize, 14336 / Math.max(1, Math.sqrt(raw.heights.length)))),
    heights: raw.heights.map((entry) => finite(entry)),
    waterDepths: raw.waterDepths.map((entry) => Math.max(0, finite(entry))),
  };
}
