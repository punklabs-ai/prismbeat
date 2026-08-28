function run(argv) {
  const [rawCommand, ...args] = argv || [];
  const command = String(rawCommand || "").toLowerCase();
  const spotify = Application("Spotify");
  if (!spotify.running()) throw new Error("Spotify is not running");

  if (command === "play") spotify.play();
  else if (command === "pause" || command === "stop") spotify.pause();
  else if (command === "playpause") {
    if (normalizedState(spotify.playerState()) === "playing") spotify.pause();
    else spotify.play();
  } else if (command === "next") spotify.nextTrack();
  else if (command === "previous") spotify.previousTrack();
  else if (command === "setvolume") setVolume(spotify, args[0]);
  else if (command === "changevolume") {
    setVolume(spotify, Number(spotify.soundVolume()) + Number(args[0] || 0));
  } else if (command === "setshuffling") spotify.shuffling = parseBoolean(args[0]);
  else if (command === "setrepeating") spotify.repeating = parseBoolean(args[0]);
  else if (command === "skipbyseconds") {
    spotify.playerPosition = Math.max(
      0,
      Number(spotify.playerPosition()) + Number(args[0] || 0),
    );
  } else if (command === "restart") {
    spotify.playerPosition = 0;
  } else {
    throw new Error(`Unknown Spotify command: ${command}`);
  }
  return "ok";
}

function setVolume(spotify, value) {
  const target = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const compensated =
    target === 0 || target === 40 || target === 60 || target === 80 || target === 100
      ? target
      : target + 1;
  spotify.soundVolume = compensated;
}

function parseBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function normalizedState(value) {
  return String(value || "").toLowerCase().includes("playing") ? "playing" : "paused";
}
