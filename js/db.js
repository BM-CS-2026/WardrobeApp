// PouchDB-based storage with live sync
// Replaces the old raw IndexedDB wrapper — same public API

const db = new PouchDB('wardrobe_sync');

let remoteDB = null;
let syncHandler = null;
let _onSyncChange = null;

// ── ID helpers ──
function makeId(store, key) { return `${store}:${key}`; }
function extractKey(docId) { return docId.substring(docId.indexOf(':') + 1); }

function toAppFormat(doc) {
  if (!doc) return undefined;
  const { _id, _rev, _attachments, type, ...rest } = doc;
  const key = extractKey(_id);
  if (type === 'settings') return { key, value: rest.value };
  return { ...rest, id: key };
}

// ── Generic CRUD (same API as before) ──

export async function getAll(store) {
  const result = await db.allDocs({
    include_docs: true,
    startkey: `${store}:`,
    endkey: `${store}:\ufff0`
  });
  return result.rows.map(r => toAppFormat(r.doc));
}

export async function get(store, id) {
  try {
    const doc = await db.get(makeId(store, id));
    return toAppFormat(doc);
  } catch (e) {
    if (e.status === 404) return undefined;
    throw e;
  }
}

export async function put(store, item) {
  const key = store === 'settings' ? item.key : item.id;
  if (!key) return;
  const _id = makeId(store, key);

  const doc = { _id, type: store };
  if (store === 'settings') {
    doc.value = item.value;
  } else {
    for (const [k, v] of Object.entries(item)) {
      if (k !== 'id' && k !== 'blob') doc[k] = v;   // skip id (in _id) and blob (use saveImage)
    }
  }

  try {
    const existing = await db.get(_id);
    doc._rev = existing._rev;
    if (existing._attachments) doc._attachments = existing._attachments;
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  return db.put(doc);
}

export async function del(store, id) {
  try {
    const doc = await db.get(makeId(store, id));
    return db.remove(doc);
  } catch (e) {
    if (e.status === 404) return;
    throw e;
  }
}

// ── Image storage (PouchDB attachments) ──

export async function saveImage(id, blob) {
  const _id = makeId('images', id);
  // Store as data URL string — no attachments, no Safari blob issues
  const dataUrl = await blobToBase64(blob);

  let rev;
  try {
    const existing = await db.get(_id);
    rev = existing._rev;
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  const doc = { _id, type: 'images', dataUrl };
  if (rev) doc._rev = rev;
  return db.put(doc);
}

export async function loadImage(id) {
  try {
    const doc = await db.get(makeId('images', id));
    // New format: dataUrl field
    if (doc.dataUrl) return doc.dataUrl;
    return null;
  } catch { return null; }
}

export async function deleteImage(id) {
  return del('images', id);
}

// Repair: convert old attachment-based images to dataUrl field
export async function repairImages(progressCb) {
  const result = await db.allDocs({
    include_docs: true,
    startkey: 'images:',
    endkey: 'images:\ufff0'
  });
  let fixed = 0, total = result.rows.length;
  for (const row of result.rows) {
    const doc = row.doc;
    // Check if dataUrl is valid (not "[object Blob]" garbage)
    if (doc.dataUrl && doc.dataUrl.length > 100 && !doc.dataUrl.includes('[object')) {
      if (progressCb) progressCb(++fixed, total);
      continue; // already good
    }
    // Try to read attachment and convert to dataUrl
    try {
      // First try: get attachment as Blob directly (works in Safari)
      const blob = await db.getAttachment(doc._id, 'data');
      if (blob && blob instanceof Blob && blob.size > 0) {
        const dataUrl = await blobToBase64(blob);
        const latest = await db.get(doc._id);
        await db.put({ _id: doc._id, _rev: latest._rev, type: 'images', dataUrl });
        fixed++;
      }
    } catch (e) {
      // Second try: get as base64 via { attachments: true }
      try {
        const docAtt = await db.get(doc._id, { attachments: true });
        if (docAtt._attachments?.data) {
          const att = docAtt._attachments.data;
          let dataUrl;
          if (att.data instanceof Blob) {
            dataUrl = await blobToBase64(att.data);
          } else if (typeof att.data === 'string' && att.data.length > 50) {
            dataUrl = `data:${att.content_type || 'image/png'};base64,${att.data}`;
          }
          if (dataUrl && dataUrl.length > 100) {
            await db.put({ _id: doc._id, _rev: docAtt._rev, type: 'images', dataUrl });
            fixed++;
          }
        }
      } catch (e2) {
        console.warn('[Repair] Could not fix image:', doc._id, e2.message || e2);
      }
    }
    if (progressCb) progressCb(fixed, total);
  }
  console.log(`[Repair] Fixed ${fixed}/${total} images`);
  return fixed;
}

// ── Convenience (unchanged API) ──

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

// ── Settings ──

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
  const lsKey = localStorage.getItem('openai_key');
  const dbKey = await getSetting('openai_key');
  if (lsKey && !dbKey) {
    await putSetting('openai_key', lsKey);
    localStorage.removeItem('openai_key');
    return lsKey;
  }
  if (lsKey && dbKey) localStorage.removeItem('openai_key');
  return dbKey;
}

export async function saveApiKey(key) {
  const trimmed = key?.trim();
  if (trimmed) await putSetting('openai_key', trimmed);
  else await deleteSetting('openai_key');
  localStorage.removeItem('openai_key');
}

// ── Sync ──

export function getSyncUrl() {
  return localStorage.getItem('sync_remote_url') || '';
}

export function setSyncUrl(url) {
  if (url) localStorage.setItem('sync_remote_url', url);
  else localStorage.removeItem('sync_remote_url');
}

export function pullOnce(remoteUrl, onProgress) {
  const remote = new PouchDB(remoteUrl);
  return new Promise((resolve, reject) => {
    db.replicate.from(remote, { batch_size: 25 })
      .on('change', (info) => { if (onProgress) onProgress(info); })
      .on('complete', (info) => resolve(info))
      .on('error', (err) => reject(err));
  });
}

export function setupSync(remoteUrl, onChange) {
  if (syncHandler) syncHandler.cancel();
  _onSyncChange = onChange;
  remoteDB = new PouchDB(remoteUrl);
  syncHandler = db.sync(remoteDB, { live: true, retry: true })
    .on('change', (info) => {
      console.log('[Sync]', info.direction, info.change.docs.length, 'docs');
      if (_onSyncChange) _onSyncChange('change', info);
    })
    .on('paused', () => {
      if (_onSyncChange) _onSyncChange('paused');
    })
    .on('active', () => {
      if (_onSyncChange) _onSyncChange('active');
    })
    .on('error', (err) => {
      console.error('[Sync] error', err);
      if (_onSyncChange) _onSyncChange('error', err);
    });
  return syncHandler;
}

export function stopSync() {
  if (syncHandler) { syncHandler.cancel(); syncHandler = null; }
  remoteDB = null;
}

// ── Migration from old IndexedDB ──

export async function migrateFromOldDB(progressCb) {
  return new Promise((resolve) => {
    const req = indexedDB.open('WardrobeDB', 2);
    req.onupgradeneeded = (e) => {
      // DB didn't exist at version 2 — nothing to migrate
      e.target.transaction.abort();
    };
    req.onerror = () => resolve(false);
    req.onsuccess = async (e) => {
      const oldDb = e.target.result;
      try {
        if (!oldDb.objectStoreNames.contains('items')) {
          oldDb.close();
          resolve(false);
          return;
        }

        const readStore = (name) => new Promise((res, rej) => {
          const tx = oldDb.transaction(name, 'readonly');
          const s = tx.objectStore(name);
          const r = s.getAll();
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });

        const oldItems = await readStore('items');
        const oldPalettes = await readStore('palettes');
        const oldOutfits = await readStore('outfits');
        const oldSettings = oldDb.objectStoreNames.contains('settings') ? await readStore('settings') : [];
        const oldImages = oldDb.objectStoreNames.contains('images') ? await readStore('images') : [];

        if (oldItems.length === 0 && oldOutfits.length === 0 && oldImages.length === 0) {
          oldDb.close();
          resolve(false);
          return;
        }

        const total = oldItems.length + oldPalettes.length + oldOutfits.length + oldSettings.length + oldImages.length;
        let done = 0;
        let imgOk = 0, imgFail = 0;
        const tick = () => { done++; if (progressCb) progressCb(done, total); };

        for (const item of oldItems) { try { await put('items', item); } catch {} tick(); }
        for (const p of oldPalettes) { try { await put('palettes', p); } catch {} tick(); }
        for (const o of oldOutfits) { try { await put('outfits', o); } catch {} tick(); }
        for (const s of oldSettings) { try { await put('settings', s); } catch {} tick(); }
        for (const img of oldImages) {
          if (img.id && img.blob) {
            try { await saveImage(img.id, img.blob); imgOk++; }
            catch (e) { console.warn('[Migration] Image failed:', img.id, e); imgFail++; }
          }
          tick();
        }
        console.log(`[Migration] Images: ${imgOk} OK, ${imgFail} failed`);

        console.log(`[Migration] Done: ${oldItems.length} items, ${oldImages.length} images`);
        oldDb.close();
        indexedDB.deleteDatabase('WardrobeDB');
        resolve(true);
      } catch (err) {
        console.error('[Migration] Error:', err);
        oldDb.close();
        resolve(false);
      }
    };
  });
}

// ── Export / Import (kept for backup) ──

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(dataUrl) {
  const [header, b64] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)[1];
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

export async function exportAll(progressCb) {
  const allItems = await getAllItems();
  const allPalettes = await getAllPalettes();
  const allOutfits = await getAllOutfits();
  const images = {};
  const imageIds = new Set();
  for (const item of allItems) { if (item.imageId) imageIds.add(item.imageId); }
  for (const outfit of allOutfits) { if (outfit.aiImageId) imageIds.add(outfit.aiImageId); }
  let done = 0;
  const total = imageIds.size;
  for (const id of imageIds) {
    const blob = await loadImage(id);
    if (blob) images[id] = await blobToBase64(blob);
    done++;
    if (progressCb) progressCb(done, total);
  }
  return { items: allItems, palettes: allPalettes, outfits: allOutfits, images };
}

export async function importAll(data, progressCb) {
  const { items = [], palettes = [], outfits = [], images = {} } = data;
  const imageEntries = Object.entries(images);
  let done = 0;
  const total = imageEntries.length + items.length + palettes.length + outfits.length;
  for (const [id, dataUrl] of imageEntries) {
    await saveImage(id, base64ToBlob(dataUrl));
    done++; if (progressCb) progressCb(done, total);
  }
  for (const item of items) { await putItem(item); done++; if (progressCb) progressCb(done, total); }
  for (const p of palettes) { await putPalette(p); done++; if (progressCb) progressCb(done, total); }
  for (const o of outfits) { await putOutfit(o); done++; if (progressCb) progressCb(done, total); }
  return { items: items.length, palettes: palettes.length, outfits: outfits.length, images: imageEntries.length };
}
