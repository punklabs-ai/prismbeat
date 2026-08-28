#!/usr/bin/env node

let frame = 0;

process.stdout.write(`${JSON.stringify({ status: "ready" })}\n`);
const timer = setInterval(() => {
  frame += 1;
  const bands = Array.from({ length: 40 }, (_, index) =>
    Math.max(0, Math.min(1, 0.5 + Math.sin(frame * 0.7 + index * 0.43) * 0.45)),
  );
  const waveform = Array.from({ length: 256 }, (_, index) =>
    Math.sin((index / 256) * Math.PI * 14 + frame * 0.18) * 0.8,
  );
  const stereoLeft = Array.from({ length: 256 }, (_, index) =>
    Math.sin((index / 256) * Math.PI * 18 + frame * 0.21) * 0.78,
  );
  const stereoRight = Array.from({ length: 256 }, (_, index) =>
    Math.sin((index / 256) * Math.PI * 18 + frame * 0.21 + 0.9) * 0.62 +
      Math.sin((index / 256) * Math.PI * 7 - frame * 0.13) * 0.18,
  );
  const chordRoot = Math.floor(frame / 18) % 12;
  const chroma = Array.from({ length: 12 }, (_, pitchClass) => {
    const interval = (pitchClass - chordRoot + 12) % 12;
    if (interval === 0) return 0.94;
    if (interval === 4) return 0.76;
    if (interval === 7) return 0.84;
    return 0.04 + Math.max(0, Math.sin(frame * 0.12 + pitchClass)) * 0.12;
  });
  process.stdout.write(
    `${JSON.stringify({
      bands,
      waveform,
      stereoLeft,
      stereoRight,
      stereoCorrelation: 0.18,
      chroma,
      rms: 0.72,
      peak: 0.88,
      bass: 0.8,
      mid: 0.62,
      treble: 0.7,
      beat: frame % 16 === 0 ? 1 : 0.15,
    })}\n`,
  );
}, 25);

process.on("SIGTERM", () => {
  clearInterval(timer);
  process.exit(0);
});
