// Small asynchronous IndexedDB fixture: commits happen after requests, and
// values are cloned at the database boundary just as real IndexedDB does.
export function memorySaveDB() {
  const values = new Map();
  let failOpen = false;
  globalThis.indexedDB = { open() {
    const req = {};
    queueMicrotask(() => {
      if (failOpen) { req.error = new Error('storage unavailable'); req.onerror?.(); return; }
      req.result = { transaction() {
        const tx = {};
        tx.objectStore = () => ({
          put(value,key) { values.set(key,structuredClone(value));return {}; },
          get(key) { const r={result:structuredClone(values.get(key))};queueMicrotask(()=>r.onsuccess?.());return r; },
        });
        queueMicrotask(()=>tx.oncomplete?.());return tx;
      } };
      req.onsuccess?.();
    });return req;
  } };
  return { values, fail(value) { failOpen=value; } };
}
