import assert from "node:assert/strict";
import test from "node:test";
import { summarizeRoadGraphPayload } from "../mcp-server/dist/autonomy.js";

test("road graph summary derives topology and traffic candidates without losing page scope", () => {
  const payload = {
    success: true,
    page: 0,
    pageSize: 2,
    totalEdges: 3,
    totalNodes: 4,
    totalLanes: 5,
    traffic: { averageTrafficFlow: 0.71, averageTrafficVolume: 120 },
    segments: [
      {
        entity: { index: 11, version: 1 },
        prefab: "Road-A",
        startNode: { index: 101, version: 1 },
        endNode: { index: 102, version: 1 },
        length: 180,
        laneCount: 2,
        outsideConnection: false,
        traffic: { density: 0.4, laneObjectCount: 8 },
      },
      {
        entity: { index: 12, version: 1 },
        prefab: "Highway-B",
        startNode: { index: 102, version: 1 },
        endNode: { index: 103, version: 1 },
        length: 300,
        laneCount: 3,
        outsideConnection: true,
        traffic: { density: 0.1, laneObjectCount: 1 },
      },
    ],
    nodes: [
      { entity: { index: 101, version: 1 }, position: { x: 0, z: 0 }, degree: 1, connectedEdges: [{ index: 11, version: 1 }] },
      { entity: { index: 102, version: 1 }, position: { x: 100, z: 0 }, degree: 3, connectedEdges: [{ index: 11, version: 1 }, { index: 12, version: 1 }, { index: 13, version: 1 }] },
      { entity: { index: 103, version: 1 }, position: { x: 400, z: 0 }, degree: 1, connectedEdges: [{ index: 12, version: 1 }] },
    ],
  };

  const summary = summarizeRoadGraphPayload(payload);
  assert.equal(summary.scope.pageScoped, true);
  assert.equal(summary.segmentCount, 2);
  assert.equal(summary.nodeCount, 3);
  assert.equal(summary.laneCount, 5);
  assert.equal(summary.junctionCount, 1);
  assert.equal(summary.deadEndCount, 2);
  assert.equal(summary.outsideConnectionSegmentCount, 1);
  assert.equal(summary.bottleneckCandidates[0].entity.index, 11);
  assert.equal(summary.junctions[0].connectedEdges.length, 3);
  assert.match(summary.observations.join(" "), /paged/i);
});
