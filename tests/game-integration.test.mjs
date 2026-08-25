import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("live game integration smoke (opt in with CS2_INTEGRATION=1)", { skip: process.env.CS2_INTEGRATION !== "1" }, async () => {
  const child = spawn(process.execPath, ["mcp-server/dist/index.js"], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
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
      try { messages.push(JSON.parse(line)); } catch { /* wait for the next JSON-RPC line */ }
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const waitFor = async (id) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const message = messages.find((entry) => entry.id === id);
      if (message) return message;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    throw new Error(`live integration timed out for response ${id}; stderr=${stderr}`);
  };
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cs2-integration", version: "1" } } })}\n`);
    await waitFor(1);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "cs2_ping", arguments: {} } })}\n`);
    const ping = await waitFor(2);
    assert.equal(ping.result?.isError, undefined, `cs2_ping failed: ${JSON.stringify(ping)}`);
    const state = JSON.parse(ping.result.content[0].text);
    assert.equal(typeof state.gameMode, "string");
  } finally {
    child.kill();
    await once(child, "exit").catch(() => undefined);
  }
});
