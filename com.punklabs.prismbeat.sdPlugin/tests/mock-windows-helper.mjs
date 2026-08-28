#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const [mode = "state", command = "", ...args] = process.argv.slice(2);
if (process.env.SPOTIFY_WINDOWS_HELPER_LOG) {
  appendFileSync(
    process.env.SPOTIFY_WINDOWS_HELPER_LOG,
    `${JSON.stringify([mode, command, ...args].filter(Boolean))}\n`,
  );
}

if (mode === "state") {
  process.stdout.write(JSON.stringify({
    timestamp: new Date().toISOString(),
    isRunning: true,
    player: {
      version: "Windows test",
      state: "playing",
      autoRepeatMode: "None",
      isShuffleActive: false,
      isShuffleEnabled: true,
      isRepeatActive: false,
      isRepeatEnabled: true,
      volume: 62,
      lastPosition: 12,
    },
    currentTrack: {
      id: "windows-track",
      spotifyUrl: "https://open.spotify.com/search/PrismBeat%20Windows",
      title: "Windows Track",
      artist: "PrismBeat",
      album: "Cross Platform",
      albumArtist: "PrismBeat",
      duration: 180000,
      durationSeconds: 180,
      positionSeconds: 12,
      positionPercent: 6.67,
      trackNumber: 1,
      artworkUrl: pathToFileURL(join(pluginRoot, "imgs/plugin.png")).href,
    },
  }));
} else if (mode === "control" || mode === "launch") {
  process.stdout.write("ok\n");
} else {
  process.stderr.write(`Unsupported mock helper mode: ${mode}\n`);
  process.exitCode = 1;
}
