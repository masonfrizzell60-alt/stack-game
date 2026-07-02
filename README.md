# STACK — Tower Builder

Standalone copy of the STACK tower-builder game (live at
[stack.peaktiktok.com](https://stack.peaktiktok.com/)). This repo is your own
working version so you can iterate freely without touching the production
`ball-game-mine` / peaktiktok hub.

## Run it

```bash
npm start
```

Then open http://localhost:5173

No build step and no dependencies to install — three.js is loaded from CDN and
everything else is plain HTML/CSS/JS.

## Structure

- `index.html` — game shell + all the sky / region background layers
- `game.js` — the three.js game (tower stacking, physics, scoring)
- `audio.js` — sound
- `style.css`, `elemental.css`, `region-detail.css` — visuals for the zones
  (Ocean / Jungle / Storm / Frozen) and depth layers
- `lib/` — three.js post-processing (bloom, line rendering) shaders
- `overlay.html` — TikTok Live stream overlay
- `gate.js` — no-op stub here (the real Discord/Peak access gate lives in the hub)

## Notes

The original enforces a Discord "Peak role" login via a server-side gate. That
gating is intentionally stripped from this standalone copy so it just runs.
