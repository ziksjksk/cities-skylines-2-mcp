import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function startMcp(bridgeUrl) {
  const child = spawn(process.execPath, ["mcp-server/dist/index.js"], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CS2_BRIDGE_URL: bridgeUrl },
  });
  const messages = [];
  let buffer = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      try {
        messages.push(JSON.parse(line));
      } catch {
        // MCP stdout should contain JSON-RPC only; keep waiting so the error is diagnostic.
      }
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const waitFor = async (id) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const message = messages.find((entry) => entry.id === id);
      if (message) return message;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    throw new Error(`timed out waiting for MCP response ${id}; stderr=${stderr}`);
  };
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  return { child, send, waitFor };
}

test("MCP-to-bridge communication reaches the configured HTTP endpoints", async () => {
  const seen = [];
  const bridge = createServer((request, response) => {
    seen.push(request.url);
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/ping")) {
      response.end(JSON.stringify({ success: true, modVersion: "test-bridge", gameMode: "Game", cityLoaded: true }));
      return;
    }
    if (request.url?.startsWith("/capabilities")) {
      response.end(JSON.stringify({ success: true, capabilities: { roads: true, road_graph: true, transit_lines: false } }));
      return;
    }
    if (request.url?.startsWith("/road/graph")) {
      response.end(JSON.stringify({
        success: true,
        page: 0,
        pageSize: 10,
        totalEdges: 1,
        totalNodes: 2,
        totalLanes: 1,
        segments: [{ entity: { index: 7, version: 1 }, prefab: "Road-Test", startNode: { index: 8, version: 1 }, endNode: { index: 9, version: 1 }, laneCount: 1, outsideConnection: false, traffic: { density: 0.2, laneObjectCount: 1 } }],
        nodes: [
          { entity: { index: 8, version: 1 }, position: { x: 0, z: 0 }, degree: 1, connectedEdges: [{ index: 7, version: 1 }] },
          { entity: { index: 9, version: 1 }, position: { x: 100, z: 0 }, degree: 1, connectedEdges: [{ index: 7, version: 1 }] },
        ],
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "test endpoint not implemented" }));
  });
  await new Promise((resolveListen) => bridge.listen(0, "127.0.0.1", resolveListen));
  const address = bridge.address();
  assert.equal(typeof address, "object");
  const mcp = startMcp(`http://127.0.0.1:${address.port}`);
  try {
    mcp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bridge-test", version: "1" } } });
    await mcp.waitFor(1);
    mcp.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "cs2_ping", arguments: {} } });
    mcp.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "cs2_capabilities", arguments: {} } });
    mcp.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "cs2_analyze_road_graph", arguments: {} } });
    const ping = await mcp.waitFor(2);
    const capabilities = await mcp.waitFor(3);
    const graph = await mcp.waitFor(4);
    assert.equal(ping.result.isError, undefined);
    assert.equal(JSON.parse(ping.result.content[0].text).modVersion, "test-bridge");
    assert.equal(JSON.parse(capabilities.result.content[0].text).capabilities.roads, true);
    assert.equal(JSON.parse(graph.result.content[0].text).analysis.deadEndCount, 2);
    assert.equal(seen.some((url) => url?.startsWith("/ping")), true);
    assert.equal(seen.some((url) => url?.startsWith("/capabilities")), true);
    assert.equal(seen.some((url) => url?.startsWith("/road/graph")), true);
  } finally {
    mcp.child.kill();
    await once(mcp.child, "exit").catch(() => undefined);
    await new Promise((resolveClose) => bridge.close(resolveClose));
  }
});
