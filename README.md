# PrismBeat

PrismBeat is a free, open-source Stream Deck plugin for Spotify. It adds
audio-reactive visualisations, a now-playing display, album artwork, playback
controls and configurable dials.

The full touch-strip experience works on Stream Deck + and Stream Deck + XL.
Keypad actions also work on Stream Deck XL.

## Requirements

- macOS 13 or later, or Windows 10 build 19041 or later
- Stream Deck 6.9 or later
- Spotify desktop
- Node.js 20 for development
- Xcode command-line tools for the macOS helper
- .NET 9 SDK for the Windows helpers

macOS requires Screen Recording permission so PrismBeat can capture Spotify
audio. Windows uses Spotify process capture and does not use the microphone.
Audio is analysed locally and is never recorded or uploaded.

## Build

```sh
cd com.punklabs.prismbeat.sdPlugin
npm ci
npm run build:audio
npm run build:windows
npm test
```

For local installation, copy `com.punklabs.prismbeat.sdPlugin` to the Stream
Deck plugins directory and restart Stream Deck:

- macOS: `~/Library/Application Support/com.elgato.StreamDeck/Plugins/`
- Windows: `%APPDATA%\Elgato\StreamDeck\Plugins\`

## Links

- Website: [prismbeat.app](https://prismbeat.app/)
- Support: [prismbeat.app/support](https://prismbeat.app/support)
- Privacy: [prismbeat.app/privacy](https://prismbeat.app/privacy)

## Licence

Source code is licensed under the [Apache License 2.0](LICENSE). PrismBeat brand
and media assets are not included in that licence; see [ASSETS.md](ASSETS.md).

PrismBeat is not affiliated with or endorsed by Spotify or Elgato.
