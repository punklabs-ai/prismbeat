#!/usr/bin/env node

process.stdout.write(`${JSON.stringify({ status: "ready" })}\n`);
const timer = setInterval(() => {
  process.stdout.write(
    `${JSON.stringify({
      bands: Array(40).fill(0),
      waveform: Array(256).fill(0),
      stereoLeft: Array(256).fill(0),
      stereoRight: Array(256).fill(0),
      stereoCorrelation: 0,
      chroma: Array(12).fill(0),
      rms: 0,
      peak: 0,
      bass: 0,
      mid: 0,
      treble: 0,
      beat: 0,
    })}\n`,
  );
}, 25);

process.on("SIGTERM", () => {
  clearInterval(timer);
  process.exit(0);
});
