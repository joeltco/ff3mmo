// moderation.js — server-side name + chat content moderation for open beta.
//
// Pure module (no I/O, no browser deps) so both `api.js` and `ws-presence.js`
// import it. Two jobs:
//   1. sanitizeName  — strip a display name down to glyphs the in-game font
//      can actually render, killing emoji / zero-width / homoglyph spoofs.
//   2. cleanChatText — mask profanity in chat; isCleanName rejects it in names.
//
// The profanity match is deliberately pragmatic, not perfect. Slurs + strong
// swears are matched as a substring of a "canonicalized" token (de-leetspeak,
// letters-only, collapsed repeats) so "f.u.c.k", "$hit", "fuuuck", "phuck"-
// style evasions still catch. Mild/ambiguous words use an exact canonical
// match to dodge the Scunthorpe problem ("class" ≠ "ass", "hello" ≠ "hell").
// Masking only changes what's displayed — it never drops the message — so a
// rare false-positive is annoying, not destructive. Tune the lists freely.

// Glyphs text-utils.js#_nameToBytes can draw: A-Z a-z 0-9 space + a little
// punctuation. Everything else is stripped from names.
const NAME_DISALLOWED = /[^A-Za-z0-9 .,'\-!?]/g;
const NAME_MAX = 16;

const LEET = { '4': 'a', '@': 'a', '3': 'e', '1': 'i', '!': 'i', '0': 'o', '5': 's', '$': 's', '7': 't', '+': 't' };

// Canonical form of a single token: lowercase → de-leet → letters only →
// collapse runs of the same letter ("fuuuck" → "fuck", "ass" → "as").
function _canon(token) {
  return String(token)
    .toLowerCase()
    .replace(/[4@31!05$7+]/g, c => LEET[c] || c)
    .replace(/[^a-z]/g, '')
    .replace(/(.)\1+/g, '$1');
}

// HARD — slurs + strong swears unlikely to live inside a clean word. Matched
// as a substring of the canonical token, so inflections ("fucking") and
// run-ons ("you<slur>") still catch. Stored pre-canonicalized.
const HARD = ['fuck', 'shit', 'cunt', 'bitch', 'pussy', 'slut', 'whore', 'fag',
  'nigger', 'nigga', 'retard', 'rape', 'kike', 'spic', 'chink', 'tranny']
  .map(_canon);

// WORD — milder / ambiguous terms. Exact canonical match only (no substring),
// so they don't trip on clean words that merely contain the letters.
const WORD = new Set(['ass', 'asshole', 'damn', 'dick', 'cock', 'piss', 'crap',
  'bastard', 'wank', 'twat', 'dyke']
  .map(_canon));

function _isProfaneToken(token) {
  const c = _canon(token);
  if (!c) return false;
  for (const w of HARD) if (w && c.includes(w)) return true;
  return WORD.has(c);
}

// Mask any profane whitespace-token with same-length asterisks, preserving the
// original spacing so the sentence still reads naturally.
export function cleanChatText(text) {
  return String(text)
    .split(/(\s+)/)
    .map(tok => (/\s/.test(tok) || !_isProfaneToken(tok))
      ? tok
      : '*'.repeat(tok.length))
    .join('');
}

// Strip a raw display name to renderable glyphs, collapse whitespace, trim,
// cap length. Returns '' when nothing renderable survives (caller substitutes
// a default).
export function sanitizeName(raw) {
  return String(raw == null ? '' : raw)
    .replace(NAME_DISALLOWED, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}

// True when a (pre-sanitized) name carries no profanity in any token.
export function isCleanName(name) {
  return !String(name).split(/\s+/).some(_isProfaneToken);
}
