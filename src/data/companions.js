// Local NPC adventurers fill an incomplete PvE party. They are never online
// roster entries, trade partners, chat senders, or PvP participants. Real
// players take priority. Gear follows the player's story, not inflated stats.
export function companionProfiles(player) {
  const flags = player.flags || {};
  const level = Math.max(1, player.stats?.level || 1);
  const late = !!flags.owen_restored;
  const mythril = !!flags.curse_lifted;
  const armor = late ? 0x77 : mythril ? 0x75 : 0x73;
  const helm = late ? 0x66 : mythril ? 0x64 : 0x62;
  const shield = late ? 0x5b : 0x58;
  const jobs = [3, 1, 4, 2].filter(job => job !== player.jobIdx).slice(0, 3);
  return jobs.map((jobIdx, i) => {
    const desch = i === 2 && flags.bahamut_escaped && !flags.owen_restored;
    if (desch) jobIdx = 5;
    const mage = [3,4,5].includes(jobIdx);
    return {
      name: desch ? 'Desch' : ({1: 'Guard',2: 'Monk',3: 'Healer',4: 'Mage'})[jobIdx],
      companionId: desch ? 'desch' : `job-${jobIdx}`, jobIdx, level,
      palIdx: jobIdx, jobLevel: 1,
      weaponR: jobIdx === 2 ? 0 : jobIdx === 3 ? 0x0e : jobIdx === 4 ? 0x09 : desch ? 0x25 : late ? 0x28 : mythril ? 0x27 : 0x24,
      armorId: jobIdx === 2 ? (late ? 0x79 : 0x73) : mage ? (late ? 0x7b : 0x73) : armor,
      helmId: mage || jobIdx === 2 ? 0x62 : helm,
      shieldId: mage || jobIdx === 2 ? null : shield,
      knownSpells: jobIdx === 3 ? [0x34, 0x35, ...(late ? [0x26] : [])]
        : jobIdx === 4 ? [0x31, 0x32, ...(late ? [0x23, 0x24, 0x25] : [])]
        : desch ? [0x31, 0x32, 0x34] : [],
    };
  });
}
