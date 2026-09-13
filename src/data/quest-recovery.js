// Reconstruct owed claims from durable progression. Retrying sends no local
// XP/items/flags; the server's per-quest ledger decides whether payment is due.
import { QUESTS, QUEST_DONE, stageIndex } from './quests.js';
export function claimsForProgress(progress) {
  const claims=[];
  for(const [id, entry] of Object.entries(progress || {})) {
    const quest=QUESTS[id]; if(!quest)continue;
    const completed=entry.s===QUEST_DONE;
    const index=completed?quest.stages.length:stageIndex(quest,entry.s);
    if(index<0)continue;
    for(let i=0;i<index;i++) {
      const stage=quest.stages[i];
      if(stage.item)claims.push({questId:id,stageId:stage.id});
    }
    if(completed)claims.push({questId:id});
  }
  return claims;
}
