/**
 * Accès minimaliste à IndexedDB, avec des promesses.
 *
 * Magasins (« object stores ») :
 *  - kv      : réglages et liste des emplacements (les handles de dossiers
 *              sont sérialisables et survivent au redémarrage du navigateur)
 *  - meta    : cache des métadonnées déjà extraites (démarrage rapide)
 *  - imports : sons importés quand aucun dossier n'est accessible en écriture
 */

const DB_NAME = 'spotifake';
const DB_VERSION = 1;
const STORES = ['kv', 'meta', 'imports'];

let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function run(storeName, mode, operation) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = operation(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const db = {
  get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
  set: (store, key, value) => run(store, 'readwrite', (s) => s.put(value, key)),
  delete: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
  values: (store) => run(store, 'readonly', (s) => s.getAll()),
  keys: (store) => run(store, 'readonly', (s) => s.getAllKeys()),
};
