import assert from "node:assert/strict";
import test from "node:test";
import {
  makeInterchangePlan,
  makeMetropolisPlan,
  makeRoadPlan,
  snapRoadPath,
  summarizeTerrain,
} from "../mcp-server/dist/geometry.js";

test("road planner splits long paths and preserves the endpoint", () => {
  const plan = makeRoadPlan({
    start: { x: 0, z: 0 },
    end: { x: 3400, z: 0 },
    geometry: "straight",
    maxSegmentLength: 1200,
  });
  assert.equal(plan.segments.length, 3);
  assert.equal(plan.segments.at(-1).end.x, 3400);
  assert.equal(plan.issues.some((issue) => issue.code === "segment_too_short"), false);
});

test("road planner reports steep elevation instead of hiding it", () => {
  const plan = makeRoadPlan({
    start: { x: 0, z: 0, y: 0 },
    end: { x: 100, z: 0, y: 50 },
    maxSlope: 0.08,
  });
  assert.equal(plan.issues.some((issue) => issue.code === "slope_too_steep"), true);
});

test("terrain summary distinguishes wet, flat, and buildable cells", () => {
  const summary = summarizeTerrain({
    resolution: 2,
    worldMin: -10,
    worldMax: 10,
    cellSize: 10,
    heights: [1, 1, 2, 2],
    waterDepths: [0, 1, 0, 0],
  });
  assert.equal(summary.water.wetCells, 1);
  assert.equal(summary.height.min, 1);
  assert.equal(summary.buildable.cells > 0, true);
});

test("interchange planner always returns a footprint and named ramp roles", () => {
  const plan = makeInterchangePlan({ center: { x: 100, z: 200 }, type: "diamond", elevatedCrossing: 8 });
  assert.equal(plan.kind, "interchange-plan");
  assert.equal(plan.roads.some((road) => road.role?.includes("ramp")), true);
  assert.equal(plan.estimatedFootprint.maxX > plan.estimatedFootprint.minX, true);
});

test("metropolis planner creates a staged plan without fixed prefab names", () => {
  const plan = makeMetropolisPlan({ bounds: { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000 } });
  assert.equal(plan.kind, "master-plan");
  assert.equal(Array.isArray(plan.corridors), true);
  assert.equal(Array.isArray(plan.districts), true);
  assert.equal(JSON.stringify(plan).includes("Basic Road"), false);
});

test("road snapping returns native node/edge anchors and does not silently miss", () => {
  const result = snapRoadPath(
    [{ x: 2, z: 3 }, { x: 102, z: 20 }],
    [{
      entity: { index: 20, version: 1 },
      start: { x: 0, z: 0 },
      end: { x: 100, z: 0 },
      startNode: { index: 21, version: 1 },
      endNode: { index: 22, version: 1 },
    }],
    { nodeSnap: true, tolerance: 5 },
  );
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.anchors[0]?.entity.index, 21);
  assert.equal(result.points[0].x, 0);
  assert.equal(result.points[0].z, 0);
  assert.equal(result.anchors.at(-1), undefined);
});

test("road projection binds an existing curved edge with a normalized curve position", () => {
  const result = snapRoadPath(
    [{ x: 50, z: 20 }, { x: 150, z: 100 }],
    [{
      entity: { index: 30, version: 2 },
      curve: {
        a: { x: 0, z: 0 },
        b: { x: 30, z: 80 },
        c: { x: 70, z: 80 },
        d: { x: 100, z: 0 },
      },
    }],
    { roadSnap: true, tolerance: 45 },
  );
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.anchors[0]?.mode, "road");
  assert.equal(result.anchors[0]?.entity.index, 30);
  assert.equal(result.anchors[0]?.curvePosition > 0.1, true);
  assert.equal(result.anchors[0]?.curvePosition < 0.9, true);
});
