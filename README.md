# Valkyrie web flasher (T-Watch S3)

A zero-install, browser-based flasher and landing page for the
[Valkyrie](https://github.com/SeanAnd/T-Watch-Valkyrie) firmware, built on
[ESP Web Tools](https://esphome.github.io/esp-web-tools/). It is a static site
(no build step) intended for GitHub Pages or any HTTPS static host.

The page shows off what the firmware does with animated pixel-art sprites, then
lets a visitor flash their watch in four steps.

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

## The firmware image (self-hosted)

`manifest.json` references the image by relative path, so it must sit next to
`index.html` in this folder:

```
valkyrie-t-watch-s3.factory.bin
```

Since it is served from the same origin as the page, there are no CORS concerns.
The image is flashed as a single part at offset `0` because the factory image
already bundles the bootloader, partition table, and app.

### Producing / refreshing the image

The build emits a version-stamped name
(`firmware-t-watch-s3-valkyrie-<version>.factory.bin`). Build it, then copy it
into this folder under the stable name the manifest expects:

```bash
# from firmware/
bin/build-esp32.sh t-watch-s3-valkyrie
cp release/firmware-t-watch-s3-valkyrie-*.factory.bin \
   ../valkyrie-flasher/valkyrie-t-watch-s3.factory.bin
```

> Prefer to pull from a GitHub Release instead of committing the binary? Set the
> manifest `path` to
> `"https://github.com/SeanAnd/T-Watch-Valkyrie/releases/latest/download/valkyrie-t-watch-s3.factory.bin"`
> and upload the image to each release under that same name.

## Deploy to GitHub Pages

1. Put these files at the root of a public repo (or in `/docs`).
2. **Settings → Pages → Deploy from a branch → `main` / `(root)`**.
3. Open `https://<user>.github.io/<repo>/` in Chrome or Edge on desktop.

GitHub Pages serves HTTPS automatically, which Web Serial requires. The layout
is mobile-first and responsive, but flashing itself still needs a desktop
Chromium browser (Web Serial is not available on iOS/Android browsers in the
same way).

## Updating for a new firmware version

- Rebuild and copy the new image over `valkyrie-t-watch-s3.factory.bin` (keep
  the same filename) using the commands above.
- Bump `version` in `manifest.json` so the version badge on the page updates.

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
