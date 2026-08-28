import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(pluginRoot, "scripts/spotify-control.js"), "utf8");

assert.deepEqual(execute("previous").calls, ["previous"]);
assert.deepEqual(execute("next").calls, ["next"]);
assert.deepEqual(execute("play").calls, ["play"]);
assert.deepEqual(execute("stop").calls, ["pause"]);
assert.equal(execute("setshuffling", "true").spotify.shuffling, true);
assert.equal(execute("setrepeating", "true").spotify.repeating, true);
assert.equal(execute("setvolume", "29").spotify.soundVolume, 30);
assert.equal(execute("changevolume", "5").spotify.soundVolume, 36);
assert.equal(execute("skipbyseconds", "5").spotify.playerPosition, 15);
assert.equal(execute("skipbyseconds", "-15").spotify.playerPosition, 0);
assert.equal(execute("restart").spotify.playerPosition, 0);

process.stdout.write("Owned Spotify control integration self-test passed\n");

function execute(command, ...args) {
  const calls = [];
  const spotify = {
    running: () => true,
    playerState: () => "playing",
    soundVolume: () => 30,
    playerPosition: () => 10,
    play: () => calls.push("play"),
    pause: () => calls.push("pause"),
    nextTrack: () => calls.push("next"),
    previousTrack: () => calls.push("previous"),
  };
  const context = vm.createContext({ Application: () => spotify });
  vm.runInContext(source, context);
  assert.equal(context.run([command, ...args]), "ok");
  return { calls, spotify };
}
