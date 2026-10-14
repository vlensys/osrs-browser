# OSRS Browser

A single-player, offline **Old School RuneScape** engine that runs entirely in the browser — no server,
no install, no plugins. Point it at a game cache you have access to and walk around Gielinor in Chrome or
Firefox on Windows or Linux.

> **No game data is included.** This repository contains only original code. Old School RuneScape and its
> cache are © Jagex Ltd. You supply a cache yourself; it is stored only in your own browser. This is an
> unaffiliated fan project for personal and educational use.

## Quick start

1. Open the app (`npm run dev`, or the GitHub Pages deployment of this repo).
2. Download a cache: on the [OpenRS2 archive](https://archive.openrs2.org/caches) pick a recent
   **oldschool / live** cache and download its **disk.zip** (and `keys.json` for builds before ~237).
3. Click **Choose disk.zip or cache files** and select the zip (or select/drop the extracted cache folder).
4. Play. The cache and your save stay in IndexedDB, so later visits start straight away.

### Controls

| Action | Input |
| --- | --- |
| Walk / default action | Left-click the world or the minimap |
| Context menu (all options, Examine) | Right-click |
| Rotate / tilt camera | Arrow keys, or middle-mouse drag |
| Zoom | Mouse wheel |
| Face north | Click the compass |
| Toggle run | Run orb under the minimap |
| Chat / commands | <kbd>Enter</kbd>, then `::pos`, `::home`, `::tele x y [plane]` |

## What works

- **Modern caches** (tested on build 241, October 2026) and pre-2025 caches with named, XTEA-encrypted maps.
  Decoders cover the current formats, including:
  - 32-bit model ids in loc configs (opcodes 6/7) and conditional sub-options (100–102),
  - region-keyed map groups with u16 terrain opcodes,
  - all model encodings (legacy, v1, v2, v3) including the trailing extension block added in 2024+.
  Every map square, loc definition and all ~62k models in build 241 decode with exact byte accounting
  (`npm run test:cache`).
- **World rendering** (WebGL 2): terrain heights, blended underlays, overlay shapes, bridges, walls, doors,
  scenery, roofs hidden when indoors, distance fog, a live minimap.
- **Game engine** in a Web Worker on the real 600 ms tick: click-to-walk with the client's BFS pathfinder,
  wall/scenery collision, running with energy, right-click menus built from cache ops, examine, opening and
  closing doors, ladders and stairs between planes, and autosave to IndexedDB.

## What doesn't (yet)

The cache holds the client's assets, not the server's game logic. NPC spawns, combat, skills, items,
quests, shops and dialogue live on Jagex's servers and would have to be re-implemented by hand. Textures
are drawn with their average colour, animations are not played, and the player is an original stand-in
figure rather than the game's character models.

## Browser support

| | Chrome / Edge 103+ | Firefox 115+ (incl. ESR) |
| --- | --- | --- |
| Windows 10/11 | ✅ CI | ✅ CI |
| Linux (X11/Wayland) | ✅ CI | ✅ CI |

Only standard, cross-browser APIs are used: WebGL 2, module Web Workers, IndexedDB (Blobs),
`DecompressionStream`, `createImageBitmap` and Pointer Events. Platform-specific details that are handled:
devicePixelRatio scaling (Windows 125%/150%), Firefox's line-based wheel deltas, middle-click
autoscroll/paste, stuck keys after Alt-Tab, WebGL context loss (GPU driver resets), and Firefox's
`storage.persist()` permission prompt (never awaited).

If the page says WebGL 2 is unavailable: in Chrome enable *Use graphics acceleration when available*; in
Firefox check hardware acceleration and that `webgl.disabled` is `false` in `about:config`.

## Development

```sh
npm install
npm run dev          # http://localhost:5173
npm test             # unit tests (uses an original, generated fixture cache)
npm run test:e2e     # Playwright: Chromium + Firefox (builds must exist: npm run build)
npm run build        # static site in dist/ (relative paths, works on any static host / GitHub Pages)
```

Validate the decoders against a real cache (never commit it):

```sh
OSRS_CACHE_DIR=/path/to/extracted/cache npm run test:cache
```

On NixOS, `nix develop` provides Node, matching Playwright browsers and the GL libraries Firefox needs.

### Layout

```
src/cache/     JS5 store: dat2/idx sectors, containers (gzip/bzip2), XTEA, reference tables
src/defs/      Config, map-square and model decoders
src/world/     World state, collision, pathfinding, scene/mesh/minimap building
src/engine/    Game rules, 600 ms tick and the worker that hosts cache + world + game
src/client/    WebGL 2 renderer, camera/input, minimap, menus, chat
src/storage/   IndexedDB, cache import (folder / files / zip with Zip64)
tools/fixture/ Original test-world cache generator used by unit + e2e tests and CI
```

The worker owns the cache and the authoritative game state; the page only renders meshes it receives
(transferred, not copied) and forwards input. Pick ids rendered into an offscreen framebuffer map clicks to
tiles and scenery.

## License

Original code: BSD-2-Clause (see `LICENSE`). Game data and trademarks belong to Jagex Ltd.
