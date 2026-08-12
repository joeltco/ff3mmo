// limits.js — persistence bounds shared by the client and the server.
//
// These two numbers were duplicated: the client owned them, and `api.js`
// hardcoded copies inside `_validateSaveData` with comments reading "mirror
// MAX_LEVEL in src/player-stats.js" and "MUST match INV_CAP in
// src/inventory.js". A comment is not a mechanism — the server CLAMPS saves to
// them, so a drift would silently truncate a real player's level or bag order
// on every save, and the only symptom would be lost progress.
//
// This module is a leaf on purpose: no imports, so the server can read it
// without pulling in the client's stat system. v1.7.863.

/** Character level cap. v1.7.943 — raised from 5 to 10. */
export const MAX_LEVEL = 10;

/** Max distinct inventory slots (v1.7.689 — was 8 from v1.7.599). */
export const INV_CAP = 16;
