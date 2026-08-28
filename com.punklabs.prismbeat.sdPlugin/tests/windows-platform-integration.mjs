import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectory = mkdtempSync(join(tmpdir(), "prismbeat-windows-test-"));
const helperLog = join(temporaryDirectory, "helper.log");
const server = new WebSocketServer({ port: 0 });
const messages = [];

const manifest = JSON.parse(readFileSync(join(pluginRoot, "manifest.json"), "utf8"));
assert.equal(manifest.UUID, "com.punklabs.prismbeat");
assert.ok(manifest.OS.some(({ Platform }) => Platform === "windows"));
assert.ok(manifest.OS.some(({ Platform }) => Platform === "mac"));

await new Promise((resolve) => server.once("listening", resolve));
const child = spawn(process.execPath, [
  join(pluginRoot, "bin/plugin.js"),
  "-port", String(server.address().port),
  "-pluginUUID", manifest.UUID,
  "-registerEvent", "registerPlugin",
  "-info", "{}",
], {
  cwd: pluginRoot,
  env: {
    ...process.env,
    SPOTIFY_PLATFORM_OVERRIDE: "win32",
    SPOTIFY_WINDOWS_HELPER_PATH: join(pluginRoot, "tests/mock-windows-helper.mjs"),
    SPOTIFY_WINDOWS_HELPER_LOG: helperLog,
    SPOTIFY_AUDIO_ANALYZER_DISABLED: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  const socket = await new Promise((resolve) => server.once("connection", resolve));
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  await waitFor(() => messages.some(({ event }) => event === "registerPlugin"));

  socket.send(JSON.stringify({
    event: "willAppear",
    action: "com.punklabs.prismbeat.playback",
    context: "windows-playback",
    payload: { controller: "Keypad", coordinates: { column: 0, row: 0 } },
  }));
  await waitFor(() => messages.some((message) =>
    message.event === "setState" &&
    message.context === "windows-playback" &&
    message.payload?.state === 1));

  socket.send(JSON.stringify({
    event: "willAppear",
    action: "com.punklabs.prismbeat.artwork",
    context: "windows-artwork",
    payload: { controller: "Keypad", coordinates: { column: 1, row: 0 } },
  }));
  await waitFor(() => messages.some((message) =>
    message.event === "setImage" &&
    message.context === "windows-artwork" &&
    String(message.payload?.image).startsWith("data:image/png;base64,")));

  socket.send(JSON.stringify({
    event: "keyUp",
    action: "com.punklabs.prismbeat.next",
    context: "windows-next",
    payload: {},
  }));
  await waitFor(() => readHelperCalls().some((call) =>
    call[0] === "control" && call[1] === "next"));

  socket.send(JSON.stringify({
    event: "keyUp",
    action: "com.punklabs.prismbeat.open",
    context: "windows-open",
    payload: {},
  }));
  await waitFor(() => readHelperCalls().some((call) => call[0] === "launch"));
  socket.close();
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("close", resolve));
  await new Promise((resolve) => server.close(resolve));
}

process.stdout.write("Windows platform routing integration test passed\n");

function readHelperCalls() {
  try {
    return readFileSync(helperLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
}

async function waitFor(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the Windows integration test condition");
}
