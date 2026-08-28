function run() {
  const fallback = stoppedState();
  let spotify;
  try {
    spotify = Application("Spotify");
    if (!spotify.running()) return JSON.stringify(fallback);
  } catch {
    return JSON.stringify(fallback);
  }

  try {
    const state = normalizedState(safe(() => spotify.playerState(), "stopped"));
    const track = state === "stopped" ? null : safe(() => spotify.currentTrack(), null);
    const duration = Number(safe(() => (track ? track.duration() : 0), 0)) || 0;
    const positionSeconds = Number(safe(() => spotify.playerPosition(), 0)) || 0;
    const shuffleActive = Boolean(safe(() => spotify.shuffling(), false));
    const repeatActive = Boolean(safe(() => spotify.repeating(), false));
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      isRunning: true,
      player: {
        version: String(safe(() => spotify.version(), "")),
        state,
        autoRepeatMode: repeatActive ? "Playlist" : "None",
        isShuffleActive: shuffleActive,
        isShuffleEnabled: Boolean(safe(() => spotify.shufflingEnabled(), false)),
        isRepeatActive: repeatActive,
        isRepeatEnabled: Boolean(safe(() => spotify.repeatingEnabled(), false)),
        volume: Number(safe(() => spotify.soundVolume(), 0)) || 0,
        lastPosition: Math.floor(positionSeconds),
      },
      currentTrack: track
        ? {
            id: String(safe(() => track.id(), "")),
            spotifyUrl: String(safe(() => track.spotifyUrl(), "")),
            title: String(safe(() => track.name(), "")),
            artist: String(safe(() => track.artist(), "")),
            album: String(safe(() => track.album(), "")),
            albumArtist: String(safe(() => track.albumArtist(), "")),
            duration,
            durationSeconds: Math.floor(duration / 1000),
            positionSeconds,
            positionPercent: duration > 0 ? (positionSeconds * 1000 * 100) / duration : 0,
            trackNumber: Number(safe(() => track.trackNumber(), 0)) || 0,
            artworkUrl: String(safe(() => track.artworkUrl(), "")),
          }
        : fallback.currentTrack,
    });
  } catch {
    return JSON.stringify(fallback);
  }
}

function safe(read, fallback) {
  try {
    const value = read();
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function normalizedState(value) {
  const state = String(value || "").toLowerCase();
  if (state.includes("playing")) return "playing";
  if (state.includes("paused")) return "paused";
  return "stopped";
}

function stoppedState() {
  return {
    timestamp: new Date().toISOString(),
    isRunning: false,
    player: {
      version: "",
      state: "stopped",
      autoRepeatMode: "None",
      isShuffleActive: false,
      isShuffleEnabled: false,
      isRepeatActive: false,
      isRepeatEnabled: false,
      volume: 0,
      lastPosition: 0,
    },
    currentTrack: {
      id: "",
      spotifyUrl: "",
      title: "",
      artist: "",
      album: "",
      albumArtist: "",
      duration: 0,
      durationSeconds: 0,
      positionSeconds: 0,
      positionPercent: 0,
      trackNumber: 0,
      artworkUrl: "",
    },
  };
}
