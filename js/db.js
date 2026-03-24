// IndexedDB wrapper for persistent storage

const DB_NAME = 'WardrobeDB';
const DB_VERSION = 2;

let dbInstance = null;

function open() {
  if (dbInstance) return Promise.resolve(dbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('items')) {
        const items = db.createObjectStore('items', { keyPath: 'id' });
        items.createIndex('category', 'category');
      }
      if (!db.objectStoreNames.contains('palettes')) {
        db.createObjectStore('palettes', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('outfits')) {
        db.createObjectStore('outfits', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('images')) {
        db.createObjectStore('images', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => { dbInstance = e.target.result; resolve(dbInstance); };
    req.onerror = (e) => reject(e.target.error);
  });
}

async function tx(store, mode = 'readonly') {
  const db = await open();
  return db.transaction(store, mode).objectStore(store);
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Generic CRUD
export async function getAll(store) {
  const s = await tx(store);
  return promisify(s.getAll());
}

export async function get(store, id) {
  const s = await tx(store);
  return promisify(s.get(id));
}

export async function put(store, item) {
  const s = await tx(store, 'readwrite');
  return promisify(s.put(item));
}

export async function del(store, id) {
  const s = await tx(store, 'readwrite');
  return promisify(s.delete(id));
}

// Image storage (as blobs in IndexedDB)
export async function saveImage(id, blob) {
  return put('images', { id, blob });
}

export async function loadImage(id) {
  const record = await get('images', id);
  return record ? record.blob : null;
}

export async function deleteImage(id) {
  return del('images', id);
}

// Convenience
export async function getAllItems() { return getAll('items'); }
export async function getItem(id) { return get('items', id); }
export async function putItem(item) { return put('items', item); }
export async function deleteItem(id) { return del('items', id); }

export async function getAllPalettes() { return getAll('palettes'); }
export async function getPalette(id) { return get('palettes', id); }
export async function putPalette(palette) { return put('palettes', palette); }
export async function deletePalette(id) { return del('palettes', id); }

export async function getAllOutfits() { return getAll('outfits'); }
export async function getOutfit(id) { return get('outfits', id); }
export async function putOutfit(outfit) { return put('outfits', outfit); }
export async function deleteOutfit(id) { return del('outfits', id); }

// Settings (API key etc.)
export async function getSetting(key) {
  const record = await get('settings', key);
  return record ? record.value : null;
}

export async function putSetting(key, value) {
  return put('settings', { key, value });
}

export async function deleteSetting(key) {
  return del('settings', key);
}

export async function getApiKey() {
  // Migrate from localStorage if present
  const lsKey = localStorage.getItem('openai_key');
  const dbKey = await getSetting('openai_key');
  if (lsKey && !dbKey) {
    await putSetting('openai_key', lsKey);
    localStorage.removeItem('openai_key');
    return lsKey;
  }
  if (lsKey && dbKey) {
    localStorage.removeItem('openai_key');
  }
  return dbKey;
}

export async function saveApiKey(key) {
  const trimmed = key?.trim();
  if (trimmed) await putSetting('openai_key', trimmed);
  else await deleteSetting('openai_key');
  localStorage.removeItem('openai_key');
}
