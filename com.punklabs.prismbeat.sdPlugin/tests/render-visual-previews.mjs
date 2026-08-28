import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = process.argv[2] || "/tmp/spotify-visual-previews";
const action = "com.punklabs.prismbeat.now-playing";
const messages = [];
const server = new WebSocketServer({ port: 0 });

mkdirSync(outputDirectory, { recursive: true });
await new Promise((resolve) => server.once("listening", resolve));
const port = server.address().port;
const child = spawn(
  process.execPath,
  [
    join(pluginRoot, "bin/plugin.js"),
    "-port",
    String(port),
    "-pluginUUID",
    "preview-plugin",
    "-registerEvent",
    "registerPlugin",
  ],
  {
    cwd: pluginRoot,
    env: {
      ...process.env,
      SPOTIFY_AUDIO_ANALYZER_PATH:
        process.env.SPOTIFY_PREVIEW_ANALYZER_PATH ||
        join(pluginRoot, "tests/mock-audio-analyzer.mjs"),
      SPOTIFY_VISUAL_INDICATOR_MS: "15",
    },
    stdio: ["ignore", "ignore", "pipe"],
  },
);

let socket;
try {
  socket = await new Promise((resolve) => server.once("connection", resolve));
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  await waitFor(0, (message) => message.event === "registerPlugin");

  socket.send(
    JSON.stringify({
      event: "willAppear",
      action,
      context: "preview-context",
      payload: { controller: "Encoder", coordinates: { column: 0, row: 0 } },
    }),
  );

  socket.send(JSON.stringify({ event: "dialUp", action, context: "preview-context", payload: {} }));

  for (let visual = 0; visual < 19; visual += 1) {
    let start = messages.length;
    if (visual > 0) {
      socket.send(
        JSON.stringify({
          event: "dialRotate",
          action,
          context: "preview-context",
          payload: { ticks: 1 },
        }),
      );
    }
    if (visual === 2) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      start = messages.length;
    }
    const message = await waitFor(
      start,
      (candidate) => {
        if (!isCanvas(candidate)) return false;
        const svg = decodeSvg(candidate);
        return (
          svg.includes('data-audio-reactive="true"') &&
          svg.includes(`data-visual-index="${visual}"`) &&
          !svg.includes('data-visual-indicator="true"')
        );
      },
    );
    const fullWidthSvg = decodeSvg(message).replace(
      'width="200" height="100" viewBox="0 0 200 100"',
      'width="800" height="100" viewBox="0 0 800 100"',
    );
    writeFileSync(join(outputDirectory, `visual-${visual}.svg`), fullWidthSvg);
  }
  process.stdout.write(`Rendered nineteen SVG previews to ${outputDirectory}\n`);
} finally {
  child.kill("SIGTERM");
  if (socket?.readyState === socket.OPEN) socket.close();
  server.close();
}

function isCanvas(message) {
  return (
    message.event === "setFeedback" &&
    message.context === "preview-context" &&
    typeof message.payload?.canvas === "string"
  );
}

function decodeSvg(message) {
  return Buffer.from(message.payload.canvas.split(",", 2)[1], "base64").toString("utf8");
}

function waitFor(start, predicate, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      for (let index = start; index < messages.length; index += 1) {
        if (predicate(messages[index])) {
          clearInterval(timer);
          resolve(messages[index]);
          return;
        }
      }
      if (Date.now() - startedAt > timeout) {
        clearInterval(timer);
        reject(new Error("Timed out rendering visual preview"));
      }
    }, 10);
  });
}
