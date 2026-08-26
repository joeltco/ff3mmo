#!/usr/bin/env node
// audit-quests.mjs — drive the quest system looking for holes, not for
// regressions.
//
// `check-quests.mjs` walks the ONE happy path and passes. That is the whole
// problem: it asserts the loop it was written against, so everything the loop
// never does is unexamined. This harness pushes on the parts a second quest, a
// force-quit, or a modded client would hit, using the REAL modules.
//
// Findings print as [HOLE]; each is reproduced, not reasoned about.
//
//   node tools/audit-quests.mjs

import { createCanvas } from '@napi-rs/canvas';
import fs from 'node:fs';

globalThis.document = { createElement: (t) => (t === 'canvas' ? createCanvas(1, 1) : {}) };

const { ps } = await import('../src/player-stats.js');
const { QUESTS } = await import('../src/data/quests.js');
const q = await import('../src/quests.js');

const holes = [];
const hole = (title, detail) => { holes.push(title); console.log(`\n[HOLE] ${title}\n       ${detail}`); };
const okay = (m) => console.log(`  ok   ${m}`);

const QID = 'ur_missing_brother';
const quest = QUESTS[QID];
// ⭐ Stage-aware. `quest.giver` is gone: stage 0 is who you ASK, the last stage
// is who you hand in to. For the Ur quests those are the same man, which is why
// the port could be behaviour-preserving.
const S0 = quest.stages[0];
const SLAST = quest.stages[quest.stages.length - 1];
const { map: mapId, npc: npcKey } = SLAST.at;
const OBJ_COUNT = SLAST.objective.count;
const ACTIVE_STAGE = SLAST.id;
const raw = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
// ⛔ Source checks read CODE, never comments. The first cut of this harness
// tested `/saveSlotsToDB/.test(src)` and `/reward\.item/.test(body)` against the
// raw file — and passed on a reverted fix, because the comment ABOVE the
// deleted code still named the symbol. A gate a comment can satisfy is not a
// gate. Everything below runs on the stripped text.
const _strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const src = (p) => _strip(raw(p));

// ── 1. hand-in pays, but nothing persists the hand-in ─────────────────────
// The reward is wire-managed gil (sendNetInvEvent hits the server mirror the
// moment it is granted) while `ps.quests[id].s = 'done'` lives only in memory
// until something calls saveSlotsToDB. Nothing on the completion path does.
// So: the money is durable and the "I already paid you" flag is not.
console.log('\n── 1. reward durability vs quest-state durability');
{
  const paths = ['src/quests.js', 'src/npc.js'];
  const code = src('src/quests.js');
  // The hand-in branch itself must persist, and so must acceptQuest — a quest
  // taken and not saved loses the ACCEPT, not just the payout.
  const handIn = /function _advance\([\s\S]{0,900}?(_persist\(\)|saveSlotsToDB\(\))/.test(code);
  // ⛔ FOLLOW THE CALL, don't grep one function body. `acceptQuest` persists via
  // `_startQuest`, which is also what the offer-on-sight path uses — a regex
  // that only looked inside acceptQuest's own braces would report a hole that
  // is not there, and would keep reporting it however the code is factored.
  const accept = /export function acceptQuest[\s\S]{0,400}?_startQuest\(/.test(code)
              && /function _startQuest\([\s\S]{0,400}?(_persist\(\)|saveSlotsToDB\(\))/.test(code);
  const wired  = /(_persist\s*=|function _persist)[\s\S]{0,200}?saveSlotsToDB\(\)/.test(code);
  if (handIn && accept && wired) okay('the completion path persists the quest state');
  else {
    // Reproduce the replay: save at "objective met, not handed in", collect,
    // discard the unsaved half (a force-quit / mobile swipe — beforeunload does
    // not fire on iOS), reload from that save, collect again.
    let paid = 0;
    ps.quests = { [QID]: { s: ACTIVE_STAGE, n: OBJ_COUNT } };
    const lastSave = JSON.parse(JSON.stringify(ps.quests));   // what save-state.js wrote
    for (let attempt = 0; attempt < 3; attempt++) {
      ps.quests = q.sanitizeQuests(JSON.parse(JSON.stringify(lastSave)));
      q.talkQuest(mapId, npcKey, (r) => { paid += r.gil | 0; });
    }
    hole('hand-in is replayable for unlimited gil',
      `3 hand-ins from ONE save paid ${paid} gil (${quest.reward.gil} each). ` +
      `The gil is pushed to the server mirror by _grantQuestReward; ` +
      `s:'done' is only in ps until the next saveSlotsToDB, and neither ${paths.join(' nor ')} calls one.`);
  }
}

// ── 2. one quest per giver, forever ───────────────────────────────────────
// talkQuest returns on the FIRST quest whose giver matches — including a
// finished one, whose `done` pages it returns for the rest of the save.
console.log('\n── 2. a second quest from the same NPC');
{
  const second = {
    id: 'audit_second',
    reward: { gil: 1 },
    stages: [
      { id: 'ask', at: { map: mapId, npc: npcKey }, offer: ['b'], accepted: ['b'], denied: ['b'] },
      { id: 'clear', at: { map: mapId, npc: npcKey },
        objective: { kind: 'defeat', zonePrefix: 'altar_cave', count: 1 },
        say: ['b'], onAdvance: ['b'] },
    ],
    after: { [npcKey]: ['b'] },
  };
  QUESTS[second.id] = second;
  ps.quests = { [QID]: { s: 'done', n: OBJ_COUNT } };
  const pages = q.talkQuest(mapId, npcKey, () => {});
  if ((pages || []).join('|') === quest.after[npcKey].join('|')) {
    hole('a giver can only ever hold one quest',
      'talkQuest returns on the FIRST matching giver, so the finished quest keeps ' +
      'answering forever and the second quest (no startWord, should offer on sight) is unreachable.');
  } else okay('a second quest from the same giver is reachable');
  // The word-gated path has the same shape but a saving grace: it `continue`s
  // past quests whose startWord does not match.
  delete QUESTS[second.id];
}

// ── 3. the reward table cannot express what the dialogue promises ─────────
console.log('\n── 3. reward shape vs reward text');
{
  const grant = src('src/npc.js').match(/function _grantQuestReward[\s\S]*?\n}/)[0];
  // `addItem(reward.item` — the grant, not a mention of the field.
  const kinds = ['gil', 'exp', 'item', 'spell', 'word'].filter(k =>
    k === 'item' ? /addItem\s*\(\s*reward\.item/.test(grant) : new RegExp(`reward\\.${k}\\b`).test(grant));
  okay(`_grantQuestReward honours: ${kinds.join(', ')}`);
  if (!kinds.includes('item')) {
    const promises = Object.values(QUESTS).filter(qq =>
      (qq.complete || []).some(l => /take this|it was his|for you|here|reward/i.test(l)));
    if (promises.length) {
      hole('the hand-in text hands over an object the reward cannot contain',
        promises.map(qq => `${qq.id}: "${qq.complete.join(' ')}" -> reward ${JSON.stringify(qq.reward)}`).join('\n       ') +
        '\n       `reward.item` would be silently dropped — _grantQuestReward has no branch for it, ' +
        'even though data/items.js already models quest items (isQuestItem).');
    }
  }
}

// ── 4. the server has no idea what a quest is ─────────────────────────────
console.log('\n── 4. server-side authority');
{
  const api = src('api.js');
  const arb = fs.existsSync(new URL('../economy-arbiter.js', import.meta.url)) ? src('economy-arbiter.js') : '';
  const knowsQuests = /export function validateQuestClaim/.test(arb) &&
                      /questClaimedAt\s*\(/.test(arb) &&
                      /from '\.\/src\/data\/quests\.js'/.test(arb);
  const shapeOnly = /Validated\s*\n?\s*\/\/\s*by SHAPE|by SHAPE/.test(api);
  if (knowsQuests) okay('the arbiter validates quest claims');
  else {
    hole('a quest reward is an unvalidated client-asserted gil-delta',
      "npc.js sends sendNetInvEvent('gil-delta', 0, reward.gil, 'quest'). ws-presence's " +
      "inv-event case applies it through mirrorApplyInvEvent with bounds checks only — " +
      "no quest table, no once-per-quest ledger, no cap tied to the reward. " +
      (shapeOnly ? "api.js's comment says a forged `s:'done'` \"buys nothing\", which is true and beside " +
                   "the point: the payout never consults `s` at all." : ''));
  }
  // The server clamp is looser than the client's.
  const { _testValidateSaveData } = await import('../api.js');
  const v = _testValidateSaveData({ quests: { [QID]: { s: ACTIVE_STAGE, n: 9999 } } });
  const serverN = v.data.quests[QID] ? v.data.quests[QID].n : null;
  const clientN = q.sanitizeQuests({ [QID]: { s: ACTIVE_STAGE, n: 9999 } })[QID].n;
  if (serverN !== clientN) {
    hole('client and server clamp the objective count differently',
      `server keeps n=${serverN} (bounded 0..9999, shape-only); client clamps to the objective (${clientN}). ` +
      'check-quests.mjs asserts the 9999 as correct behaviour, so the gate PINS the divergence.');
  } else okay('client and server agree on the count clamp');
}

// ── 5. reachability: the start word depends on an unrelated field ─────────
console.log('\n── 5. is every quest actually reachable?');
{
  const { TOWN_NPCS } = await import('../src/data/town-npcs.js');
  // TOWN_NPCS is a Map(mapId -> [{key, x, y, spec}]) — Object.values on a Map
  // yields nothing, which is how the first run of this harness "proved" the
  // quest giver was unplaced. Self-test below.
  const specs = new Map();
  for (const [, list] of TOWN_NPCS) {
    for (const row of (Array.isArray(list) ? list : [list])) if (row && row.key) specs.set(row.key, row.spec || row);
  }
  if (specs.size < 10) { console.error(`  harness self-test FAILED: only ${specs.size} NPC specs read`); process.exit(2); }
  okay(`read ${specs.size} placed NPC specs from TOWN_NPCS`);
  for (const qq of Object.values(QUESTS)) {
    const g0 = (qq.stages || [])[0];
    if (!g0 || !g0.at) { hole(`quest ${qq.id} has no stage 0`, 'stages[] is empty'); continue; }
    const spec = specs.get(g0.at.npc);
    if (!spec) { hole(`quest ${qq.id} has no placed stage-0 NPC`, `npcKey ${g0.at.npc} is not in TOWN_NPCS`); continue; }
    if (!qq.startWord) { okay(`${qq.id}: offers on sight, no word gate`); continue; }
    const participates = ((spec.teaches || []).length > 0) || Object.keys(spec.answers || {}).length > 0;
    if (!participates) {
      hole(`quest ${qq.id} is unreachable`,
        `word-menu.js#_verbRows only opens the ASK menu for an NPC with teaches/answers; ` +
        `${g0.at.npc} has neither, so the start word can never be put to them.`);
    } else {
      okay(`${qq.id}: giver takes part in Word Memory, so ASK reaches them`);
      if (!(spec.answers || {})[qq.startWord]) {
        hole(`quest ${qq.id}'s start word shows as unanswerable`,
          `_askRows dims a term the NPC has no answers[] entry for. ${g0.at.npc} would render ` +
          `${qq.startWord.toUpperCase()} grey — "this one knows nothing" — while it is the one term that opens the quest.`);
      }
    }
  }
}

// ── 6. what the player can see ────────────────────────────────────────────
// The design note is explicit that there is no quest UI — the giver IS the
// interface. So the requirement is not "a journal exists", it is "the giver
// says the number", which means the {n}/{count}/{left} tokens must be filled
// in by the time pages leave talkQuest. An unexpanded token reaching the
// message box would render as literal "{n}" on screen.
console.log('\n── 6. player-facing progress');
{
  ps.quests = { [QID]: { s: ACTIVE_STAGE, n: 1 } };
  const mid = q.talkQuest(mapId, npcKey, () => {});
  const joined = (mid || []).join(' ');
  if (/\{|\}/.test(joined)) {
    hole('a progress token reached the message box unexpanded',
      `talkQuest returned ${JSON.stringify(mid)} — the player would read the braces.`);
  } else if (!/\b1\b/.test(joined) || !/\b3\b/.test(joined)) {
    hole('the giver does not say how far along the player is',
      `at n=1 of ${OBJ_COUNT} the ACTIVE line was "${joined}" — no count in it. ` +
      'ps.quests[id].n is tracked, clamped, saved and server-validated; if nothing reads it out ' +
      'the player has no way to know where they are, and the design note rules out a journal screen.');
  } else okay(`ACTIVE line reads the count out: "${joined}"`);

  // ⛔ EVERY page of EVERY stage, not just the one this section exercises — an
  // unfilled token anywhere is a rendered brace in front of the player. Walks
  // the whole table now that pages live per stage, including `also` and
  // `after`, which the old top-level list could not see.
  const _tokened = [];
  for (const qq of Object.values(QUESTS)) {
    for (const st of qq.stages || []) {
      for (const part of ['offer', 'accepted', 'denied', 'say', 'onAdvance']) {
        for (const pg of st[part] || []) if (/\{/.test(pg)) _tokened.push(`${qq.id}.${st.id}.${part}`);
      }
      for (const [k, pgs] of Object.entries(st.also || {})) {
        for (const pg of pgs || []) if (/\{/.test(pg)) _tokened.push(`${qq.id}.${st.id}.also.${k}`);
      }
    }
    // `after` pages are shown with NO stage, so a token there can never be
    // filled — quests.js passes `stage: null` and the count reads 0. That is a
    // page the player would see braces on, not a formatting nit.
    for (const [k, pgs] of Object.entries(qq.after || {})) {
      for (const pg of pgs || []) if (/\{/.test(pg)) {
        hole(`after.${k} of ${qq.id} carries a progress token`,
          `"${pg}" — \`after\` pages are rendered with no stage, so {n}/{count}/{left} cannot be filled.`);
      }
    }
  }
  if (_tokened.length) okay(`progress tokens live on ${_tokened.length} page group(s): ${_tokened.join(', ')}`);
}

// ── 7. dead API ───────────────────────────────────────────────────────────
// Generalised from the questsForMap finding: anything the quest modules export
// has to be imported by somebody, or it is a maintenance cost with no user.
console.log('\n── 7. unused exports');
{
  const files = fs.readdirSync(new URL('../src', import.meta.url), { recursive: true })
    .filter(f => String(f).endsWith('.js'));
  const others = (self) => files.filter(f => !String(f).endsWith(self))
    .map(f => src('src/' + f)).join('\n') + src('api.js') + src('ws-presence.js') + src('economy-arbiter.js');
  for (const [file, selfName] of [['src/quests.js', 'quests.js'], ['src/data/quests.js', 'data/quests.js']]) {
    const names = [...src(file).matchAll(/^export (?:function|const|let) (\w+)/gm)].map(m => m[1]);
    const pool = others(selfName === 'quests.js' ? 'src/quests.js' : 'data/quests.js');
    const dead = names.filter(n => !new RegExp(`\\b${n}\\b`).test(pool));
    if (dead.length) hole(`${file} exports nothing uses: ${dead.join(', ')}`,
      'exported and imported by no other module — dead weight that reads as live API.');
    else okay(`${file}: all ${names.length} exports are imported somewhere`);
  }
}

console.log(`\naudit-quests: ${holes.length} hole(s)`);
for (const h of holes) console.log('  - ' + h);
// Gate as of v1.8.6: every hole above is closed, so a reopened one fails the
// deploy instead of waiting for the next audit to notice it.
process.exit(holes.length ? 1 : 0);
