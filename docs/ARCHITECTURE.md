# Architecture

## Runtime data flow

```text
Spotify process audio
        │
        ├─ macOS: ScreenCaptureKit (48 kHz stereo)
        │
        └─ Windows: WASAPI process loopback (48 kHz stereo)
        │
        ▼
Native platform analyser
  FFT · waveform · stereo · chroma · beat
        │ newline-delimited JSON over stdout
        ▼
Node.js Stream Deck plugin
  state · controls · histories · renderers
        │ SVG data URLs over local Stream Deck WebSocket
        ▼
Four or six 200×100 feedback segments
  device-aware views into one continuous canvas
```

## Stream Deck plugin

`bin/plugin.js` owns the interaction and rendering state:

- receives `willAppear`, `willDisappear`, `dialRotate`, `dialUp` and `touchTap` events;
- assigns each encoder its configured track, volume, seek or disabled role, with a track/volume/seek/volume automatic fallback;
- applies per-encoder role changes received from the dial Property Inspector;
- polls Spotify state once per second;
- updates a dedicated Play/Stop key from playback state and fetches the current album cover for overlay-free artwork keys;
- updates Mute/Unmute keys from Spotify volume, remembers the last audible volume and restores it when unmuting;
- reads the artwork placement dropdown and renders either the full cover, an explicitly selected quarter or an automatically assigned quarter from the action's adjacent 2×2 group;
- renders configurable live square crops of all nineteen visualisations on Visual Preset keys and persists press-to-cycle selection changes;
- runs animation frames every 160 ms;
- starts the native analyser only while visualiser mode or at least one live Visual Preset key is active;
- maintains spectrum peaks, waveform persistence and frequency history;
- tracks connected device type and renders four 200-pixel views on Stream Deck + or six 200-pixel views on Stream Deck + XL, scaling the canonical 800×100 artwork across the device's full 800×100 or 1200×100 strip;
- captures fast beat events between the slower Stream Deck render frames.

The plugin uses a local WebSocket supplied by Stream Deck. It does not expose an HTTP server.

## Native analysers

### macOS

`native/AudioAnalyzer.swift`:

1. Requests/preflights Screen Recording permission.
2. Locates the Spotify process using ScreenCaptureKit shareable content.
3. Configures a two-channel, 48 kHz process-audio stream.
4. Preserves left and right samples while also producing a mono analysis window.
5. Runs an 8,192-point Hann-windowed FFT.
6. Emits 40 logarithmic bands spanning 45 Hz–16 kHz.
7. Produces a zero-crossing-triggered waveform with percentile-based gain.
8. Produces independently normalised stereo samples and a correlation value.
9. Maps FFT energy from C2–C8 into twelve pitch classes.
10. Calculates RMS, peak, three broad frequency regions and a bass-derived beat envelope.

The build script cross-compiles `arm64` and `x86_64`, combines them with `lipo`, then signs the universal helper using the stable identifier `com.punklabs.prismbeat.audio-analyzer`. Development builds use an ad-hoc signature. Release builds require a `Developer ID Application` identity from the Punk Labs Apple team (`CNFJQQGQD4`) and receive a hardened-runtime signature with a secure timestamp. The script refuses identities from every other team.

### Windows

`native/windows/` provides a self-contained .NET 9 helper for Windows x64 and ARM64. It:

1. Finds Spotify's active Windows audio session and process.
2. Uses Windows 10 2004+ process-loopback capture, excluding other application and notification audio.
3. Requests 48 kHz stereo IEEE-float samples.
4. Produces the same 40-band FFT, waveform, stereo, chromagram and energy protocol as the macOS analyser.
5. Uses Global System Media Transport Controls for now-playing state and transport controls.
6. Uses Spotify's Windows audio session for app-specific volume.

The plugin selects the x64 or ARM64 helper from the host Node.js architecture. Both are published self-contained, so customers do not need to install .NET.

## Analyser protocol

The analyser writes newline-delimited JSON. Lifecycle messages are:

```json
{"status":"ready"}
```

or:

```json
{"status":"error","code":"permission","message":"…"}
```

Audio frames contain:

| Field | Shape | Meaning |
| --- | --- | --- |
| `bands` | 40 values, 0–1 | Low-to-high logarithmic spectrum |
| `waveform` | 256 values, -1–1 | Triggered mono oscilloscope samples |
| `stereoLeft` | 256 values, -1–1 | Normalised left-channel samples |
| `stereoRight` | 256 values, -1–1 | Normalised right-channel samples |
| `stereoCorrelation` | -1–1 | Left/right phase correlation |
| `chroma` | 12 values, 0–1 | Pitch classes, C=0 through B=11 |
| `rms` | 0–1 | Normalised loudness |
| `peak` | 0–1 | Absolute sample peak |
| `bass` | 0–1 | Low-frequency energy |
| `mid` | 0–1 | Mid-frequency energy |
| `treble` | 0–1 | High-frequency energy |
| `beat` | 0–1 | Bass-transient envelope |

## Spotify state and controls

On macOS, the plugin ships its own JavaScript for Automation scripts:

```text
scripts/spotify-state.js
scripts/spotify-control.js
```

On Windows, `prismbeat-windows.exe` uses the native Windows media-session APIs for playback state, metadata, artwork, transport, seek, shuffle and repeat, and the Spotify audio session for volume. Clipboard operations use the local Windows clipboard. Windows media sessions do not expose Spotify's track URI, so Copy Track Link falls back to a Spotify search URL for the current artist and title. These integrations run locally; the plugin does not depend on Elgato's Spotify plugin.

## Privacy and permissions

- Screen Recording permission is required on macOS because ScreenCaptureKit provides process audio under that privacy category.
- Windows uses process-loopback capture and does not capture from the microphone.
- Capture is filtered to Spotify on both platforms.
- Audio samples and analysis frames remain in memory.
- No audio recording is created.
- The plugin should retain clear first-run permission messaging as it is productised.
