import { execFile, spawn } from "node:child_process";
import { accessSync, chmodSync, constants as fsConstants } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import WebSocket from "ws";

const execFileAsync = promisify(execFile);

const ACTION_MARQUEE = "com.punklabs.prismbeat.now-playing";
const ACTION_OPEN = "com.punklabs.prismbeat.open";
const ACTION_PLAYBACK = "com.punklabs.prismbeat.playback";
const ACTION_ARTWORK = "com.punklabs.prismbeat.artwork";
const ACTION_PREVIOUS = "com.punklabs.prismbeat.previous";
const ACTION_NEXT = "com.punklabs.prismbeat.next";
const ACTION_SHUFFLE = "com.punklabs.prismbeat.shuffle";
const ACTION_REPEAT = "com.punklabs.prismbeat.repeat";
const ACTION_MUTE = "com.punklabs.prismbeat.mute";
const ACTION_RESTART = "com.punklabs.prismbeat.restart";
const ACTION_SEEK_BACK = "com.punklabs.prismbeat.seek-back-15";
const ACTION_SEEK_FORWARD = "com.punklabs.prismbeat.seek-forward-15";
const ACTION_VOLUME_DOWN = "com.punklabs.prismbeat.volume-down";
const ACTION_VOLUME_UP = "com.punklabs.prismbeat.volume-up";
const ACTION_COPY_LINK = "com.punklabs.prismbeat.copy-track-link";
const ACTION_VISUAL_PRESET = "com.punklabs.prismbeat.visual-preset";
const DISPLAY_WIDTH = 800;
const SEGMENT_WIDTH = 200;
const FRAME_MS = 160;
const SCROLL_STEP = 6;
const SPECTRUM_BANDS = 40;
const SPECTRUM_BLOCKS = 12;
const WAVEFORM_POINTS = 256;
const STEREO_POINTS = 256;
const PITCH_CLASSES = 12;
const OSCILLOSCOPE_TRAILS = 5;
const WAVEFORM_HISTORY_FRAMES = 5;
const TUNNEL_RINGS = 15;
const TUNNEL_ZONES = 16;
const TERRAIN_RIDGES = 12;
const VISUAL_COUNT = 19;
const SPECTROGRAM_COLUMNS = 40;
const VISUAL_INDICATOR_MS = Number(process.env.SPOTIFY_VISUAL_INDICATOR_MS || 5000);
const VISUAL_PALETTE = ["#31f5d0", "#52a8ff", "#9c6cff", "#ff5ca8", "#ff9f43", "#ffe45e"];
const ARTWORK_QUARTERS = new Set([
  "auto",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
]);
const DIAL_ROLES = new Set(["track", "volume", "seek", "none"]);
const VISUAL_DIAL_ROLES = new Set(["visual", ...DIAL_ROLES]);
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOST_PLATFORM = process.env.SPOTIFY_PLATFORM_OVERRIDE || process.platform;
const WINDOWS_ARCH = process.env.SPOTIFY_WINDOWS_ARCH_OVERRIDE || process.arch;
const WINDOWS_HELPER_PATH =
  process.env.SPOTIFY_WINDOWS_HELPER_PATH ||
  join(
    PLUGIN_ROOT,
    "bin",
    WINDOWS_ARCH === "arm64" ? "windows-arm64" : "windows-x64",
    "prismbeat-windows.exe",
  );
const USING_WINDOWS_HELPER = HOST_PLATFORM === "win32";
const AUDIO_ANALYZER_PATH =
  process.env.SPOTIFY_AUDIO_ANALYZER_PATH ||
  (USING_WINDOWS_HELPER ? WINDOWS_HELPER_PATH : join(PLUGIN_ROOT, "bin/audio-analyzer"));
const AUDIO_ANALYZER_ARGS =
  USING_WINDOWS_HELPER && !process.env.SPOTIFY_AUDIO_ANALYZER_PATH ? ["analyze"] : [];
const AUDIO_ANALYZER_DISABLED = process.env.SPOTIFY_AUDIO_ANALYZER_DISABLED === "1";

const stateScript = join(PLUGIN_ROOT, "scripts/spotify-state.js");
const dispatcherScript = join(PLUGIN_ROOT, "scripts/spotify-control.js");

const parameters = parseParameters(process.argv.slice(2));
const socket = new WebSocket(`ws://127.0.0.1:${parameters.port}`);
const contexts = new Map();
const connectedDevices = new Map(
  (parameters.info?.devices || []).map((device) => [device.id, device]),
);
const playbackContexts = new Set();
const artworkContexts = new Map();
const shuffleContexts = new Set();
const repeatContexts = new Set();
const muteContexts = new Set();
const visualPresetContexts = new Map();

let spotifyState = stoppedState();
let lastAudibleVolume = 50;
let pollInFlight = false;
let scrollX = DISPLAY_WIDTH + 16;
let messageWidth = 480;
let currentTrackId = "";
let currentArtworkUrl = "";
let currentArtworkImage = "";
let artworkLoadingUrl = "";
let artworkRequestId = 0;
let controlQueue = Promise.resolve();
let displayMode = "text";
let visualIndex = 0;
let visualPhase = 0;
let animationFrame = 0;
let visualIndicatorVisible = false;
let visualIndicatorTimer = null;
let audioAnalyzerProcess = null;
let audioAnalyzerBuffer = "";
let audioAnalyzerStatus = "idle";
let audioAnalyzerMessage = "";
let audioAnalyzerErrorCode = "";
let audioAnalysis = emptyAudioAnalysis();
let capturedBeatPeak = 0;
let visualBeat = 0;
let starfieldTravel = 0;
let starfieldSpeed = 0.001;
let starfieldBurst = 0;
let plasmaFlow = 0;
let particleTravel = 0;
let particleSpeed = 0.002;
const spectrogramHistory = Array.from(
  { length: SPECTROGRAM_COLUMNS },
  () => Array(SPECTRUM_BANDS).fill(0),
);
const waveformHistory = Array.from(
  { length: WAVEFORM_HISTORY_FRAMES },
  () => Array(WAVEFORM_POINTS).fill(0),
);
const tunnelHistory = Array.from(
  { length: TUNNEL_RINGS },
  () => emptyTunnelSnapshot(),
);
const spectrumLevels = Array.from(
  { length: SPECTRUM_BANDS },
  () => 0,
);
const spectrumTargets = [...spectrumLevels];
const spectrumPeaks = [...spectrumLevels];
const spectrumPeakHolds = Array(SPECTRUM_BANDS).fill(0);

socket.on("open", () => {
  send({ event: parameters.registerEvent, uuid: parameters.pluginUUID });
});

socket.on("message", (raw) => {
  try {
    handleEvent(JSON.parse(raw.toString()));
  } catch (error) {
    console.error("Unable to handle Stream Deck event", error);
  }
});

socket.on("close", shutdown);
socket.on("error", (error) => console.error("Stream Deck connection error", error));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

setInterval(pollSpotify, 1000);
setInterval(animate, FRAME_MS);
pollSpotify();

function parseParameters(args) {
  const values = {};
  for (let index = 0; index < args.length - 1; index += 2) {
    values[args[index].replace(/^-/, "")] = args[index + 1];
  }
  return {
    port: values.port,
    pluginUUID: values.pluginUUID,
    registerEvent: values.registerEvent,
    info: parsePluginInfo(values.info),
  };
}

function parsePluginInfo(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function handleEvent(event) {
  if (event.event === "deviceDidConnect" || event.event === "deviceDidChange") {
    connectedDevices.set(event.device, event.payload?.deviceInfo || {});
    for (const details of contexts.values()) {
      if (details.device === event.device) {
        details.segmentCount = segmentCountForDevice(event.device, details.column);
      }
    }
    renderAll();
    return;
  }

  if (event.event === "deviceDidDisconnect") {
    connectedDevices.delete(event.device);
    return;
  }

  if (event.event === "willAppear") {
    if (event.action === ACTION_MARQUEE) {
      const column = Number(event.payload?.coordinates?.column ?? 0);
      const role = resolveDialRole(event.payload?.settings?.role, column);
      const visualRole = resolveVisualDialRole(event.payload?.settings?.visualRole);
      contexts.set(event.context, {
        column,
        role,
        visualRole,
        device: event.device || "",
        segmentCount: segmentCountForDevice(event.device, column),
      });
      send({
        event: "setFeedbackLayout",
        context: event.context,
        payload: { layout: "layouts/marquee.json" },
      });
      sendTriggerDescription(event.context, role, visualRole);
      renderContext(event.context, contexts.get(event.context));
    } else if (event.action === ACTION_PLAYBACK) {
      playbackContexts.add(event.context);
      renderPlaybackButton(event.context);
    } else if (event.action === ACTION_ARTWORK) {
      artworkContexts.set(
        event.context,
        artworkContext(event.payload?.settings, event.payload?.coordinates, event.device),
      );
      renderArtworkButtons();
      refreshArtwork(spotifyState.currentTrack?.artworkUrl || "");
    } else if (event.action === ACTION_SHUFFLE) {
      shuffleContexts.add(event.context);
      renderShuffleButton(event.context);
    } else if (event.action === ACTION_REPEAT) {
      repeatContexts.add(event.context);
      renderRepeatButton(event.context);
    } else if (event.action === ACTION_MUTE) {
      muteContexts.add(event.context);
      renderMuteButton(event.context);
    } else if (event.action === ACTION_VISUAL_PRESET) {
      visualPresetContexts.set(event.context, visualPresetContext(event.payload?.settings));
      ensureAudioAnalyzer();
      renderVisualPreset(event.context);
    }
    return;
  }

  if (event.event === "willDisappear") {
    contexts.delete(event.context);
    playbackContexts.delete(event.context);
    shuffleContexts.delete(event.context);
    repeatContexts.delete(event.context);
    muteContexts.delete(event.context);
    if (visualPresetContexts.delete(event.context) && !visualPresetContexts.size && displayMode === "text") {
      stopAudioAnalyzer();
    }
    if (artworkContexts.delete(event.context)) renderArtworkButtons();
    return;
  }

  if (event.action === ACTION_ARTWORK && event.event === "didReceiveSettings") {
    const previous = artworkContexts.get(event.context);
    artworkContexts.set(
      event.context,
      artworkContext(
        event.payload?.settings,
        event.payload?.coordinates || previous,
        event.device || previous?.device,
      ),
    );
    renderArtworkButtons();
    return;
  }

  if (event.action === ACTION_VISUAL_PRESET && event.event === "didReceiveSettings") {
    visualPresetContexts.set(event.context, visualPresetContext(event.payload?.settings));
    ensureAudioAnalyzer();
    renderVisualPreset(event.context);
    return;
  }

  if (event.action === ACTION_MARQUEE && event.event === "didReceiveSettings") {
    const previous = contexts.get(event.context);
    if (!previous) return;
    const column = Number(event.payload?.coordinates?.column ?? previous.column);
    const role = resolveDialRole(event.payload?.settings?.role, column);
    const visualRole = resolveVisualDialRole(event.payload?.settings?.visualRole);
    contexts.set(event.context, {
      column,
      role,
      visualRole,
      device: event.device || previous.device,
      segmentCount: segmentCountForDevice(event.device || previous.device, column),
    });
    sendTriggerDescription(event.context, role, visualRole);
    return;
  }

  if (event.action === ACTION_OPEN && event.event === "keyUp") {
    launchSpotify();
    return;
  }

  if (event.action === ACTION_PLAYBACK && event.event === "keyUp") {
    queueControl(spotifyState.player?.state === "playing" ? "stop" : "play");
    return;
  }

  if (event.action === ACTION_PREVIOUS && event.event === "keyUp") {
    queueControl("previous");
    return;
  }

  if (event.action === ACTION_NEXT && event.event === "keyUp") {
    queueControl("next");
    return;
  }

  if (event.action === ACTION_SHUFFLE && event.event === "keyUp") {
    queueControl(
      "setshuffling",
      spotifyState.player?.isShuffleActive ? "false" : "true",
    );
    return;
  }

  if (event.action === ACTION_REPEAT && event.event === "keyUp") {
    queueControl(
      "setrepeating",
      spotifyState.player?.isRepeatActive ? "false" : "true",
    );
    return;
  }

  if (event.action === ACTION_MUTE && event.event === "keyUp") {
    const volume = Number(spotifyState.player?.volume || 0);
    if (volume > 0) lastAudibleVolume = volume;
    queueControl("setvolume", String(volume > 0 ? 0 : lastAudibleVolume));
    return;
  }

  if (event.action === ACTION_RESTART && event.event === "keyUp") {
    queueControl("restart");
    return;
  }

  if (event.action === ACTION_SEEK_BACK && event.event === "keyUp") {
    queueControl("skipbyseconds", "-15");
    return;
  }

  if (event.action === ACTION_SEEK_FORWARD && event.event === "keyUp") {
    queueControl("skipbyseconds", "15");
    return;
  }

  if (event.action === ACTION_VOLUME_DOWN && event.event === "keyUp") {
    queueControl("changevolume", "-5");
    return;
  }

  if (event.action === ACTION_VOLUME_UP && event.event === "keyUp") {
    queueControl("changevolume", "5");
    return;
  }

  if (event.action === ACTION_COPY_LINK && event.event === "keyUp") {
    copyCurrentTrackLink(event.context);
    return;
  }

  if (event.action === ACTION_VISUAL_PRESET && event.event === "keyDown") {
    cycleVisualPreset(event.context);
    return;
  }

  if (event.action !== ACTION_MARQUEE) return;
  const context = contexts.get(event.context);
  if (!context) return;

  if (event.event === "dialRotate") {
    const ticks = Number(event.payload?.ticks ?? 0);
    if (displayMode === "visualizer" && context.visualRole === "visual") cycleVisual(ticks);
    else if (displayMode === "visualizer") handleDialRotate(context.visualRole, ticks);
    else handleDialRotate(context.role, ticks);
  } else if (event.event === "dialUp") {
    toggleDisplayMode();
  } else if (event.event === "touchTap") {
    queueControl("playpause");
  }
}

function roleForColumn(column) {
  return ["track", "volume", "seek", "volume", "track", "volume"][column] || "volume";
}

function segmentCountForDevice(device, column = 0) {
  const deviceInfo = connectedDevices.get(device) || {};
  const deviceType = Number(deviceInfo.type);
  const keypadColumns = Number(deviceInfo.size?.columns);
  if (deviceType === 13 || keypadColumns === 9 || Number(column) >= 4) return 6;
  return 4;
}

function resolveDialRole(configuredRole, column) {
  return DIAL_ROLES.has(configuredRole) ? configuredRole : roleForColumn(column);
}

function resolveVisualDialRole(configuredRole) {
  return VISUAL_DIAL_ROLES.has(configuredRole) ? configuredRole : "visual";
}

function dialRoleDescription(role) {
  return {
    visual: "Choose visual",
    track: "Previous / Next track",
    volume: "Spotify volume",
    seek: "Seek -/+ 5 seconds",
    none: "No action",
  }[role];
}

function sendTriggerDescription(context, role, visualRole) {
  send({
    event: "setTriggerDescription",
    context,
    payload: {
      rotate: dialRoleDescription(displayMode === "visualizer" ? visualRole : role),
      push: displayMode === "visualizer" ? "Show artist and track" : "Show visualizer",
      touch: "Play / Pause",
    },
  });
}

function toggleDisplayMode() {
  displayMode = displayMode === "text" ? "visualizer" : "text";
  if (displayMode === "text") {
    if (!visualPresetContexts.size) stopAudioAnalyzer();
    hideVisualIndicator();
    resetMarquee();
  } else {
    visualPhase = 0;
    ensureAudioAnalyzer();
    showVisualIndicatorTemporarily();
  }
  for (const [context, details] of contexts) {
    sendTriggerDescription(context, details.role, details.visualRole);
  }
  renderAll();
}

function cycleVisual(ticks) {
  if (!ticks) return;
  if (!audioAnalyzerProcess && audioAnalyzerStatus === "error") ensureAudioAnalyzer();
  visualIndex = (visualIndex + (ticks > 0 ? 1 : -1) + VISUAL_COUNT) % VISUAL_COUNT;
  visualPhase = 0;
  showVisualIndicatorTemporarily();
  renderAll();
}

function showVisualIndicatorTemporarily() {
  visualIndicatorVisible = true;
  if (visualIndicatorTimer) clearTimeout(visualIndicatorTimer);
  visualIndicatorTimer = setTimeout(() => {
    visualIndicatorTimer = null;
    visualIndicatorVisible = false;
    if (displayMode === "visualizer") renderAll();
  }, VISUAL_INDICATOR_MS);
}

function hideVisualIndicator() {
  visualIndicatorVisible = false;
  if (visualIndicatorTimer) clearTimeout(visualIndicatorTimer);
  visualIndicatorTimer = null;
}

function ensureAudioAnalyzer() {
  if (AUDIO_ANALYZER_DISABLED || audioAnalyzerProcess) return;
  audioAnalyzerStatus = "starting";
  audioAnalyzerMessage = "";
  audioAnalyzerErrorCode = "";
  audioAnalyzerBuffer = "";
  resetSpectrogramHistory();
  resetWaveformHistory();
  resetTunnelHistory();
  resetStarfieldMotion();
  resetBeatEnvelope();
  resetPlasmaMotion();
  resetParticleMotion();

  if (HOST_PLATFORM === "darwin") {
    try {
      accessSync(AUDIO_ANALYZER_PATH, fsConstants.X_OK);
    } catch {
      try {
        chmodSync(AUDIO_ANALYZER_PATH, 0o755);
      } catch (error) {
        audioAnalyzerStatus = "error";
        audioAnalyzerMessage = `Unable to make the audio analyzer executable: ${error.message}`;
        audioAnalyzerErrorCode = "launch_failed";
        renderAll();
        return;
      }
    }
  }

  const child = spawn(AUDIO_ANALYZER_PATH, AUDIO_ANALYZER_ARGS, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  audioAnalyzerProcess = child;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    audioAnalyzerBuffer += chunk;
    const lines = audioAnalyzerBuffer.split("\n");
    audioAnalyzerBuffer = lines.pop() || "";
    for (const line of lines) handleAudioAnalyzerLine(line);
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    const message = chunk.trim();
    if (message) console.error("Spotify audio analyzer", message);
  });

  child.on("error", (error) => {
    if (audioAnalyzerProcess !== child) return;
    audioAnalyzerStatus = "error";
    audioAnalyzerMessage = error.message;
    audioAnalyzerErrorCode = "launch_failed";
    renderAll();
  });

  child.on("close", (code) => {
    if (audioAnalyzerProcess !== child) return;
    audioAnalyzerProcess = null;
    if (displayMode === "visualizer" && audioAnalyzerStatus !== "error") {
      audioAnalyzerStatus = "error";
      audioAnalyzerMessage = `Audio analyzer stopped (${code ?? "unknown"})`;
      audioAnalyzerErrorCode = "analyzer_stopped";
      renderAll();
    }
  });
}

function handleAudioAnalyzerLine(line) {
  if (!line.trim()) return;
  try {
    const payload = JSON.parse(line);
    if (payload.status === "ready") {
      audioAnalyzerStatus = "ready";
      renderAll();
      return;
    }
    if (payload.status === "error") {
      audioAnalyzerStatus = "error";
      audioAnalyzerMessage = String(payload.message || "Audio capture is unavailable");
      audioAnalyzerErrorCode = String(payload.code || "capture_failed");
      renderAll();
      return;
    }
    if (!Array.isArray(payload.bands) || payload.bands.length !== SPECTRUM_BANDS) return;
    const waveform = Array.isArray(payload.waveform)
      ? payload.waveform
          .slice(0, WAVEFORM_POINTS)
          .map((value) => Math.max(-1, Math.min(1, Number(value) || 0)))
      : Array(WAVEFORM_POINTS).fill(0);
    while (waveform.length < WAVEFORM_POINTS) waveform.push(0);
    const stereoLeft = signedArray(payload.stereoLeft, STEREO_POINTS);
    const stereoRight = signedArray(payload.stereoRight, STEREO_POINTS);
    const chroma = Array.isArray(payload.chroma)
      ? payload.chroma.slice(0, PITCH_CLASSES).map(normalizedNumber)
      : Array(PITCH_CLASSES).fill(0);
    while (chroma.length < PITCH_CLASSES) chroma.push(0);
    audioAnalysis = {
      bands: payload.bands.map(normalizedNumber),
      waveform,
      stereoLeft,
      stereoRight,
      stereoCorrelation: signedNumber(payload.stereoCorrelation),
      chroma,
      rms: normalizedNumber(payload.rms),
      peak: normalizedNumber(payload.peak),
      bass: normalizedNumber(payload.bass),
      mid: normalizedNumber(payload.mid),
      treble: normalizedNumber(payload.treble),
      beat: normalizedNumber(payload.beat),
      receivedAt: Date.now(),
    };
    spectrogramHistory.push([...audioAnalysis.bands]);
    if (spectrogramHistory.length > SPECTROGRAM_COLUMNS) spectrogramHistory.shift();
    waveformHistory.push([...audioAnalysis.waveform]);
    if (waveformHistory.length > WAVEFORM_HISTORY_FRAMES) waveformHistory.shift();
    capturedBeatPeak = Math.max(capturedBeatPeak, audioAnalysis.beat);
    audioAnalyzerStatus = "active";
  } catch (error) {
    console.error("Unable to parse Spotify audio analysis", error.message);
  }
}

function stopAudioAnalyzer() {
  const child = audioAnalyzerProcess;
  audioAnalyzerProcess = null;
  if (child) child.kill("SIGTERM");
  audioAnalyzerStatus = "idle";
  audioAnalyzerMessage = "";
  audioAnalyzerErrorCode = "";
  audioAnalysis = emptyAudioAnalysis();
  resetWaveformHistory();
  resetTunnelHistory();
  resetStarfieldMotion();
  resetBeatEnvelope();
  resetPlasmaMotion();
  resetParticleMotion();
}

function handleDialRotate(role, ticks) {
  if (!ticks) return;
  if (role === "track") {
    queueControl(ticks > 0 ? "next" : "previous");
  } else if (role === "volume") {
    queueControl("changevolume", String(ticks * 5));
  } else if (role === "seek") {
    queueControl("skipbyseconds", String(ticks * 5));
  }
}

function queueControl(command, ...args) {
  controlQueue = controlQueue
    .then(async () => {
      if (!spotifyState.isRunning) {
        await launchSpotify();
        await delay(900);
      }
      if (USING_WINDOWS_HELPER) {
        await execWindowsHelper(["control", command, ...args], {
          timeout: 5000,
          maxBuffer: 1024 * 1024,
        });
      } else {
        await execFileAsync(
          "osascript",
          ["-l", "JavaScript", dispatcherScript, command, ...args],
          {
            timeout: 4000,
            maxBuffer: 1024 * 1024,
          },
        );
      }
      await pollSpotify();
    })
    .catch((error) => console.error(`Spotify command ${command} failed`, error));
}

async function launchSpotify() {
  try {
    if (USING_WINDOWS_HELPER) {
      await execWindowsHelper(["launch"], { timeout: 5000 });
    } else {
      await execFileAsync("open", ["-a", "Spotify"], { timeout: 4000 });
    }
  } catch (error) {
    console.error("Unable to open Spotify", error);
  }
}

async function pollSpotify() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const { stdout } = USING_WINDOWS_HELPER
      ? await execWindowsHelper(["state"], {
          timeout: 5000,
          maxBuffer: 1024 * 1024,
        })
      : await execFileAsync("osascript", ["-l", "JavaScript", stateScript], {
          timeout: 3000,
          maxBuffer: 1024 * 1024,
        });
    const nextState = JSON.parse(stdout.trim());
    const nextTrackId = nextState.currentTrack?.id || "";
    const nextArtworkUrl = nextState.currentTrack?.artworkUrl || "";
    const previousPlaybackState = spotifyState.player?.state;
    spotifyState = nextState;
    const volume = Number(spotifyState.player?.volume || 0);
    if (volume > 0) lastAudibleVolume = volume;
    renderPlaybackButtons();
    renderShuffleButtons();
    renderRepeatButtons();
    renderMuteButtons();
    refreshArtwork(nextArtworkUrl);
    if (nextTrackId !== currentTrackId) {
      currentTrackId = nextTrackId;
      resetMarquee();
    } else if (spotifyState.player?.state !== previousPlaybackState) {
      renderAll();
    }
  } catch (error) {
    spotifyState = stoppedState();
    renderPlaybackButtons();
    renderShuffleButtons();
    renderRepeatButtons();
    renderMuteButtons();
    refreshArtwork("");
    console.error("Unable to read Spotify state", error.message);
  } finally {
    pollInFlight = false;
  }
}

function execWindowsHelper(args, options) {
  return WINDOWS_HELPER_PATH.endsWith(".mjs")
    ? execFileAsync(process.execPath, [WINDOWS_HELPER_PATH, ...args], options)
    : execFileAsync(WINDOWS_HELPER_PATH, args, options);
}

function renderShuffleButtons() {
  for (const context of shuffleContexts) renderShuffleButton(context);
}

function renderShuffleButton(context) {
  send({
    event: "setState",
    context,
    payload: { state: spotifyState.player?.isShuffleActive ? 1 : 0 },
  });
}

function renderRepeatButtons() {
  for (const context of repeatContexts) renderRepeatButton(context);
}

function renderRepeatButton(context) {
  send({
    event: "setState",
    context,
    payload: { state: spotifyState.player?.isRepeatActive ? 1 : 0 },
  });
}

function renderMuteButtons() {
  for (const context of muteContexts) renderMuteButton(context);
}

function renderMuteButton(context) {
  send({
    event: "setState",
    context,
    payload: { state: Number(spotifyState.player?.volume || 0) === 0 ? 1 : 0 },
  });
}

function renderPlaybackButtons() {
  for (const context of playbackContexts) renderPlaybackButton(context);
}

function renderPlaybackButton(context) {
  send({
    event: "setState",
    context,
    payload: { state: spotifyState.player?.state === "playing" ? 1 : 0 },
  });
}

function copyCurrentTrackLink(context) {
  const spotifyUrl = shareableSpotifyUrl(spotifyState.currentTrack?.spotifyUrl);
  if (!spotifyUrl) {
    send({ event: "showAlert", context });
    return;
  }
  const clipboard = spawn(USING_WINDOWS_HELPER ? "clip.exe" : "/usr/bin/pbcopy", [], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  clipboard.once("error", () => send({ event: "showAlert", context }));
  clipboard.once("close", (code) => {
    send({ event: code === 0 ? "showOk" : "showAlert", context });
  });
  clipboard.stdin.end(spotifyUrl);
}

function shareableSpotifyUrl(value) {
  const spotifyUrl = String(value || "").trim();
  const match = spotifyUrl.match(/^spotify:(track|episode):([a-zA-Z0-9]+)$/);
  return match ? `https://open.spotify.com/${match[1]}/${match[2]}` : spotifyUrl;
}

function visualPresetContext(settings = {}) {
  const requestedIndex = Number(settings?.visualIndex);
  return {
    visualIndex: Number.isInteger(requestedIndex)
      ? Math.max(0, Math.min(VISUAL_COUNT - 1, requestedIndex))
      : 0,
  };
}

function renderVisualPresets() {
  for (const context of visualPresetContexts.keys()) renderVisualPreset(context);
}

function renderVisualPreset(context) {
  const details = visualPresetContexts.get(context);
  if (!details) return;
  send({
    event: "setImage",
    context,
    payload: { image: svgDataUri(visualPresetSvg(details.visualIndex)) },
  });
}

function cycleVisualPreset(context) {
  const details = visualPresetContexts.get(context);
  if (!details) return;
  details.visualIndex = (details.visualIndex + 1) % VISUAL_COUNT;
  send({
    event: "setSettings",
    context,
    payload: { visualIndex: details.visualIndex },
  });
  renderVisualPreset(context);
}

function visualPresetSvg(index) {
  const focusX = index === 10 ? 300 : index === 18 ? 620 : 400;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="${focusX - 50} 0 100 100" data-visual-preset-index="${index}" data-audio-reactive="${isAudioReactive()}">
  <defs>
    <linearGradient id="visual-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#070a10"/><stop offset="0.5" stop-color="#0a0c16"/><stop offset="1" stop-color="#06080d"/></linearGradient>
    <filter id="glow" x="-30%" y="-80%" width="160%" height="260%"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect x="0" y="0" width="800" height="100" fill="url(#visual-bg)"/>
  ${visualMarkup(index, visualPhase)}
  </svg>`;
}

function renderArtworkButtons() {
  for (const [context, details] of artworkContexts) renderArtworkButton(context, details);
}

function renderArtworkButton(context, details = artworkContexts.get(context)) {
  send({
    event: "setImage",
    context,
    payload: { image: artworkImage(details) },
  });
}

function artworkContext(settings = {}, coordinates = {}, device = "") {
  const artworkLayout = settings?.artworkLayout === "quarter" ? "quarter" : "single";
  const quarter = ARTWORK_QUARTERS.has(settings?.quarter) ? settings.quarter : "auto";
  return {
    artworkLayout,
    quarter,
    column: Number(coordinates?.column ?? 0),
    row: Number(coordinates?.row ?? 0),
    device: device || coordinates?.device || "",
  };
}

function artworkImage(details) {
  const source = currentArtworkImage || svgDataUri(artworkPlaceholderSvg());
  if (details?.artworkLayout !== "quarter") return source;
  return svgDataUri(artworkQuarterSvg(source, resolveArtworkQuarter(details)));
}

function resolveArtworkQuarter(details) {
  if (details.quarter && details.quarter !== "auto") return details.quarter;
  const automaticTiles = automaticArtworkGroup(details);
  const minimumColumn = Math.min(...automaticTiles.map(({ column }) => column));
  const minimumRow = Math.min(...automaticTiles.map(({ row }) => row));
  const vertical = details.row <= minimumRow ? "top" : "bottom";
  const horizontal = details.column <= minimumColumn ? "left" : "right";
  return `${vertical}-${horizontal}`;
}

function automaticArtworkGroup(details) {
  const candidates = [...artworkContexts.values()].filter(
    (candidate) =>
      candidate.artworkLayout === "quarter" &&
      candidate.quarter === "auto" &&
      candidate.device === details.device,
  );
  const group = [];
  const pending = [details];
  const visited = new Set();
  while (pending.length) {
    const tile = pending.pop();
    const key = `${tile.column}:${tile.row}`;
    if (visited.has(key)) continue;
    visited.add(key);
    group.push(tile);
    for (const candidate of candidates) {
      const distance =
        Math.abs(candidate.column - tile.column) + Math.abs(candidate.row - tile.row);
      if (distance === 1) pending.push(candidate);
    }
  }
  return group;
}

function artworkQuarterSvg(source, quarter) {
  const [sourceX, sourceY] = {
    "top-left": [0, 0],
    "top-right": [-144, 0],
    "bottom-left": [0, -144],
    "bottom-right": [-144, -144],
  }[quarter] || [0, 0];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144" data-artwork-layout="quarter">
  <image data-artwork-quarter="${quarter}" href="${escapeXml(source)}" x="${sourceX}" y="${sourceY}" width="288" height="288" preserveAspectRatio="xMidYMid slice"/>
</svg>`;
}

function refreshArtwork(url) {
  const nextUrl = typeof url === "string" ? url.trim() : "";
  if (nextUrl !== currentArtworkUrl) {
    currentArtworkUrl = nextUrl;
    currentArtworkImage = "";
    artworkLoadingUrl = "";
    artworkRequestId += 1;
    renderArtworkButtons();
  }
  if (!nextUrl || currentArtworkImage || artworkLoadingUrl === nextUrl) return;

  let parsedUrl;
  try {
    parsedUrl = new URL(nextUrl);
  } catch {
    return;
  }
  if (!["https:", "http:", "file:"].includes(parsedUrl.protocol)) return;

  const requestId = ++artworkRequestId;
  artworkLoadingUrl = nextUrl;
  const artworkRequest = parsedUrl.protocol === "file:"
    ? readFile(parsedUrl).then((bytes) => ({ bytes, contentType: artworkMimeType(bytes) }))
    : fetch(nextUrl, { signal: AbortSignal.timeout(5000) }).then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return {
          bytes: Buffer.from(await response.arrayBuffer()),
          contentType: (response.headers.get("content-type") || "image/jpeg")
            .split(";", 1)[0]
            .trim()
            .toLowerCase(),
        };
      });
  artworkRequest
    .then(({ bytes, contentType }) => {
      if (!contentType.startsWith("image/")) throw new Error(`Unexpected ${contentType}`);
      if (bytes.byteLength > 5 * 1024 * 1024) throw new Error("Image is larger than 5 MB");
      if (requestId !== artworkRequestId || currentArtworkUrl !== nextUrl) return;
      currentArtworkImage = `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
      artworkLoadingUrl = "";
      renderArtworkButtons();
    })
    .catch((error) => {
      if (requestId !== artworkRequestId) return;
      artworkLoadingUrl = "";
      console.error("Unable to load Spotify artwork", error.message);
    });
}

function artworkMimeType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (bytes.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  return "image/jpeg";
}

function artworkPlaceholderSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="20" fill="#090b0a"/>
  <circle cx="72" cy="72" r="47" fill="#171d19" stroke="#1ed760" stroke-width="4"/>
  <circle cx="72" cy="72" r="12" fill="#1ed760"/>
  <circle cx="72" cy="72" r="5" fill="#090b0a"/>
</svg>`;
}

function svgDataUri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function resetMarquee() {
  const message = marqueeMessage();
  messageWidth = Math.max(360, Array.from(message).length * 11.5);
  scrollX = DISPLAY_WIDTH + 16;
  renderAll();
}

function animate() {
  if (!contexts.size && !visualPresetContexts.size) return;
  const visualsVisible = displayMode === "visualizer" || visualPresetContexts.size > 0;
  let visualsAdvanced = false;
  if (visualsVisible) {
    const reactive = isAudioReactive();
    const shouldAdvance =
      reactive || spotifyState.player?.state === "playing" || audioAnalyzerStatus === "starting";
    if (shouldAdvance) {
      animationFrame += 1;
      updateBeatEnvelope();
      visualPhase += reactive ? 0.08 + audioAnalysis.rms * 0.54 + visualBeat * 0.2 : 0.08;
      updateTunnelHistory();
      updateStarfieldMotion(reactive);
      updatePlasmaMotion(reactive);
      updateParticleMotion(reactive);
      if (
        visualIndex === 0 ||
        [...visualPresetContexts.values()].some((details) => details.visualIndex === 0)
      ) {
        updateSpectrumLevels();
      }
      visualsAdvanced = true;
    }
    if (visualPresetContexts.size && visualsAdvanced) renderVisualPresets();
  }
  if (displayMode === "visualizer") {
    if (visualsAdvanced) renderAll();
    return;
  }
  if (!contexts.size) return;
  scrollX -= SCROLL_STEP;
  if (scrollX < -messageWidth - 40) scrollX = DISPLAY_WIDTH + 16;
  renderAll();
}

function renderAll() {
  for (const [context, details] of contexts) renderContext(context, details);
}

function renderContext(context, details) {
  const svg = createSegmentSvg(details);
  const image = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  send({ event: "setFeedback", context, payload: { canvas: image } });
}

function createSegmentSvg(details) {
  if (displayMode === "visualizer") return createVisualizerSegmentSvg(details);

  const { column, segmentCount, transform } = segmentTransform(details);
  const progress = Math.max(
    0,
    Math.min(100, Number(spotifyState.currentTrack?.positionPercent || 0)),
  );
  const message = escapeXml(marqueeMessage());

  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100" data-segment-column="${column}" data-segment-count="${segmentCount}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#101411"/>
      <stop offset="1" stop-color="#050706"/>
    </linearGradient>
  </defs>
  <g transform="${transform}">
  <rect x="0" y="0" width="800" height="100" fill="url(#bg)"/>
  <text x="${Math.round(scrollX)}" y="61" fill="#ffffff" font-family="Helvetica Neue, Arial, sans-serif" font-size="25" font-weight="600">${message}</text>
  <rect x="0" y="94" width="800" height="6" fill="#172019"/>
  <rect x="0" y="94" width="${Math.round(progress * 8)}" height="6" fill="#1ed760"/>
  </g>
</svg>`;
}

function createVisualizerSegmentSvg(details) {
  const { column, segmentCount, transform } = segmentTransform(details);
  const reactive = isAudioReactive();
  const indicator = visualIndicatorVisible
    ? `<rect x="0" y="88" width="800" height="12" fill="#05070a" opacity="0.6"/>
  ${Array.from({ length: VISUAL_COUNT }, (_, index) => {
    const active = index === visualIndex;
    const indicatorX = 400 + (index - (VISUAL_COUNT - 1) / 2) * 10;
    return `<circle data-visual-indicator="true" cx="${indicatorX}" cy="93" r="${active ? 2.8 : 1.7}" fill="${active ? "#ffffff" : "#63706a"}" opacity="${active ? 0.95 : 0.55}"/>`;
  }).join("")}`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100" data-audio-reactive="${reactive}" data-visual-index="${visualIndex}" data-segment-column="${column}" data-segment-count="${segmentCount}">
  <defs>
    <linearGradient id="visual-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#070a10"/>
      <stop offset="0.5" stop-color="#0a0c16"/>
      <stop offset="1" stop-color="#06080d"/>
    </linearGradient>
    <filter id="glow" x="-30%" y="-80%" width="160%" height="260%">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <g transform="${transform}">
  <rect x="0" y="0" width="800" height="100" fill="url(#visual-bg)"/>
  ${visualMarkup(visualIndex, visualPhase)}
  ${audioStatusMarkup()}
  ${indicator}
  </g>
</svg>`;
}

function segmentTransform(details = {}) {
  const segmentCount = Number(details.segmentCount) === 6 ? 6 : 4;
  const column = Math.max(0, Math.min(segmentCount - 1, Number(details.column) || 0));
  const horizontalScale = segmentCount / 4;
  return {
    column,
    segmentCount,
    transform: `matrix(${horizontalScale} 0 0 1 ${-column * SEGMENT_WIDTH} 0)`,
  };
}

function visualMarkup(index, phase) {
  if (index === 0) return spectrumAnalyzer();
  if (index === 1) return waveformLines();
  if (index === 2) return laserTunnel();
  if (index === 3) return starfield();
  if (index === 4) return plasmaClouds();
  if (index === 5) return kaleidoscopePetals(phase);
  if (index === 6) return spectrumHalo(phase);
  if (index === 7) return spectrumTerrain();
  if (index === 8) return spectrogramWaterfall();
  if (index === 9) return particleFountain();
  if (index === 10) return stereoVectorscope();
  if (index === 11) return lightningStorm();
  if (index === 12) return cymaticRipplePool(phase);
  if (index === 13) return dnaHelix(phase);
  if (index === 14) return pitchConstellation();
  if (index === 15) return digitalRain(phase);
  if (index === 16) return outrunHighway(phase);
  if (index === 17) return neonCityCruise(phase);
  return miamiNightRun(phase);
}

function updateSpectrumLevels() {
  for (let band = 0; band < SPECTRUM_BANDS; band += 1) {
    const audioLevel = isAudioReactive() ? audioAnalysis.bands[band] : 0;
    spectrumTargets[band] = Math.min(
      SPECTRUM_BLOCKS,
      Math.pow(audioLevel, 0.72) * SPECTRUM_BLOCKS,
    );

    const current = spectrumLevels[band];
    const target = spectrumTargets[band];
    const response = target > current ? 0.78 : 0.26;
    spectrumLevels[band] += (target - current) * response;

    if (spectrumLevels[band] >= spectrumPeaks[band]) {
      spectrumPeaks[band] = spectrumLevels[band];
      spectrumPeakHolds[band] = 5;
    } else if (spectrumPeakHolds[band] > 0) {
      spectrumPeakHolds[band] -= 1;
    } else {
      spectrumPeaks[band] = Math.max(spectrumLevels[band], spectrumPeaks[band] - 0.48);
    }
  }
}

function spectrumAnalyzer() {
  const blocks = [];
  const levelColors = [
    "#21e6c1",
    "#31f5d0",
    "#57ef9b",
    "#8af06c",
    "#d5eb55",
    "#ffe45e",
    "#ffb347",
    "#ff7a45",
    "#ff466d",
    "#ff3f88",
    "#f250b5",
    "#df63e8",
  ];

  for (let column = 0; column < SPECTRUM_BANDS; column += 1) {
    const band = column;
    const blockCount = Math.max(
      0,
      Math.min(SPECTRUM_BLOCKS, Math.round(spectrumLevels[band])),
    );
    for (let block = 0; block < blockCount; block += 1) {
      blocks.push(
        `<rect data-band="${band}" data-spectrum-layout="low-mid-high" x="${column * 20 + 3}" y="${91 - block * 8}" width="14" height="6" rx="1.5" fill="${levelColors[block]}" opacity="0.96"/>`,
      );
    }

    const peakBlock = Math.max(
      0,
      Math.min(SPECTRUM_BLOCKS, Math.round(spectrumPeaks[band])),
    );
    const markerY = peakBlock > 0 ? 96 - peakBlock * 8 : 98;
    blocks.push(
      `<rect data-band="${band}" data-spectrum-layout="low-mid-high" data-peak-marker="true" x="${column * 20 + 3}" y="${markerY}" width="14" height="2" rx="1" fill="#ffffff" opacity="${peakBlock > 0 ? 0.82 : 0.48}"/>`,
    );
  }
  return blocks.join("");
}

function waveformLines() {
  const colors = ["#6328a8", "#8d3bd1", "#b94ff0", "#579cff", "#31f5d0"];
  const opacities = [0.1, 0.16, 0.24, 0.4, 0.96];
  const widths = [1, 1.1, 1.25, 1.55, 2.35];
  const oscilloscopeHistory = waveformHistory.slice(-OSCILLOSCOPE_TRAILS);
  const grid = `<g data-oscilloscope-grid="true" stroke="#90a8c8" fill="none">
    <line x1="0" y1="25" x2="800" y2="25" opacity="0.07"/>
    <line x1="0" y1="50" x2="800" y2="50" opacity="0.18"/>
    <line x1="0" y1="75" x2="800" y2="75" opacity="0.07"/>
    ${[100, 200, 300, 400, 500, 600, 700]
      .map((x) => `<line x1="${x}" y1="0" x2="${x}" y2="100" opacity="0.055"/>`)
      .join("")}
  </g>`;
  const traces = oscilloscopeHistory
    .map((waveform, age) => {
      const points = waveform.map((sample, index) => {
        const x = (index / (WAVEFORM_POINTS - 1)) * DISPLAY_WIDTH;
        const y = 50 - sample * 44;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
      const glow = age >= OSCILLOSCOPE_TRAILS - 2 ? ' filter="url(#glow)"' : "";
      return `<polyline data-reacts-to="triggered-waveform" data-persistence-age="${OSCILLOSCOPE_TRAILS - 1 - age}" points="${points.join(" ")}" fill="none" stroke="${colors[age]}" stroke-width="${widths[age]}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacities[age]}"${glow}/>`;
    })
    .join("");
  return `${grid}${traces}`;
}

function laserTunnel() {
  // Stream Deck's Windows SVG rasteriser can stall on Gaussian filters applied
  // to transformed polygons. Keep the geometry reactive there, but render its
  // glow as a crisp neon stroke rather than blocking the plugin WebSocket.
  const glow = HOST_PLATFORM === "win32" ? "" : ' filter="url(#glow)"';
  return tunnelHistory
    .map((frame, index) => {
      const age = TUNNEL_RINGS - 1 - index;
      const depth = age / (TUNNEL_RINGS - 1);
      const eased = depth * depth;
      const energy = (frame.bass + frame.mid + frame.treble + frame.rms) / 4;
      const previousFrame = tunnelHistory[Math.max(0, index - 1)];
      const midChange = frame.mid - previousFrame.mid;
      const width =
        44 + eased * 736 + frame.bass * (18 + eased * 34) + frame.beat * (14 + eased * 42);
      const height =
        10 + eased * 82 + frame.bass * (5 + eased * 7) + frame.beat * (3 + eased * 7);
      const centerX = 400 + midChange * 44 * (1 - eased);
      const centerY = 50 + midChange * 7 * (1 - eased);
      const skew = midChange * 16 * (1 - eased);
      const radiusX = width / 2;
      const radiusY = height / 2;
      const points = [
        `${(centerX - radiusX + skew).toFixed(1)},${(centerY - radiusY).toFixed(1)}`,
        `${(centerX + radiusX + skew).toFixed(1)},${(centerY - radiusY).toFixed(1)}`,
        `${(centerX + radiusX - skew).toFixed(1)},${(centerY + radiusY).toFixed(1)}`,
        `${(centerX - radiusX - skew).toFixed(1)},${(centerY + radiusY).toFixed(1)}`,
      ];

      const spectralCentroid = weightedCentroid(frame.zones);
      const dominantFrequency = dominantFrequencyPosition(frame.zones);
      const colourPosition = dominantFrequency * 0.72 + spectralCentroid * 0.28;
      const hue = Math.round(155 + colourPosition * 205 + frame.beat * 12) % 360;
      const lightness = Math.min(82, 54 + frame.treble * 18 + frame.beat * 12);
      const strokeColor = hslToHex(hue, 96, lightness);
      const silent = energy < 0.012 && frame.beat < 0.01;
      const opacity = silent
        ? age === 0
          ? 0.22
          : 0.012
        : Math.min(1, 0.12 + energy * 0.72 + depth * 0.15 + frame.beat * 0.25);
      const strokeWidth = 1 + depth * 2.2 + frame.treble * 1.8 + frame.beat * 1.8;

      return `<polygon data-reacts-to="frequency-tunnel" data-shape="rectangle" data-history-age="${age}" data-bass="${frame.bass.toFixed(3)}" data-mid="${frame.mid.toFixed(3)}" data-treble="${frame.treble.toFixed(3)}" data-beat="${frame.beat.toFixed(3)}" points="${points.join(" ")}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth.toFixed(2)}" stroke-linecap="square" stroke-linejoin="miter" opacity="${opacity.toFixed(3)}"${glow}/>`;
    })
    .join("");
}

function starfield() {
  const stars = [];
  const reactive = isAudioReactive();
  const rms = reactive ? audioAnalysis.rms : 0;
  const bass = reactive ? audioAnalysis.bass : 0;
  const mid = reactive ? audioAnalysis.mid : 0;
  const treble = isAudioReactive() ? audioAnalysis.treble : 0;
  const visibleThreshold = Math.min(1, 0.24 + rms * 0.48 + mid * 0.2 + starfieldBurst * 0.28);
  const extentX = 420 + mid * 28;
  const extentY = 47 + mid * 8;
  for (let index = 0; index < 76; index += 1) {
    if (stableRandom(index * 61 + 13) > visibleThreshold) continue;
    const angle = stableRandom(index * 17 + 3) * Math.PI * 2;
    const individualSpeed = 0.72 + stableRandom(index * 29 + 5) * 0.56;
    const progress = (stableRandom(index * 43 + 9) + starfieldTravel * individualSpeed) % 1;
    const trailLength =
      0.0025 + rms * 0.014 + treble * 0.072 + starfieldBurst * 0.12;
    const previousProgress = Math.max(0, progress - trailLength);
    const radius = progress * progress;
    const previousRadius = previousProgress * previousProgress;
    const x = 400 + Math.cos(angle) * radius * extentX;
    const y = 50 + Math.sin(angle) * radius * extentY;
    const previousX = 400 + Math.cos(angle) * previousRadius * extentX;
    const previousY = 50 + Math.sin(angle) * previousRadius * extentY;
    const color = VISUAL_PALETTE[index % VISUAL_PALETTE.length];
    const opacity = Math.min(
      1,
      0.08 + progress * 0.42 + rms * 0.2 + mid * 0.12 + treble * 0.22 + starfieldBurst * 0.3,
    );
    const glow = opacity > 0.68 ? ' filter="url(#glow)"' : "";
    stars.push(
      `<line data-star="${index}" x1="${previousX.toFixed(1)}" y1="${previousY.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${color}" stroke-width="${(0.7 + progress * 2.8 + treble * 1.6 + starfieldBurst * 1.1).toFixed(1)}" stroke-linecap="round" opacity="${opacity.toFixed(2)}"${glow}/>` ,
    );
  }
  const flareOpacity = Math.min(0.85, starfieldBurst * 0.72 + bass * starfieldBurst * 0.25);
  const flare = flareOpacity > 0.01
    ? `<circle data-hyperspace-flare="true" cx="400" cy="50" r="${(2 + starfieldBurst * 8).toFixed(1)}" fill="#ffffff" opacity="${flareOpacity.toFixed(2)}" filter="url(#glow)"/>`
    : "";
  return `<g data-reacts-to="audio-warp-starfield" data-starfield-center="400,50" data-starfield-speed="${starfieldSpeed.toFixed(4)}" data-starfield-burst="${starfieldBurst.toFixed(3)}" data-visible-stars="${stars.length}">${stars.join("")}${flare}</g>`;
}

function plasmaClouds() {
  const reactive = isAudioReactive();
  const bands = reactive ? audioAnalysis.bands : Array(SPECTRUM_BANDS).fill(0);
  const zones = compressBands(bands, 12);
  const bass = reactive ? audioAnalysis.bass : 0;
  const mid = reactive ? audioAnalysis.mid : 0;
  const treble = reactive ? audioAnalysis.treble : 0;
  const rms = reactive ? audioAnalysis.rms : 0;
  const gradients = [];
  const clouds = [];

  for (let index = 0; index < zones.length; index += 1) {
    const frequencyPosition = index / (zones.length - 1);
    const level = zones[index];
    const lowWeight = 1 - frequencyPosition;
    const hue = 162 + frequencyPosition * 188 + visualBeat * 18;
    const lightness = 50 + level * 20 + treble * frequencyPosition * 8 + visualBeat * 7;
    const color = hslToHex(hue, 92, Math.min(78, lightness));
    const x =
      400 +
      Math.sin(plasmaFlow * (0.82 + frequencyPosition * 0.46) + index * 1.71) *
        (350 + mid * 38);
    const y =
      50 +
      Math.cos(plasmaFlow * (0.68 + frequencyPosition * 0.58) + index * 1.13) *
        (31 + mid * 15);
    const radiusX =
      (78 + stableRandom(index * 19 + 2) * 112) * (1 - frequencyPosition * 0.34) +
      bass * lowWeight * 76 +
      level * 62 +
      visualBeat * (24 + lowWeight * 32);
    const radiusY =
      (18 + stableRandom(index * 23 + 4) * 30) * (1 - frequencyPosition * 0.42) +
      mid * 15 +
      level * 15 +
      treble * frequencyPosition * 5 +
      visualBeat * 8;
    const coreOpacity = Math.min(0.96, 0.34 + level * 0.48 + visualBeat * 0.18);
    const opacity = Math.min(
      0.9,
      0.025 + rms * 0.24 + level * 0.42 + treble * frequencyPosition * 0.1 + visualBeat * 0.12,
    );
    gradients.push(
      `<radialGradient id="plasma-${index}"><stop offset="0" stop-color="${color}" stop-opacity="${coreOpacity.toFixed(2)}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`,
    );
    clouds.push(
      `<ellipse data-plasma-band-zone="${index}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="${radiusX.toFixed(1)}" ry="${radiusY.toFixed(1)}" fill="url(#plasma-${index})" opacity="${opacity.toFixed(3)}" style="mix-blend-mode:screen"/>`,
    );
  }

  return `<defs>${gradients.join("")}</defs><g data-reacts-to="spectrum-plasma" data-plasma-energy="${rms.toFixed(3)}" data-plasma-beat="${visualBeat.toFixed(3)}" data-plasma-zones="${zones.length}">${clouds.join("")}</g>`;
}

function kaleidoscopePetals(phase) {
  const shapes = [];
  const centers = [145, 400, 655];
  const reactive = isAudioReactive();
  const beat = reactive ? visualBeat : 0;
  const mid = reactive ? audioAnalysis.mid : 0;
  const rms = reactive ? audioAnalysis.rms : 0;

  for (let centerIndex = 0; centerIndex < centers.length; centerIndex += 1) {
    const centerX = centers[centerIndex];
    for (let ring = 0; ring < 2; ring += 1) {
      for (let petal = 0; petal < 10; petal += 1) {
        const band = ring * 20 + petal * 2;
        const level = reactive
          ? averageValues(audioAnalysis.bands.slice(band, band + 2))
          : 0;
        const direction = ring === 0 ? 1 : -1;
        const angle =
          (petal / 10) * Math.PI * 2 + direction * phase * (0.16 + ring * 0.07);
        const innerRadius = 5 + ring * 10;
        const outerRadius = 13 + ring * 6 + level * 21 + beat * 7;
        const spread = 0.17 + mid * 0.08;
        const point = (radius, pointAngle) =>
          `${(centerX + Math.cos(pointAngle) * radius * 2.15).toFixed(1)},${(50 + Math.sin(pointAngle) * radius).toFixed(1)}`;
        const points = [
          point(innerRadius, angle - spread),
          point(outerRadius, angle),
          point(innerRadius, angle + spread),
          `${centerX},50`,
        ].join(" ");
        const color = VISUAL_PALETTE[(petal + ring * 2 + centerIndex) % VISUAL_PALETTE.length];
        shapes.push(
          `<polygon data-reacts-to="kaleidoscope-bands" data-band-start="${band}" points="${points}" fill="${color}" opacity="${Math.min(0.9, 0.06 + level * 0.68 + beat * 0.16).toFixed(2)}" filter="url(#glow)"/>`,
        );
      }
    }
    shapes.push(
      `<ellipse cx="${centerX}" cy="50" rx="${(7 + beat * 6).toFixed(1)}" ry="${(3.5 + beat * 3).toFixed(1)}" fill="#ffffff" opacity="${Math.min(0.92, 0.14 + rms * 0.5 + beat * 0.28).toFixed(2)}"/>`,
    );
  }
  return `<g data-kaleidoscope-energy="${rms.toFixed(3)}" data-kaleidoscope-beat="${beat.toFixed(3)}">${shapes.join("")}</g>`;
}

function spectrumHalo(phase) {
  const lines = [];
  const reactive = isAudioReactive();
  const beat = reactive ? visualBeat : 0;
  const rms = reactive ? audioAnalysis.rms : 0;
  for (let band = 0; band < SPECTRUM_BANDS; band += 1) {
    const level = reactive ? audioAnalysis.bands[band] : 0;
    const angle = (band / SPECTRUM_BANDS) * Math.PI * 2 + phase * 0.035;
    const innerXRadius = 118;
    const innerYRadius = 23;
    const outerXRadius = innerXRadius + 22 + level * 72 + beat * 16;
    const outerYRadius = innerYRadius + 7 + level * 19 + beat * 5;
    const x1 = 400 + Math.cos(angle) * innerXRadius;
    const y1 = 50 + Math.sin(angle) * innerYRadius;
    const x2 = 400 + Math.cos(angle) * outerXRadius;
    const y2 = 50 + Math.sin(angle) * outerYRadius;
    lines.push(
      `<line data-reacts-to="frequency-halo" data-band="${band}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${VISUAL_PALETTE[band % VISUAL_PALETTE.length]}" stroke-width="${(1.5 + level * 3.2 + beat).toFixed(1)}" stroke-linecap="round" opacity="${Math.min(0.98, 0.16 + level * 0.76 + beat * 0.08).toFixed(2)}" filter="url(#glow)"/>`,
    );
  }
  return `<g data-halo-energy="${rms.toFixed(3)}" data-halo-beat="${beat.toFixed(3)}"><ellipse cx="400" cy="50" rx="112" ry="21" fill="#070a10" stroke="#516078" stroke-width="1" opacity="0.9"/>${lines.join("")}</g>`;
}

function spectrumTerrain() {
  const ridgeFrames = Array.from({ length: TERRAIN_RIDGES }, (_, index) => {
    const age = Math.round(
      ((TERRAIN_RIDGES - 1 - index) / (TERRAIN_RIDGES - 1)) *
        (spectrogramHistory.length - 1),
    );
    return spectrogramHistory[spectrogramHistory.length - 1 - age] ||
      Array(SPECTRUM_BANDS).fill(0);
  });
  const energy = averageValues(ridgeFrames[ridgeFrames.length - 1]);
  const ridges = ridgeFrames.map((frame, index) => {
    const depth = index / (TERRAIN_RIDGES - 1);
    const perspective = 0.22 + depth * 0.78;
    const baselineY = 15 + Math.pow(depth, 1.45) * 81;
    const amplitude = 4 + Math.pow(depth, 1.15) * 31;
    const points = frame.map((level, band) => {
      const fullWidthX = (band / (SPECTRUM_BANDS - 1)) * DISPLAY_WIDTH;
      const x = 400 + (fullWidthX - 400) * perspective;
      const y = baselineY - Math.pow(level, 0.76) * amplitude;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const firstX = 400 - 400 * perspective;
    const lastX = 400 + 400 * perspective;
    const fillPoints = [
      `${firstX.toFixed(1)},${baselineY.toFixed(1)}`,
      ...points,
      `${lastX.toFixed(1)},${baselineY.toFixed(1)}`,
    ].join(" ");
    const glow = depth > 0.7 ? ' filter="url(#glow)"' : "";
    return `<polygon data-terrain-fill="${index}" points="${fillPoints}" fill="#071018" opacity="${(0.4 + depth * 0.3).toFixed(2)}"/><polyline data-reacts-to="spectrum-terrain" data-terrain-ridge="${index}" data-frequency-axis="low-left-high-right" points="${points.join(" ")}" fill="none" stroke="url(#terrain-line)" stroke-width="${(0.75 + depth * 1.75).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" opacity="${(0.22 + depth * 0.72).toFixed(2)}"${glow}/>`;
  });
  const perspectiveGrid = [-400, -300, -200, -100, 0, 100, 200, 300, 400]
    .map(
      (bottomX) =>
        `<line x1="400" y1="15" x2="${400 + bottomX}" y2="100" stroke="#315574" stroke-width="0.7" opacity="0.16"/>`,
    )
    .join("");
  const longitudeBands = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 39];
  const longitudes = longitudeBands.map((band) => {
    const points = ridgeFrames.map((frame, index) => {
      const depth = index / (TERRAIN_RIDGES - 1);
      const perspective = 0.22 + depth * 0.78;
      const baselineY = 15 + Math.pow(depth, 1.45) * 81;
      const amplitude = 4 + Math.pow(depth, 1.15) * 31;
      const fullWidthX = (band / (SPECTRUM_BANDS - 1)) * DISPLAY_WIDTH;
      const x = 400 + (fullWidthX - 400) * perspective;
      const y = baselineY - Math.pow(frame[band] || 0, 0.76) * amplitude;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return `<polyline data-terrain-longitude="${band}" points="${points.join(" ")}" fill="none" stroke="#6589a8" stroke-width="0.65" opacity="0.26"/>`;
  }).join("");
  return `<defs><linearGradient id="terrain-line" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#31f5d0"/><stop offset="0.52" stop-color="#9c6cff"/><stop offset="1" stop-color="#ff5ca8"/></linearGradient></defs><g data-terrain-source="frequency-history" data-terrain-energy="${energy.toFixed(3)}" data-terrain-ridges="${TERRAIN_RIDGES}">${perspectiveGrid}<line x1="312" y1="15" x2="488" y2="15" stroke="#52a8ff" stroke-width="1" opacity="0.4"/>${ridges.join("")}${longitudes}</g>`;
}

function spectrogramWaterfall() {
  const cells = [];
  const rowCount = 16;
  const rowHeight = 100 / rowCount;
  const columnWidth = DISPLAY_WIDTH / (SPECTROGRAM_COLUMNS * 2);

  for (let age = 0; age < SPECTROGRAM_COLUMNS; age += 1) {
    const frame = spectrogramHistory[spectrogramHistory.length - 1 - age];
    if (!frame) continue;
    const ageFade = 1 - age / (SPECTROGRAM_COLUMNS + 6);
    for (let row = 0; row < rowCount; row += 1) {
      const bandStart = Math.floor((row / rowCount) * SPECTRUM_BANDS);
      const bandEnd = Math.max(
        bandStart + 1,
        Math.floor(((row + 1) / rowCount) * SPECTRUM_BANDS),
      );
      const level = Math.max(...frame.slice(bandStart, bandEnd));
      if (level < 0.025) continue;
      const hue = Math.round(275 - level * 235 + row * 1.8);
      const lightness = Math.round(27 + level * 42);
      const opacity = Math.min(0.98, (0.08 + level * 0.94) * ageFade);
      const y = 100 - (row + 1) * rowHeight;
      const leftX = 400 - (age + 1) * columnWidth;
      const color = hslToHex(hue, 95, lightness);
      cells.push(
        `<rect data-reacts-to="center-frequency-history" data-frequency-axis="low-bottom-high-top" x="${leftX.toFixed(1)}" y="${y.toFixed(1)}" width="${(columnWidth + 0.35).toFixed(1)}" height="${(rowHeight + 0.25).toFixed(1)}" fill="${color}" opacity="${opacity.toFixed(2)}"/>`,
      );
    }
  }
  const history = cells.join("");
  return `<defs><g id="spectrogram-half">${history}</g></defs><use href="#spectrogram-half"/><use href="#spectrogram-half" transform="translate(800 0) scale(-1 1)"/><line data-spectrogram-origin="center" x1="400" y1="0" x2="400" y2="100" stroke="#ffffff" stroke-width="1" opacity="0.55"/>`;
}

function particleFountain() {
  const particles = [];
  const reactive = isAudioReactive();
  const beat = reactive ? visualBeat : 0;
  const rms = reactive ? audioAnalysis.rms : 0;
  const bass = reactive ? audioAnalysis.bass : 0;
  const mid = reactive ? audioAnalysis.mid : 0;
  const treble = reactive ? audioAnalysis.treble : 0;
  const emitters = [190, 400, 610];

  for (let index = 0; index < 84; index += 1) {
    const band = (index * 7) % SPECTRUM_BANDS;
    const level = reactive ? audioAnalysis.bands[band] : 0;
    if (level < 0.025 && beat < 0.04 && stableRandom(index * 67 + 17) > 0.12) continue;
    const individualSpeed = 0.72 + stableRandom(index * 31 + 5) * 0.58;
    const age = (stableRandom(index * 43 + 9) + particleTravel * individualSpeed) % 1;
    const direction = stableRandom(index * 59 + 13) * 2 - 1;
    const emitterX = emitters[index % emitters.length];
    const response = Math.pow(level, 0.78);
    const spread = 48 + response * 92 + mid * 34;
    const height = 12 + response * 58 + bass * 10 + beat * 12;
    const x = emitterX + direction * age * spread + Math.sin(age * 12 + index) * mid * 8;
    const y = 96 - Math.sin(age * Math.PI) * height + age * 3;
    const previousAge = Math.max(0, age - 0.018 - treble * 0.03 - beat * 0.024);
    const previousX =
      emitterX + direction * previousAge * spread + Math.sin(previousAge * 12 + index) * mid * 8;
    const previousY = 96 - Math.sin(previousAge * Math.PI) * height + previousAge * 3;
    const color = hslToHex(160 + (band / (SPECTRUM_BANDS - 1)) * 190 + beat * 14, 94, 58 + treble * 12);
    const opacity = Math.max(0.025, (1 - age) * (0.08 + response * 0.72 + beat * 0.2));
    particles.push(
      `<line data-particle-band="${band}" x1="${previousX.toFixed(1)}" y1="${previousY.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${color}" stroke-width="${(0.8 + response * 2.5 + treble * 0.5).toFixed(1)}" stroke-linecap="round" opacity="${opacity.toFixed(2)}"/>`,
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.65 + response * 2.1 + treble * 0.45 + beat * 0.7).toFixed(1)}" fill="${color}" opacity="${Math.min(1, opacity + 0.1 + treble * 0.08).toFixed(2)}" filter="url(#glow)"/>`,
    );
  }
  const emitterFlares = emitters.map(
    (x) => `<ellipse cx="${x}" cy="96" rx="${(4 + bass * 6 + beat * 9).toFixed(1)}" ry="${(1.2 + beat * 2).toFixed(1)}" fill="#ffffff" opacity="${Math.min(0.85, 0.08 + rms * 0.24 + beat * 0.45).toFixed(2)}" filter="url(#glow)"/>`,
  ).join("");
  return `<g data-reacts-to="frequency-particle-fountain" data-fountain-energy="${rms.toFixed(3)}" data-fountain-beat="${beat.toFixed(3)}" data-visible-particles="${particles.length / 2}">${particles.join("")}${emitterFlares}</g>`;
}

function stereoVectorscope() {
  const reactive = isAudioReactive();
  const rms = reactive ? audioAnalysis.rms : 0;
  const correlation = reactive ? audioAnalysis.stereoCorrelation : 0;
  const panelCount = 4;
  const samplesPerPanel = Math.floor(STEREO_POINTS / panelCount);
  const panels = [];

  for (let panel = 0; panel < panelCount; panel += 1) {
    const centerX = 100 + panel * 200;
    const start = panel * samplesPerPanel;
    const end = Math.min(STEREO_POINTS, start + samplesPerPanel);
    const points = [];
    for (let sample = start; sample < end; sample += 1) {
      const left = reactive ? audioAnalysis.stereoLeft[sample] : 0;
      const right = reactive ? audioAnalysis.stereoRight[sample] : 0;
      points.push(`${(centerX + left * 42).toFixed(1)},${(50 - right * 42).toFixed(1)}`);
    }
    const color = VISUAL_PALETTE[panel % VISUAL_PALETTE.length];
    const traceOpacity = reactive ? Math.min(0.98, 0.34 + rms * 0.7) : 0.08;
    panels.push(
      `<g data-scope-panel="${panel}">
        <circle cx="${centerX}" cy="50" r="43" fill="#05090d" stroke="#547087" stroke-width="1" opacity="0.72"/>
        <circle cx="${centerX}" cy="50" r="28" fill="none" stroke="#8ca6b8" stroke-width="0.6" opacity="0.12"/>
        <line x1="${centerX - 43}" y1="50" x2="${centerX + 43}" y2="50" stroke="#8ca6b8" stroke-width="0.6" opacity="0.14"/>
        <line x1="${centerX}" y1="7" x2="${centerX}" y2="93" stroke="#8ca6b8" stroke-width="0.6" opacity="0.14"/>
        <polyline data-reacts-to="stereo-vectorscope" data-stereo-source="left-x-right-y" data-scope-samples="${points.length}" points="${points.join(" ")}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity="${(traceOpacity * 0.15).toFixed(2)}"/>
        <polyline data-reacts-to="stereo-vectorscope" data-stereo-source="left-x-right-y" data-scope-samples="${points.length}" points="${points.join(" ")}" fill="none" stroke="${color}" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" opacity="${traceOpacity.toFixed(2)}" filter="url(#glow)"/>
      </g>`,
    );
  }

  return `<g data-vectorscope-correlation="${correlation.toFixed(3)}" data-vectorscope-energy="${rms.toFixed(3)}" data-vectorscope-panels="${panelCount}">${panels.join("")}</g>`;
}

function lightningStorm() {
  const reactive = isAudioReactive();
  const rms = reactive ? audioAnalysis.rms : 0;
  const bass = reactive ? audioAnalysis.bass : 0;
  const mid = reactive ? audioAnalysis.mid : 0;
  const treble = reactive ? audioAnalysis.treble : 0;
  const beat = reactive ? visualBeat : 0;
  const strikeFrame = Math.floor(animationFrame / 2);
  const pointCount = 41;
  const boltPoints = [];

  for (let point = 0; point < pointCount; point += 1) {
    const band = Math.min(SPECTRUM_BANDS - 1, point);
    const level = reactive ? audioAnalysis.bands[band] : 0;
    const x = (point / (pointCount - 1)) * DISPLAY_WIDTH;
    const jagged = stableRandom(strikeFrame * 131 + point * 43 + 7) * 2 - 1;
    const broadBend = Math.sin(point * 0.48 + visualPhase * 0.55) * mid * 13;
    const y = 50 + broadBend + jagged * (2 + level * 17 + mid * 6) + Math.sin(point * 0.16) * bass * 5;
    boltPoints.push({ x, y, band, level });
  }

  const branches = [];
  for (let branch = 0; branch < 10; branch += 1) {
    const pointIndex = 3 + branch * 4;
    const source = boltPoints[Math.min(pointCount - 2, pointIndex)];
    const highBand = 30 + (branch % 10);
    const highLevel = reactive ? audioAnalysis.bands[highBand] : 0;
    if (highLevel < 0.08 && beat < 0.1) continue;
    const direction = stableRandom(strikeFrame * 89 + branch * 23) > 0.5 ? 1 : -1;
    const length = 10 + highLevel * 34 + treble * 16 + beat * 12;
    const endX = source.x + (stableRandom(branch * 71 + strikeFrame) * 18 - 4);
    const endY = source.y + direction * length;
    const middleX = (source.x + endX) / 2 + (stableRandom(branch * 47 + 5) - 0.5) * 10;
    const middleY = (source.y + endY) / 2;
    branches.push(
      `<polyline data-lightning-branch-band="${highBand}" points="${source.x.toFixed(1)},${source.y.toFixed(1)} ${middleX.toFixed(1)},${middleY.toFixed(1)} ${endX.toFixed(1)},${endY.toFixed(1)}" fill="none" stroke="${hslToHex(194 + branch * 8, 96, 65 + highLevel * 18)}" stroke-width="${(0.55 + highLevel * 1.25 + beat * 0.7).toFixed(2)}" opacity="${Math.min(0.92, 0.12 + highLevel * 0.68 + beat * 0.2).toFixed(2)}" filter="url(#glow)"/>`,
    );
  }

  const points = boltPoints.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const boltOpacity = reactive ? Math.min(1, 0.18 + rms * 0.62 + beat * 0.34) : 0.045;
  const flashOpacity = reactive ? Math.min(0.22, beat * 0.2) : 0;
  return `<defs><linearGradient id="lightning-line" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#31f5d0"/><stop offset="0.48" stop-color="#ffffff"/><stop offset="1" stop-color="#9c6cff"/></linearGradient></defs><g data-reacts-to="frequency-lightning-storm" data-lightning-energy="${rms.toFixed(3)}" data-lightning-beat="${beat.toFixed(3)}" data-lightning-branches="${branches.length}"><rect x="0" y="0" width="800" height="100" fill="#b9eaff" opacity="${flashOpacity.toFixed(3)}"/><polyline points="${points}" fill="none" stroke="#52a8ff" stroke-width="${(8 + bass * 8 + beat * 6).toFixed(1)}" opacity="${(boltOpacity * 0.1).toFixed(2)}"/><polyline points="${points}" fill="none" stroke="url(#lightning-line)" stroke-width="${(1.1 + bass * 2.4 + beat * 1.8).toFixed(2)}" stroke-linejoin="bevel" stroke-linecap="round" opacity="${boltOpacity.toFixed(2)}" filter="url(#glow)"/>${branches.join("")}</g>`;
}

function cymaticRipplePool(phase) {
  const reactive = isAudioReactive();
  const rms = reactive ? audioAnalysis.rms : 0;
  const beat = reactive ? visualBeat : 0;
  const emitters = [80, 240, 400, 560, 720];
  const rings = [];
  const sources = [];

  for (let emitter = 0; emitter < emitters.length; emitter += 1) {
    const bandStart = emitter * 8;
    const level = reactive
      ? averageValues(audioAnalysis.bands.slice(bandStart, bandStart + 8))
      : 0;
    const frequencyPosition = emitter / (emitters.length - 1);
    const color = hslToHex(166 + frequencyPosition * 176, 94, 62 + level * 12);
    for (let ring = 0; ring < 7; ring += 1) {
      const progress = (ring / 7 + phase * (0.025 + frequencyPosition * 0.012)) % 1;
      const radius = 4 + progress * (92 + level * 28 + beat * 16);
      const opacity = reactive
        ? Math.max(0.015, (1 - progress) * (0.06 + level * 0.58 + beat * 0.2))
        : (1 - progress) * 0.025;
      rings.push(
        `<circle data-reacts-to="cymatic-frequency-ripples" data-ripple-emitter="${emitter}" data-band-start="${bandStart}" cx="${emitters[emitter]}" cy="50" r="${radius.toFixed(1)}" fill="none" stroke="${color}" stroke-width="${(0.55 + level * 1.8 + (1 - frequencyPosition) * beat * 1.1).toFixed(2)}" opacity="${opacity.toFixed(3)}"/>`,
      );
    }
    sources.push(
      `<circle cx="${emitters[emitter]}" cy="50" r="${(1.6 + level * 4.8 + beat * 3).toFixed(1)}" fill="${color}" opacity="${(0.14 + level * 0.72 + beat * 0.14).toFixed(2)}" filter="url(#glow)"/>`,
    );
  }
  return `<g data-cymatic-energy="${rms.toFixed(3)}" data-cymatic-beat="${beat.toFixed(3)}" data-cymatic-emitters="${emitters.length}">${rings.join("")}${sources.join("")}</g>`;
}

function dnaHelix(phase) {
  const reactive = isAudioReactive();
  const bass = reactive ? audioAnalysis.bass : 0;
  const mid = reactive ? audioAnalysis.mid : 0;
  const treble = reactive ? audioAnalysis.treble : 0;
  const beat = reactive ? visualBeat : 0;
  const pointCount = 81;
  // See laserTunnel: Windows stalls when it rasterises the glowing, transformed
  // long polylines. Static colour strokes keep the same audio geometry alive.
  const windowsRenderer = HOST_PLATFORM === "win32";
  const glow = windowsRenderer ? "" : ' filter="url(#glow)"';
  const strandA = [];
  const strandB = [];
  const rungs = [];

  for (let point = 0; point < pointCount; point += 1) {
    const position = point / (pointCount - 1);
    const band = Math.min(SPECTRUM_BANDS - 1, Math.floor(position * SPECTRUM_BANDS));
    const level = reactive ? audioAnalysis.bands[band] : 0;
    const angle = position * Math.PI * 2 * (4.5 + mid * 2.2) + phase * 0.34;
    const amplitude = 13 + bass * 9 + level * 8 + beat * 4;
    const x = position * DISPLAY_WIDTH;
    const yA = 50 + Math.sin(angle) * amplitude;
    const yB = 50 - Math.sin(angle) * amplitude;
    strandA.push(`${x.toFixed(1)},${yA.toFixed(1)}`);
    strandB.push(`${x.toFixed(1)},${yB.toFixed(1)}`);
    if (point % 4 === 0) {
      const front = Math.cos(angle) >= 0;
      const color = hslToHex(162 + position * 188, 94, 60 + treble * 14);
      rungs.push(
        `<line data-dna-rung-band="${band}" x1="${x.toFixed(1)}" y1="${yA.toFixed(1)}" x2="${x.toFixed(1)}" y2="${yB.toFixed(1)}" stroke="${color}" stroke-width="${(0.8 + level * 2.4 + beat * 0.7).toFixed(2)}" opacity="${Math.min(0.92, (front ? 0.22 : 0.08) + level * 0.6 + treble * 0.1).toFixed(2)}"/>`,
      );
    }
  }

  const energy = reactive ? audioAnalysis.rms : 0;
  const strandOpacity = reactive ? Math.min(0.96, 0.28 + energy * 0.65) : 0.1;
  const gradients = windowsRenderer
    ? ""
    : `<defs><linearGradient id="dna-a" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#31f5d0"/><stop offset="0.5" stop-color="#52a8ff"/><stop offset="1" stop-color="#9c6cff"/></linearGradient><linearGradient id="dna-b" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffe45e"/><stop offset="0.5" stop-color="#ff5ca8"/><stop offset="1" stop-color="#ff9f43"/></linearGradient></defs>`;
  const strandAColor = windowsRenderer ? "#52a8ff" : "url(#dna-a)";
  const strandBColor = windowsRenderer ? "#ff5ca8" : "url(#dna-b)";
  return `${gradients}<g data-reacts-to="frequency-dna-helix" data-dna-energy="${energy.toFixed(3)}" data-dna-rungs="${rungs.length}">${rungs.join("")}<polyline points="${strandA.join(" ")}" fill="none" stroke="${strandAColor}" stroke-width="${(1.3 + treble * 1.6 + beat).toFixed(2)}" opacity="${strandOpacity.toFixed(2)}"${glow}/><polyline points="${strandB.join(" ")}" fill="none" stroke="${strandBColor}" stroke-width="${(1.3 + treble * 1.6 + beat).toFixed(2)}" opacity="${strandOpacity.toFixed(2)}"${glow}/></g>`;
}

function pitchConstellation() {
  const reactive = isAudioReactive();
  const beat = reactive ? visualBeat : 0;
  const chroma = reactive ? audioAnalysis.chroma : Array(PITCH_CLASSES).fill(0);
  const nodes = Array.from({ length: PITCH_CLASSES }, (_, pitchClass) => ({
    pitchClass,
    level: chroma[pitchClass] || 0,
    x: 52 + (pitchClass / (PITCH_CLASSES - 1)) * 696,
    y: 17 + stableRandom(pitchClass * 97 + 31) * 66,
  }));
  const active = [...nodes]
    .filter((node) => node.level > 0.16)
    .sort((left, right) => right.level - left.level)
    .slice(0, 6);
  const connections = [];
  for (let first = 0; first < active.length; first += 1) {
    for (let second = first + 1; second < active.length; second += 1) {
      const strength = Math.min(active[first].level, active[second].level);
      connections.push(
        `<line data-pitch-connection="${active[first].pitchClass}-${active[second].pitchClass}" x1="${active[first].x.toFixed(1)}" y1="${active[first].y.toFixed(1)}" x2="${active[second].x.toFixed(1)}" y2="${active[second].y.toFixed(1)}" stroke="${hslToHex(180 + active[first].pitchClass * 15, 90, 66)}" stroke-width="${(0.55 + strength * 1.5 + beat * 0.5).toFixed(2)}" opacity="${Math.min(0.68, 0.04 + strength * 0.5 + beat * 0.08).toFixed(2)}"/>`,
      );
    }
  }
  const stars = nodes.map(({ pitchClass, level, x, y }) => {
    const color = hslToHex(160 + pitchClass * 17, 94, 61 + level * 17);
    const radius = 2.2 + level * 7.5 + beat * level * 3;
    const opacity = reactive ? 0.16 + level * 0.8 : 0.11;
    return `<circle data-reacts-to="pitch-class-constellation" data-pitch-class="${pitchClass}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius.toFixed(1)}" fill="${color}" opacity="${Math.min(0.98, opacity).toFixed(2)}" filter="url(#glow)"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1" fill="#ffffff" opacity="${Math.min(0.96, 0.22 + level * 0.72).toFixed(2)}"/>`;
  });
  const dominant = active[0]?.pitchClass ?? -1;
  return `<g data-pitch-source="fft-chromagram" data-pitch-dominant="${dominant}" data-pitch-active="${active.length}" data-pitch-connections="${connections.length}">${connections.join("")}${stars.join("")}</g>`;
}

function digitalRain(phase) {
  const reactive = isAudioReactive();
  const rms = reactive ? audioAnalysis.rms : 0;
  const bass = reactive ? audioAnalysis.bass : 0;
  const treble = reactive ? audioAnalysis.treble : 0;
  const beat = reactive ? visualBeat : 0;
  const drops = [];

  for (let band = 0; band < SPECTRUM_BANDS; band += 1) {
    const level = reactive ? audioAnalysis.bands[band] : 0;
    for (let stream = 0; stream < 3; stream += 1) {
      const visibility = stableRandom(band * 83 + stream * 29 + 11);
      if (!reactive && (stream > 0 || band % 8 !== 0)) continue;
      if (reactive && visibility > 0.12 + level * 0.88 + beat * 0.18) continue;
      const speed = 0.022 + level * 0.095 + treble * 0.018;
      const progress = (stableRandom(band * 41 + stream * 67) + phase * speed) % 1;
      const x = band * 20 + 10 + (stream - 1) * 3.2;
      const trail = 5 + level * 24 + bass * 8 + treble * 10 + beat * 8;
      const cycleStartY = -8;
      const cycleEndY = 108 + trail;
      const y = cycleStartY + progress * (cycleEndY - cycleStartY);
      const color = hslToHex(158 + (band / (SPECTRUM_BANDS - 1)) * 178, 94, 56 + level * 20);
      const opacity = reactive
        ? Math.min(0.96, 0.08 + level * 0.68 + rms * 0.12 + beat * 0.16)
        : 0.07;
      drops.push(
        `<line data-reacts-to="frequency-digital-rain" data-rain-band="${band}" data-rain-cycle-start="${cycleStartY}" data-rain-cycle-end="${cycleEndY.toFixed(1)}" data-rain-trail="${trail.toFixed(1)}" x1="${x.toFixed(1)}" y1="${(y - trail).toFixed(1)}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${color}" stroke-width="${(0.75 + level * 2.2 + bass * 0.6).toFixed(2)}" stroke-linecap="round" opacity="${opacity.toFixed(2)}" filter="url(#glow)"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.65 + level * 1.7 + beat * 0.7).toFixed(1)}" fill="#ffffff" opacity="${Math.min(1, opacity + 0.12).toFixed(2)}"/>`,
      );
    }
  }
  return `<g data-rain-source="frequency-bands" data-rain-energy="${rms.toFixed(3)}" data-rain-beat="${beat.toFixed(3)}" data-visible-rain-drops="${drops.length}">${drops.join("")}</g>`;
}

function outrunHighway(phase) {
  const reactive = isAudioReactive();
  const rms = reactive ? audioAnalysis.rms : 0;
  const bass = reactive ? audioAnalysis.bass : 0;
  const mid = reactive ? audioAnalysis.mid : 0;
  const treble = reactive ? audioAnalysis.treble : 0;
  const beat = reactive ? visualBeat : 0;
  const horizon = 46;
  const sunRadius = 25 + rms * 5 + mid * 3 + beat * 4;
  const sunCenterY = 29 + bass * 2;
  const travel = (phase * 0.22) % 1;

  const stars = Array.from({ length: 34 }, (_, index) => {
    const x = stableRandom(index * 71 + 13) * DISPLAY_WIDTH;
    const y = 3 + stableRandom(index * 47 + 29) * 34;
    const sparkle = stableRandom(index * 101 + animationFrame * 0.37);
    const opacity = reactive
      ? Math.min(0.9, 0.12 + treble * 0.48 + sparkle * 0.24)
      : 0.13 + sparkle * 0.08;
    return `<circle data-outrun-star="${index}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.35 + sparkle * 0.75 + treble * 0.35).toFixed(2)}" fill="#d8e5ff" opacity="${opacity.toFixed(2)}"/>`;
  });

  const rearMountainPoints = Array.from({ length: 25 }, (_, index) => {
    const x = (index / 24) * DISPLAY_WIDTH;
    const height = 4 + stableRandom(index * 89 + 7) * 13;
    return `${x.toFixed(1)},${(horizon - height).toFixed(1)}`;
  });
  const frequencyMountainPoints = Array.from({ length: SPECTRUM_BANDS }, (_, band) => {
    const x = (band / (SPECTRUM_BANDS - 1)) * DISPLAY_WIDTH;
    const level = reactive ? audioAnalysis.bands[band] : 0;
    const lowWeight = 1 - band / (SPECTRUM_BANDS - 1);
    const height =
      2.5 +
      stableRandom(band * 61 + 17) * 5 +
      Math.pow(level, 0.72) * 23 +
      bass * lowWeight * 5 +
      beat * level * 4;
    return `${x.toFixed(1)},${(horizon - height).toFixed(1)}`;
  });

  const perspectiveLines = Array.from({ length: 21 }, (_, index) => {
    const bottomX = -120 + index * 52;
    const color = index % 2 === 0 ? "#2de2e6" : "#9c4dff";
    return `<line data-outrun-grid-ray="${index}" x1="400" y1="${horizon}" x2="${bottomX}" y2="102" stroke="${color}" stroke-width="${(0.55 + treble * 0.65).toFixed(2)}" opacity="${(0.2 + rms * 0.28 + treble * 0.14).toFixed(2)}"/>`;
  });
  const horizonLines = Array.from({ length: 10 }, (_, index) => {
    const progress = (index / 10 + travel) % 1;
    const y = horizon + Math.pow(progress, 2.15) * (101 - horizon);
    return `<line data-outrun-grid-row="${index}" x1="0" y1="${y.toFixed(1)}" x2="800" y2="${y.toFixed(1)}" stroke="#ff3cac" stroke-width="${(0.45 + progress * 1.1 + beat * 0.6).toFixed(2)}" opacity="${(0.12 + progress * 0.5 + rms * 0.18).toFixed(2)}"/>`;
  });
  const centreDashes = Array.from({ length: 6 }, (_, index) => {
    const progress = (index / 6 + travel) % 1;
    const y = horizon + Math.pow(progress, 2.05) * (104 - horizon);
    const halfWidth = 0.6 + progress * 4.6;
    const height = 0.8 + progress * 4.5;
    return `<path data-outrun-road-dash="${index}" d="M${(400 - halfWidth).toFixed(1)} ${y.toFixed(1)}H${(400 + halfWidth).toFixed(1)}L${(400 + halfWidth * 1.45).toFixed(1)} ${(y + height).toFixed(1)}H${(400 - halfWidth * 1.45).toFixed(1)}Z" fill="#fff1ff" opacity="${(0.18 + progress * 0.68 + beat * 0.12).toFixed(2)}" filter="url(#glow)"/>`;
  });
  const sunStripes = Array.from({ length: 7 }, (_, index) => {
    const y = sunCenterY - 5 + index * 5.3;
    return `<rect data-outrun-sun-stripe="${index}" x="${(400 - sunRadius - 2).toFixed(1)}" y="${y.toFixed(1)}" width="${(sunRadius * 2 + 4).toFixed(1)}" height="${(1.2 + index * 0.22).toFixed(1)}" fill="#16072d" opacity="0.9"/>`;
  });

  return `<defs>
  <linearGradient id="outrun-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#050014"/><stop offset="0.58" stop-color="#19063f"/><stop offset="1" stop-color="#4b0b5f"/></linearGradient>
  <linearGradient id="outrun-ground" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#190428"/><stop offset="1" stop-color="#03000b"/></linearGradient>
  <linearGradient id="outrun-sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff45c"/><stop offset="0.48" stop-color="#ff9f43"/><stop offset="1" stop-color="#ff3cac"/></linearGradient>
  <clipPath id="outrun-sun-clip"><circle cx="400" cy="${sunCenterY.toFixed(1)}" r="${sunRadius.toFixed(1)}"/></clipPath>
  </defs>
  <g data-reacts-to="synthwave-highway" data-frequency-axis="low-left-high-right" data-outrun-energy="${rms.toFixed(3)}" data-outrun-bass="${bass.toFixed(3)}" data-outrun-beat="${beat.toFixed(3)}" data-grid-travel="${travel.toFixed(3)}">
    <rect x="0" y="0" width="800" height="${horizon}" fill="url(#outrun-sky)"/>
    <g data-outrun-stars="${stars.length}">${stars.join("")}</g>
    <circle data-outrun-sun-energy="${(rms + mid + beat).toFixed(3)}" cx="400" cy="${sunCenterY.toFixed(1)}" r="${sunRadius.toFixed(1)}" fill="url(#outrun-sun)" opacity="${(0.72 + rms * 0.18 + beat * 0.08).toFixed(2)}" filter="url(#glow)"/>
    <g clip-path="url(#outrun-sun-clip)">${sunStripes.join("")}</g>
    <polygon points="0,${horizon} ${rearMountainPoints.join(" ")} 800,${horizon}" fill="#11051f" stroke="#7d3cff" stroke-width="1" opacity="0.8"/>
    <polygon data-outrun-frequency-mountains="${SPECTRUM_BANDS}" points="0,${horizon} ${frequencyMountainPoints.join(" ")} 800,${horizon}" fill="#080310" stroke="#ff3cac" stroke-width="${(1 + mid * 0.8 + beat * 0.5).toFixed(2)}" opacity="0.96" filter="url(#glow)"/>
    <rect x="0" y="${horizon}" width="800" height="${100 - horizon}" fill="url(#outrun-ground)"/>
    <line x1="0" y1="${horizon}" x2="800" y2="${horizon}" stroke="#ff4fd8" stroke-width="${(1.3 + beat * 1.3).toFixed(2)}" opacity="${(0.55 + rms * 0.3).toFixed(2)}" filter="url(#glow)"/>
    <g>${perspectiveLines.join("")}${horizonLines.join("")}</g>
    <path d="M400 ${horizon}L238 102M400 ${horizon}L562 102" fill="none" stroke="#2de2e6" stroke-width="${(1.1 + bass * 1.2 + beat * 0.8).toFixed(2)}" opacity="0.9" filter="url(#glow)"/>
    <g>${centreDashes.join("")}</g>
    <rect x="0" y="0" width="800" height="100" fill="#ff3cac" opacity="${(beat * 0.06).toFixed(3)}"/>
  </g>`;
}

function neonCityCruise(phase) {
  const reactive = isAudioReactive();
  const rms = reactive ? audioAnalysis.rms : 0;
  const bass = reactive ? audioAnalysis.bass : 0;
  const mid = reactive ? audioAnalysis.mid : 0;
  const treble = reactive ? audioAnalysis.treble : 0;
  const beat = reactive ? visualBeat : 0;
  const horizon = 58;
  const travel = (phase * (0.14 + rms * 0.12 + beat * 0.04)) % 1;
  const buildings = Array.from({ length: 32 }, (_, index) => {
    const band = Math.min(SPECTRUM_BANDS - 1, Math.floor((index / 31) * SPECTRUM_BANDS));
    const level = reactive ? audioAnalysis.bands[band] : 0;
    const width = 17 + stableRandom(index * 43 + 7) * 13;
    const x = index * 25 - 4;
    const baseHeight = 8 + stableRandom(index * 79 + 19) * 18;
    const height = baseHeight + Math.pow(level, 0.72) * 30 + mid * level * 6;
    const y = horizon - height;
    const color = index % 3 === 0 ? "#2de2e6" : index % 3 === 1 ? "#ff3cac" : "#9c4dff";
    const windows = Array.from({ length: Math.max(1, Math.floor(height / 7)) }, (_, row) => {
      const windowY = y + 4 + row * 7;
      const lit = stableRandom(index * 131 + row * 23 + Math.floor(animationFrame / 5)) < 0.3 + treble * 0.5;
      return `<rect x="${(x + 4).toFixed(1)}" y="${windowY.toFixed(1)}" width="${Math.max(3, width - 8).toFixed(1)}" height="1.3" fill="${lit ? "#fff27a" : "#3b174f"}" opacity="${lit ? (0.28 + treble * 0.55).toFixed(2) : "0.18"}"/>`;
    });
    return `<g data-city-building-band="${band}"><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${width.toFixed(1)}" height="${height.toFixed(1)}" fill="#09051a" stroke="${color}" stroke-width="${(0.55 + level * 1.4 + beat * 0.5).toFixed(2)}" opacity="0.94"/>${windows.join("")}</g>`;
  });
  const gridRays = Array.from({ length: 17 }, (_, index) => {
    const x = -100 + index * 62.5;
    return `<line data-city-grid-ray="${index}" x1="400" y1="${horizon}" x2="${x.toFixed(1)}" y2="102" stroke="${index % 2 ? "#ff3cac" : "#2de2e6"}" stroke-width="${(0.45 + treble * 0.8).toFixed(2)}" opacity="${(0.16 + rms * 0.35).toFixed(2)}"/>`;
  });
  const gridRows = Array.from({ length: 7 }, (_, index) => {
    const progress = (index / 7 + travel) % 1;
    const y = horizon + Math.pow(progress, 2.15) * (102 - horizon);
    return `<line data-city-grid-row="${index}" x1="0" y1="${y.toFixed(1)}" x2="800" y2="${y.toFixed(1)}" stroke="#a947ff" stroke-width="${(0.45 + progress + beat * 0.6).toFixed(2)}" opacity="${(0.13 + progress * 0.48).toFixed(2)}"/>`;
  });
  return `<defs><linearGradient id="city-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#020515"/><stop offset="0.58" stop-color="#171044"/><stop offset="1" stop-color="#6a155e"/></linearGradient><linearGradient id="city-road" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#160626"/><stop offset="1" stop-color="#02040c"/></linearGradient></defs>
  <g data-reacts-to="neon-city-cruise" data-city-energy="${rms.toFixed(3)}" data-city-bass="${bass.toFixed(3)}" data-city-beat="${beat.toFixed(3)}" data-city-buildings="${buildings.length}">
    <rect x="0" y="0" width="800" height="${horizon}" fill="url(#city-sky)"/><circle cx="676" cy="19" r="13" fill="#d8f5ff" opacity="${(0.34 + mid * 0.4).toFixed(2)}" filter="url(#glow)"/><circle cx="681" cy="16" r="13" fill="#090829" opacity="0.94"/>
    ${buildings.join("")}<line x1="0" y1="${horizon}" x2="800" y2="${horizon}" stroke="#ff57df" stroke-width="${(1 + beat * 1.6).toFixed(2)}" opacity="0.9" filter="url(#glow)"/>
    <rect x="0" y="${horizon}" width="800" height="${100 - horizon}" fill="url(#city-road)"/>${gridRays.join("")}${gridRows.join("")}
    <path d="M400 ${horizon}L300 102M400 ${horizon}L500 102" fill="none" stroke="#fff2ff" stroke-width="${(0.8 + bass * 1.5).toFixed(2)}" opacity="0.55"/>
  </g>`;
}

function miamiNightRun(phase) {
  const reactive = isAudioReactive();
  const rms = reactive ? audioAnalysis.rms : 0;
  const bass = reactive ? audioAnalysis.bass : 0;
  const mid = reactive ? audioAnalysis.mid : 0;
  const treble = reactive ? audioAnalysis.treble : 0;
  const beat = reactive ? visualBeat : 0;
  const horizon = 43;
  const sunX = 621;
  const sunY = 28;
  const waveLines = Array.from({ length: 5 }, (_, row) => {
    const baseY = 52 + row * 10;
    const points = Array.from({ length: 81 }, (_, index) => {
      const x = index * 10;
      const sampleIndex = Math.min(WAVEFORM_POINTS - 1, Math.floor((index / 80) * WAVEFORM_POINTS));
      const band = Math.min(SPECTRUM_BANDS - 1, Math.floor((index / 80) * SPECTRUM_BANDS));
      const sample = reactive ? audioAnalysis.waveform[sampleIndex] : 0;
      const level = reactive ? audioAnalysis.bands[band] : 0;
      const swell = sample * (2 + row * 0.65) + level * (1.2 + row * 0.45);
      const tide = Math.sin(index * 0.42 + phase * 0.08 + row * 1.1) * (0.55 + rms * 1.2);
      return `${x},${(baseY + swell + tide).toFixed(1)}`;
    });
    return `<polyline data-miami-ocean-wave="${row}" points="${points.join(" ")}" fill="none" stroke="${row % 2 ? "#2de2e6" : "#ff4fc8"}" stroke-width="${(0.7 + row * 0.15 + treble * 0.5).toFixed(2)}" opacity="${(0.18 + row * 0.1 + rms * 0.25).toFixed(2)}"/>`;
  });
  const palms = [58, 135, 226, 334, 715, 770].map((x, index) => {
    const foreground = index === 0 || index === 5;
    const baseY = foreground ? 102 : 67 + (index % 2) * 7;
    const height = (foreground ? 46 : 27) + bass * (foreground ? 7 : 3) + beat * 3;
    const topX = x + Math.sin(phase * 0.025 + index) * (1 + mid * 2);
    const topY = baseY - height;
    const fronds = Array.from({ length: 7 }, (_, frond) => {
      const angle = -2.9 + frond * 0.72 + Math.sin(phase * 0.018 + frond) * 0.05;
      const length = (foreground ? 18 : 12) + treble * 5;
      const endX = topX + Math.cos(angle) * length;
      const endY = topY + Math.sin(angle) * length * 0.55;
      const controlX = topX + Math.cos(angle) * length * 0.52;
      const controlY = topY + Math.sin(angle) * length * 0.1 - 2;
      return `<path d="M${topX.toFixed(1)} ${topY.toFixed(1)}Q${controlX.toFixed(1)} ${controlY.toFixed(1)} ${endX.toFixed(1)} ${endY.toFixed(1)}" fill="none" stroke="#090414" stroke-width="${foreground ? 3 : 2}" stroke-linecap="round"/>`;
    });
    return `<g data-miami-palm="${index}"><path d="M${x} ${baseY}Q${(x - 3).toFixed(1)} ${(baseY - height * 0.52).toFixed(1)} ${topX.toFixed(1)} ${topY.toFixed(1)}" fill="none" stroke="#08030f" stroke-width="${foreground ? 5 : 3}" stroke-linecap="round"/>${fronds.join("")}</g>`;
  });
  const sunStripes = Array.from({ length: 6 }, (_, index) => `<rect x="592" y="${(sunY - 7 + index * 4.5).toFixed(1)}" width="58" height="${(1 + index * 0.25).toFixed(1)}" fill="#40104f" opacity="0.82"/>`);
  return `<defs><linearGradient id="miami-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#071338"/><stop offset="0.52" stop-color="#6b1c70"/><stop offset="1" stop-color="#ff5a88"/></linearGradient><linearGradient id="miami-water" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#17063d"/><stop offset="1" stop-color="#020b20"/></linearGradient><linearGradient id="miami-sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff86b"/><stop offset="1" stop-color="#ff3f9e"/></linearGradient><clipPath id="miami-sun-clip"><circle cx="${sunX}" cy="${sunY}" r="27"/></clipPath></defs>
  <g data-reacts-to="miami-night-run" data-miami-energy="${rms.toFixed(3)}" data-miami-bass="${bass.toFixed(3)}" data-miami-treble="${treble.toFixed(3)}" data-miami-palms="${palms.length}" data-ocean-source="waveform-spectrum">
    <rect width="800" height="${horizon}" fill="url(#miami-sky)"/><circle cx="${sunX}" cy="${sunY}" r="${(25 + rms * 5 + beat * 3).toFixed(1)}" fill="url(#miami-sun)" opacity="0.94" filter="url(#glow)"/><g clip-path="url(#miami-sun-clip)">${sunStripes.join("")}</g>
    <path d="M0 ${horizon}L55 34L108 43L178 31L244 43L300 37L365 43L430 34L490 43L540 38L585 43L690 34L800 43V49H0Z" fill="#10051e" stroke="#6f2cff" stroke-width="0.8" opacity="0.9"/>
    <rect x="0" y="${horizon}" width="800" height="${100 - horizon}" fill="url(#miami-water)"/><line x1="0" y1="${horizon}" x2="800" y2="${horizon}" stroke="#ff69db" stroke-width="${(1 + beat).toFixed(2)}" filter="url(#glow)"/>${waveLines.join("")}${palms.join("")}
  </g>`;
}

function stableRandom(seed) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function audioStatusMarkup() {
  if (isAudioReactive() || AUDIO_ANALYZER_DISABLED) return "";
  let message = "Play Spotify to start audio-reactive visuals";
  if (audioAnalyzerStatus === "starting") message = "Starting Spotify audio capture…";
  if (audioAnalyzerStatus === "error") {
    if (audioAnalyzerErrorCode === "permission") {
      message = "Allow Screen Recording once, then restart Stream Deck";
    } else if (audioAnalyzerErrorCode === "spotify_not_running") {
      message = "Open Spotify, then rotate a dial to retry";
    } else {
      message = "Audio analyser stopped — rotate a dial to retry";
    }
  }
  return `<rect x="165" y="29" width="470" height="30" rx="15" fill="#05070a" opacity="0.88"/>
  <text x="400" y="49" text-anchor="middle" fill="#ffffff" font-family="Helvetica Neue, Arial, sans-serif" font-size="16" font-weight="600">${escapeXml(message)}</text>`;
}

function isAudioReactive() {
  return audioAnalysis.receivedAt > 0 && Date.now() - audioAnalysis.receivedAt < 1000;
}

function normalizedNumber(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function signedNumber(value) {
  return Math.max(-1, Math.min(1, Number(value) || 0));
}

function signedArray(values, length) {
  const normalized = Array.isArray(values)
    ? values.slice(0, length).map(signedNumber)
    : [];
  while (normalized.length < length) normalized.push(0);
  return normalized;
}

function emptyAudioAnalysis() {
  return {
    bands: Array(SPECTRUM_BANDS).fill(0),
    waveform: Array(WAVEFORM_POINTS).fill(0),
    stereoLeft: Array(STEREO_POINTS).fill(0),
    stereoRight: Array(STEREO_POINTS).fill(0),
    stereoCorrelation: 0,
    chroma: Array(PITCH_CLASSES).fill(0),
    rms: 0,
    peak: 0,
    bass: 0,
    mid: 0,
    treble: 0,
    beat: 0,
    receivedAt: 0,
  };
}

function resetSpectrogramHistory() {
  for (const frame of spectrogramHistory) frame.fill(0);
}

function resetWaveformHistory() {
  for (const frame of waveformHistory) frame.fill(0);
}

function emptyTunnelSnapshot() {
  return {
    zones: Array(TUNNEL_ZONES).fill(0),
    bass: 0,
    mid: 0,
    treble: 0,
    rms: 0,
    beat: 0,
  };
}

function updateTunnelHistory() {
  const reactive = isAudioReactive();
  const snapshot = reactive
    ? {
        zones: compressBands(audioAnalysis.bands, TUNNEL_ZONES),
        bass: audioAnalysis.bass,
        mid: audioAnalysis.mid,
        treble: audioAnalysis.treble,
        rms: audioAnalysis.rms,
        beat: visualBeat,
      }
    : emptyTunnelSnapshot();
  tunnelHistory.push(snapshot);
  if (tunnelHistory.length > TUNNEL_RINGS) tunnelHistory.shift();
}

function resetTunnelHistory() {
  for (let index = 0; index < tunnelHistory.length; index += 1) {
    tunnelHistory[index] = emptyTunnelSnapshot();
  }
}

function updateStarfieldMotion(reactive) {
  starfieldBurst = Math.max(visualBeat, starfieldBurst * 0.7);
  const rms = reactive ? audioAnalysis.rms : 0;
  const bass = reactive ? audioAnalysis.bass : 0;
  const targetSpeed = 0.001 + Math.pow(rms, 1.4) * 0.035 + bass * 0.012;
  const response = targetSpeed > starfieldSpeed ? 0.55 : 0.14;
  starfieldSpeed += (targetSpeed - starfieldSpeed) * response;
  starfieldTravel = (starfieldTravel + starfieldSpeed + starfieldBurst * 0.065) % 1;
}

function resetStarfieldMotion() {
  starfieldTravel = 0;
  starfieldSpeed = 0.001;
  starfieldBurst = 0;
}

function updateBeatEnvelope() {
  visualBeat = Math.max(capturedBeatPeak, visualBeat * 0.7);
  capturedBeatPeak = 0;
}

function resetBeatEnvelope() {
  capturedBeatPeak = 0;
  visualBeat = 0;
}

function updatePlasmaMotion(reactive) {
  const rms = reactive ? audioAnalysis.rms : 0;
  const mid = reactive ? audioAnalysis.mid : 0;
  plasmaFlow =
    (plasmaFlow + 0.012 + rms * 0.04 + mid * 0.075 + visualBeat * 0.03) %
    (Math.PI * 2);
}

function resetPlasmaMotion() {
  plasmaFlow = 0;
}

function updateParticleMotion(reactive) {
  const rms = reactive ? audioAnalysis.rms : 0;
  const bass = reactive ? audioAnalysis.bass : 0;
  const targetSpeed = 0.002 + Math.pow(rms, 1.25) * 0.028 + bass * 0.012;
  const response = targetSpeed > particleSpeed ? 0.52 : 0.15;
  particleSpeed += (targetSpeed - particleSpeed) * response;
  particleTravel = (particleTravel + particleSpeed + visualBeat * 0.04) % 1;
}

function resetParticleMotion() {
  particleTravel = 0;
  particleSpeed = 0.002;
}

function compressBands(bands, targetCount) {
  return Array.from({ length: targetCount }, (_, index) => {
    const start = Math.floor((index * bands.length) / targetCount);
    const end = Math.max(start + 1, Math.floor(((index + 1) * bands.length) / targetCount));
    return averageValues(bands.slice(start, end));
  });
}

function averageValues(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function weightedCentroid(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0.0001) return 0.15;
  return values.reduce(
    (sum, value, index) => sum + value * (index / Math.max(1, values.length - 1)),
    0,
  ) / total;
}

function dominantFrequencyPosition(values) {
  if (!values.length) return 0;
  let strongestIndex = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] > values[strongestIndex]) strongestIndex = index;
  }
  return strongestIndex / Math.max(1, values.length - 1);
}

function hslToHex(hue, saturation, lightness) {
  const normalizedHue = ((hue % 360) + 360) % 360;
  const normalizedSaturation = Math.max(0, Math.min(100, saturation)) / 100;
  const normalizedLightness = Math.max(0, Math.min(100, lightness)) / 100;
  const chroma =
    (1 - Math.abs(2 * normalizedLightness - 1)) * normalizedSaturation;
  const segment = normalizedHue / 60;
  const intermediate = chroma * (1 - Math.abs((segment % 2) - 1));
  let red = 0;
  let green = 0;
  let blue = 0;

  if (segment < 1) [red, green] = [chroma, intermediate];
  else if (segment < 2) [red, green] = [intermediate, chroma];
  else if (segment < 3) [green, blue] = [chroma, intermediate];
  else if (segment < 4) [green, blue] = [intermediate, chroma];
  else if (segment < 5) [red, blue] = [intermediate, chroma];
  else [red, blue] = [chroma, intermediate];

  const match = normalizedLightness - chroma / 2;
  return `#${[red, green, blue]
    .map((channel) => Math.round((channel + match) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function shutdown() {
  stopAudioAnalyzer();
  process.exit(0);
}

function marqueeMessage() {
  if (!spotifyState.isRunning) {
    return "Spotify is not running  •  Press any dial to open Spotify";
  }
  const artist = spotifyState.currentTrack?.artist || "Unknown artist";
  const title = spotifyState.currentTrack?.title || "Unknown track";
  return `${artist}  —  ${title}`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function stoppedState() {
  return {
    isRunning: false,
    player: {
      state: "stopped",
      volume: 0,
      isShuffleActive: false,
      isRepeatActive: false,
    },
    currentTrack: { id: "", artist: "", title: "", positionPercent: 0 },
  };
}

function send(message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
