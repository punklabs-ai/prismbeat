import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = mkdtempSync(join(tmpdir(), "spotify-silent-visuals-"));
execFileSync(
  process.execPath,
  [join(pluginRoot, "tests/render-visual-previews.mjs"), outputDirectory],
  {
    cwd: pluginRoot,
    env: {
      ...process.env,
      SPOTIFY_PREVIEW_ANALYZER_PATH: join(
        pluginRoot,
        "tests/mock-silent-audio-analyzer.mjs",
      ),
    },
    timeout: 15_000,
  },
);

const visuals = Array.from({ length: 19 }, (_, index) =>
  readFileSync(join(outputDirectory, `visual-${index}.svg`), "utf8"),
);

assert.equal([...visuals[0].matchAll(/data-peak-marker="true"/g)].length, 40);
assert.doesNotMatch(visuals[0], /height="6" rx="1\.5"/);
assert.equal([...visuals[1].matchAll(/data-reacts-to="triggered-waveform"/g)].length, 5);
assert.match(visuals[1], /0\.0,50\.0/);
assert.equal([...visuals[2].matchAll(/data-shape="rectangle"/g)].length, 15);
assert.doesNotMatch(visuals[2], /data-bass="(?!0\.000)/);

const visibleStars = Number(visuals[3].match(/data-visible-stars="([0-9]+)"/)?.[1]);
assert.ok(visibleStars > 0 && visibleStars <= 25, `expected sparse idle stars, found ${visibleStars}`);

assert.match(visuals[4], /data-plasma-energy="0\.000"/);
assert.equal([...visuals[4].matchAll(/data-plasma-band-zone="[0-9]+"/g)].length, 12);
assert.match(visuals[4], /data-plasma-band-zone="0"[^>]+opacity="0\.025"/);
assert.match(visuals[5], /data-kaleidoscope-energy="0\.000"/);
assert.match(visuals[5], /data-reacts-to="kaleidoscope-bands"[^>]+opacity="0\.06"/);
assert.match(visuals[6], /data-halo-energy="0\.000"/);
assert.equal([...visuals[6].matchAll(/data-reacts-to="frequency-halo"/g)].length, 40);
assert.match(visuals[7], /data-terrain-energy="0\.000"/);
assert.equal(
  [...visuals[7].matchAll(/data-reacts-to="spectrum-terrain"/g)].length,
  12,
);
assert.equal([...visuals[7].matchAll(/data-terrain-longitude="[0-9]+"/g)].length, 11);
assert.doesNotMatch(visuals[7], /captured-waveform-feedback/);
assert.doesNotMatch(visuals[8], /data-reacts-to="center-frequency-history"/);
assert.match(visuals[8], /data-spectrogram-origin="center"[^>]+y2="100"/);

const visibleParticles = Number(
  visuals[9].match(/data-visible-particles="([0-9]+)"/)?.[1],
);
assert.ok(
  visibleParticles > 0 && visibleParticles <= 12,
  `expected a few idle fountain embers, found ${visibleParticles}`,
);
assert.match(visuals[9], /data-fountain-energy="0\.000"/);

assert.match(visuals[10], /data-vectorscope-energy="0\.000"/);
assert.match(visuals[10], /data-vectorscope-correlation="0\.000"/);
assert.equal([...visuals[10].matchAll(/data-scope-panel="[0-3]"/g)].length, 4);
assert.match(visuals[11], /data-lightning-energy="0\.000"/);
assert.match(visuals[11], /data-lightning-branches="0"/);
assert.match(visuals[12], /data-cymatic-energy="0\.000"/);
assert.equal(
  [...visuals[12].matchAll(/data-reacts-to="cymatic-frequency-ripples"/g)].length,
  35,
);
assert.match(visuals[13], /data-dna-energy="0\.000"/);
assert.equal([...visuals[13].matchAll(/data-dna-rung-band="[0-9]+"/g)].length, 21);
assert.match(visuals[14], /data-pitch-source="fft-chromagram"/);
assert.match(visuals[14], /data-pitch-active="0"/);
assert.doesNotMatch(visuals[14], /data-pitch-connection=/);
assert.equal(
  [...visuals[14].matchAll(/data-reacts-to="pitch-class-constellation"/g)].length,
  12,
);
assert.match(visuals[15], /data-rain-energy="0\.000"/);
assert.match(visuals[15], /data-visible-rain-drops="10"/);
const silentRainCycles = [
  ...visuals[15].matchAll(
    /data-rain-cycle-start="-8" data-rain-cycle-end="([0-9.]+)" data-rain-trail="([0-9.]+)"/g,
  ),
];
assert.equal(silentRainCycles.length, 10);
assert.ok(
  silentRainCycles.every((cycle) => Number(cycle[1]) - Number(cycle[2]) >= 107.9),
);
assert.match(visuals[16], /data-reacts-to="synthwave-highway"/);
assert.match(visuals[16], /data-outrun-energy="0\.000"/);
assert.match(visuals[16], /data-outrun-bass="0\.000"/);
assert.match(visuals[16], /data-outrun-beat="0\.000"/);
assert.match(visuals[16], /data-outrun-frequency-mountains="40"/);
assert.equal([...visuals[16].matchAll(/data-outrun-grid-ray="[0-9]+"/g)].length, 21);
assert.equal([...visuals[16].matchAll(/data-outrun-grid-row="[0-9]+"/g)].length, 10);
assert.match(visuals[17], /data-reacts-to="neon-city-cruise"/);
assert.match(visuals[17], /data-city-energy="0\.000"/);
assert.match(visuals[17], /data-city-buildings="32"/);
assert.equal([...visuals[17].matchAll(/data-city-building-band="[0-9]+"/g)].length, 32);
assert.match(visuals[18], /data-reacts-to="miami-night-run"/);
assert.match(visuals[18], /data-miami-energy="0\.000"/);
assert.match(visuals[18], /data-miami-palms="6"/);
assert.equal([...visuals[18].matchAll(/data-miami-ocean-wave="[0-9]+"/g)].length, 5);

for (const svg of visuals) assert.doesNotMatch(svg, /(?:fill|stroke)="hsl\(/);

process.stdout.write("Silent visual state test passed\n");
