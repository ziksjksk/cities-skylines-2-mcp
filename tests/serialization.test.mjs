import assert from "node:assert/strict";
import test from "node:test";
import { makeMetropolisPlan, makeRoadPlan } from "../mcp-server/dist/geometry.js";

test("road and metropolis plans survive JSON serialization as MCP payloads", () => {
  const road = makeRoadPlan({
    start: { x: -120, z: 40, y: 3 },
    end: { x: 640, z: 280, y: 18 },
    controlPoints: [{ x: 120, z: 80, y: 8 }, { x: 360, z: 220, y: 13 }],
    geometry: "bezier",
    maxSegmentLength: 160,
    maxSlope: 0.12,
    role: "serialization-test",
    level: 1,
  });
  const metropolis = makeMetropolisPlan({
    bounds: { minX: -2000, maxX: 2000, minZ: -1600, maxZ: 1600 },
    center: { x: 120, z: -80 },
    density: "high",
    waterfront: true,
    terrain: { resolution: 2, worldMin: -2000, worldMax: 2000, cellSize: 2000, heights: [1, 2, 2, 3], waterDepths: [0, 0, 1, 0] },
  });

  const decoded = JSON.parse(JSON.stringify({ road, metropolis }));
  assert.equal(decoded.road.kind, "road-plan");
  assert.equal(decoded.road.geometry, "bezier");
  assert.equal(decoded.road.segments.at(-1).end.x, road.segments.at(-1).end.x);
  assert.equal(decoded.road.segments.at(-1).end.y, road.segments.at(-1).end.y);
  assert.equal(decoded.road.segments[0].role, "serialization-test");
  assert.equal(decoded.metropolis.kind, "master-plan");
  assert.deepEqual(decoded.metropolis.bounds, metropolis.bounds);
  assert.equal(decoded.metropolis.districts.length, metropolis.districts.length);
  assert.equal(decoded.metropolis.terrainSummary.water.wetCells, 1);
});
