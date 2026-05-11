// HUD state — fade timers, top-box strip, loading-screen sprite caches.
// Single `hudSt` object so consumers read/write live values through object properties.

export const hudSt = {
  // ── HUD fade timers ───────────────────────────────────────────────
  hudInfoFadeTimer: 0,     // ms; advances toward HUD_INFO_FADE_STEPS * HUD_INFO_FADE_STEP_MS
  hudHpLvStep: 0,          // crossfade step between Lv row and HP row (0..HUD_INFO_FADE_STEPS)
  hudHpLvTimer: 0,         // ms accumulator for HP/Lv step advance
  playerDeathTimer: null,  // null = alive; number = ms into death animation

  // ── Top-box strip (256×32 above viewport) ─────────────────────────
  topBoxMode: 'name',      // 'name' | 'battle'
  topBoxBgCanvas: null,    // pre-rendered BG strip (frame 0)
  topBoxBgFadeFrames: null, // [original, step1, step2, ..., black]

  // ── Loading-screen sprite caches (init-once from ROM) ─────────────
  loadingBgFadeFrames: null, // battle BG fade frames for loading screen
  moogleFadeFrames: null,    // [bright, step1, step2, black] per walk frame pair
  bossFadeFrames: null,      // same structure for adamantoise
  adamantoiseFrames: null,   // [normal, flipped] canvases
  moogleFrames: null,        // [normal, flipped] canvases
  invincibleFrames: null,    // [frameA, frameB] 32×32 canvases (east-facing)
};

// Timing constants — shared so consumers don't need local copies
export const HUD_INFO_FADE_STEPS = 4;
export const HUD_INFO_FADE_STEP_MS = 200;
export const HUD_HPLV_STEP_MS = 60;
