"jh®Ð¥‹¥Rw±¥ç-y×§v‡ßŠW¡jÊrêëyÔáyú%–Œ"ž¥zg§¶Æ«zz-rZ,yÐÂLæãpÂLæãpÂLæã9¸ì.)ÞÛ])¢È­Š‰õimport assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = (...parts) => readFileSync(resolve(ROOT, ...parts), "utf8");

test("MCP server advertises the autonomy tools over stdio", async () => {
  const child = spawn(process.execPath, ["mcp-server/dist/index.js"], {
    cwd: new URL("..", import.meta.url),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CS2_BRIDGE_URL: "http://127.0.0.1:1" },
  });
  const lines = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      lines.push(buffer.slice(0, newline).replace(/\r$/, ""));
      buffer = buffer.slice(newline + 1);
    }
  });
  const waitForId = async (id) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const match = lines.find((line) => line.includes(`"id":${id}`));
      if (match) return JSON.parse(match);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for MCP response id ${id}; stderr=${child.stderr.read()?.toString() ?? ""}`);
  };
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } })}\n`);
  await waitForId(1);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  const response = await waitForId(2);
  const names = (response.result?.tools ?? []).map((tool) => tool.name);
  for (const expected of [
    "cs2_capabilities",
    "cs2_discover_assets",
    "cs2_query_entities",
    "cs2_analyze_map",
    "cs2_analyze_city",
    "cs2_query_utilities",
    "cs2_build_utility_network",
    "cs2_plan_metropolis",
    "cs2_plan_district",
    "cs2_build_district",
    "cs2_build_interchange",
    "cs2_build_greenway",
    "cs2_upgrade_road",
    "cs2_list_tiles",
    "cs2_purchase_tile",
    "cs2_purchase_tiles",
    "cs2_place_prop",
    "cs2_place_tree",
    "cs2_draw_tree_line",
    "cs2_draw_prop_line",
    "cs2_tree_brush",
    "cs2_prop_brush",
    "cs2_decorate_road",
    "cs2_decorate_interchange",
    "cs2_decorate_waterfront",
    "cs2_decorate_district",
    "cs2_paint_surface",
    "cs2_list_surfaces",
    "cs2_terraform",
    "cs2_create_transport_line",
    "cs2_modify_transport_line",
    "cs2_delete_transport_line",
    "cs2_transport_analysis",
    "cs2_dispatch_transport_vehicle",
    "cs2_place_station",
    "cs2_place_depot",
    "cs2_place_stop",
    "cs2_analyze_road_graph",
    "cs2_optimize_traffic",
    "cs2_build_track",
    "cs2_transform_object",
    "cs2_move_object",
    "cs2_rotate_object",
    "cs2_copy_object",
    "cs2_recolor_object",
    "cs2_validate_city",
    "cs2_execute_master_plan",
    "cs2_run_autonomous_city_cycle",
    "cs2_create_district",
    "cs2_demolish",
  ]) {
    assert.equal(names.includes(expected), true, `missing advertised tool ${expected}`);
  }
  const roadTool = (response.result?.tools ?? []).find((tool) => tool.name === "cs2_build_road");
  for (const parameter of ["start", "end", "controlPoints", "elevation", "startElevation", "endElevation", "targetSlope", "parallelOffset", "snapMode", "nodeSnap", "roadSnap", "angleSnap", "snapTolerance", "laneConfiguration"]) {
    assert.equal(Object.hasOwn(roadTool?.inputSchema?.properties ?? {}, parameter), true, `cs2_build_road schema is missing ${parameter}`);
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "cs2_build_road", arguments: { prefab: "runtime-road", start: { x: 0, z: 0 }, end: { x: 800, z: 0 }, parallelOffset: 24, targetSlope: 0.08, preview: true } } })}\n`);
  const roadPreview = await waitForId(3);
  const roadPreviewPayload = JSON.parse(roadPreview.result.content[0].text);
  assert.equal(roadPreviewPayload.dryRun, true);
  assert.equal(roadPreviewPayload.plan.segments.at(-1).end.x, 800);
  assert.equal(roadPreviewPayload.requested.parallelOffset, 24);
  child.kill();
  await once(child, "exit").catch(() => undefined);
});

test("native source contracts cover grid/access/zoning/entity/surface and verified mutation paths", () => {
  const handlers = source("CS2MCP.Bridge", "RequestHandlers.cs");
  const build = source("CS2MCP.Bridge", "RequestHandlers.Build.cs");
  const zoning = source("CS2MCP.Bridge", "RequestHandlers.Zoning.cs");
  const surfaces = source("CS2MCP.Bridge", "RequestHandlers.Surface.cs");
  const tool = source("CS2MCP.Bridge", "BridgeToolSystem.cs");
  const capabilities = source("CS2MCP.Bridge", "RequestHandlers.Capabilities.cs");
  const autonomy = source("mcp-server", "src", "autonomy.ts");
  const index = source("mcp-server", "src", "index.ts");

  assert.match(handlers, /\/city\/entities/);
  assert.match(handlers, /\/city\/surfaces/);
  assert.match(handlers, /\/city\/terrain\/sample/);
  assert.match(build, /Game\.Net\.Upgraded/);
  assert.match(build, /dryRun/);
  assert.match(zoning, /TryQueueZoning/);
  assert.equal(zoning.includes("EntityManager.SetBuffer<Cell>"), false);
  assert.match(surfaces, /GetSurfaces/);
  assert.match(tool, /BuildingFlags\.RequireRoad/);
  assert.match(tool, /BuildingFlags\.RequireAccess/);
  assert.match(tool, /placementGrid = 8f/);
  assert.match(tool, /OperationKind\.Zoning/);
  assert.match(autonomy, /executeVerifiedSurface/);
  assert.match(autonomy, /executeVerifiedTerraform/);
  assert.match(autonomy, /executeVerifiedRoadUpgrade/);
  assert.match(autonomy, /parallel-road-with-end-connectors/);
  assert.match(autonomy, /summarizeRoadGraphPayload/);
  assert.match(autonomy, /semanticCatalog/);
  assert.match(capabilities, /CountTunnelCapablePrefabs/);
  assert.match(capabilities, /Application\.buildGUID/);
  assert.match(capabilities, /transport_vehicle_dispatch/);
  assert.match(build, /PlaceableNetData/);
  assert.match(build, /startNode = DescribeEntity/);
  assert.match(build, /curve = new/);
  assert.match(build, /laneCount/);
  assert.match(index, /"cs2_upgrade_road"/);
  assert.match(index, /parallelOffset/);
  assert.match(index, /validateLaneConfiguration/);
  assert.match(index, /snapRoadPath/);
  assert.match(autonomy, /startEntityIndex/);
  assert.match(autonomy, /"cs2_optimize_traffic"/);
  assert.match(autonomy, /startCurvePosition/);
  assert.match(autonomy, /cs2_dispatch_transport_vehicle/);
  assert.match(autonomy, /RouteVehicle count or vehicle-entity readback/);
  assert.match(autonomy, /\/transport\/line\/dispatch/);
  assert.match(tool, /CreateTransportDispatchDefinition/);
  assert.match(tool, /TransportVehicleRequest/);
});
