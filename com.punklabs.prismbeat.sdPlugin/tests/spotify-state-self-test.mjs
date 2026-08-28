import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const stateScript = join(pluginRoot, "scripts/spotify-state.js");
const controlScript = join(pluginRoot, "scripts/spotify-control.js");

execFileSync(process.execPath, ["--check", stateScript]);
execFileSync(process.execPath, ["--check", controlScript]);

const state = JSON.parse(
  execFileSync("osascript", ["-l", "JavaScript", stateScript], {
    encoding: "utf8",
    timeout: 5000,
  }).trim(),
);

assert.equal(typeof state.isRunning, "boolean");
assert.equal(typeof state.player?.state, "string");
assert.equal(typeof state.player?.volume, "number");
assert.equal(typeof state.player?.isShuffleActive, "boolean");
assert.equal(typeof state.player?.isRepeatActive, "boolean");
assert.equal(typeof state.currentTrack?.artworkUrl, "string");

const pluginSource = readFileSync(join(pluginRoot, "bin/plugin.js"), "utf8");
assert.doesNotMatch(pluginSource, /com\.elgato\.spotify/);

process.stdout.write("Owned Spotify state integration self-test passed\n");
