// Ordered snapshots with a durable local pending marker. A slow older request
// must not overwrite a later quest completion; losing the network must not
// make the next login silently prefer an older cloud save.
import { openSaveDB } from './save.js';
let localTail = Promise.resolve();
let cloudTail = Promise.resolve();
let sequence = 0;
const accountKey = () => window.ff3Auth?.getAccountKey?.() ?? null;

function writeEntries(entries) {
  const task = localTail.then(async () => {
    const db = await openSaveDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('roms', 'readwrite');
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Local save failed'));
      const store = tx.objectStore('roms');
      for (const [key, value] of entries) store.put(value, key);
    });
  });
  localTail = task.catch(e => console.warn('[save] local write failed:', e));
  return task;
}

export function queueSaveSnapshot(slots) {
  const snapshot = structuredClone(slots);
  const owner = accountKey();
  const revision = `${Date.now()}-${++sequence}`;
  const auth = window.ff3Auth;
  const local = writeEntries([['saves', snapshot], ['saves-pending', { owner, revision }]]);
  // Do not let an unavailable IndexedDB prevent a cloud save.
  const localDone = local.catch(() => {});
  const cloud = cloudTail.then(async () => {
    if (!auth || auth !== window.ff3Auth || owner !== accountKey()) return false;
    let saved = true;
    for (let i = 0; i < snapshot.length; i++) {
      if (!snapshot[i]) continue;
      if (owner !== accountKey()) return false;
      try { if (await auth.serverSave(i, snapshot[i]) === false) saved = false; }
      catch (e) { saved = false; console.warn('[save] cloud write failed:', e); }
    }
    await localDone;
    if (saved) await writeEntries([['saves-ack', { owner, revision }]]).catch(() => {});
    return saved;
  });
  cloudTail = cloud.catch(e => { console.warn('[save] sync failed:', e); return false; });
  return Promise.all([localDone, cloudTail]);
}

export async function readLocalSnapshot() {
  await localTail;
  const db = await openSaveDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('roms', 'readonly');
    const store = tx.objectStore('roms');
    const data = store.get('saves'), pending = store.get('saves-pending'), ack = store.get('saves-ack');
    tx.oncomplete = () => {
      const owned = !pending.result || pending.result.owner === accountKey();
      resolve({ slots: owned ? data.result : null,
        pending: owned && !!pending.result && pending.result.revision !== ack.result?.revision });
    };
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Local load failed'));
  });
}

// Deletion shares the cloud queue so an older in-flight write cannot restore
// a slot immediately after its delete completes.
export function queueCloudDelete(slot) {
  const auth = window.ff3Auth, owner = accountKey();
  const task = cloudTail.then(async () => {
    if (auth && auth === window.ff3Auth && owner === accountKey()) await auth.serverDeleteSave(slot);
  });
  cloudTail = task.catch(e => console.warn('[save] delete failed:', e));
  return cloudTail;
}
