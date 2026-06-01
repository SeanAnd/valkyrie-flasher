# Valkyrie web flasher (T-Watch S3)

A zero-install, browser-based flasher and landing page for the
[Valkyrie](https://github.com/SeanAnd/T-Watch-Valkyrie) firmware, built on
[ESP Web Tools](https://esphome.github.io/esp-web-tools/). It is a static site
(no build step) intended for GitHub Pages or any HTTPS static host.

The page shows off Valkyrie's BLE / Wi-Fi threat scanning, wardriving,
Meshtastic mesh participation and RPG-style leveling with animated pixel-art
sprites, then lets a visitor flash their watch in four steps.

## Files

| File / folder | Purpose |
|---------------|---------|
| `index.html` | Page markup: hero, interactive watch demo, flash steps, feature cards, footer, and the `<esp-web-install-button>`. |
| `styles.css` | All styling: dark + cyan theme, mobile-first responsive layout, sprite/sweep/pulse animations, ESP Web Tools color variables, reduced-motion fallbacks. |
| `app.js` | Behavior only (cosmetic): sprite frame-cyclers, the interactive watch-state demo, fade-in on scroll, and the version badge read from `manifest.json`. |
| `manifest.json` | Tells ESP Web Tools which image to flash (ESP32-S3, single factory image at offset `0`). The `version` field drives the version badge on the page. |
| `valkyrie-t-watch-s3.factory.bin` | The firmware image, served from this folder alongside the page. |
| `animations/` | 88x88 transparent pixel sprites in `start*` (intro) + `*Loop*` (loop) sequences for `sleeping`, `bleScanning`, `wifiScanning`, `wardriving`, `heartbeat`. |

Concerns are split across the three top-level files (`index.html` for
structure, `styles.css` for presentation, `app.js` for behavior) so the page
stays easy to theme and maintain.

## Flashing flow

Connecting, viewing **Logs & Console**, and installing all happen inside the
standard ESP Web Tools dialog when the visitor clicks **Flash Valkyrie**. The
page itself only themes the button and surrounds it with marketing/help
content; it does not implement its own serial console.

## How the demo works

- **Sprites:** the frames are individual PNGs, so `app.js` swaps an `<img>`
  `src` through each sequence (~5-7 fps). The interactive watch plays a
  state's `start*` intro once and then loops its `*Loop*` frames.
- **States:** the watch demo cycles `BLE scan → Wi-Fi scan → Heartbeat →
  Wardrive → Sleeping`, auto-advancing every ~6.5 s and pausing while the user
  hovers/focuses it. Tapping a chip jumps straight to that state.
- **Motion:** everything respects `prefers-reduced-motion` (no frame cycling,
  no auto-advance, no fade-in) and animations only run while on screen.

## Cables

Different T-Watch revisions use either micro-USB or USB depending on the
version, so the instructions just say "a USB data cable." There are no
connector-specific references to keep in sync.

```bash
# from firmware/
bin/build-esp32.sh t-watch-s3-valkyrie
cp release/firmware-t-watch-s3-valkyrie-*.factory.bin \
   ../valkyrie-flasher/valkyrie-t-watch-s3.factory.bin
```

## Requirements / limitations

- Flashing works only in Chromium-based desktop browsers (Chrome, Edge, Opera)
  because Web Serial is unavailable in Safari, Firefox, and on iOS.
- Must be served over HTTPS (or `http://localhost` for local testing).
- Keep the Windows `flash-valkyrie.bat` package as a fallback for unsupported
  browsers.

## Test locally

Web Serial treats `http://localhost` as a secure context, so a plain static
server works:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/ in Chrome
```
