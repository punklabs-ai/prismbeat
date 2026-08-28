import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const action = "com.punklabs.prismbeat.now-playing";
const playbackAction = "com.punklabs.prismbeat.playback";
const artworkAction = "com.punklabs.prismbeat.artwork";
const shuffleAction = "com.punklabs.prismbeat.shuffle";
const repeatAction = "com.punklabs.prismbeat.repeat";
const muteAction = "com.punklabs.prismbeat.mute";
const visualPresetAction = "com.punklabs.prismbeat.visual-preset";
const messages = [];
const server = new WebSocketServer({ port: 0 });

const manifest = JSON.parse(readFileSync(join(pluginRoot, "manifest.json"), "utf8"));
assert.equal(manifest.Name, "PrismBeat Visualizer");
assert.equal(manifest.Category, "PrismBeat Visualizer");
assert.equal(manifest.Author, "PUNK LABS");
const pluginIcon = readFileSync(join(pluginRoot, "imgs/plugin.svg"), "utf8");
const categoryIcon = readFileSync(join(pluginRoot, "imgs/category.svg"), "utf8");
assert.doesNotMatch(pluginIcon, /#1ed760/i);
assert.doesNotMatch(categoryIcon, /#1ed760/i);
assert.match(pluginIcon, /#18e4f2/i);
assert.match(pluginIcon, /#ff3dcc/i);
assert.equal([...pluginIcon.matchAll(/<rect /g)].length, 6);
assert.equal([...categoryIcon.matchAll(/<rect /g)].length, 5);
const playbackManifest = manifest.Actions.find(({ UUID }) => UUID === playbackAction);
const artworkManifest = manifest.Actions.find(({ UUID }) => UUID === artworkAction);
const marqueeManifest = manifest.Actions.find(({ UUID }) => UUID === action);
const muteManifest = manifest.Actions.find(({ UUID }) => UUID === muteAction);
const visualPresetManifest = manifest.Actions.find(({ UUID }) => UUID === visualPresetAction);
assert.deepEqual(
  playbackManifest.States.map(({ Image }) => Image),
  ["imgs/play", "imgs/stop"],
);
assert.deepEqual(
  muteManifest.States.map(({ Image }) => Image),
  ["imgs/volume-on", "imgs/volume-muted"],
);
assert.equal(artworkManifest.States[0].Image, "imgs/artwork");
assert.equal(artworkManifest.PropertyInspectorPath, "ui/artwork.html");
const artworkInspector = readFileSync(join(pluginRoot, "ui/artwork.html"), "utf8");
assert.match(artworkInspector, /artwork-position/);
assert.match(artworkInspector, /Mosaic — Automatic/);
assert.match(artworkInspector, /Mosaic — Top left/);
assert.equal(marqueeManifest.PropertyInspectorPath, "ui/marquee.html");
assert.match(readFileSync(join(pluginRoot, "ui/marquee.html"), "utf8"), /Spotify volume/);
assert.match(readFileSync(join(pluginRoot, "ui/marquee.html"), "utf8"), /Visualiser screen/);
assert.match(readFileSync(join(pluginRoot, "ui/marquee.js"), "utf8"), /visualRole/);
assert.equal(visualPresetManifest.PropertyInspectorPath, "ui/visual-preset.html");
const visualPresetInspector = readFileSync(join(pluginRoot, "ui/visual-preset.html"), "utf8");
assert.equal([...visualPresetInspector.matchAll(/<option value="[0-9]+">/g)].length, 19);
assert.match(visualPresetInspector, /Press it to advance to the next visual/);
for (const uuid of [
  "com.punklabs.prismbeat.previous",
  "com.punklabs.prismbeat.next",
  shuffleAction,
  repeatAction,
  muteAction,
  "com.punklabs.prismbeat.restart",
  "com.punklabs.prismbeat.seek-back-15",
  "com.punklabs.prismbeat.seek-forward-15",
  "com.punklabs.prismbeat.volume-down",
  "com.punklabs.prismbeat.volume-up",
  "com.punklabs.prismbeat.copy-track-link",
  visualPresetAction,
]) {
  assert.ok(manifest.Actions.some((candidate) => candidate.UUID === uuid));
}
for (const actionManifest of manifest.Actions) {
  for (const state of actionManifest.States || []) {
    assert.ok(
      existsSync(join(pluginRoot, `${state.Image}.svg`)),
      `missing action image ${state.Image}.svg`,
    );
  }
}

await new Promise((resolve) => server.once("listening", resolve));
const port = server.address().port;
const child = spawn(
  process.execPath,
  [
    join(pluginRoot, "bin/plugin.js"),
    "-port",
    String(port),
    "-pluginUUID",
    "test-plugin",
    "-registerEvent",
    "registerPlugin",
    "-info",
    JSON.stringify({
      devices: [
        {
          id: "stream-deck-plus-xl",
          name: "Stream Deck + XL",
          size: { columns: 9, rows: 4 },
          type: 13,
        },
      ],
    }),
  ],
  {
    cwd: pluginRoot,
    env: {
      ...process.env,
      SPOTIFY_AUDIO_ANALYZER_PATH: join(pluginRoot, "tests/mock-audio-analyzer.mjs"),
      SPOTIFY_VISUAL_INDICATOR_MS: "500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let socket;
try {
  socket = await new Promise((resolve) => server.once("connection", resolve));
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  await waitForSince(0, (message) => message.event === "registerPlugin");

  socket.send(
    JSON.stringify({
      event: "deviceDidConnect",
      device: "stream-deck-plus",
      payload: { deviceInfo: { type: 7, size: { columns: 4, rows: 2 } } },
    }),
  );

  for (let column = 0; column < 4; column += 1) {
    socket.send(
      JSON.stringify({
        event: "willAppear",
        action,
        context: `context-${column}`,
        device: "stream-deck-plus",
        payload: {
          controller: "Encoder",
          coordinates: { column, row: 0 },
          settings: {
            role: ["track", "volume", "seek", "volume"][column],
            visualRole: ["visual", "volume", "visual", "volume"][column],
          },
        },
      }),
    );
  }

  for (let column = 0; column < 6; column += 1) {
    socket.send(
      JSON.stringify({
        event: "willAppear",
        action,
        context: `xl-context-${column}`,
        device: "stream-deck-plus-xl",
        payload: {
          controller: "Encoder",
          coordinates: { column, row: 0 },
          settings: {},
        },
      }),
    );
  }

  socket.send(
    JSON.stringify({
      event: "willAppear",
      action: playbackAction,
      context: "playback-context",
      payload: { controller: "Keypad", coordinates: { column: 1, row: 0 } },
    }),
  );
  const playbackFeedback = await waitForSince(
    0,
    (message) => message.event === "setState" && message.context === "playback-context",
  );
  assert.ok([0, 1].includes(playbackFeedback.payload?.state));

  for (const [toggleAction, context] of [
    [shuffleAction, "shuffle-context"],
    [repeatAction, "repeat-context"],
    [muteAction, "mute-context"],
  ]) {
    socket.send(
      JSON.stringify({
        event: "willAppear",
        action: toggleAction,
        context,
        payload: { controller: "Keypad", coordinates: { column: 0, row: 1 } },
      }),
    );
    const stateFeedback = await waitForSince(
      0,
      (message) => message.event === "setState" && message.context === context,
    );
    assert.ok([0, 1].includes(stateFeedback.payload?.state));
  }

  socket.send(
    JSON.stringify({
      event: "willAppear",
      action: artworkAction,
      context: "artwork-context",
      payload: { controller: "Keypad", coordinates: { column: 3, row: 0 } },
    }),
  );
  const artworkFeedback = await waitForSince(
    0,
    (message) => message.event === "setImage" && message.context === "artwork-context",
  );
  assert.match(artworkFeedback.payload?.image || "", /^data:image\//);

  const mosaicTiles = [
    { context: "artwork-top-left", column: 1, row: 0, quarter: "top-left", x: 0, y: 0 },
    { context: "artwork-top-right", column: 2, row: 0, quarter: "top-right", x: -144, y: 0 },
    { context: "artwork-bottom-left", column: 1, row: 1, quarter: "bottom-left", x: 0, y: -144 },
    { context: "artwork-bottom-right", column: 2, row: 1, quarter: "bottom-right", x: -144, y: -144 },
  ];
  for (const tile of mosaicTiles) {
    const artworkStart = messages.length;
    socket.send(
      JSON.stringify({
        event: "willAppear",
        action: artworkAction,
        context: tile.context,
        device: "stream-deck-plus",
        payload: {
          controller: "Keypad",
          coordinates: { column: tile.column, row: tile.row },
          settings: { artworkLayout: "quarter", quarter: "auto" },
        },
      }),
    );
    const tileFeedback = await waitForSince(
      artworkStart,
      (message) => message.event === "setImage" && message.context === tile.context,
    );
    const tileSvg = decodeKeyImageSvg(tileFeedback);
    assert.match(tileSvg, new RegExp(`data-artwork-quarter="${tile.quarter}"`));
    assert.match(tileSvg, new RegExp(`x="${tile.x}" y="${tile.y}" width="288"`));
  }

  const separateMosaicStart = messages.length;
  socket.send(
    JSON.stringify({
      event: "willAppear",
      action: artworkAction,
      context: "artwork-xl-top-left",
      device: "stream-deck-plus-xl",
      payload: {
        controller: "Keypad",
        coordinates: { column: 5, row: 2 },
        settings: { artworkLayout: "quarter", quarter: "auto" },
      },
    }),
  );
  const separateMosaicFeedback = await waitForSince(
    separateMosaicStart,
    (message) => message.event === "setImage" && message.context === "artwork-xl-top-left",
  );
  assert.match(decodeKeyImageSvg(separateMosaicFeedback), /data-artwork-quarter="top-left"/);

  const explicitStart = messages.length;
  socket.send(
    JSON.stringify({
      event: "didReceiveSettings",
      action: artworkAction,
      context: "artwork-context",
      payload: { settings: { artworkLayout: "quarter", quarter: "bottom-right" } },
    }),
  );
  const explicitFeedback = await waitForSince(
    explicitStart,
    (message) => message.event === "setImage" && message.context === "artwork-context",
  );
  assert.match(decodeKeyImageSvg(explicitFeedback), /data-artwork-quarter="bottom-right"/);

  const dialSettingsStart = messages.length;
  socket.send(
    JSON.stringify({
      event: "didReceiveSettings",
      action,
      context: "context-2",
      payload: {
        controller: "Encoder",
        coordinates: { column: 2, row: 0 },
        settings: { role: "none" },
      },
    }),
  );
  const disabledDialFeedback = await waitForSince(
    dialSettingsStart,
    (message) =>
      message.event === "setTriggerDescription" && message.context === "context-2",
  );
  assert.equal(disabledDialFeedback.payload?.rotate, "No action");

  const automaticDialStart = messages.length;
  socket.send(
    JSON.stringify({
      event: "didReceiveSettings",
      action,
      context: "context-2",
      payload: {
        controller: "Encoder",
        coordinates: { column: 2, row: 0 },
        settings: { role: "auto" },
      },
    }),
  );
  const automaticDialFeedback = await waitForSince(
    automaticDialStart,
    (message) =>
      message.event === "setTriggerDescription" && message.context === "context-2",
  );
  assert.equal(automaticDialFeedback.payload?.rotate, "Seek -/+ 5 seconds");

  const initial = await waitForSince(0, isCanvasFor("context-0"));
  const textSvg = decodeSvg(initial);
  assert.match(textSvg, /data-segment-column="0" data-segment-count="4"/);
  assert.match(textSvg, /transform="matrix\(1 0 0 1 0 0\)"/);
  assert.doesNotMatch(textSvg, />TRACK</);
  assert.doesNotMatch(textSvg, />VOLUME</);
  assert.doesNotMatch(textSvg, />SEEK</);
  assert.doesNotMatch(textSvg, />PLAY \/ PAUSE</);

  const xlFifthSegment = decodeSvg(await waitForSince(0, isCanvasFor("xl-context-4")));
  const xlSixthSegment = decodeSvg(await waitForSince(0, isCanvasFor("xl-context-5")));
  assert.match(xlFifthSegment, /data-segment-column="4" data-segment-count="6"/);
  assert.match(xlFifthSegment, /transform="matrix\(1\.5 0 0 1 -800 0\)"/);
  assert.match(xlSixthSegment, /data-segment-column="5" data-segment-count="6"/);
  assert.match(xlSixthSegment, /transform="matrix\(1\.5 0 0 1 -1000 0\)"/);

  let start = messages.length;
  sendDial("dialUp", 0);
  const visualVolumeDescription = await waitForSince(
    start,
    (message) =>
      message.event === "setTriggerDescription" && message.context === "context-1",
  );
  assert.equal(visualVolumeDescription.payload?.rotate, "Spotify volume");
  const silentBaseline = await waitForSince(
    start,
    (message) =>
      isCanvasFor("context-0")(message) &&
      decodeSvg(message).includes('data-audio-reactive="false"') &&
      decodeSvg(message).includes('data-peak-marker="true"'),
  );
  const silentSvg = decodeSvg(silentBaseline);
  assert.equal([...silentSvg.matchAll(/data-peak-marker="true"/g)].length, 40);
  assert.match(
    silentSvg,
    /data-band="0" data-spectrum-layout="low-mid-high" data-peak-marker="true" x="3" y="98"/,
  );

  let response = await waitForSince(
    start,
    (message) =>
      isCanvasFor("context-0")(message) &&
      decodeSvg(message).includes('data-audio-reactive="true"') &&
      decodeSvg(message).includes('data-band="0"') &&
      decodeSvg(message).includes('width="14" height="6"'),
  );
  let visualSvg = decodeSvg(response);
  assert.match(visualSvg, /<rect[^>]+width="14" height="6"/);
  assert.match(visualSvg, /data-audio-reactive="true"/);
  assert.match(visualSvg, /data-spectrum-layout="low-mid-high"/);
  assert.match(
    visualSvg,
    /data-band="0" data-spectrum-layout="low-mid-high" data-peak-marker="true" x="3"/,
  );
  assert.match(
    visualSvg,
    /data-band="20" data-spectrum-layout="low-mid-high" data-peak-marker="true" x="403"/,
  );
  assert.match(
    visualSvg,
    /data-band="39" data-spectrum-layout="low-mid-high" data-peak-marker="true" x="783"/,
  );
  assert.match(visualSvg, /data-visual-indicator="true"/);
  assert.equal(
    [...visualSvg.matchAll(/data-visual-indicator="true"/g)].length,
    19,
  );
  const xlVisualSvg = decodeSvg(
    await waitForSince(
      start,
      (message) =>
        isCanvasFor("xl-context-5")(message) &&
        decodeSvg(message).includes('data-audio-reactive="true"'),
    ),
  );
  assert.match(xlVisualSvg, /data-segment-column="5" data-segment-count="6"/);
  assert.match(xlVisualSvg, /data-spectrum-layout="low-mid-high"/);

  start = messages.length;
  response = await waitForSince(
    start,
    (message) =>
      isCanvasFor("context-0")(message) &&
      !decodeSvg(message).includes('data-visual-indicator="true"'),
  );
  assert.doesNotMatch(decodeSvg(response), /data-visual-indicator="true"/);

  const visualPatterns = [
    /data-reacts-to="triggered-waveform"/,
    /data-reacts-to="frequency-tunnel"/,
    /data-reacts-to="audio-warp-starfield"/,
    /data-reacts-to="spectrum-plasma"/,
    /data-reacts-to="kaleidoscope-bands"/,
    /data-reacts-to="frequency-halo"/,
    /data-reacts-to="spectrum-terrain"/,
    /data-reacts-to="center-frequency-history"/,
    /data-reacts-to="frequency-particle-fountain"/,
    /data-reacts-to="stereo-vectorscope"/,
    /data-reacts-to="frequency-lightning-storm"/,
    /data-reacts-to="cymatic-frequency-ripples"/,
    /data-reacts-to="frequency-dna-helix"/,
    /data-reacts-to="pitch-class-constellation"/,
    /data-reacts-to="frequency-digital-rain"/,
    /data-reacts-to="synthwave-highway"/,
    /data-reacts-to="neon-city-cruise"/,
    /data-reacts-to="miami-night-run"/,
  ];
  for (const pattern of visualPatterns) {
    start = messages.length;
    sendDial("dialRotate", 0, 1);
    response = await waitForSince(
      start,
      (message) => isCanvasFor("context-0")(message) && pattern.test(decodeSvg(message)),
    );
    const renderedSvg = decodeSvg(response);
    assert.match(renderedSvg, pattern);
    assert.doesNotMatch(renderedSvg, /(?:fill|stroke)="hsl\(/);
    if (pattern.source.includes("frequency-tunnel")) {
      const tunnelSvg = decodeSvg(response);
      assert.equal(
        [...tunnelSvg.matchAll(/data-reacts-to="frequency-tunnel"/g)].length,
        15,
      );
      const tunnelFrames = [
        ...tunnelSvg.matchAll(/data-shape="rectangle"[^>]+points="([^"]+)"/g),
      ];
      assert.equal(tunnelFrames.length, 15);
      assert.ok(
        tunnelFrames.every((frame) => frame[1].trim().split(/\s+/).length === 4),
        "every tunnel frame should retain four hard rectangular corners",
      );
      assert.match(tunnelSvg, /data-reacts-to="frequency-tunnel"[^>]+stroke="#[0-9a-f]{6}"/);
      assert.doesNotMatch(tunnelSvg, /stroke="hsl\(/);
    }
    if (pattern.source.includes("audio-warp-starfield")) {
      const starfieldSvg = decodeSvg(response);
      assert.match(starfieldSvg, /data-starfield-center="400,50"/);
      assert.match(starfieldSvg, /data-starfield-speed="0\.[0-9]+"/);
      assert.match(starfieldSvg, /data-starfield-burst="[0-9.]+"/);
      assert.match(starfieldSvg, /data-visible-stars="[0-9]+"/);
      assert.doesNotMatch(starfieldSvg, /data-reacts-to="treble-beat"/);
    }
    if (pattern.source.includes("spectrum-plasma")) {
      assert.match(renderedSvg, /data-plasma-zones="12"/);
      assert.equal([...renderedSvg.matchAll(/data-plasma-band-zone="[0-9]+"/g)].length, 12);
      assert.match(renderedSvg, /stop-color="#[0-9a-f]{6}"/);
    }
    if (pattern.source.includes("kaleidoscope-bands")) {
      assert.match(renderedSvg, /data-band-start="0"/);
      assert.match(renderedSvg, /data-band-start="38"/);
      assert.match(renderedSvg, /cy="50"/);
    }
    if (pattern.source.includes("frequency-halo")) {
      assert.equal([...renderedSvg.matchAll(/data-reacts-to="frequency-halo"/g)].length, 40);
      assert.match(renderedSvg, /data-band="0"/);
      assert.match(renderedSvg, /data-band="39"/);
      assert.match(renderedSvg, /<ellipse cx="400" cy="50"/);
    }
    if (pattern.source.includes("spectrum-terrain")) {
      assert.match(renderedSvg, /data-terrain-source="frequency-history"/);
      assert.match(renderedSvg, /data-terrain-ridges="12"/);
      const terrainRidges = [
        ...renderedSvg.matchAll(/data-reacts-to="spectrum-terrain"[^>]+points="([^"]+)"/g),
      ];
      assert.equal(terrainRidges.length, 12);
      assert.ok(terrainRidges.every((ridge) => ridge[1].trim().split(/\s+/).length === 40));
      assert.equal([...renderedSvg.matchAll(/data-terrain-longitude="[0-9]+"/g)].length, 11);
      assert.doesNotMatch(renderedSvg, /captured-waveform-feedback/);
    }
    if (pattern.source.includes("center-frequency-history")) {
      assert.match(renderedSvg, /data-frequency-axis="low-bottom-high-top"/);
      assert.match(renderedSvg, /data-spectrogram-origin="center"[^>]+y2="100"/);
    }
    if (pattern.source.includes("frequency-particle-fountain")) {
      assert.match(renderedSvg, /data-visible-particles="[0-9]+"/);
      assert.match(renderedSvg, /data-particle-band="[0-9]+"/);
      assert.match(renderedSvg, /stroke="#[0-9a-f]{6}"/);
    }
    if (pattern.source.includes("stereo-vectorscope")) {
      assert.match(renderedSvg, /data-vectorscope-panels="4"/);
      assert.match(renderedSvg, /data-stereo-source="left-x-right-y"/);
      assert.match(renderedSvg, /data-vectorscope-correlation="-?[0-9.]+"/);
      assert.equal([...renderedSvg.matchAll(/data-scope-panel="[0-3]"/g)].length, 4);
    }
    if (pattern.source.includes("frequency-lightning-storm")) {
      assert.match(renderedSvg, /data-lightning-energy="[0-9.]+"/);
      assert.match(renderedSvg, /data-lightning-branches="[1-9][0-9]*"/);
      assert.match(renderedSvg, /data-lightning-branch-band="3[0-9]"/);
    }
    if (pattern.source.includes("cymatic-frequency-ripples")) {
      assert.match(renderedSvg, /data-cymatic-emitters="5"/);
      assert.equal(
        [...renderedSvg.matchAll(/data-reacts-to="cymatic-frequency-ripples"/g)].length,
        35,
      );
      assert.match(renderedSvg, /data-band-start="32"/);
    }
    if (pattern.source.includes("frequency-dna-helix")) {
      assert.match(renderedSvg, /data-dna-rungs="21"/);
      assert.match(renderedSvg, /data-dna-rung-band="0"/);
      assert.match(renderedSvg, /data-dna-rung-band="39"/);
    }
    if (pattern.source.includes("pitch-class-constellation")) {
      assert.match(renderedSvg, /data-pitch-source="fft-chromagram"/);
      assert.equal(
        [...renderedSvg.matchAll(/data-reacts-to="pitch-class-constellation"/g)].length,
        12,
      );
      assert.match(renderedSvg, /data-pitch-active="[1-9][0-9]*"/);
      assert.match(renderedSvg, /data-pitch-connection="[0-9]+-[0-9]+"/);
    }
    if (pattern.source.includes("frequency-digital-rain")) {
      assert.match(renderedSvg, /data-rain-source="frequency-bands"/);
      assert.match(renderedSvg, /data-visible-rain-drops="[1-9][0-9]*"/);
      assert.match(renderedSvg, /data-rain-band="39"/);
      const rainCycles = [
        ...renderedSvg.matchAll(
          /data-rain-cycle-start="-8" data-rain-cycle-end="([0-9.]+)" data-rain-trail="([0-9.]+)"/g,
        ),
      ];
      assert.ok(rainCycles.length > 0);
      assert.ok(
        rainCycles.every((cycle) => Number(cycle[1]) - Number(cycle[2]) >= 107.9),
        "every rain tail should clear the lower edge before its stream wraps",
      );
    }
    if (pattern.source.includes("synthwave-highway")) {
      assert.match(renderedSvg, /data-frequency-axis="low-left-high-right"/);
      assert.match(renderedSvg, /data-outrun-frequency-mountains="40"/);
      assert.match(renderedSvg, /data-outrun-sun-energy="[0-9.]+"/);
      assert.match(renderedSvg, /data-grid-travel="[0-9.]+"/);
      assert.equal([...renderedSvg.matchAll(/data-outrun-grid-ray="[0-9]+"/g)].length, 21);
      assert.equal([...renderedSvg.matchAll(/data-outrun-grid-row="[0-9]+"/g)].length, 10);
      assert.equal([...renderedSvg.matchAll(/data-outrun-road-dash="[0-9]+"/g)].length, 6);
    }
    if (pattern.source.includes("neon-city-cruise")) {
      assert.match(renderedSvg, /data-city-buildings="32"/);
      assert.equal([...renderedSvg.matchAll(/data-city-building-band="[0-9]+"/g)].length, 32);
      assert.equal([...renderedSvg.matchAll(/data-city-grid-ray="[0-9]+"/g)].length, 17);
      assert.equal([...renderedSvg.matchAll(/data-city-grid-row="[0-9]+"/g)].length, 7);
    }
    if (pattern.source.includes("miami-night-run")) {
      assert.match(renderedSvg, /data-miami-palms="6"/);
      assert.match(renderedSvg, /data-ocean-source="waveform-spectrum"/);
      assert.equal([...renderedSvg.matchAll(/data-miami-palm="[0-9]+"/g)].length, 6);
      assert.equal([...renderedSvg.matchAll(/data-miami-ocean-wave="[0-9]+"/g)].length, 5);
    }
  }

  start = messages.length;
  sendDial("dialRotate", 0, 1);
  response = await waitForSince(
    start,
    (message) =>
      isCanvasFor("context-0")(message) &&
      decodeSvg(message).includes('data-spectrum-layout="low-mid-high"'),
  );
  assert.match(decodeSvg(response), /<rect[^>]+width="14" height="6"/);

  start = messages.length;
  sendDial("dialUp", 0);
  response = await waitForSince(
    start,
    (message) =>
      isCanvasFor("context-0")(message) && decodeSvg(message).includes('font-size="25"'),
  );
  assert.match(decodeSvg(response), /font-size="25"/);

  const presetStart = messages.length;
  socket.send(
    JSON.stringify({
      event: "willAppear",
      action: visualPresetAction,
      context: "visual-preset-context",
      payload: {
        controller: "Keypad",
        coordinates: { column: 0, row: 0 },
        settings: { visualIndex: 17 },
      },
    }),
  );
  let presetFeedback = await waitForSince(
    presetStart,
    (message) => message.event === "setImage" && message.context === "visual-preset-context",
  );
  assert.match(decodeKeyImageSvg(presetFeedback), /data-visual-preset-index="17"/);
  assert.match(decodeKeyImageSvg(presetFeedback), /data-reacts-to="neon-city-cruise"/);

  const presetSettingsStart = messages.length;
  socket.send(
    JSON.stringify({
      event: "didReceiveSettings",
      action: visualPresetAction,
      context: "visual-preset-context",
      payload: { settings: { visualIndex: 18 } },
    }),
  );
  presetFeedback = await waitForSince(
    presetSettingsStart,
    (message) => message.event === "setImage" && message.context === "visual-preset-context",
  );
  assert.match(decodeKeyImageSvg(presetFeedback), /data-visual-preset-index="18"/);
  assert.match(decodeKeyImageSvg(presetFeedback), /data-reacts-to="miami-night-run"/);

  const presetCycleStart = messages.length;
  socket.send(
    JSON.stringify({
      event: "keyDown",
      action: visualPresetAction,
      context: "visual-preset-context",
      payload: {},
    }),
  );
  const savedPreset = await waitForSince(
    presetCycleStart,
    (message) => message.event === "setSettings" && message.context === "visual-preset-context",
  );
  assert.equal(savedPreset.payload?.visualIndex, 0);
  presetFeedback = await waitForSince(
    presetCycleStart,
    (message) =>
      message.event === "setImage" &&
      message.context === "visual-preset-context" &&
      decodeKeyImageSvg(message).includes('data-visual-preset-index="0"'),
  );
  assert.match(decodeKeyImageSvg(presetFeedback), /data-spectrum-layout="low-mid-high"/);

  process.stdout.write("Spotify marquee interaction test passed\n");
} finally {
  child.kill("SIGTERM");
  if (socket?.readyState === socket.OPEN) socket.close();
  server.close();
}

function sendDial(event, column, ticks = 0) {
  socket.send(
    JSON.stringify({
      event,
      action,
      context: `context-${column}`,
      payload: event === "dialRotate" ? { ticks } : {},
    }),
  );
}

function isCanvasFor(context) {
  return (message) =>
    message.event === "setFeedback" &&
    message.context === context &&
    typeof message.payload?.canvas === "string";
}

function decodeSvg(message) {
  const encoded = message.payload.canvas.split(",", 2)[1];
  return Buffer.from(encoded, "base64").toString("utf8");
}

function decodeKeyImageSvg(message) {
  const image = message.payload.image;
  assert.match(image, /^data:image\/svg\+xml;base64,/);
  return Buffer.from(image.split(",", 2)[1], "base64").toString("utf8");
}

function waitForSince(start, predicate, timeout = 3000) {
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
        reject(new Error("Timed out waiting for plugin feedback"));
      }
    }, 10);
  });
}
