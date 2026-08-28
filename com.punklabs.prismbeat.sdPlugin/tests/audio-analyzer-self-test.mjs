import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const analyzer = join(pluginRoot, "bin/audio-analyzer");
const frame = runAnalyzer(["--self-test"]);

assert.equal(frame.bands.length, 40);
assert.equal(frame.waveform.length, 256);
assert.equal(frame.stereoLeft.length, 256);
assert.equal(frame.stereoRight.length, 256);
assert.equal(frame.chroma.length, 12);
assert.ok(frame.stereoCorrelation >= -1 && frame.stereoCorrelation <= 1);
assert.ok(frame.rms > 0.5);
assert.ok(frame.bass > 0.1);
assert.ok(frame.mid > 0.1);
assert.ok(frame.treble > 0.1);
assert.ok(frame.bands.some((level) => level > 0.7));

const toneTests = [
  { frequency: 90, label: "bass" },
  { frequency: 1_000, label: "mid" },
  { frequency: 8_000, label: "treble" },
];
const detectedBands = toneTests.map(({ frequency, label }) => {
  const toneFrame = runAnalyzer(["--test-tone", String(frequency)]);
  const strongestLevel = Math.max(...toneFrame.bands);
  const strongestBand = toneFrame.bands.indexOf(strongestLevel);
  const expectedBand = Math.max(
    0,
    Math.min(
      39,
      Math.floor((Math.log(frequency / 45) / Math.log(16_000 / 45)) * 40),
    ),
  );
  assert.ok(strongestLevel > 0.5, `${label} tone should produce a strong FFT band`);
  assert.ok(
    Math.abs(strongestBand - expectedBand) <= 2,
    `${label} tone detected in band ${strongestBand}, expected near ${expectedBand}`,
  );
  return strongestBand;
});

assert.ok(detectedBands[0] < detectedBands[1]);
assert.ok(detectedBands[1] < detectedBands[2]);

const balancedFrame = runAnalyzer(["--test-balanced-bands"]);
const regionLevels = [
  average(balancedFrame.bands.slice(0, 13)),
  average(balancedFrame.bands.slice(13, 27)),
  average(balancedFrame.bands.slice(27, 40)),
];
assert.ok(
  Math.max(...regionLevels) - Math.min(...regionLevels) < 0.08,
  `equal logarithmic-band energy should render evenly: ${regionLevels.join(", ")}`,
);

const oscilloscopeFrame = runAnalyzer(["--test-tone", "440"]);
const risingCrossings = oscilloscopeFrame.waveform.reduce(
  (count, sample, index, waveform) =>
    index > 0 && waveform[index - 1] <= 0 && sample > 0 ? count + 1 : count,
  0,
);
assert.equal(oscilloscopeFrame.waveform.length, 256);
assert.ok(
  Math.abs(oscilloscopeFrame.waveform[0]) < 0.15,
  "triggered waveform should begin close to a zero crossing",
);
assert.ok(
  oscilloscopeFrame.waveform[1] > oscilloscopeFrame.waveform[0],
  "triggered waveform should begin on a rising edge",
);
assert.ok(
  risingCrossings >= 12 && risingCrossings <= 16,
  `440 Hz trace should retain its real frequency across the 32 ms window; found ${risingCrossings} cycles`,
);
assert.equal(
  oscilloscopeFrame.chroma.indexOf(Math.max(...oscilloscopeFrame.chroma)),
  9,
  "440 Hz should resolve to pitch class A (C=0, A=9)",
);
assert.equal(oscilloscopeFrame.stereoCorrelation, 1);

const stereoFrame = runAnalyzer(["--test-stereo"]);
assert.equal(stereoFrame.stereoLeft.length, 256);
assert.equal(stereoFrame.stereoRight.length, 256);
assert.ok(
  stereoFrame.stereoLeft.some(
    (sample, index) => Math.abs(sample - stereoFrame.stereoRight[index]) > 0.2,
  ),
  "stereo scope channels should retain their independent samples",
);
assert.ok(
  Math.abs(stereoFrame.stereoCorrelation) < 0.25,
  `quadrature stereo test should have low correlation; found ${stereoFrame.stereoCorrelation}`,
);

process.stdout.write("Native FFT analyzer self-test passed\n");

function runAnalyzer(arguments_) {
  const output = execFileSync(analyzer, arguments_, { encoding: "utf8" });
  return JSON.parse(output.trim());
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
