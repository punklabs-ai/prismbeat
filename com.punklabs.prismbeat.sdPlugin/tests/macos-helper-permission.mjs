import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

if (process.platform !== "darwin") {
  console.log("macOS helper permission test skipped on this platform");
  process.exit(0);
}

const pluginRoot = process.env.PRISMBEAT_PERMISSION_TEST_PLUGIN_ROOT
  || dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoot = mkdtempSync(join(tmpdir(), "prismbeat-helper-permission-"));
const analyzerPath = join(temporaryRoot, "audio-analyzer");
const server = new WebSocketServer({ port: 0 });
let child;

try {
  copyFileSync(
    process.env.PRISMBEAT_PERMISSION_TEST_ANALYZER_PATH
      || join(pluginRoot, "tests/mock-audio-analyzer.mjs"),
    analyzerPath,
  );
  chmodSync(analyzerPath, 0o644);
  assert.equal(statSync(analyzerPath).mode & 0o777, 0o644);

  await new Promise((resolve) => server.once("listening", resolve));
  child = spawn(
    process.execPath,
    [
      join(pluginRoot, "bin/plugin.js"),
      "-port",
      String(server.address().port),
      "-pluginUUID",
      "permission-test-plugin",
      "-registerEvent",
      "registerPlugin",
      "-info",
      JSON.stringify({ devices: [] }),
    ],
    {
      cwd: pluginRoot,
      env: {
        ...process.env,
        SPOTIFY_AUDIO_ANALYZER_PATH: analyzerPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const socket = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("plugin connection timed out")), 5_000);
    server.once("connection", (connection) => {
      clearTimeout(timer);
      resolve(connection);
    });
  });

  const reactiveFrame = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`audio-reactive frame timed out\n${stderr}`)),
      5_000,
    );
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.event !== "setFeedback" || message.context !== "permission-context") return;
      const image = message.payload?.canvas;
      if (!image?.startsWith("data:image/svg+xml;base64,")) return;
      const svg = Buffer.from(image.slice("data:image/svg+xml;base64,".length), "base64").toString();
      if (!svg.includes('data-audio-reactive="true"')) return;
      clearTimeout(timer);
      resolve();
    });
  });

  socket.send(
    JSON.stringify({
      event: "willAppear",
      action: "com.punklabs.prismbeat.now-playing",
      context: "permission-context",
      device: "permission-device",
      payload: {
        controller: "Encoder",
        coordinates: { column: 0, row: 0 },
        settings: {},
      },
    }),
  );
  socket.send(
    JSON.stringify({
      event: "dialUp",
      action: "com.punklabs.prismbeat.now-playing",
      context: "permission-context",
      device: "permission-device",
      payload: { controller: "Encoder", coordinates: { column: 0, row: 0 } },
    }),
  );

  await reactiveFrame;
  assert.equal(statSync(analyzerPath).mode & 0o777, 0o755);
  socket.close();
  console.log("macOS packaged helper permission repair passed");
} finally {
  if (child && !child.killed) child.kill("SIGTERM");
  await new Promise((resolve) => server.close(resolve));
  rmSync(temporaryRoot, { recursive: true, force: true });
}
