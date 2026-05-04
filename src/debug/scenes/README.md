# EMU debugger — scene library

Committed savestates of canonical FF3 NES moments, loaded on demand from the EMU tab's `SCENES` panel. Each scene is a paused jsnes savestate plus a small metadata header.

## Why

Single-slot localStorage means every capture clobbers the previous one, and savestates don't survive a different person's browser. The scene library makes specific captured moments **portable across machines and browsers** — anyone who clones the repo gets the same set of "load to here" buttons. Useful for:

- Pair work over SSH (one captures, the other can navigate to the exact same frame)
- Reproducing visual bugs at a known reference frame
- Onboarding for new sprite-capture work — load the scene, hit `SNAP OAM`, done

## File layout

- `index.json` — array of scene metadata (name, description, captured date, frame). The EMU tab fetches this and renders one button per entry.
- `<name>.json` — full scene file. Same fields as the index entry, plus `state` containing the slim jsnes `toJSON()` output (no `romData` — re-attached at load time from the running emulator's `nes.romData`).

## Adding a new scene

1. In the EMU tab, navigate to the moment you want.
2. Pause.
3. Open the `SCENES` panel, fill in `name` (lowercase letters, digits, hyphens) and `description`.
4. Tap `EXPORT SCENE` → the scene JSON appears in the output textarea.
5. Tap `SAVE FILE` (downloads `<name>.json`) **or** copy the JSON.
6. Commit the scene file to `src/debug/scenes/<name>.json` and add a metadata entry to `index.json`:
   ```json
   {
     "name": "ur-magic-shop",
     "description": "Cure hovered at counter",
     "captured": "2026-05-04",
     "frame": 12345
   }
   ```
7. Deploy. The new scene appears in everyone's `SCENES` panel after they refresh.

## Schema

Index entry (in `index.json`):

```json
{
  "name": "string — file basename, also display label",
  "description": "string — one-line gist",
  "captured": "YYYY-MM-DD",
  "frame": 12345
}
```

Scene file (`<name>.json`):

```json
{
  "name": "string",
  "description": "string",
  "captured": "YYYY-MM-DD",
  "frame": 12345,
  "state": { /* jsnes.toJSON() output with romData stripped */ }
}
```

## Notes

- Scene JSON files run **100–500 KB** each. Keep the library curated; don't ship every scratch capture.
- `state` aliases live arrays from the running NES at capture time. The EMU tab parses a fresh copy via `JSON.parse` on every load to avoid mutation drift (same fix as savestate slots in v1.6.98).
- `romData` is intentionally absent. The fetch path attaches `nes.romData` before calling `nes.fromJSON(state)`.
