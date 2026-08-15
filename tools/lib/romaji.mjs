// romaji.mjs — kana -> Latin, so FF2's cast is readable on a sheet.
//
// FF2 is the Japanese ROM; every name in it is kana. `@napi-rs/canvas` has no
// CJK glyphs unless a font is registered, and even with one registered a sheet
// full of kana is unreadable to anyone who does not read kana. So labels get
// transliterated.
//
// ⛔ This is a READING AID, not a translation, and NOT a source of truth. The
// authoritative text stays in `tools/lib/ff2-text.mjs` and the dialogue dumps.
// Nothing in the game should ever be named from this file's output — Hepburn
// gives "Hiruda" where the official localisation says "Hilda".
//
// Hepburn, with the four things a naive table gets wrong:
//   っ/ッ  doubles the NEXT consonant        こっち  -> kotchi
//   ゃゅょ  fuses with the i-column           きょ    -> kyo, しゃ -> sha
//   ぁぃぅぇぉ replaces the preceding vowel   フォ    -> fo,  ティ -> ti
//   ー      lengthens the preceding vowel     カー    -> kaa

/** Katakana sits exactly 0x60 above hiragana, so one table serves both. */
const toHira = (c) => {
  const v = c.codePointAt(0);
  return (v >= 0x30A1 && v <= 0x30F6) ? String.fromCodePoint(v - 0x60) : c;
};

const BASE = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', を: 'wo', ん: 'n',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
};

/** i-column + small y-kana. sh/ch/j drop the y: しゃ = sha, not shya. */
const YOON = {
  き: 'ky', ぎ: 'gy', し: 'sh', じ: 'j', ち: 'ch', ぢ: 'j',
  に: 'ny', ひ: 'hy', び: 'by', ぴ: 'py', み: 'my', り: 'ry',
};
const SMALL_Y = { ゃ: 'a', ゅ: 'u', ょ: 'o' };
const SMALL_V = { ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o' };
const VOWELS = 'aiueo';

/** True when a kana glyph carries no Latin reading (punctuation, brackets). */
const isKana = (c) => BASE[c] !== undefined || SMALL_Y[c] !== undefined ||
  SMALL_V[c] !== undefined || c === 'っ' || c === 'ー';

export function romaji(text) {
  const k = [...String(text)].map(toHira);
  let out = '';
  let geminate = false;

  for (let i = 0; i < k.length; i++) {
    const c = k[i];
    const next = k[i + 1];

    if (c === 'っ') { geminate = true; continue; }

    if (c === 'ー') {
      // repeat the last vowel we emitted; a bare ー with nothing before it
      // is dropped rather than guessed at.
      const last = out[out.length - 1];
      if (VOWELS.includes(last)) out += last;
      continue;
    }

    // small vowel replaces the preceding syllable's vowel: フォ -> fo
    if (SMALL_V[c] !== undefined) {
      if (VOWELS.includes(out[out.length - 1])) {
        // う + small vowel is a w-glide (ウィ -> wi), not a bare vowel
        out = out.slice(0, -1) + (out.endsWith('u') && !out.slice(0, -1).match(/[bcdfghjklmnpqrstvwxyz]$/)
          ? 'w' : '') + SMALL_V[c];
      } else out += SMALL_V[c];
      continue;
    }

    // small ya/yu/yo is only meaningful after the i-column
    if (SMALL_Y[c] !== undefined) { out += 'y' + SMALL_Y[c]; continue; }

    let syl = BASE[c];
    if (syl === undefined) {
      // not kana — pass it through untouched (digits, 【 】, punctuation)
      out += c;
      geminate = false;
      continue;
    }

    if (SMALL_Y[next] !== undefined && YOON[c] !== undefined) {
      syl = YOON[c] + SMALL_Y[next];
      i++;
    }

    // ん before a labial reads as m in Hepburn: しんぶん -> shimbun
    if (c === 'ん' && next && /^[bpm]/.test(BASE[next] || '')) syl = 'm';

    if (geminate) {
      // っ doubles the consonant that follows; ch doubles as t (こっち = kotchi)
      const m = /^(ch|[bcdfghjklmnpqrstvwxyz])/.exec(syl);
      if (m) out += (m[1] === 'ch' ? 't' : m[1]);
      geminate = false;
    }
    out += syl;
  }
  return out;
}

/** "ヒルダ" -> "Hiruda". Each run of kana is capitalised on its own. */
export function romajiName(text) {
  const r = romaji(text);
  return r.replace(/(^|[^a-z])([a-z])/g, (_, p, c) => p + c.toUpperCase());
}

/** Does this string contain kana at all? Used to decide whether to annotate. */
export const hasKana = (text) => [...String(text)].some(c => isKana(toHira(c)));
