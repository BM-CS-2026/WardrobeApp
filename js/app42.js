import * as db from './db42.js';
import { createClothingItem, createColorPalette, createOutfit } from './models.js?v=20';
import { extractColorProfile, extractFromRegion, paletteAffinity, colorScore } from './color-engine.js?v=20';
import { generateOutfits, computeCompleteness, computeStyleScore } from './outfit-generator.js?v=20';
import { analyzeOutfitPhoto, generateOutfitImage } from './cloud-ai.js?v=20';
import { hslToCss, generateId, scoreColor, CATEGORIES, STYLE_TAGS, HARMONY_TYPES, VIBES } from './utils.js?v=20';

// ── Global app object (must be first) ──
window.app = {};

// ── State ──
let currentTab = 'wardrobe';
let items = [];
let palettes = [];
let outfits = [];
let wishlist = []; // Wish List items (outfit references)
let myWishlist = []; // My Wish List (custom items with photo + text)

// ── Undo System ──
const undoStack = []; // { type, data }
const MAX_UNDO = 20;

function pushUndo(action) {
  undoStack.push(action);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

app.undoLast = async () => {
  if (!undoStack.length) {
    openSheet(`
      <h2>Undo</h2>
      <p style="color:var(--text-secondary);margin-bottom:16px">Nothing to undo.</p>
      <button class="btn btn-secondary" onclick="closeSheet()">OK</button>
    `);
    return;
  }

  const action = undoStack.pop();
  showLoading('Undoing...');

  try {
    if (action.type === 'delete-item') {
      // Restore deleted item
      await db.putItem(action.item);
      if (action.imageData && action.item.imageId) {
        await db.saveImage(action.item.imageId, dataUrlToBlob(action.imageData));
      }
      items.push(action.item);
    } else if (action.type === 'delete-items') {
      // Restore multiple deleted items
      for (const entry of action.entries) {
        await db.putItem(entry.item);
        if (entry.imageData && entry.item.imageId) {
          await db.saveImage(entry.item.imageId, dataUrlToBlob(entry.imageData));
        }
        items.push(entry.item);
      }
    } else if (action.type === 'add-items') {
      // Remove added items
      for (const id of action.itemIds) {
        const item = items.find(i => i.id === id);
        if (item?.imageId) await db.deleteImage(item.imageId);
        await db.deleteItem(id);
        items = items.filter(i => i.id !== id);
      }
    } else if (action.type === 'delete-outfit') {
      await db.putOutfit(action.outfit);
      outfits.push(action.outfit);
    } else if (action.type === 'add-outfits') {
      for (const id of action.outfitIds) {
        await db.deleteOutfit(id);
        outfits = outfits.filter(o => o.id !== id);
      }
    } else if (action.type === 'edit-item') {
      const item = items.find(i => i.id === action.itemId);
      if (item) {
        Object.assign(item, action.oldData);
        await db.putItem(item);
      }
    }

    hideLoading();
    await loadData();
    renderCurrentTab();
    openSheet(`
      <h2>Undone</h2>
      <p style="color:var(--text-secondary);margin-bottom:16px">${action.description || 'Last action undone.'}</p>
      <button class="btn btn-secondary" onclick="closeSheet()">OK</button>
    `);
  } catch (e) {
    hideLoading();
    alert('Undo failed: ' + e.message);
  }
};

function dataUrlToBlob(dataUrl) {
  const parts = dataUrl.split(',');
  const mime = parts[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
  const raw = atob(parts[1]);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// ── AI Outfit Image Generation ──
function outfitImageCacheKey(itemIds) {
  return 'outfit-img-' + [...itemIds].sort().join('-');
}

const imageGenQueue = [];
let isProcessingQueue = false;
let aiGenTotal = 0;
let aiGenDone = 0;

function enqueueImageGeneration(outfitItems, cardElement, outfitObj = null) {
  const outfitId = outfitObj?.id || null;
  imageGenQueue.push({ outfitItems, outfitId, cardElement, outfitObj });
  aiGenTotal++;
  updateAiProgressBar();
  processImageQueue();
}

function updateAiProgressBar() {
  let bar = document.getElementById('ai-gen-progress');
  if (aiGenDone >= aiGenTotal || aiGenTotal === 0) {
    if (bar) bar.remove();
    aiGenTotal = 0;
    aiGenDone = 0;
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'ai-gen-progress';
    bar.className = 'ai-gen-progress-bar';
    document.body.appendChild(bar);
  }
  const pct = Math.round((aiGenDone / aiGenTotal) * 100);
  bar.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px">
      <div class="ai-shimmer" style="width:20px;height:20px;flex-shrink:0"></div>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:600;margin-bottom:4px">Generating AI images: ${aiGenDone}/${aiGenTotal}</div>
        <div style="height:4px;background:var(--border);border-radius:2px;overflow:hidden">
          <div style="height:100%;background:var(--accent);border-radius:2px;width:${pct}%;transition:width 0.3s"></div>
        </div>
      </div>
    </div>
  `;
}

async function processImageQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  while (imageGenQueue.length > 0) {
    const job = imageGenQueue.shift();
    await triggerOutfitImageGeneration(job);
    aiGenDone++;
    updateAiProgressBar();
  }
  isProcessingQueue = false;
}

// Find the current DOM card for an outfit (may have been re-rendered)
function findCardForOutfit(outfitId, fallbackCard) {
  if (outfitId) {
    // Look for card with onclick containing this outfit ID
    const allCards = document.querySelectorAll('.outfit-card-wide');
    for (const card of allCards) {
      const row = card.querySelector('.outfit-card-row');
      if (row && row.getAttribute('onclick')?.includes(outfitId)) return card;
    }
  }
  // Fall back to original card if still in DOM
  if (fallbackCard && document.body.contains(fallbackCard)) return fallbackCard;
  return null;
}

async function triggerOutfitImageGeneration({ outfitItems, outfitId, cardElement, outfitObj }) {
  const cacheKey = outfitImageCacheKey(outfitItems.map(i => i.id));
  const MAX_RETRIES = 2;

  // Check cache first
  const cached = await db.loadImage(cacheKey);
  if (cached) {
    const card = findCardForOutfit(outfitId, cardElement);
    if (card) replaceCollageWithAiImage(card, cached);
    if (outfitObj && !outfitObj.aiImageId) {
      outfitObj.aiImageId = cacheKey;
      await db.putOutfit(outfitObj);
    }
    return;
  }

  // Show loading state on card (if visible)
  let card = findCardForOutfit(outfitId, cardElement);
  if (card) showCardLoadingState(card);
  console.log('[AI] Generating outfit image...', outfitItems.map(i => i.name));

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const apiKey = await db.getApiKey();
      if (!apiKey) {
        console.warn('[AI] No API key found, skipping image generation');
        card = findCardForOutfit(outfitId, cardElement);
        if (card) removeCardLoadingState(card);
        return;
      }
      const descriptions = outfitItems.map(i => ({ name: i.name, color: i.colorProfile?.dominantColor }));
      const blob = await generateOutfitImage(descriptions, apiKey);
      await db.saveImage(cacheKey, blob);

      // Update card in DOM (find again since it may have been re-rendered)
      card = findCardForOutfit(outfitId, cardElement);
      if (card) replaceCollageWithAiImage(card, blob);

      console.log('[AI] Outfit image generated successfully');
      if (outfitObj && !outfitObj.aiImageId) {
        outfitObj.aiImageId = cacheKey;
        await db.putOutfit(outfitObj);
      }
      // Also update the in-memory outfit
      if (outfitId) {
        const memOutfit = outfits.find(o => o.id === outfitId);
        if (memOutfit && !memOutfit.aiImageId) {
          memOutfit.aiImageId = cacheKey;
          await db.putOutfit(memOutfit);
        }
      }
      return; // success
    } catch (err) {
      console.error(`[AI] DALL-E generation failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`, err.message);
      if (attempt < MAX_RETRIES) {
        // Wait before retry (3s, then 6s)
        await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
      } else {
        card = findCardForOutfit(outfitId, cardElement);
        if (card) {
          removeCardLoadingState(card);
          showCardErrorState(card, err.message);
        }
      }
    }
  }
}

function replaceCollageWithAiImage(cardElement, data) {
  const url = (typeof data === 'string') ? data : URL.createObjectURL(data);
  const aiDiv = cardElement.querySelector('.outfit-card-ai');
  if (aiDiv) {
    aiDiv.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;border-radius:var(--radius-sm)">`;
  } else {
    const collage = cardElement.querySelector('.outfit-collage');
    if (!collage) return;
    collage.innerHTML = `<img src="${url}">`;
    collage.classList.add('ai-generated');
  }
}

function showCardLoadingState(cardElement) {
  const target = cardElement.querySelector('.outfit-card-ai') || cardElement.querySelector('.outfit-collage');
  if (!target) return;
  target.style.position = 'relative';
  // Remove existing overlay if any
  const existing = target.querySelector('.ai-loading-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.className = 'ai-loading-overlay';
  overlay.innerHTML = '<div class="ai-shimmer"></div><div style="font-size:11px;color:var(--text-secondary);margin-top:8px">Generating...</div>';
  target.appendChild(overlay);
}

function removeCardLoadingState(cardElement) {
  const overlay = cardElement.querySelector('.ai-loading-overlay');
  if (overlay) overlay.remove();
}

function showCardErrorState(cardElement, message) {
  const collage = cardElement.querySelector('.outfit-card-ai') || cardElement.querySelector('.outfit-collage');
  if (!collage) return;
  collage.style.position = 'relative';
  const overlay = document.createElement('div');
  overlay.className = 'ai-loading-overlay';
  overlay.style.background = 'rgba(255,200,200,0.8)';
  overlay.innerHTML = `<div style="font-size:11px;color:#c00;text-align:center;padding:8px">AI failed<br>${message.slice(0, 60)}</div>`;
  collage.appendChild(overlay);
}

// Generate missing AI images for all outfits that don't have one
app.generateMissingImages = () => {
  const saved = outfits.filter(o => o.isSaved && !o.aiImageId);
  if (!saved.length) {
    openSheet(`
      <h2>AI Images</h2>
      <p style="color:var(--text-secondary);margin-bottom:16px">All outfits already have AI images!</p>
      <button class="btn btn-secondary" onclick="closeSheet()">OK</button>
    `);
    return;
  }

  // Reset progress counters
  aiGenTotal = 0;
  aiGenDone = 0;

  const allCards = document.querySelectorAll('.outfit-card-wide');
  saved.forEach(outfit => {
    const oi = (outfit.itemIds || []).map(id => items.find(i => i.id === id)).filter(Boolean);
    if (!oi.length) return;
    // Find the card for this outfit
    let card = null;
    for (const c of allCards) {
      const row = c.querySelector('.outfit-card-row');
      if (row && row.getAttribute('onclick')?.includes(outfit.id)) { card = c; break; }
    }
    enqueueImageGeneration(oi, card, outfit);
  });
};

// ── Init ──
document.addEventListener('DOMContentLoaded', async () => {
  // Service worker disabled — using Cloudant sync instead
  // if ('serviceWorker' in navigator) {
  //   navigator.serviceWorker.register('./sw.js').catch(() => {});
  // }

  // Migrate from old IndexedDB if needed
  const migrated = await db.migrateFromOldDB((done, total) => {
    document.getElementById('loading-msg').textContent = `Migrating data... ${done}/${total}`;
  });
  if (migrated) console.log('[App] Migration from old DB complete');

  // Sync — silent, don't block app loading
  const syncUrl = db.getSyncUrl();
  if (syncUrl) {
    // Try to pull in background, don't block or show errors
    db.pullOnce(syncUrl).then(r => {
      console.log('[Sync] Pull complete:', r.docs_written, 'docs');
      if (r.docs_written > 0) { loadData().then(() => renderCurrentTab()); }
    }).catch(e => {
      console.warn('[Sync] Pull failed (will retry via live sync):', e.message || e);
    });
  }

  // Auto-repair broken images (wrong field names, etc.)
  const repaired = await db.repairImages();
  if (repaired) console.log(`[App] Repaired ${repaired} images`);

  // DEBUG: check raw PouchDB directly
  try {
    const rawDB = new PouchDB('wardrobe_sync');
    const rawInfo = await rawDB.info();
    const rawItems = await rawDB.allDocs({startkey:'items:',endkey:'items:\ufff0'});
    console.log('[DEBUG] Raw PouchDB:', rawInfo.doc_count, 'docs,', rawItems.rows.length, 'items');
    if (rawItems.rows.length > 0 && items.length === 0) {
      // db module can't read but raw PouchDB can — force reload from raw
      document.title = 'DEBUG: ' + rawItems.rows.length + ' raw items found';
    }
  } catch(e) { console.error('[DEBUG]', e); }

  await loadData();

  // DEBUG: if still 0 items, show what happened
  if (items.length === 0) {
    try {
      const checkDB = new PouchDB('wardrobe_sync');
      const checkItems = await checkDB.allDocs({startkey:'items:',endkey:'items:\ufff0',include_docs:true});
      if (checkItems.rows.length > 0) {
        // Data exists but loadData couldn't read it — load manually
        items = checkItems.rows.map(r => {
          const { _id, _rev, _attachments, type, ...rest } = r.doc;
          return { ...rest, id: _id.substring(_id.indexOf(':') + 1) };
        });
      }
    } catch(e) {}
  }

  await ensureBuiltInPalettes();
  setupTabs();
  renderCurrentTab();

  // Start live sync for ongoing changes
  startSyncIfConfigured();

  // Wire up persistent file inputs
  document.getElementById('file-picker-hidden').onchange = function() { app.handlePhotos(this); };
  document.getElementById('file-camera-hidden').onchange = function() { app.handlePhotos(this); };
  document.getElementById('wishlist-file-hidden').onchange = function() { app.handleMyWishPhoto(this); };
  document.getElementById('wishlist-camera-hidden').onchange = function() { app.handleMyWishPhoto(this); };
});

// ── Sync ──

function setSyncDot(state) {
  const dot = document.getElementById('sync-dot');
  if (!dot) return;
  const colors = { paused: '#4CAF50', active: '#2196F3', error: '#f44336', off: '#999' };
  dot.style.background = colors[state] || colors.off;
  dot.title = state === 'paused' ? 'Synced' : state === 'active' ? 'Syncing...' : state === 'error' ? 'Sync error' : 'Sync not configured';
}

function startSyncIfConfigured() {
  const url = db.getSyncUrl();
  if (!url) { setSyncDot('off'); return; }
  db.setupSync(url, async (event, info) => {
    setSyncDot(event === 'error' ? 'error' : event);
    if (event === 'change' || event === 'paused') {
      await loadData();
      renderCurrentTab();
    }
  });
  setSyncDot('active');
}

app.showSyncSettings = () => {
  const currentUrl = db.getSyncUrl();
  const itemCount = items.length;
  const outfitCount = outfits.filter(o => o.isSaved).length;
  openSheet(`
    <h2>Settings & Troubleshooting</h2>

    <!-- Status -->
    <div style="background:var(--bg);border-radius:10px;padding:12px;margin-bottom:16px">
      <div style="font-weight:700;margin-bottom:8px">Status</div>
      <div style="font-size:13px;display:flex;justify-content:space-between;margin-bottom:4px">
        <span>Items</span><strong>${itemCount}</strong>
      </div>
      <div style="font-size:13px;display:flex;justify-content:space-between;margin-bottom:4px">
        <span>Outfits</span><strong>${outfitCount}</strong>
      </div>
      <div style="font-size:13px;display:flex;justify-content:space-between">
        <span>Sync</span><strong>${currentUrl ? '✅ Connected' : '❌ Not configured'}</strong>
      </div>
    </div>

    <!-- Cloud Sync -->
    <div style="background:var(--bg);border-radius:10px;padding:12px;margin-bottom:16px">
      <div style="font-weight:700;margin-bottom:8px">Cloud Sync</div>
      <div class="form-group" style="margin-bottom:8px">
        <input id="sync-url-input" type="url" placeholder="https://apikey:pass@...cloudant.../wardrobe" value="${currentUrl}" style="font-size:12px">
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" onclick="app.saveSyncUrl()" style="flex:1">Save & Sync</button>
        ${currentUrl ? '<button class="btn btn-secondary btn-sm" onclick="app.disconnectSync()" style="flex:1">Disconnect</button>' : ''}
      </div>
    </div>

    <!-- Fix Tools -->
    <div style="background:var(--bg);border-radius:10px;padding:12px;margin-bottom:16px">
      <div style="font-weight:700;margin-bottom:8px">Fix Issues</div>

      <button class="btn btn-sm btn-outline" style="margin-bottom:6px" onclick="app.forceResync()">
        🔄 Force Pull (download all data from cloud)
      </button>

      <button class="btn btn-sm btn-outline" style="margin-bottom:6px" onclick="app.forcePushToCloud()">
        ☁️ Force Push (upload all data to cloud)
      </button>

      <button class="btn btn-sm btn-outline" style="margin-bottom:6px" onclick="app.checkRemoteDb()">
        📡 Check Remote Database
      </button>

      <button class="btn btn-sm btn-outline" style="margin-bottom:6px" onclick="app.clearCacheReload()">
        🧹 Clear Cache & Reload App
      </button>

      <button class="btn btn-sm btn-danger" style="margin-bottom:6px" onclick="app.nukeCacheReload()">
        💣 Nuke All Caches & Reload
      </button>

      <button class="btn btn-sm btn-outline" style="margin-bottom:6px" onclick="app.repairImages()">
        🖼️ Repair Broken Images
      </button>

      <button class="btn btn-sm btn-outline" style="margin-bottom:6px" onclick="app.showDbStats()">
        📊 Show Database Details
      </button>
    </div>

    <div id="troubleshoot-log" style="background:var(--bg);border-radius:10px;padding:12px;margin-bottom:16px;font-size:11px;font-family:monospace;white-space:pre-wrap;max-height:200px;overflow-y:auto;display:none"></div>

    <button class="btn btn-secondary" onclick="closeSheet()">‹ Back</button>
  `);
};

app.saveSyncUrl = async () => {
  const url = document.getElementById('sync-url-input')?.value?.trim();
  if (!url) { alert('Please enter a URL.'); return; }
  db.setSyncUrl(url);
  db.stopSync();
  closeSheet();
  showLoading('Syncing data...');
  try {
    await db.pullOnce(url, (info) => {
      document.getElementById('loading-msg').textContent = `Syncing... ${info.docs_written} docs`;
    });
  } catch (e) {
    console.warn('[Sync] Pull failed:', e);
  }
  await loadData();
  hideLoading();
  renderCurrentTab();
  startSyncIfConfigured();
};

app.disconnectSync = () => {
  db.stopSync();
  db.setSyncUrl('');
  setSyncDot('off');
  closeSheet();
};

app.forceResync = async () => {
  const url = db.getSyncUrl();
  if (!url) { alert('No sync URL configured. Tap the dot to set one.'); return; }
  closeSheet();
  showLoading('Pulling all data from cloud...');
  try {
    const result = await db.pullOnce(url, (info) => {
      document.getElementById('loading-msg').textContent = `Pulling... ${info.docs_written} docs`;
    });
    await loadData();
    renderCurrentTab();
    hideLoading();
    alert(`Sync complete! Pulled ${result.docs_written} docs. Now showing ${items.length} items.`);
  } catch (e) {
    hideLoading();
    alert('Sync failed: ' + (e.message || JSON.stringify(e)) + '\n\nURL: ' + url.substring(0, 40) + '...');
  }
};

function tsLog(msg) {
  const el = document.getElementById('troubleshoot-log');
  if (el) {
    el.style.display = 'block';
    el.textContent += msg + '\n';
    el.scrollTop = el.scrollHeight;
  }
}

app.forcePushToCloud = async () => {
  const url = db.getSyncUrl();
  if (!url) { alert('No sync URL configured.'); return; }
  tsLog('Pushing to cloud...');
  try {
    const result = await db.pushOnce(url);
    tsLog('PUSH COMPLETE: ' + result.docs_written + ' docs written');
    alert('Push complete! ' + result.docs_written + ' docs uploaded.');
  } catch (e) {
    tsLog('PUSH ERROR: ' + e.message);
    alert('Push failed: ' + e.message);
  }
};

app.checkRemoteDb = async () => {
  const url = db.getSyncUrl();
  if (!url) { alert('No sync URL configured.'); return; }
  tsLog('Checking remote...');
  try {
    const info = await db.checkRemote(url);
    tsLog('Remote: ' + info.doc_count + ' docs');
    tsLog('Items: ' + info.items + ', Outfits: ' + info.outfits + ', Images: ' + info.images);
    alert(`Remote DB:\n${info.doc_count} total docs\n${info.items} items\n${info.outfits} outfits\n${info.images} images`);
  } catch (e) {
    tsLog('ERROR: ' + e.message);
    alert('Check failed: ' + e.message);
  }
};

app.clearCacheReload = async () => {
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
  }
  const keys = await caches.keys();
  for (const k of keys) await caches.delete(k);
  alert('Cache cleared! App will reload.');
  location.reload(true);
};

app.nukeCacheReload = async () => {
  tsLog('Nuking ALL caches and service workers...');
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) { await r.unregister(); tsLog('  Unregistered SW'); }
  }
  const keys = await caches.keys();
  for (const k of keys) { await caches.delete(k); tsLog('  Deleted: ' + k); }
  // Clear sessionStorage too
  sessionStorage.clear();
  tsLog('All caches nuked! Reloading...');
  alert('All caches destroyed! App will reload with completely fresh files.');
  location.reload(true);
};

app.repairImages = async () => {
  tsLog('Repairing images...');
  closeSheet();
  showLoading('Repairing images...');
  const fixed = await db.repairImages((done, total) => {
    document.getElementById('loading-msg').textContent = `Repairing... ${done}/${total}`;
  });
  hideLoading();
  alert(`Repaired ${fixed} images.`);
  renderCurrentTab();
};

app.showDbStats = async () => {
  const allDocs = await db.getAllItems();
  const allOutfits = await db.getAllOutfits();
  const allPalettes = await db.getAllPalettes();
  const cats = {};
  for (const item of allDocs) {
    cats[item.category] = (cats[item.category] || 0) + 1;
  }
  const catLines = Object.entries(cats).map(([k, v]) => `  ${k}: ${v}`).join('\n');
  const msg = `Items: ${allDocs.length}\n${catLines}\nOutfits: ${allOutfits.length}\nPalettes: ${allPalettes.length}\nSync URL: ${db.getSyncUrl() ? 'Yes' : 'No'}`;
  tsLog(msg);
  alert(msg);
};

async function loadData() {
  [items, palettes, outfits] = await Promise.all([
    db.getAllItems(),
    db.getAllPalettes(),
    db.getAllOutfits(),
  ]);
  wishlist = (await db.getSetting('wishlist')) || [];
  myWishlist = (await db.getSetting('my_wishlist')) || [];
}

async function saveWishlist() {
  await db.putSetting('wishlist', wishlist);
}

async function saveMyWishlist() {
  await db.putSetting('my_wishlist', myWishlist);
}

async function ensureBuiltInPalettes() {
  if (palettes.some(p => p.isBuiltIn)) return;
  const presets = getPresetPalettes();
  for (const p of presets) {
    await db.putPalette(p);
  }
  palettes = await db.getAllPalettes();
}

// ── Tabs ──
function setupTabs() {
  document.querySelectorAll('.tab-bar button').forEach(btn => {
    btn.addEventListener('click', () => {
      currentTab = btn.dataset.tab;
      document.querySelectorAll('.tab-bar button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderCurrentTab();
    });
  });
}

function renderCurrentTab() {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${currentTab}`)?.classList.add('active');

  if (currentTab === 'wardrobe') renderWardrobe();
  else if (currentTab === 'palettes') renderPalettes();
  else if (currentTab === 'outfits') renderOutfits();
}

// ══════════════════════════════════════
// ── WARDROBE TAB (all categories, scrollable) ──
// ══════════════════════════════════════

let selectMode = false;
let selectedItems = new Set();

function renderWardrobe() {
  const view = document.getElementById('view-wardrobe');

  // Always show all 5 category sections
  const sections = CATEGORIES.map(cat => ({
    ...cat,
    items: items.filter(i => i.category === cat.id).sort((a, b) => b.dateAdded - a.dateAdded),
  }));

  view.innerHTML = `
    <div class="view-header">
      <h1>Wardrobe</h1>
      <div style="display:flex;gap:8px">
        ${items.length > 0 ? `<button class="btn-icon" onclick="app.toggleSelectMode()" title="Select items" style="font-size:16px;${selectMode ? 'background:var(--accent);color:white' : ''}">${selectMode ? '✕' : '☑'}</button>` : ''}
        <button class="btn-icon" onclick="app.undoLast()" title="Undo last action" style="font-size:16px">↩️</button>
        <button class="btn-icon" onclick="app.startCreateOutfit()" title="Create Outfit" style="font-size:16px">✨</button>
        <button class="btn-icon" onclick="app.showAddFlow()">+</button>
      </div>
    </div>
    ${selectMode ? `
      <div style="display:flex;gap:8px;padding:8px 16px;background:var(--accent-light);align-items:center">
        <span style="flex:1;font-size:13px;font-weight:600">${selectedItems.size} selected</span>
        <button class="btn btn-sm btn-primary" onclick="app.createOutfitFromSelected()" ${selectedItems.size === 0 || selectedItems.size > 2 ? 'disabled' : ''}>Create Outfit (1-2)</button>
        <button class="btn btn-sm btn-danger" onclick="app.deleteSelected()" ${selectedItems.size === 0 ? 'disabled' : ''}>Delete</button>
      </div>
    ` : ''}
    <div style="padding-bottom:24px">
      ${sections.map(section => `
        <div class="category-section">
          <div class="category-header">
            <span class="cat-icon">${section.icon}</span>
            <span class="cat-name">${plural(section.name)}</span>
            <span class="cat-count">(${section.items.length})</span>
          </div>
          ${section.items.length === 0 ? `
            <div class="category-empty">No ${plural(section.name).toLowerCase()} yet</div>
          ` : `
            <div class="item-grid-scroll">
              ${section.items.map(item => renderItemCard(item)).join('')}
            </div>
          `}
        </div>
      `).join('')}
    </div>
  `;
  lazyLoadImages();
}

function renderItemCard(item) {
  const cp = item.colorProfile;
  const isSelected = selectedItems.has(item.id);
  const onclick = selectMode ? `app.toggleItemSelection('${item.id}')` : `app.showItemDetail('${item.id}')`;
  return `
    <div class="item-card ${isSelected ? 'item-selected' : ''}" onclick="${onclick}">
      <div class="thumb" id="thumb-${item.id}">
        ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img">` : `<span>${CATEGORIES.find(c => c.id === item.category)?.icon || '👔'}</span>`}
        ${selectMode ? `<div class="select-check ${isSelected ? 'checked' : ''}">
          ${isSelected ? '✓' : ''}
        </div>` : ''}
      </div>
      <div class="info">
        <div class="name">${esc(item.name)}</div>
        <div class="meta">
          ${cp ? `<div class="swatch" style="background:${hslToCss(cp.dominantColor)}" onclick="event.stopPropagation(); app.showColorPicker('${item.id}','dominant')"></div>` : ''}
          ${hasDistinctSecondary(cp) ? `<div class="swatch" style="background:${hslToCss(cp.secondaryColors[0])};width:12px;height:12px" onclick="event.stopPropagation(); app.showColorPicker('${item.id}','secondary')"></div>` : ''}
        </div>
      </div>
    </div>
  `;
}

// Check if secondary color is meaningfully different from dominant
function hasDistinctSecondary(cp) {
  if (!cp?.secondaryColors?.length) return false;
  const d = cp.dominantColor, s = cp.secondaryColors[0];
  // Hue difference (circular)
  const hueDiff = Math.abs(d.hue - s.hue);
  const hueGap = Math.min(hueDiff, 360 - hueDiff);
  // Lightness and saturation differences
  const lightDiff = Math.abs(d.lightness - s.lightness);
  const satDiff = Math.abs(d.saturation - s.saturation);
  // Only show secondary if clearly a different color
  // (big hue shift, OR large lightness/saturation difference)
  return hueGap > 30 || lightDiff > 0.25 || satDiff > 0.3;
}

// ── Color Swatch Picker ──

app.showColorPicker = (itemId, which) => {
  const item = items.find(i => i.id === itemId);
  if (!item?.colorProfile) return;
  const cp = item.colorProfile;
  const current = which === 'dominant' ? cp.dominantColor : cp.secondaryColors?.[0];
  if (!current) return;

  // Generate alternative colors based on current color with variations
  const alternatives = generateColorAlternatives(current);

  openSheet(`
    <h2>Pick ${which === 'dominant' ? 'Dominant' : 'Secondary'} Color</h2>
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:4px">${esc(item.name)}</p>
    ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img" style="width:100%;max-height:150px;object-fit:contain;border-radius:var(--radius);background:var(--bg);margin-bottom:12px">` : ''}

    <p style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">Current:</p>
    <div style="display:flex;gap:8px;margin-bottom:16px;align-items:center">
      <div style="width:36px;height:36px;border-radius:50%;background:${hslToCss(current)};border:3px solid var(--accent);flex-shrink:0"></div>
      <span style="font-size:13px;color:var(--text-secondary)">${colorName(current)}</span>
    </div>

    <p style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">Tap a better match:</p>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
      ${alternatives.map((c, i) => `
        <div style="text-align:center;cursor:pointer" onclick="app.pickSwatchColor('${itemId}','${which}',${i})">
          <div style="width:44px;height:44px;border-radius:50%;background:${hslToCss(c)};margin:0 auto 4px;border:2px solid var(--border)"></div>
          <div style="font-size:10px;color:var(--text-secondary)">${colorName(c)}</div>
        </div>
      `).join('')}
    </div>

    <button class="btn btn-outline" style="margin-bottom:8px" onclick="app.customSwatchColor('${itemId}','${which}')">Custom Color</button>
    ${which === 'secondary' ? `<button class="btn btn-danger btn-sm" style="margin-bottom:8px" onclick="app.deleteSecondaryColor('${itemId}')">Remove Secondary Color</button>` : ''}
    <button class="btn btn-secondary" onclick="closeSheet()">Cancel</button>
  `);
  app._colorAlternatives = alternatives;
  lazyLoadImages();
};

function generateColorAlternatives(current) {
  const alts = [];
  const h = current.hue;
  const s = current.saturation;
  const l = current.lightness;

  // Darker / lighter versions
  alts.push({ hue: h, saturation: s, lightness: Math.max(0.08, l - 0.2) });
  alts.push({ hue: h, saturation: s, lightness: Math.min(0.92, l + 0.2) });

  // More / less saturated
  alts.push({ hue: h, saturation: Math.min(1, s + 0.25), lightness: l });
  alts.push({ hue: h, saturation: Math.max(0, s - 0.25), lightness: l });

  // Nearby hues
  alts.push({ hue: (h + 15) % 360, saturation: s, lightness: l });
  alts.push({ hue: (h + 345) % 360, saturation: s, lightness: l });

  // Warmer / cooler
  alts.push({ hue: (h + 30) % 360, saturation: Math.min(1, s + 0.1), lightness: l });
  alts.push({ hue: (h + 330) % 360, saturation: Math.min(1, s + 0.1), lightness: l });

  // Common clothing colors
  alts.push({ hue: 0, saturation: 0, lightness: 0.1 });    // black
  alts.push({ hue: 0, saturation: 0, lightness: 0.95 });   // white
  alts.push({ hue: 220, saturation: 0.6, lightness: 0.3 }); // navy
  alts.push({ hue: 30, saturation: 0.4, lightness: 0.35 }); // brown

  return alts;
}

function colorName(c) {
  const h = c.hue, s = c.saturation, l = c.lightness;
  if (l < 0.12) return 'Black';
  if (l > 0.9 && s < 0.1) return 'White';
  if (s < 0.08) return l < 0.4 ? 'Charcoal' : l < 0.65 ? 'Gray' : 'Light Gray';
  if (s < 0.2) return l < 0.4 ? 'Dark Gray' : 'Gray';

  let name = '';
  if (h < 15 || h >= 345) name = 'Red';
  else if (h < 40) name = 'Orange';
  else if (h < 55) name = 'Yellow';
  else if (h < 80) name = 'Olive';
  else if (h < 160) name = 'Green';
  else if (h < 195) name = 'Teal';
  else if (h < 250) name = 'Blue';
  else if (h < 290) name = 'Purple';
  else if (h < 345) name = 'Pink';

  if (l < 0.3) return 'Dark ' + name;
  if (l > 0.7) return 'Light ' + name;
  return name;
}

app.deleteSecondaryColor = async (itemId) => {
  const item = items.find(i => i.id === itemId);
  if (!item?.colorProfile) return;
  item.colorProfile.secondaryColors = [];
  await db.putItem(item);
  closeSheet();
  if (document.getElementById('detail-overlay')?.classList.contains('open')) {
    app.showItemDetail(itemId);
  } else {
    renderWardrobe();
  }
};

app.pickSwatchColor = async (itemId, which, altIdx) => {
  const item = items.find(i => i.id === itemId);
  if (!item?.colorProfile || !app._colorAlternatives) return;
  const newColor = app._colorAlternatives[altIdx];

  if (which === 'dominant') {
    item.colorProfile.dominantColor = newColor;
  } else {
    if (!item.colorProfile.secondaryColors?.length) {
      item.colorProfile.secondaryColors = [newColor];
    } else {
      item.colorProfile.secondaryColors[0] = newColor;
    }
  }

  await db.putItem(item);
  closeSheet();
  // If detail view is open, refresh it; otherwise refresh wardrobe
  if (document.getElementById('detail-overlay')?.classList.contains('open')) {
    app.showItemDetail(itemId);
  } else {
    renderWardrobe();
  }
};

app.customSwatchColor = (itemId, which) => {
  const item = items.find(i => i.id === itemId);
  if (!item?.colorProfile) return;
  const current = which === 'dominant' ? item.colorProfile.dominantColor : item.colorProfile.secondaryColors?.[0];
  if (!current) return;

  // Use the app's existing color picker
  const cpHue = document.getElementById('cp-hue');
  const cpSat = document.getElementById('cp-sat');
  const cpLight = document.getElementById('cp-light');
  cpHue.value = Math.round(current.hue);
  cpSat.value = Math.round(current.saturation * 100);
  cpLight.value = Math.round(current.lightness * 100);

  // Update preview
  const updatePreview = () => {
    const h = cpHue.value, s = cpSat.value, l = cpLight.value;
    document.getElementById('cp-preview').style.background = `hsl(${h},${s}%,${l}%)`;
    document.getElementById('cp-hue-val').textContent = h + '°';
    document.getElementById('cp-sat-val').textContent = s + '%';
    document.getElementById('cp-light-val').textContent = l + '%';
  };
  updatePreview();
  cpHue.oninput = updatePreview;
  cpSat.oninput = updatePreview;
  cpLight.oninput = updatePreview;

  document.getElementById('cp-done').onclick = async () => {
    const newColor = {
      hue: parseFloat(cpHue.value),
      saturation: parseFloat(cpSat.value) / 100,
      lightness: parseFloat(cpLight.value) / 100,
    };
    if (which === 'dominant') {
      item.colorProfile.dominantColor = newColor;
    } else {
      if (!item.colorProfile.secondaryColors?.length) {
        item.colorProfile.secondaryColors = [newColor];
      } else {
        item.colorProfile.secondaryColors[0] = newColor;
      }
    }
    await db.putItem(item);
    document.getElementById('color-picker-overlay').classList.remove('open');
    closeSheet();
    if (document.getElementById('detail-overlay')?.classList.contains('open')) {
      app.showItemDetail(itemId);
    } else {
      renderWardrobe();
    }
  };

  document.getElementById('color-picker-overlay').classList.add('open');
};

// ── Add Flow ──

// Holds newly added items after AI analysis so we can show the results screen
let newlyAddedItems = [];

app.showAddFlow = async () => {
  const savedKey = await db.getApiKey() || '';
  const hasKey = !!savedKey;
  openSheet(`
    <h2>Add Items</h2>
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px">
      Take a photo or pick from your library. AI will identify each item (shirt, pants, shoes...) and put it in the right section.
    </p>
    <label class="choice-card" for="file-camera-hidden">
      <div class="icon-box">📷</div>
      <div class="text">
        <h4>Take Photo</h4>
        <p>Snap a picture of an item or outfit</p>
      </div>
      <div class="chevron">›</div>
    </label>
    <label class="choice-card" for="file-picker-hidden">
      <div class="icon-box">🖼️</div>
      <div class="text">
        <h4>Choose from Photos</h4>
        <p>Select photos from your library</p>
      </div>
      <div class="chevron">›</div>
    </label>

    <div class="divider"></div>
    <div class="form-group">
      <label>OpenAI API Key ${hasKey ? '(saved)' : ''}</label>
      <input id="api-key-input" type="password" placeholder="sk-..." value="${savedKey}" onchange="app.saveApiKey(this.value)">
      <p style="font-size:11px;color:var(--text-secondary);margin-top:4px">Required for AI detection. Stored locally on your device only.</p>
    </div>
  `);
};

app.saveApiKey = (key) => {
  db.saveApiKey(key);
};


// ── Process photos through AI → save items → show results with outfit checkbox ──

app.handlePhotos = async (input) => {
  const files = Array.from(input.files);
  if (!files.length) return;
  input.value = '';

  // Save API key from the sheet input if present, then close sheet
  const sheetKeyInput = document.getElementById('api-key-input');
  if (sheetKeyInput?.value?.trim()) {
    await db.saveApiKey(sheetKeyInput.value.trim());
  }
  closeSheet();

  const apiKey = await db.getApiKey();
  if (!apiKey) { alert('Please set your OpenAI API key first (use the + button).'); return; }

  const total = files.length;
  newlyAddedItems = [];

  showLoading(`Analyzing photo 1 / ${total}...`);

  for (let i = 0; i < files.length; i++) {
    showLoading(`Analyzing photo ${i + 1} / ${total}...`);

    try {
      const garments = await analyzeOutfitPhoto(files[i], apiKey);

      for (let g = 0; g < garments.length; g++) {
        const garment = garments[g];
        showLoading(`Photo ${i + 1}/${total}: saving ${garment.description || garment.category}...`);

        let croppedBlob = null;
        let profile = null;

        const category = CATEGORIES.find(c => c.id === garment.category)?.id || 'shirt';

        if (garment.boundingBox) {
          const result = await extractFromRegion(files[i], garment.boundingBox, category);
          croppedBlob = result.croppedBlob;
          profile = result.profile;
        } else {
          profile = await extractColorProfile(files[i]);
          croppedBlob = files[i];
        }

        const imageId = generateId();
        await db.saveImage(imageId, croppedBlob);

        const item = createClothingItem({
          name: garment.description || `${category} ${items.length + 1}`,
          category,
          colorProfile: profile,
          imageId,
        });
        await db.putItem(item);
        items.push(item);
        newlyAddedItems.push(item);
      }
    } catch (err) {
      console.error(`Failed to analyze photo ${i + 1}:`, err);
      hideLoading();
      const cont = confirm(`Error on photo ${i + 1}: ${err.message}\n\nContinue with remaining photos?`);
      if (!cont) break;
      if (i + 1 < files.length) showLoading(`Analyzing photo ${i + 2} / ${total}...`);
    }
  }

  hideLoading();

  if (newlyAddedItems.length > 0) {
    showImportResults();
  } else {
    renderWardrobe();
  }
};

// ── Import Results Screen: shows detected items with "create outfits" checkboxes ──

function showImportResults() {
  // Track which items user wants outfits for
  const outfitChecked = {};
  newlyAddedItems.forEach(item => { outfitChecked[item.id] = false; });

  openSheet(buildResultsHTML(outfitChecked));
  lazyLoadImages();

  // Store in app scope so event handlers can access
  app._outfitChecked = outfitChecked;
}

function buildResultsHTML(outfitChecked) {
  const hasExistingItems = items.length > newlyAddedItems.length;
  return `
    <h2>Added ${newlyAddedItems.length} Item${newlyAddedItems.length > 1 ? 's' : ''}</h2>
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px">
      ${hasExistingItems ? 'Check any item to generate outfit ideas using your existing wardrobe.' : 'Items saved to your wardrobe.'}
    </p>
    ${newlyAddedItems.map((item, i) => {
      const cp = item.colorProfile;
      const cat = CATEGORIES.find(c => c.id === item.category);
      const checked = outfitChecked[item.id];
      return `
        <div style="display:flex;gap:10px;align-items:center;padding:10px;background:var(--bg);border-radius:10px;margin-bottom:8px">
          ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img" style="width:56px;height:56px;border-radius:8px;object-fit:cover;flex-shrink:0">` :
            `<div style="width:56px;height:56px;border-radius:8px;background:var(--border);display:flex;align-items:center;justify-content:center;flex-shrink:0">${cat?.icon || '👔'}</div>`}
          <div style="flex:1;min-width:0">
            <div style="font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(item.name)}</div>
            <div style="font-size:12px;color:var(--text-secondary)">${cat?.icon || ''} ${cat?.name || ''}</div>
          </div>
          ${cp ? `<div class="swatch md" style="background:${hslToCss(cp.dominantColor)};flex-shrink:0"></div>` : ''}
          ${hasExistingItems ? `
            <label style="display:flex;align-items:center;gap:6px;flex-shrink:0;cursor:pointer" onclick="event.stopPropagation()">
              <input type="checkbox" ${checked ? 'checked' : ''} onchange="app.toggleOutfitCheck('${item.id}', this.checked)" style="width:20px;height:20px;accent-color:var(--accent)">
              <span style="font-size:11px;color:var(--text-secondary)">Outfits</span>
            </label>
          ` : ''}
        </div>
      `;
    }).join('')}

    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="btn btn-secondary" onclick="app.finishImport()" style="flex:1">Done</button>
      ${hasExistingItems ? `<button class="btn btn-primary" id="gen-outfits-btn" onclick="app.generateOutfitsForChecked()" style="flex:1" disabled>Create Outfits</button>` : ''}
    </div>
  `;
}

app.toggleOutfitCheck = (itemId, checked) => {
  app._outfitChecked[itemId] = checked;
  const anyChecked = Object.values(app._outfitChecked).some(v => v);
  const btn = document.getElementById('gen-outfits-btn');
  if (btn) btn.disabled = !anyChecked;
};

app.finishImport = () => {
  newlyAddedItems = [];
  closeSheet();
  renderWardrobe();
};

app.generateOutfitsForChecked = async () => {
  const checkedItems = newlyAddedItems.filter(item => app._outfitChecked[item.id]);
  if (!checkedItems.length) return;

  closeSheet();
  showLoading('Generating outfits...');

  // Find the best palette for each checked item (highest affinity)
  const allResults = [];

  for (const seedItem of checkedItems) {
    // Find best-matching palette
    let bestPalette = palettes[0];
    let bestAffinity = -1;
    for (const pal of palettes) {
      const aff = paletteAffinity(seedItem, pal.colors);
      if (aff > bestAffinity) { bestAffinity = aff; bestPalette = pal; }
    }

    if (bestPalette) {
      const results = generateOutfits(items, bestPalette, seedItem);
      for (const r of results) {
        allResults.push({ ...r, seedItem, palette: bestPalette });
      }
    }
  }

  // De-duplicate and sort by score
  allResults.sort((a, b) => b.overallScore - a.overallScore);
  const topResults = allResults.slice(0, 8);

  hideLoading();
  newlyAddedItems = [];
  renderWardrobe();

  if (topResults.length > 0) {
    showGeneratedOutfitsSheet(topResults, checkedItems);
  } else {
    openSheet(`
      <h2>No Outfits Found</h2>
      <p style="color:var(--text-secondary);margin-bottom:16px">Add more items to different categories (shirts, pants, shoes) to generate outfit combinations.</p>
      <button class="btn btn-primary" onclick="app.closeSheetAndRender()">OK</button>
    `);
  }
};

app.closeSheetAndRender = () => { closeSheet(); renderWardrobe(); };

app.toggleSelectMode = () => {
  selectMode = !selectMode;
  selectedItems.clear();
  renderWardrobe();
};

app.toggleItemSelection = (id) => {
  if (selectedItems.has(id)) {
    selectedItems.delete(id);
  } else {
    selectedItems.add(id);
  }
  renderWardrobe();
};

app.deleteSelected = async () => {
  const count = selectedItems.size;
  if (!count) return;
  if (!confirm(`Delete ${count} selected item${count > 1 ? 's' : ''}?`)) return;

  showLoading(`Deleting ${count} items...`);
  const entries = [];
  for (const id of selectedItems) {
    const item = items.find(i => i.id === id);
    let imageData = null;
    if (item?.imageId) {
      imageData = await db.loadImage(item.imageId);
      await db.deleteImage(item.imageId).catch(() => {});
    }
    entries.push({ item: { ...item }, imageData });
    await db.deleteItem(id);
  }
  pushUndo({ type: 'delete-items', entries, description: `Restored ${count} deleted items` });
  items = items.filter(i => !selectedItems.has(i.id));
  selectedItems.clear();
  selectMode = false;
  hideLoading();
  renderWardrobe();
};

app.createOutfitFromSelected = () => {
  const seedIds = [...selectedItems];
  if (seedIds.length === 0 || seedIds.length > 2) return;
  app._seedSelections = new Set(seedIds);
  app._outfitGuidance = '';
  if (seedIds.length === 1) {
    outfitSeedItem = items.find(i => i.id === seedIds[0]);
  } else {
    outfitSeedItem = seedIds.map(id => items.find(i => i.id === id)).filter(Boolean);
  }
  selectMode = false;
  selectedItems.clear();
  showOutfitStep2();
};

app.goHome = () => {
  closeSheet();
  closeDetail();
  currentTab = 'wardrobe';
  document.querySelectorAll('.tab-bar button').forEach(b => b.classList.toggle('active', b.dataset.tab === 'wardrobe'));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-wardrobe').classList.add('active');
  renderWardrobe();
};

app.deleteAllItems = async () => {
  if (!confirm(`Delete all ${items.length} items from your wardrobe? This cannot be undone.`)) return;
  showLoading('Deleting all items...');
  for (const item of items) {
    if (item.imageId) await db.deleteImage(item.imageId).catch(() => {});
    await db.deleteItem(item.id);
  }
  items = [];
  // Also clear outfits since they reference deleted items
  for (const o of outfits) {
    await db.deleteOutfit(o.id).catch(() => {});
  }
  outfits = [];
  hideLoading();
  renderWardrobe();
};

// ══════════════════════════════════════
// ── EXPORT / IMPORT WARDROBE ──
// ══════════════════════════════════════

app.exportWardrobe = async () => {
  showLoading('Exporting wardrobe...');
  try {
    const data = await db.exportAll((done, total) => {
      document.getElementById('loading-msg').textContent = `Exporting images... ${done}/${total}`;
    });
    const json = JSON.stringify(data);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wardrobe-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    hideLoading();
  } catch (err) {
    hideLoading();
    alert('Export failed: ' + err.message);
  }
};

app.showImportWardrobe = () => {
  openSheet(`
    <h2>Import Wardrobe</h2>
    <p style="color:var(--text-secondary);margin-bottom:16px">Select a wardrobe backup file (.json) to import. Existing items will be kept — duplicates are merged.</p>
    <input type="file" accept=".json,application/json" id="import-file-input" style="margin-bottom:16px">
    <button class="btn btn-primary" onclick="app.doImportWardrobe()">Import</button>
  `);
};

app.doImportWardrobe = async () => {
  const fileInput = document.getElementById('import-file-input');
  const file = fileInput?.files?.[0];
  if (!file) { alert('Please select a file.'); return; }

  closeSheet();
  showLoading('Reading file...');
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.items && !data.palettes && !data.outfits) {
      throw new Error('Invalid backup file — no wardrobe data found.');
    }
    const result = await db.importAll(data, (done, total) => {
      document.getElementById('loading-msg').textContent = `Importing... ${done}/${total}`;
    });
    hideLoading();
    await loadData();
    renderWardrobe();
    alert(`Imported ${result.items} items, ${result.palettes} palettes, ${result.outfits} outfits, ${result.images} images.`);
  } catch (err) {
    hideLoading();
    alert('Import failed: ' + err.message);
  }
};

// ══════════════════════════════════════
// ── RE-ANALYZE ALL ITEMS ──
// ══════════════════════════════════════

app.removeAllBackgrounds = async () => {
  const withImages = items.filter(i => i.imageId);
  if (!withImages.length) return;
  if (!confirm(`Remove backgrounds from ${withImages.length} items?`)) return;
  showLoading('Removing backgrounds...');
  let done = 0;
  for (const item of withImages) {
    done++;
    document.getElementById('loading-msg').textContent = `Removing background ${done}/${withImages.length}...`;
    try {
      const imgData = await db.loadImage(item.imageId);
      if (!imgData) continue;
      let blob;
      if (typeof imgData === 'string') {
        const resp = await fetch(imgData);
        blob = await resp.blob();
      } else {
        blob = imgData;
      }
      const noBg = await removeBackground(blob);
      await db.saveImage(item.imageId, noBg);
    } catch (e) { console.warn('BG removal failed for', item.id, e); }
  }
  hideLoading();
  renderCurrentTab();
};

app.reanalyzeAll = async () => {
  const apiKey = await db.getApiKey();
  if (!apiKey) {
    openSheet(`
      <h2>API Key Needed</h2>
      <p style="color:var(--text-secondary);margin-bottom:16px">Enter your OpenAI API key to re-analyze items.</p>
      <div class="form-group">
        <input id="reanalyze-key" type="password" placeholder="sk-..." value="">
      </div>
      <button class="btn btn-primary" onclick="app.saveKeyAndReanalyze()">Continue</button>
    `);
    return;
  }
  await runReanalysis(apiKey);
};

app.saveKeyAndReanalyze = async () => {
  const key = document.getElementById('reanalyze-key')?.value?.trim();
  if (!key) { alert('Please enter your API key.'); return; }
  await db.saveApiKey(key);
  closeSheet();
  await runReanalysis(key);
};

async function runReanalysis(apiKey) {
  const total = items.length;
  if (!total) return;

  if (!confirm(`Re-analyze ${total} item${total > 1 ? 's' : ''}? This will re-classify items and split outfit photos into individual garments.`)) return;

  showLoading(`Re-analyzing item 1 / ${total}...`);

  // Work on a copy of the items list since we'll modify it
  const originalItems = [...items];
  const newItems = [];
  const itemsToDelete = [];

  for (let i = 0; i < originalItems.length; i++) {
    const item = originalItems[i];
    showLoading(`Re-analyzing ${i + 1} / ${total}: ${item.name}...`);

    try {
      // Load the stored image
      const blob = await db.loadImage(item.imageId);
      if (!blob) {
        // No image stored, keep as-is
        newItems.push(item);
        continue;
      }

      // Send to AI for analysis
      const garments = await analyzeOutfitPhoto(blob, apiKey);

      if (!garments.length) {
        // AI found nothing, keep original
        newItems.push(item);
        continue;
      }

      if (garments.length === 1) {
        // Single garment detected — just update the category if different
        const g = garments[0];
        const newCat = CATEGORIES.find(c => c.id === g.category)?.id || item.category;

        // If bounding box is much smaller than whole image, re-crop it
        const b = g.boundingBox;
        const isSmallCrop = b && (b.width < 0.85 || b.height < 0.85);

        if (isSmallCrop) {
          const result = await extractFromRegion(blob, b, newCat);
          const newImageId = generateId();
          await db.saveImage(newImageId, result.croppedBlob);

          item.category = newCat;
          item.name = g.description || item.name;
          item.colorProfile = result.profile;
          // Keep old imageId around, save new one
          const oldImageId = item.imageId;
          item.imageId = newImageId;
          await db.putItem(item);
          // Clean up old image if it changed
          if (oldImageId !== newImageId) await db.deleteImage(oldImageId).catch(() => {});
        } else {
          item.category = newCat;
          item.name = g.description || item.name;
          await db.putItem(item);
        }
        newItems.push(item);
      } else {
        // Multiple garments — split into individual items
        itemsToDelete.push(item);

        for (const g of garments) {
          showLoading(`Re-analyzing ${i + 1}/${total}: isolating ${g.description || g.category}...`);

          const cat = CATEGORIES.find(c => c.id === g.category)?.id || 'shirt';
          let croppedBlob = blob;
          let profile = null;

          if (g.boundingBox) {
            const result = await extractFromRegion(blob, g.boundingBox, cat);
            croppedBlob = result.croppedBlob;
            profile = result.profile;
          } else {
            profile = await extractColorProfile(blob);
          }

          const newImageId = generateId();
          await db.saveImage(newImageId, croppedBlob);

          const newItem = createClothingItem({
            name: g.description || `${cat}`,
            category: cat,
            colorProfile: profile,
            imageId: newImageId,
          });
          await db.putItem(newItem);
          newItems.push(newItem);
        }
      }
    } catch (err) {
      console.error(`Re-analysis failed for ${item.name}:`, err);
      // Keep original on error
      newItems.push(item);

      hideLoading();
      const cont = confirm(`Error on "${item.name}": ${err.message}\n\nContinue with remaining items?`);
      if (!cont) break;
      showLoading(`Re-analyzing ${i + 2} / ${total}...`);
    }
  }

  // Delete the old items that were split
  for (const old of itemsToDelete) {
    await db.deleteItem(old.id);
    if (old.imageId) await db.deleteImage(old.imageId).catch(() => {});
  }

  // Update the global items array
  items = newItems;

  hideLoading();
  renderWardrobe();

  // Show summary
  const splitCount = itemsToDelete.length;
  const totalNew = newItems.length;
  openSheet(`
    <div style="text-align:center;padding:24px">
      <div style="font-size:48px;margin-bottom:12px">✅</div>
      <h2>Re-analysis Complete</h2>
      <p style="color:var(--text-secondary);margin-bottom:16px">
        ${splitCount > 0 ? `Split ${splitCount} outfit photo${splitCount > 1 ? 's' : ''} into individual items. ` : ''}
        You now have ${totalNew} item${totalNew !== 1 ? 's' : ''} across your wardrobe.
      </p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-bottom:16px">
        ${CATEGORIES.map(cat => {
          const count = newItems.filter(i => i.category === cat.id).length;
          return `<span style="padding:6px 12px;background:var(--bg);border-radius:16px;font-size:13px">${cat.icon} ${count} ${cat.name}${count !== 1 ? 's' : ''}</span>`;
        }).join('')}
      </div>
      <button class="btn btn-primary" onclick="app.closeSheetAndRender()">Done</button>
    </div>
  `);
};

async function showGeneratedOutfitsSheet(results, seedItems, vibe) {
  // Auto-save all generated outfits
  await autoSaveOutfits(results);
  // Store results so event handlers can access them
  app._genResults = results;

  const seedNames = seedItems.map(i => i.name).join(', ');
  const vibeLabel = vibe ? `${vibe.icon} ${vibe.name}` : '';
  openSheet(`
    <h2>Outfit Ideas</h2>
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px">
      ${results.length} outfits generated${seedNames ? ` for: ${esc(seedNames)}` : ''}${vibeLabel ? ` — ${vibeLabel}` : ''}
    </p>
    <div class="outfit-list">
      ${results.map((r, i) => `
        <div class="outfit-card-wide" onclick="app.showGenOutfitDetail(${i})">
          <div class="outfit-card-row">
            <div class="outfit-card-ai">
              <div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--bg);flex-direction:column;gap:6px">
                <div class="spinner" style="width:24px;height:24px;margin:0"></div>
                <span style="font-size:11px;color:var(--text-secondary)">Generating...</span>
              </div>
            </div>
            <div class="outfit-card-items">
              ${r.items.map(item => `
                <div class="outfit-card-item">
                  ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img">` :
                    `<div class="outfit-card-item-placeholder" style="background:${item.colorProfile ? hslToCss(item.colorProfile.dominantColor) : 'var(--bg)'}">
                      ${CATEGORIES.find(c => c.id === item.category)?.icon || ''}
                    </div>`}
                  <span class="outfit-card-item-name">${esc(item.name)}</span>
                </div>
              `).join('')}
            </div>
          </div>
          <div class="score-badge">
            <span class="pct ${scoreColor(r.overallScore)}">${Math.round(r.overallScore * 100)}%</span>
            <span style="color:var(--text-secondary)">${r.items.length} items</span>
          </div>
        </div>
      `).join('')}
    </div>
    <div id="ai-progress-bar" style="position:sticky;bottom:0;background:var(--card);padding:10px 16px;border-top:1px solid var(--border)">
      <div style="font-size:13px;font-weight:600;margin-bottom:6px">Generating AI images: <span id="ai-progress-text">0%</span></div>
      <div style="height:6px;background:var(--bg);border-radius:3px;overflow:hidden">
        <div id="ai-progress-fill" style="height:100%;background:var(--accent);border-radius:3px;width:0%;transition:width 0.3s"></div>
      </div>
      <p style="font-size:11px;color:var(--text-secondary);margin-top:4px">You can close this and keep working — images will appear in Outfits tab</p>
    </div>
    <button class="btn btn-secondary" style="margin-top:8px" onclick="app.closeSheetAndRender()">Close & Continue in Background</button>
    <button class="btn btn-secondary" style="margin-top:8px" onclick="closeSheet(); showOutfitStep2()">‹ Back to Vibe Selection</button>
  `);
  lazyLoadImages();

  // Start background AI image generation with progress
  generateAiImagesInBackground(results);
}

// Background AI image generation — works even after sheet is closed
async function generateAiImagesInBackground(results) {
  const apiKey = await db.getApiKey();
  if (!apiKey) return;

  const total = results.length;
  let done = 0;

  function updateProgress() {
    const pct = Math.round((done / total) * 100);
    // Update progress bar in sheet (if still open)
    const fill = document.getElementById('ai-progress-fill');
    const text = document.getElementById('ai-progress-text');
    if (fill) fill.style.width = `${pct}%`;
    if (text) text.textContent = `${pct}% (${done}/${total})`;
    // Re-render Outfits tab to show new images
    renderOutfits();
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const cacheKey = outfitImageCacheKey(r.items.map(it => it.id));
    const cached = await db.loadImage(cacheKey);
    if (cached) {
      // Update outfit in memory if needed
      const savedOutfit = outfits.find(o => outfitImageCacheKey(o.itemIds) === cacheKey);
      if (savedOutfit && !savedOutfit.aiImageId) {
        savedOutfit.aiImageId = cacheKey;
        await db.putOutfit(savedOutfit);
      }
      done++;
      updateProgress();
      continue;
    }

    try {
      const descriptions = r.items.map(it => ({ name: it.name, color: it.colorProfile?.dominantColor }));
      const blob = await generateOutfitImage(descriptions, apiKey);
      await db.saveImage(cacheKey, blob);

      // Update the saved outfit in DB
      const savedOutfit = outfits.find(o => outfitImageCacheKey(o.itemIds) === cacheKey);
      if (savedOutfit && !savedOutfit.aiImageId) {
        savedOutfit.aiImageId = cacheKey;
        await db.putOutfit(savedOutfit);
      }

      done++;
      updateProgress();
    } catch (err) {
      console.error('[AI] Background image generation failed:', err.message);
      break;
    }
  }

  // Mark complete in sheet if still open
  const bar = document.getElementById('ai-progress-bar');
  if (bar) {
    bar.innerHTML = `<div style="text-align:center;font-size:13px;color:var(--success);padding:4px">All ${done} AI images generated!</div>`;
    setTimeout(() => { if (bar.parentNode) bar.remove(); }, 3000);
  }
}

app.showGenOutfitDetail = (idx) => {
  const r = app._genResults[idx];
  if (!r) return;
  const cacheKey = outfitImageCacheKey(r.items.map(i => i.id));
  // Find matching saved outfit for wishlist
  const savedOutfit = outfits.find(o => outfitImageCacheKey(o.itemIds) === cacheKey);
  const isInWishlist = savedOutfit && wishlist.some(w => w.outfitId === savedOutfit.id);

  const colorExpl = r.colorScore >= 0.7 ? 'Colors work very well together' : r.colorScore >= 0.4 ? 'Colors are acceptable but could improve' : 'Colors don\'t match well';
  const compExpl = r.completenessScore >= 0.7 ? 'Has all key pieces' : r.completenessScore >= 0.4 ? 'Missing some optional pieces' : 'Missing essential items';
  const styleExpl = r.styleScore >= 0.7 ? 'Consistent style direction' : r.styleScore >= 0.4 ? 'Mixed styles' : 'Conflicting styles';

  closeSheet();
  openSheet(`
    <h2>Outfit #${idx + 1}</h2>
    <img data-ai-cache-key="${cacheKey}" class="lazy-ai-cache" style="width:100%;max-height:350px;object-fit:contain;border-radius:var(--radius);background:var(--bg);margin-bottom:12px">

    <div class="section-title">Items</div>
    ${r.items.map(item => {
      const cat = CATEGORIES.find(c => c.id === item.category);
      return `
        <div class="item-row" style="padding:6px 8px;margin-bottom:4px;cursor:pointer" onclick="closeSheet(); app.showItemDetail('${item.id}')">
          ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img" style="width:50px;height:50px;border-radius:6px">` :
            `<div style="width:50px;height:50px;border-radius:6px;background:${item.colorProfile ? hslToCss(item.colorProfile.dominantColor) : 'var(--bg)'};display:flex;align-items:center;justify-content:center;font-size:14px">${cat?.icon || ''}</div>`}
          <div class="item-info" style="min-width:0">
            <div class="name" style="font-size:13px">${esc(item.name)}</div>
            <div class="cat" style="font-size:11px">${cat?.name || ''}</div>
          </div>
        </div>
      `;
    }).join('')}

    ${savedOutfit ? `<button class="btn ${isInWishlist ? 'btn-secondary' : 'btn-outline'}" style="margin-top:10px" onclick="app.toggleWishlist('${savedOutfit.id}'); app.showGenOutfitDetail(${idx})">
      ${isInWishlist ? '✓ In Wish List' : '🛒 Wish List'}
    </button>` : ''}

    <div class="divider"></div>
    <div class="score-row"><span class="label">Color Match</span><span class="value ${scoreColor(r.colorScore)}">${Math.round(r.colorScore * 100)}%</span></div>
    <div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px">${colorExpl}</div>
    <div class="score-row"><span class="label">Completeness</span><span class="value ${scoreColor(r.completenessScore)}">${Math.round(r.completenessScore * 100)}%</span></div>
    <div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px">${compExpl}</div>
    <div class="score-row"><span class="label">Style Harmony</span><span class="value ${scoreColor(r.styleScore)}">${Math.round(r.styleScore * 100)}%</span></div>
    <div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px">${styleExpl}</div>
    <div class="divider"></div>
    <div class="score-row"><span class="label" style="font-weight:700">Overall</span><span class="value ${scoreColor(r.overallScore)}" style="font-weight:700">${Math.round(r.overallScore * 100)}%</span></div>
    <div class="palette-bar" style="margin:16px 0">
      ${r.items.filter(it => it.colorProfile).map(it => `<div style="background:${hslToCss(it.colorProfile.dominantColor)}"></div>`).join('')}
    </div>
    <div style="text-align:center;font-size:13px;color:var(--success);margin-bottom:8px">Auto-saved to Outfits</div>
    <button class="btn btn-secondary" onclick="app.backToGenResults()">‹ Back to Results</button>
  `);
  lazyLoadImages();
};

app.saveGenOutfit = async (idx) => {
  const r = app._genResults[idx];
  if (!r) return;
  const cacheKey = outfitImageCacheKey(r.items.map(i => i.id));
  const aiBlob = await db.loadImage(cacheKey);
  const outfit = createOutfit({
    itemIds: r.items.map(i => i.id),
    colorScore: r.colorScore,
    completenessScore: r.completenessScore,
    styleScore: r.styleScore,
    overallScore: r.overallScore,
    aiImageId: aiBlob ? cacheKey : null,
  });
  await db.putOutfit(outfit);
  outfits.push(outfit);
  closeSheet();
  openSheet(`
    <div style="text-align:center;padding:24px">
      <div style="font-size:48px;margin-bottom:12px">✅</div>
      <h2>Outfit Saved!</h2>
      <p style="color:var(--text-secondary);margin-bottom:16px">You can find it in the Outfits tab.</p>
      <button class="btn btn-secondary" onclick="app.backToGenResults()">See More Outfits</button>
      <button class="btn btn-primary" style="margin-top:8px" onclick="app.closeSheetAndRender()">Done</button>
    </div>
  `);
};

app.backToGenResults = () => {
  if (app._genResults?.length) {
    closeSheet();
    showGeneratedOutfitsSheet(app._genResults, []);
  }
};

function showLoading(msg) {
  document.getElementById('loading-msg').textContent = msg;
  document.getElementById('loading-overlay').classList.add('show');
}

function hideLoading() {
  document.getElementById('loading-overlay').classList.remove('show');
}

// ══════════════════════════════════════
// ── CREATE OUTFIT FLOW ──
// ══════════════════════════════════════

let outfitSeedItem = null;
let outfitVibe = null;
let outfitWeather = null;
let outfitNoJeans = false;

app._seedSelections = new Set();
app._outfitGuidance = '';

app.startCreateOutfit = () => {
  app._seedSelections = new Set();
  app._outfitGuidance = '';
  outfitSeedItem = null;
  outfitVibe = null;
  outfitWeather = null;
  outfitNoJeans = false;
  showOutfitStep1();
};

// Step 1: Pick items (multi-select) + text guidance
function showOutfitStep1() {
  const selectedCount = app._seedSelections.size;
  openSheet(`
    <h2>Create Outfit</h2>
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px">
      Pick 1-2 items to build the outfit around, then add optional guidance.
    </p>

    <div class="choice-card" onclick="app.outfitNewPhoto()">
      <div class="icon-box">📷</div>
      <div class="text">
        <h4>New Photo</h4>
        <p>Take a photo of an item</p>
      </div>
      <div class="chevron">›</div>
    </div>

    ${items.length > 0 ? `
      <div class="section-label" style="margin-top:16px">Pick from your wardrobe (up to 2):</div>
      <div id="pick-item-list" style="max-height:250px;overflow-y:auto">
        ${CATEGORIES.map(cat => {
          const catItems = items.filter(i => i.category === cat.id);
          if (!catItems.length) return '';
          return `
            <div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin:10px 0 4px">${cat.icon} ${plural(cat.name)}</div>
            ${catItems.map(item => `
              <div class="pick-item-row ${app._seedSelections.has(item.id) ? 'selected' : ''}" onclick="app.toggleSeedItem('${item.id}')">
                ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img" style="width:44px;height:44px;border-radius:8px;object-fit:cover">` :
                  `<div style="width:44px;height:44px;border-radius:8px;background:var(--border);display:flex;align-items:center;justify-content:center">${cat.icon}</div>`}
                <div style="flex:1;min-width:0">
                  <div style="font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(item.name)}</div>
                </div>
                ${item.colorProfile ? `<div class="swatch" style="background:${hslToCss(item.colorProfile.dominantColor)}"></div>` : ''}
                <div style="width:22px;height:22px;border-radius:50%;border:2px solid ${app._seedSelections.has(item.id) ? 'var(--accent)' : 'var(--border)'};display:flex;align-items:center;justify-content:center;flex-shrink:0">
                  ${app._seedSelections.has(item.id) ? '<span style="color:var(--accent);font-size:14px;font-weight:700">✓</span>' : ''}
                </div>
              </div>
            `).join('')}
          `;
        }).join('')}
      </div>
    ` : ''}

    <div class="divider"></div>
    <div class="form-group">
      <label>Guidance (optional)</label>
      <input id="outfit-guidance" type="text" placeholder="e.g. no jeans, rainy day, formal meeting..." value="${esc(app._outfitGuidance)}" oninput="app._outfitGuidance = this.value">
    </div>

    <button class="btn btn-primary" onclick="app.goToStep2()" ${selectedCount === 0 ? 'disabled' : ''}>
      Continue with ${selectedCount} item${selectedCount !== 1 ? 's' : ''} selected
    </button>

    <input type="file" accept="image/*" capture="environment" class="file-input" id="file-outfit-new" onchange="app.handleOutfitNewPhoto(this)">
  `);
  lazyLoadImages();
};

app.toggleSeedItem = (id) => {
  if (app._seedSelections.has(id)) {
    app._seedSelections.delete(id);
  } else {
    if (app._seedSelections.size >= 2) return;
    app._seedSelections.add(id);
  }
  // Save guidance before re-render
  const guidanceEl = document.getElementById('outfit-guidance');
  if (guidanceEl) app._outfitGuidance = guidanceEl.value;
  showOutfitStep1();
};

app.goToStep2 = () => {
  const guidanceEl = document.getElementById('outfit-guidance');
  if (guidanceEl) app._outfitGuidance = guidanceEl.value;
  const seedIds = [...app._seedSelections];
  if (seedIds.length === 1) {
    outfitSeedItem = items.find(i => i.id === seedIds[0]);
  } else {
    outfitSeedItem = seedIds.map(id => items.find(i => i.id === id)).filter(Boolean);
  }
  closeSheet();
  showOutfitStep2();
};

app.outfitNewPhoto = async () => {
  const apiKey = await db.getApiKey();
  if (!apiKey) { alert('Please set your OpenAI API key first (use the + button).'); return; }
  document.getElementById('file-outfit-new').click();
};

app.handleOutfitNewPhoto = async (input) => {
  const file = input.files[0];
  if (!file) return;
  input.value = '';

  const apiKey = await db.getApiKey();
  closeSheet();
  showLoading('AI is identifying the item...');

  try {
    const garments = await analyzeOutfitPhoto(file, apiKey);
    if (!garments.length) { hideLoading(); alert('Could not identify any items.'); showOutfitStep1(); return; }

    // Take the first detected garment as the seed item
    const garment = garments[0];
    let croppedBlob = file;
    let profile = await extractColorProfile(file);

    const category = CATEGORIES.find(c => c.id === garment.category)?.id || 'shirt';

    if (garment.boundingBox) {
      const result = await extractFromRegion(file, garment.boundingBox, category);
      croppedBlob = result.croppedBlob;
      profile = result.profile;
    }

    const imageId = generateId();
    await db.saveImage(imageId, croppedBlob);
    const item = createClothingItem({
      name: garment.description || `${category}`,
      category,
      colorProfile: profile,
      imageId,
    });
    await db.putItem(item);
    items.push(item);

    // Also save any other garments from the photo
    for (let i = 1; i < garments.length; i++) {
      const g = garments[i];
      let cb = file, pr = await extractColorProfile(file);
      const gcat = CATEGORIES.find(c => c.id === g.category)?.id || 'shirt';
      if (g.boundingBox) {
        const res = await extractFromRegion(file, g.boundingBox, gcat);
        cb = res.croppedBlob;
        pr = res.profile;
      }
      const iid = generateId();
      await db.saveImage(iid, cb);
      const cat = CATEGORIES.find(c => c.id === g.category)?.id || 'shirt';
      const extra = createClothingItem({ name: g.description || cat, category: cat, colorProfile: pr, imageId: iid });
      await db.putItem(extra);
      items.push(extra);
    }

    outfitSeedItem = item;
    hideLoading();
    showOutfitStep2();
  } catch (err) {
    hideLoading();
    alert('Error: ' + err.message);
    showOutfitStep1();
  }
};

app.pickExistingItem = (id) => {
  outfitSeedItem = items.find(i => i.id === id);
  if (!outfitSeedItem) return;
  closeSheet();
  showOutfitStep2();
};

// Step 2: Pick a vibe
function showOutfitStep2() {
  const seeds = Array.isArray(outfitSeedItem) ? outfitSeedItem : (outfitSeedItem ? [outfitSeedItem] : []);

  const WEATHERS = [
    { id: 'hot', name: 'Hot', icon: '☀️' },
    { id: 'warm', name: 'Warm', icon: '🌤️' },
    { id: 'mild', name: 'Mild', icon: '⛅' },
    { id: 'cool', name: 'Cool', icon: '🌥️' },
    { id: 'cold', name: 'Cold', icon: '❄️' },
    { id: 'rainy', name: 'Rainy', icon: '🌧️' },
  ];

  openSheet(`
    <h2>Choose a Vibe</h2>
    ${seeds.map(seed => {
      const cat = CATEGORIES.find(c => c.id === seed?.category);
      return `<div style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg);border-radius:10px;margin-bottom:8px">
        ${seed?.imageId ? `<img data-image-id="${seed.imageId}" class="lazy-img" style="width:48px;height:48px;border-radius:8px;object-fit:cover">` :
          `<div style="width:48px;height:48px;border-radius:8px;background:var(--border);display:flex;align-items:center;justify-content:center">${cat?.icon || '👔'}</div>`}
        <div style="flex:1">
          <div style="font-size:14px;font-weight:600">${esc(seed?.name || 'Item')}</div>
          <div style="font-size:12px;color:var(--text-secondary)">${cat?.name || ''}</div>
        </div>
        ${seed?.colorProfile ? `<div class="swatch md" style="background:${hslToCss(seed.colorProfile.dominantColor)}"></div>` : ''}
      </div>`;
    }).join('')}

    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">What's the occasion?</p>
    <div class="vibe-grid">
      ${VIBES.map(v => `
        <div class="vibe-card ${outfitVibe === v.id ? 'selected' : ''}" onclick="app.selectVibe('${v.id}')">
          <div class="vibe-icon">${v.icon}</div>
          <div class="vibe-name">${v.name}</div>
        </div>
      `).join('')}
    </div>

    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;margin-top:20px">What's the weather?</p>
    <div class="weather-grid">
      ${WEATHERS.map(w => `
        <div class="weather-chip ${outfitWeather === w.id ? 'selected' : ''}" onclick="app.selectWeather('${w.id}')">
          <span class="weather-icon">${w.icon}</span>
          <span class="weather-name">${w.name}</span>
        </div>
      `).join('')}
    </div>

    <div style="display:flex;align-items:center;gap:10px;margin-top:16px;padding:10px 12px;background:var(--bg);border-radius:var(--radius-sm)">
      <label style="flex:1;font-size:14px;font-weight:600;cursor:pointer" for="no-jeans-toggle">No jeans</label>
      <div class="toggle-switch ${outfitNoJeans ? 'on' : ''}" onclick="app.toggleNoJeans()">
        <div class="toggle-knob"></div>
      </div>
    </div>

    <div class="form-group" style="margin-top:16px">
      <label>Additional notes (optional)</label>
      <input id="outfit-extra-text" type="text" placeholder="e.g. meeting with client, outdoor dinner..." value="${esc(app._outfitGuidance)}" oninput="app._outfitGuidance = this.value">
    </div>

    <button class="btn btn-primary" style="margin-top:12px" id="generate-btn" onclick="app.runVibeOutfitGen()" ${!outfitVibe ? 'disabled' : ''}>
      ✨ Generate Outfits
    </button>
    <button class="btn btn-secondary" style="margin-top:8px" onclick="closeSheet(); showOutfitStep1()">‹ Back</button>
  `);
  lazyLoadImages();
}

app.selectVibe = (vibeId) => {
  outfitVibe = vibeId;
  // Update UI in-place instead of full re-render
  document.querySelectorAll('.vibe-card').forEach(card => {
    card.classList.toggle('selected', card.getAttribute('onclick')?.includes(`'${vibeId}'`));
  });
  const btn = document.getElementById('generate-btn');
  if (btn) btn.disabled = false;
};

app.selectWeather = (weatherId) => {
  outfitWeather = outfitWeather === weatherId ? null : weatherId;
  document.querySelectorAll('.weather-chip').forEach(chip => {
    chip.classList.toggle('selected', chip.getAttribute('onclick')?.includes(`'${weatherId}'`) && outfitWeather === weatherId);
  });
};

app.toggleNoJeans = () => {
  outfitNoJeans = !outfitNoJeans;
  const toggle = document.querySelector('.toggle-switch');
  if (toggle) toggle.classList.toggle('on', outfitNoJeans);
};

app.runVibeOutfitGen = () => {
  if (!outfitSeedItem || !outfitVibe) return;
  const vibe = VIBES.find(v => v.id === outfitVibe);
  if (!vibe) return;

  // Capture free text before closing
  const el = document.getElementById('outfit-extra-text');
  if (el) app._outfitGuidance = el.value;

  closeSheet();
  showLoading('Generating outfits...');

  const seeds = Array.isArray(outfitSeedItem) ? outfitSeedItem : [outfitSeedItem];

  setTimeout(() => {
    const vibePalette = { id: 'vibe-temp', name: vibe.name, colors: vibe.colors, harmonyType: 'analogous', isBuiltIn: false };

    // Filter items by guidance and preferences
    let filteredItems = items;

    // No jeans toggle
    if (outfitNoJeans) {
      filteredItems = filteredItems.filter(item => {
        const name = item.name.toLowerCase();
        return !name.includes('jeans') && !name.includes('denim');
      });
    }

    // Weather filtering — exclude heavy layers in hot weather, light items in cold
    if (outfitWeather === 'hot' || outfitWeather === 'warm') {
      filteredItems = filteredItems.filter(item => {
        const name = item.name.toLowerCase();
        return !name.includes('wool') && !name.includes('heavy') && !name.includes('parka') && !name.includes('down jacket');
      });
    }
    if (outfitWeather === 'cold') {
      // Favor jackets — don't exclude them
    }

    // Text guidance exclusions
    const guidance = (app._outfitGuidance || '').toLowerCase().trim();
    if (guidance) {
      const noMatches = guidance.match(/no\s+(\w+)/gi) || [];
      const excludeTerms = noMatches.map(m => m.replace(/^no\s+/i, '').toLowerCase());
      if (excludeTerms.length) {
        filteredItems = filteredItems.filter(item => {
          const name = item.name.toLowerCase();
          return !excludeTerms.some(term => name.includes(term));
        });
      }
    }

    const results = generateOutfits(filteredItems, vibePalette, seeds);

    hideLoading();

    if (results.length > 0) {
      app._genResults = results;
      showGeneratedOutfitsSheet(results, seeds, vibe);
    } else {
      openSheet(`
        <h2>No Outfits Found</h2>
        <p style="color:var(--text-secondary);margin-bottom:16px">
          You need items in different categories (shirts, pants, shoes) to generate combinations. Add more items and try again.
        </p>
        <button class="btn btn-primary" onclick="app.closeSheetAndRender()">OK</button>
      `);
    }
  }, 50);
};

// ── Item Detail ──
app.showItemDetail = async (id) => {
  const item = items.find(i => i.id === id);
  if (!item) return;

  let imgSrc = '';
  if (item.imageId) {
    const data = await db.loadImage(item.imageId);
    if (data) imgSrc = (typeof data === 'string') ? data : URL.createObjectURL(data);
  }

  const cp = item.colorProfile;
  openDetail(`
    <div class="detail-header">
      <button class="back-btn" onclick="app.closeDetail()">‹ Back</button>
      <h1 style="font-size:17px;flex:1">${esc(item.name)}</h1>
      ${item.imageId ? `<button class="btn-icon" style="font-size:16px" onclick="app.removeItemBg('${item.id}')">✂️</button>` : ''}
      <button class="btn-icon" style="font-size:16px" onclick="app.deleteItem('${item.id}')">🗑️</button>
    </div>
    <div class="detail-body">
      ${imgSrc ? `<img src="${imgSrc}" class="detail-image">` : ''}

      <div style="background:var(--card);border:1.5px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:16px">
        <div style="font-size:13px;font-weight:600;color:var(--text-secondary);margin-bottom:6px">Description (edit to correct)</div>
        <textarea id="item-name-edit" rows="2" style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:var(--radius-sm);font-size:14px;font-family:inherit;resize:vertical">${esc(item.name)}</textarea>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-sm btn-primary" style="flex:1" onclick="app.saveItemName('${item.id}')">Save Description</button>
          <button class="btn btn-sm btn-outline" style="flex:1" onclick="app.reanalyzeItem('${item.id}')">🔄 Re-analyze with AI</button>
        </div>
      </div>

      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
        <span style="padding:5px 12px;background:var(--bg);border-radius:16px;font-size:13px">${CATEGORIES.find(c => c.id === item.category)?.icon || ''} ${CATEGORIES.find(c => c.id === item.category)?.name || ''}</span>
        <span style="margin-left:auto;font-size:12px;color:var(--text-secondary)">${new Date(item.dateAdded).toLocaleDateString()}</span>
      </div>

      ${item.styleTags?.length ? `
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px">
          ${item.styleTags.map(t => `<span class="tag active" style="cursor:default">${t}</span>`).join('')}
        </div>
      ` : ''}

      ${cp ? `
        <div class="section-title">Colors <span style="font-size:11px;font-weight:400;color:var(--text-secondary)">(tap to change)</span></div>
        <div style="display:flex;gap:16px;align-items:center;margin-bottom:16px">
          <div style="text-align:center;cursor:pointer" onclick="app.showColorPicker('${item.id}','dominant')">
            <div class="swatch lg" style="background:${hslToCss(cp.dominantColor)};border:2px solid var(--border)"></div>
            <div style="font-size:10px;color:var(--text-secondary);margin-top:4px">Dominant</div>
            <div style="font-size:10px;color:var(--text-secondary)">${colorName(cp.dominantColor)}</div>
          </div>
          ${hasDistinctSecondary(cp) ? `
            <div style="text-align:center;cursor:pointer" onclick="app.showColorPicker('${item.id}','secondary')">
              <div class="swatch lg" style="background:${hslToCss(cp.secondaryColors[0])};border:2px solid var(--border)"></div>
              <div style="font-size:10px;color:var(--text-secondary);margin-top:4px">Secondary</div>
              <div style="font-size:10px;color:var(--text-secondary)">${colorName(cp.secondaryColors[0])}</div>
            </div>
          ` : ''}
        </div>
      ` : ''}

      <button class="btn btn-primary" onclick="app.generateFromItem('${item.id}')">✨ Generate Outfits</button>
      <button class="btn btn-outline" style="margin-top:8px" onclick="app.pickSecondItem('${item.id}')">+ Add Another Item & Generate</button>
      ${cp ? `<button class="btn btn-outline" style="margin-top:8px" onclick="app.showColorMatching('${item.id}')">🎨 Potential Color Matching</button>` : ''}
    </div>
  `);
  lazyLoadImages();
};

app.pickSecondItem = (firstItemId) => {
  const firstItem = items.find(i => i.id === firstItemId);
  if (!firstItem) return;
  const firstCat = CATEGORIES.find(c => c.id === firstItem.category);
  const others = items.filter(i => i.id !== firstItemId);

  openSheet(`
    <h2>Pick a Second Item</h2>
    <div style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg);border-radius:10px;margin-bottom:12px">
      ${firstItem.imageId ? `<img data-image-id="${firstItem.imageId}" class="lazy-img" style="width:44px;height:44px;border-radius:8px;object-fit:cover">` : ''}
      <div style="flex:1;font-size:14px;font-weight:600">${esc(firstItem.name)}</div>
      <span style="font-size:11px;color:var(--text-secondary)">${firstCat?.name || ''}</span>
    </div>
    <div style="max-height:350px;overflow-y:auto">
      ${CATEGORIES.map(cat => {
        const catItems = others.filter(i => i.category === cat.id);
        if (!catItems.length) return '';
        return `
          <div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin:10px 0 4px">${cat.icon} ${plural(cat.name)}</div>
          ${catItems.map(item => `
            <div class="pick-item-row" onclick="app.generateFromTwoItems('${firstItemId}', '${item.id}')">
              ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img" style="width:44px;height:44px;border-radius:8px;object-fit:cover">` :
                `<div style="width:44px;height:44px;border-radius:8px;background:var(--border);display:flex;align-items:center;justify-content:center">${cat.icon}</div>`}
              <div style="flex:1;min-width:0">
                <div style="font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(item.name)}</div>
              </div>
              ${item.colorProfile ? `<div class="swatch" style="background:${hslToCss(item.colorProfile.dominantColor)}"></div>` : ''}
            </div>
          `).join('')}
        `;
      }).join('')}
    </div>
    <button class="btn btn-secondary" style="margin-top:12px" onclick="closeSheet()">Cancel</button>
  `);
  lazyLoadImages();
};

app.generateFromTwoItems = (id1, id2) => {
  const item1 = items.find(i => i.id === id1);
  const item2 = items.find(i => i.id === id2);
  if (!item1 || !item2) return;
  closeSheet();
  closeDetail();
  outfitSeedItem = [item1, item2];
  app._seedSelections = new Set([id1, id2]);
  app._outfitGuidance = '';
  outfitVibe = null;
  outfitWeather = null;
  outfitNoJeans = false;
  showOutfitStep2();
};

app.saveItemName = async (id) => {
  const newName = document.getElementById('item-name-edit')?.value?.trim();
  if (!newName) return;
  const item = items.find(i => i.id === id);
  if (!item) return;
  const oldName = item.name;
  pushUndo({ type: 'edit-item', itemId: id, oldData: { name: oldName }, description: `Reverted name to "${oldName}"` });
  item.name = newName;
  await db.putItem(item);
  app.showItemDetail(id);
  renderWardrobe();
};

app.reanalyzeItem = async (id) => {
  const item = items.find(i => i.id === id);
  if (!item || !item.imageId) { alert('No image to re-analyze.'); return; }

  const apiKey = await db.getApiKey();
  if (!apiKey) { alert('Please set your OpenAI API key first.'); return; }

  showLoading('Re-analyzing item with AI...');
  try {
    const blob = await db.loadImage(item.imageId);
    if (!blob) { hideLoading(); alert('Image not found.'); return; }

    const garments = await analyzeOutfitPhoto(blob, apiKey);
    if (garments.length > 0) {
      // Use the first garment's description and category
      const g = garments[0];
      item.name = g.description || item.name;
      item.category = CATEGORIES.find(c => c.id === g.category) ? g.category : item.category;
      await db.putItem(item);
    }

    hideLoading();
    app.showItemDetail(id);
    renderWardrobe();
  } catch (err) {
    hideLoading();
    alert('Re-analysis failed: ' + err.message);
  }
};

app.removeItemBg = async (id) => {
  const item = items.find(i => i.id === id);
  if (!item?.imageId) return;
  showLoading('Removing background...');
  try {
    const imgData = await db.loadImage(item.imageId);
    if (!imgData) { hideLoading(); return; }
    let blob;
    if (typeof imgData === 'string') {
      const resp = await fetch(imgData);
      blob = await resp.blob();
    } else {
      blob = imgData;
    }
    const noBg = await removeBackground(blob);
    await db.saveImage(item.imageId, noBg);
  } catch (e) { console.warn('BG removal failed', e); }
  hideLoading();
  app.showItemDetail(id);
};

app.deleteItem = async (id) => {
  if (!confirm('Delete this item?')) return;
  const item = items.find(i => i.id === id);
  // Save for undo
  let imageData = null;
  if (item?.imageId) {
    imageData = await db.loadImage(item.imageId);
    await db.deleteImage(item.imageId);
  }
  pushUndo({ type: 'delete-item', item: { ...item }, imageData, description: `Restored "${item?.name || 'item'}"` });
  await db.deleteItem(id);
  items = items.filter(i => i.id !== id);
  closeDetail();
  renderWardrobe();
};

// ══════════════════════════════════════
// ── PALETTES TAB ──
// ══════════════════════════════════════

// ── Color Matching from Item ──

app.showColorMatching = (itemId) => {
  const item = items.find(i => i.id === itemId);
  if (!item?.colorProfile) return;
  const base = item.colorProfile.dominantColor;
  const h = base.hue, s = base.saturation, l = base.lightness;

  // Generate palettes using color science harmony rules
  const harmonies = [
    {
      name: 'Complementary',
      desc: 'Opposite on the color wheel — bold, high-contrast combinations.',
      colors: [
        base,
        { hue: (h + 180) % 360, saturation: s, lightness: l },
        { hue: h, saturation: Math.max(0.1, s - 0.15), lightness: Math.min(0.85, l + 0.2) },
        { hue: (h + 180) % 360, saturation: Math.max(0.1, s - 0.15), lightness: Math.min(0.85, l + 0.15) },
      ],
    },
    {
      name: 'Analogous',
      desc: 'Neighboring colors — natural, harmonious, easy to wear.',
      colors: [
        base,
        { hue: (h + 30) % 360, saturation: s, lightness: l },
        { hue: (h + 330) % 360, saturation: s, lightness: l },
        { hue: (h + 15) % 360, saturation: Math.max(0.1, s - 0.1), lightness: Math.min(0.85, l + 0.15) },
      ],
    },
    {
      name: 'Triadic',
      desc: 'Three colors evenly spaced — vibrant and balanced.',
      colors: [
        base,
        { hue: (h + 120) % 360, saturation: s, lightness: l },
        { hue: (h + 240) % 360, saturation: s, lightness: l },
        { hue: h, saturation: Math.max(0.05, s - 0.2), lightness: Math.min(0.9, l + 0.25) },
      ],
    },
    {
      name: 'Split Complementary',
      desc: 'Two colors adjacent to the complement — contrast with less tension.',
      colors: [
        base,
        { hue: (h + 150) % 360, saturation: s, lightness: l },
        { hue: (h + 210) % 360, saturation: s, lightness: l },
        { hue: h, saturation: Math.max(0.05, s - 0.15), lightness: Math.min(0.9, l + 0.2) },
      ],
    },
    {
      name: 'Monochromatic',
      desc: 'Same hue, different shades — elegant, sophisticated, always safe.',
      colors: [
        { hue: h, saturation: s, lightness: Math.max(0.1, l - 0.2) },
        base,
        { hue: h, saturation: Math.max(0.05, s - 0.15), lightness: Math.min(0.85, l + 0.2) },
        { hue: h, saturation: Math.max(0.05, s - 0.25), lightness: Math.min(0.92, l + 0.35) },
      ],
    },
    {
      name: 'Neutral Pairing',
      desc: 'Your color with black, white, and gray — classic and versatile.',
      colors: [
        base,
        { hue: 0, saturation: 0, lightness: 0.1 },
        { hue: 0, saturation: 0, lightness: 0.5 },
        { hue: 0, saturation: 0, lightness: 0.93 },
      ],
    },
  ];

  closeDetail();
  // Switch to palettes tab
  currentTab = 'palettes';
  document.querySelectorAll('.tab-bar button').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-bar button')[1].classList.add('active');
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-palettes').classList.add('active');

  const view = document.getElementById('view-palettes');
  view.innerHTML = `
    <div class="view-header">
      <button class="back-btn" onclick="app.showItemDetail('${item.id}')" style="font-size:14px;padding:4px 12px;border:1.5px solid var(--border);border-radius:16px;background:var(--card)">‹ Back</button>
      <h1 style="font-size:17px;flex:1">Color Matching</h1>
    </div>

    <div style="padding:0 16px 8px;display:flex;align-items:center;gap:12px">
      ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img" style="width:50px;height:50px;border-radius:10px;object-fit:cover">` : ''}
      <div>
        <div style="font-size:14px;font-weight:600">${esc(item.name)}</div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:4px">
          <div style="width:18px;height:18px;border-radius:50%;background:${hslToCss(base)};border:1px solid var(--border)"></div>
          <span style="font-size:12px;color:var(--text-secondary)">${colorName(base)}</span>
        </div>
      </div>
    </div>

    <div style="padding:0 16px 24px">
      ${harmonies.map(harmony => `
        <div style="background:var(--card);border:1.5px solid var(--border);border-radius:var(--radius);padding:14px;margin-bottom:12px">
          <div style="font-size:15px;font-weight:700;margin-bottom:2px">${harmony.name}</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-bottom:10px">${harmony.desc}</div>
          <div class="palette-bar" style="height:48px;margin-bottom:10px;border-radius:var(--radius-sm);overflow:hidden">
            ${harmony.colors.map(c => `<div style="background:${hslToCss(c)}"></div>`).join('')}
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
            ${harmony.colors.map(c => `
              <div style="display:flex;align-items:center;gap:4px">
                <div style="width:14px;height:14px;border-radius:50%;background:${hslToCss(c)};border:1px solid var(--border)"></div>
                <span style="font-size:11px;color:var(--text-secondary)">${colorName(c)}</span>
              </div>
            `).join('')}
          </div>
          <button class="btn btn-sm btn-outline" onclick="app.saveMatchPalette('${item.id}','${harmony.name}')">Save as Palette</button>
        </div>
      `).join('')}
    </div>
  `;
  lazyLoadImages();
};

app.saveMatchPalette = async (itemId, harmonyName) => {
  const item = items.find(i => i.id === itemId);
  if (!item?.colorProfile) return;
  const base = item.colorProfile.dominantColor;
  const h = base.hue, s = base.saturation, l = base.lightness;

  // Regenerate the specific harmony colors
  const harmonyMap = {
    'Complementary': [base, {hue:(h+180)%360,saturation:s,lightness:l}, {hue:h,saturation:Math.max(0.1,s-0.15),lightness:Math.min(0.85,l+0.2)}, {hue:(h+180)%360,saturation:Math.max(0.1,s-0.15),lightness:Math.min(0.85,l+0.15)}],
    'Analogous': [base, {hue:(h+30)%360,saturation:s,lightness:l}, {hue:(h+330)%360,saturation:s,lightness:l}, {hue:(h+15)%360,saturation:Math.max(0.1,s-0.1),lightness:Math.min(0.85,l+0.15)}],
    'Triadic': [base, {hue:(h+120)%360,saturation:s,lightness:l}, {hue:(h+240)%360,saturation:s,lightness:l}, {hue:h,saturation:Math.max(0.05,s-0.2),lightness:Math.min(0.9,l+0.25)}],
    'Split Complementary': [base, {hue:(h+150)%360,saturation:s,lightness:l}, {hue:(h+210)%360,saturation:s,lightness:l}, {hue:h,saturation:Math.max(0.05,s-0.15),lightness:Math.min(0.9,l+0.2)}],
    'Monochromatic': [{hue:h,saturation:s,lightness:Math.max(0.1,l-0.2)}, base, {hue:h,saturation:Math.max(0.05,s-0.15),lightness:Math.min(0.85,l+0.2)}, {hue:h,saturation:Math.max(0.05,s-0.25),lightness:Math.min(0.92,l+0.35)}],
    'Neutral Pairing': [base, {hue:0,saturation:0,lightness:0.1}, {hue:0,saturation:0,lightness:0.5}, {hue:0,saturation:0,lightness:0.93}],
  };

  const colors = harmonyMap[harmonyName];
  if (!colors) return;

  const palette = createColorPalette({
    name: `${colorName(base)} ${harmonyName}`,
    colors,
    harmonyType: harmonyName.toLowerCase().replace(/\s+/g, '_'),
  });

  await db.putPalette(palette);
  palettes.push(palette);

  openSheet(`
    <div style="text-align:center;padding:24px">
      <div style="font-size:48px;margin-bottom:12px">🎨</div>
      <h2>Palette Saved</h2>
      <p style="color:var(--text-secondary);margin-bottom:16px">"${esc(palette.name)}" added to your palettes.</p>
      <button class="btn btn-primary" onclick="closeSheet()">OK</button>
    </div>
  `);
};

function renderPalettes() {
  const view = document.getElementById('view-palettes');
  const builtIn = palettes.filter(p => p.isBuiltIn);
  const custom = palettes.filter(p => !p.isBuiltIn);

  view.innerHTML = `
    <div class="view-header">
      <h1>Palettes</h1>
      <button class="btn-icon" onclick="app.showPaletteEditor()">+</button>
    </div>

    <!-- Color Wheel & Guide -->
    <div class="color-wheel-section">
      <div style="font-size:17px;font-weight:700;margin-bottom:16px;text-align:center">Color Harmony Guide</div>
      <div style="display:flex;justify-content:center;margin-bottom:20px">
        <canvas id="color-wheel-canvas" width="220" height="220"></canvas>
      </div>
      <div class="harmony-cards">
        <div class="harmony-card" style="border-left:4px solid hsl(0,70%,50%)">
          <div class="harmony-card-dots">
            <div style="background:hsl(0,70%,50%)"></div>
            <div style="background:hsl(180,70%,50%)"></div>
          </div>
          <div class="harmony-card-text">
            <div class="harmony-card-title">Complementary</div>
            <div class="harmony-card-desc">Opposite on the wheel. Bold contrast, eye-catching outfits.</div>
          </div>
        </div>
        <div class="harmony-card" style="border-left:4px solid hsl(210,70%,50%)">
          <div class="harmony-card-dots">
            <div style="background:hsl(200,70%,50%)"></div>
            <div style="background:hsl(220,70%,50%)"></div>
            <div style="background:hsl(240,70%,50%)"></div>
          </div>
          <div class="harmony-card-text">
            <div class="harmony-card-title">Analogous</div>
            <div class="harmony-card-desc">Neighbors on the wheel. Easy, natural, harmonious look.</div>
          </div>
        </div>
        <div class="harmony-card" style="border-left:4px solid hsl(120,70%,45%)">
          <div class="harmony-card-dots">
            <div style="background:hsl(0,70%,50%)"></div>
            <div style="background:hsl(120,70%,45%)"></div>
            <div style="background:hsl(240,65%,50%)"></div>
          </div>
          <div class="harmony-card-text">
            <div class="harmony-card-title">Triadic</div>
            <div class="harmony-card-desc">Three evenly spaced. Vibrant and balanced energy.</div>
          </div>
        </div>
        <div class="harmony-card" style="border-left:4px solid hsl(220,30%,40%)">
          <div class="harmony-card-dots">
            <div style="background:hsl(220,20%,25%)"></div>
            <div style="background:hsl(220,20%,50%)"></div>
            <div style="background:hsl(220,20%,75%)"></div>
          </div>
          <div class="harmony-card-text">
            <div class="harmony-card-title">Monochromatic</div>
            <div class="harmony-card-desc">One color, different shades. Elegant, sophisticated, safe.</div>
          </div>
        </div>
      </div>
    </div>

    ${palettes.length === 0 ? `
      <div class="empty-state">
        <div class="icon">🎨</div>
        <h3>No Palettes</h3>
        <p>Create a color palette to generate coordinated outfits</p>
        <button class="btn btn-primary btn-sm" onclick="app.showPaletteEditor()">Create Palette</button>
      </div>
    ` : `
      ${builtIn.length ? `<div class="section-label" style="padding:12px 16px 0">Built-in</div>` : ''}
      ${builtIn.map(p => renderPaletteItem(p)).join('')}
      ${custom.length ? `<div class="section-label" style="padding:12px 16px 0">Custom</div>` : ''}
      ${custom.map(p => renderPaletteItem(p)).join('')}
    `}
  `;

  // Draw color wheel
  drawColorWheel();
}

function drawColorWheel() {
  const canvas = document.getElementById('color-wheel-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const cx = w / 2, cy = h / 2;
  const outerR = Math.min(cx, cy) - 14;
  const innerR = outerR * 0.6;

  // Clear
  ctx.clearRect(0, 0, w, h);

  // Draw color ring
  for (let angle = 0; angle < 360; angle++) {
    const rad1 = (angle - 0.8) * Math.PI / 180;
    const rad2 = (angle + 0.8) * Math.PI / 180;
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, rad1, rad2);
    ctx.arc(cx, cy, innerR, rad2, rad1, true);
    ctx.closePath();
    ctx.fillStyle = `hsl(${angle}, 80%, 55%)`;
    ctx.fill();
  }

  // Smooth ring edges
  ctx.beginPath();
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.08)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
  ctx.stroke();

  // White center
  ctx.beginPath();
  ctx.arc(cx, cy, innerR - 1, 0, Math.PI * 2);
  ctx.fillStyle = 'white';
  ctx.fill();

  // Color labels around the outside
  ctx.font = '600 10px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#555';
  const labels = [
    [0, 'Red'], [30, 'Orange'], [60, 'Yellow'], [120, 'Green'],
    [180, 'Cyan'], [210, 'Blue'], [270, 'Purple'], [330, 'Pink']
  ];
  const labelR = outerR + 11;
  for (const [deg, label] of labels) {
    const rad = (deg - 90) * Math.PI / 180;
    const lx = cx + Math.cos(rad) * labelR;
    const ly = cy + Math.sin(rad) * labelR;
    ctx.fillText(label, lx, ly);
  }
}

function drawOutfitColorWheel(canvasId, colors) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !colors.length) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const cx = w / 2, cy = h / 2;
  const outerR = Math.min(cx, cy) - 28;
  const innerR = outerR * 0.6;
  const midR = (outerR + innerR) / 2;

  ctx.clearRect(0, 0, w, h);

  // Draw the color ring
  for (let angle = 0; angle < 360; angle++) {
    const rad1 = (angle - 0.8) * Math.PI / 180;
    const rad2 = (angle + 0.8) * Math.PI / 180;
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, rad1, rad2);
    ctx.arc(cx, cy, innerR, rad2, rad1, true);
    ctx.closePath();
    ctx.fillStyle = `hsl(${angle}, 75%, 55%)`;
    ctx.fill();
  }

  // Smooth ring edges
  ctx.strokeStyle = 'rgba(0,0,0,0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, outerR, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, innerR, 0, Math.PI * 2); ctx.stroke();

  // White center
  ctx.beginPath();
  ctx.arc(cx, cy, innerR - 1, 0, Math.PI * 2);
  ctx.fillStyle = '#fafafa';
  ctx.fill();

  // Draw connection lines between colors (inside the wheel)
  if (colors.length > 1) {
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(72, 116, 212, 0.35)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    const pts = colors.map(c => {
      const rad = (c.hue - 90) * Math.PI / 180;
      return { x: cx + Math.cos(rad) * midR, y: cy + Math.sin(rad) * midR };
    });
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);

    // Fill the polygon with translucent accent
    ctx.fillStyle = 'rgba(72, 116, 212, 0.08)';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fill();
  }

  // Draw color dots on the ring with labels
  ctx.font = '600 10px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  colors.forEach((c, i) => {
    const rad = (c.hue - 90) * Math.PI / 180;
    const dotX = cx + Math.cos(rad) * midR;
    const dotY = cy + Math.sin(rad) * midR;
    const dotR = 10;

    // Outer glow
    ctx.beginPath();
    ctx.arc(dotX, dotY, dotR + 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fill();

    // Color dot
    ctx.beginPath();
    ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${c.hue}, ${Math.round(c.sat * 100)}%, ${Math.round(c.light * 100)}%)`;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Label outside the ring
    const labelR = outerR + 16;
    const lx = cx + Math.cos(rad) * labelR;
    const ly = cy + Math.sin(rad) * labelR;
    ctx.fillStyle = '#333';
    ctx.fillText(c.name, lx, ly);
  });

  // Detect harmony type and show label
  const hues = colors.map(c => c.hue);
  const harmonyType = detectHarmony(hues);
  const labelEl = document.getElementById('outfit-harmony-label');
  if (labelEl) {
    const descriptions = {
      'Monochromatic': 'Same color family, different shades — elegant & sophisticated',
      'Analogous': 'Neighboring colors on the wheel — harmonious & easy on the eye',
      'Complementary': 'Opposite colors on the wheel — bold & high contrast',
      'Split-Complementary': 'One color + two neighbors of its opposite — vibrant yet balanced',
      'Triadic': 'Three evenly spaced colors — lively & dynamic',
      'Neutral': 'Low-saturation tones — timeless & versatile',
      'Mixed': 'Creative color combination',
    };
    labelEl.innerHTML = `<strong>${harmonyType}</strong><br><span style="font-size:11px">${descriptions[harmonyType] || ''}</span>`;
  }

  // Draw harmony label in center of wheel
  ctx.fillStyle = '#333';
  ctx.font = '700 12px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(harmonyType, cx, cy - 4);
  ctx.font = '400 9px -apple-system, sans-serif';
  ctx.fillStyle = '#888';
  ctx.fillText('harmony', cx, cy + 10);
}

function detectHarmony(hues) {
  if (hues.length < 2) return 'Monochromatic';

  // Check if all are neutral/low-saturation (handled by caller via sat, but approximate by hue spread)
  const sorted = [...hues].sort((a, b) => a - b);

  // Hue differences between all pairs
  const diffs = [];
  for (let i = 0; i < hues.length; i++) {
    for (let j = i + 1; j < hues.length; j++) {
      const d = Math.abs(hues[i] - hues[j]);
      diffs.push(Math.min(d, 360 - d));
    }
  }
  const maxDiff = Math.max(...diffs);
  const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;

  if (maxDiff < 25) return 'Monochromatic';
  if (maxDiff < 60) return 'Analogous';
  if (hues.length === 2 && Math.abs(maxDiff - 180) < 30) return 'Complementary';
  if (hues.length >= 3) {
    // Check triadic (120 apart)
    const isTriadic = diffs.every(d => Math.abs(d - 120) < 25 || Math.abs(d - 240) < 25);
    if (isTriadic) return 'Triadic';

    // Check split-complementary
    const hasFarPair = diffs.some(d => Math.abs(d - 180) < 30);
    const hasClosePair = diffs.some(d => d < 60);
    if (hasFarPair && hasClosePair) return 'Split-Complementary';
  }
  if (Math.abs(maxDiff - 180) < 35) return 'Complementary';
  if (maxDiff < 90) return 'Analogous';

  return 'Mixed';
}

function renderPaletteItem(p) {
  return `
    <div class="palette-item" onclick="app.showPaletteDetail('${p.id}')">
      <div class="row">
        <span class="name">${esc(p.name)}</span>
        <span class="type">${HARMONY_TYPES.find(h => h.id === p.harmonyType)?.name || ''}</span>
      </div>
      <div class="palette-bar">
        ${p.colors.map(c => `<div style="background:${hslToCss(c)}"></div>`).join('')}
      </div>
    </div>
  `;
}

app.showPaletteDetail = (id) => {
  const p = palettes.find(x => x.id === id);
  if (!p) return;

  openDetail(`
    <div class="detail-header">
      <button class="back-btn" onclick="app.closeDetail()">‹ Back</button>
      <h1 style="font-size:17px;flex:1">${esc(p.name)}</h1>
      ${!p.isBuiltIn ? `<button class="btn-icon" style="font-size:16px" onclick="app.showPaletteEditor('${p.id}')">✏️</button>` : ''}
    </div>
    <div class="detail-body">
      <div class="palette-bar" style="height:48px;margin-bottom:16px">
        ${p.colors.map(c => `<div style="background:${hslToCss(c)}"></div>`).join('')}
      </div>

      <div style="display:flex;justify-content:space-between;margin-bottom:8px">
        <span style="color:var(--text-secondary)">Harmony Type</span>
        <span style="font-weight:600">${HARMONY_TYPES.find(h => h.id === p.harmonyType)?.name || ''}</span>
      </div>

      <div class="section-title">Colors</div>
      ${p.colors.map((c, i) => `
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
          <div class="swatch lg" style="background:${hslToCss(c)}"></div>
          <div>
            <div style="font-size:14px">Color ${i + 1}</div>
            <div style="font-size:12px;color:var(--text-secondary);font-variant-numeric:tabular-nums">
              H:${Math.round(c.hue)}° S:${Math.round(c.saturation * 100)}% L:${Math.round(c.lightness * 100)}%
            </div>
          </div>
        </div>
      `).join('')}

      <button class="btn btn-primary" style="margin-top:20px" onclick="app.generateFromPalette('${p.id}')">✨ Use for Outfits</button>
      ${!p.isBuiltIn ? `<button class="btn btn-danger" style="margin-top:8px" onclick="app.deletePalette('${p.id}')">Delete Palette</button>` : ''}
    </div>
  `);
};

app.deletePalette = async (id) => {
  if (!confirm('Delete this palette?')) return;
  await db.deletePalette(id);
  palettes = palettes.filter(p => p.id !== id);
  closeDetail();
  renderPalettes();
};

// ── Palette Editor ──
let editorColors = [{ hue: 220, saturation: 0.6, lightness: 0.45 }];
let editingPaletteId = null;

app.showPaletteEditor = (id) => {
  closeDetail();
  const existing = id ? palettes.find(p => p.id === id) : null;
  editingPaletteId = id || null;
  editorColors = existing ? [...existing.colors] : [{ hue: 220, saturation: 0.6, lightness: 0.45 }];

  renderPaletteEditor(existing?.name || '', existing?.harmonyType || 'analogous');
};

function renderPaletteEditor(name, harmonyType) {
  openSheet(`
    <h2>${editingPaletteId ? 'Edit' : 'New'} Palette</h2>
    <div class="form-group">
      <label>Name</label>
      <input id="pal-name" value="${esc(name)}" placeholder="My Palette">
    </div>
    <div class="form-group">
      <label>Harmony Type</label>
      <select id="pal-harmony" onchange="app.onHarmonyChange()">
        ${HARMONY_TYPES.map(h => `<option value="${h.id}" ${h.id === harmonyType ? 'selected' : ''}>${h.name}</option>`).join('')}
      </select>
    </div>
    <button class="btn btn-secondary btn-sm" style="margin-bottom:16px;width:auto" onclick="app.autoGenHarmony()">Auto-Generate from First Color</button>

    <div class="palette-bar" style="margin-bottom:12px">
      ${editorColors.map(c => `<div style="background:${hslToCss(c)}"></div>`).join('')}
    </div>

    <div id="pal-color-list">
      ${editorColors.map((c, i) => `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <div class="swatch md" style="background:${hslToCss(c)}"></div>
          <span style="font-size:14px;flex:1">Color ${i + 1}</span>
          <button class="btn btn-secondary btn-sm" onclick="app.editPalColor(${i})">Edit</button>
          ${editorColors.length > 1 ? `<button class="btn btn-sm" style="background:var(--danger);color:white" onclick="app.removePalColor(${i})">×</button>` : ''}
        </div>
      `).join('')}
    </div>

    ${editorColors.length < 6 ? `<button class="btn btn-outline btn-sm" style="margin-bottom:16px;width:auto" onclick="app.addPalColor()">+ Add Color</button>` : ''}

    <button class="btn btn-primary" onclick="app.savePalette()">Save</button>
  `);
}

app.addPalColor = () => {
  editorColors.push({ hue: Math.random() * 360, saturation: 0.5, lightness: 0.5 });
  renderPaletteEditor(document.getElementById('pal-name').value, document.getElementById('pal-harmony').value);
};

app.removePalColor = (i) => {
  editorColors.splice(i, 1);
  renderPaletteEditor(document.getElementById('pal-name').value, document.getElementById('pal-harmony').value);
};

app.autoGenHarmony = () => {
  const type = HARMONY_TYPES.find(h => h.id === document.getElementById('pal-harmony').value);
  if (!type || !editorColors.length) return;
  const base = editorColors[0];
  editorColors = type.offsets.map(offset => ({
    hue: (base.hue + offset) % 360,
    saturation: base.saturation,
    lightness: base.lightness,
  }));
  renderPaletteEditor(document.getElementById('pal-name').value, type.id);
};

app.onHarmonyChange = () => {};

app.editPalColor = (index) => {
  const c = editorColors[index];
  openColorPicker(c, (updated) => {
    editorColors[index] = updated;
    renderPaletteEditor(document.getElementById('pal-name')?.value || '', document.getElementById('pal-harmony')?.value || 'analogous');
  });
};

app.savePalette = async () => {
  const name = document.getElementById('pal-name').value.trim();
  if (!name || !editorColors.length) return;
  const harmonyType = document.getElementById('pal-harmony').value;

  if (editingPaletteId) {
    const existing = palettes.find(p => p.id === editingPaletteId);
    if (existing) {
      existing.name = name;
      existing.colors = editorColors;
      existing.harmonyType = harmonyType;
      await db.putPalette(existing);
    }
  } else {
    const pal = createColorPalette({ name, colors: editorColors, harmonyType });
    await db.putPalette(pal);
    palettes.push(pal);
  }

  palettes = await db.getAllPalettes();
  editingPaletteId = null;
  closeSheet();
  renderPalettes();
};

// ── Color Picker ──
function openColorPicker(color, onDone) {
  const c = { ...color };
  const overlay = document.getElementById('color-picker-overlay');
  overlay.classList.add('open');

  const render = () => {
    document.getElementById('cp-preview').style.background = hslToCss(c);
    document.getElementById('cp-hue').value = c.hue;
    document.getElementById('cp-sat').value = c.saturation * 100;
    document.getElementById('cp-light').value = c.lightness * 100;
    document.getElementById('cp-hue-val').textContent = `${Math.round(c.hue)}°`;
    document.getElementById('cp-sat-val').textContent = `${Math.round(c.saturation * 100)}%`;
    document.getElementById('cp-light-val').textContent = `${Math.round(c.lightness * 100)}%`;

    // gradient backgrounds
    document.getElementById('cp-hue').style.background = `linear-gradient(to right, ${
      Array.from({length: 13}, (_, i) => hslToCss({hue: i * 30, saturation: c.saturation, lightness: c.lightness})).join(',')
    })`;
    document.getElementById('cp-sat').style.background = `linear-gradient(to right, ${hslToCss({...c, saturation: 0})}, ${hslToCss({...c, saturation: 1})})`;
    document.getElementById('cp-light').style.background = `linear-gradient(to right, ${hslToCss({...c, lightness: 0})}, ${hslToCss({...c, lightness: 0.5})}, ${hslToCss({...c, lightness: 1})})`;
  };

  document.getElementById('cp-hue').oninput = (e) => { c.hue = +e.target.value; render(); };
  document.getElementById('cp-sat').oninput = (e) => { c.saturation = +e.target.value / 100; render(); };
  document.getElementById('cp-light').oninput = (e) => { c.lightness = +e.target.value / 100; render(); };

  document.getElementById('cp-done').onclick = () => {
    overlay.classList.remove('open');
    onDone(c);
  };

  render();
}

// ══════════════════════════════════════
// ── OUTFITS TAB ──
// ══════════════════════════════════════

let showFavoritesOnly = false;

function renderOutfits() {
  const view = document.getElementById('view-outfits');
  const saved = outfits.filter(o => o.isSaved).sort((a, b) => b.dateCreated - a.dateCreated);
  const displayed = showFavoritesOnly ? saved.filter(o => o.favorite) : saved;

  const missingCount = saved.filter(o => !o.aiImageId).length;

  view.innerHTML = `
    <div class="view-header">
      <h1>Outfits</h1>
      <div style="display:flex;gap:8px">
        ${saved.some(o => o.favorite) ? `<button class="btn-icon" onclick="app.toggleFavFilter()" title="Favorites" style="font-size:16px;${showFavoritesOnly ? 'background:var(--accent);color:white' : ''}">❤️</button>` : ''}
      </div>
    </div>
    ${displayed.length === 0 ? `
      <div class="empty-state">
        <div class="icon">${showFavoritesOnly ? '❤️' : '✨'}</div>
        <h3>${showFavoritesOnly ? 'No Favorites Yet' : 'No Saved Outfits'}</h3>
        <p>${showFavoritesOnly ? 'Tap the heart on outfits you love' : 'Generate outfits from your wardrobe items'}</p>
      </div>
    ` : `
      <div class="outfit-list" style="padding:12px 16px">
        ${displayed.map((o, idx) => renderOutfitCard(o, idx + 1)).join('')}
      </div>
    `}
  `;
  lazyLoadImages();

  // Auto-generate missing AI images (if not already processing)
  if (missingCount > 0 && !isProcessingQueue) {
    setTimeout(() => app.generateMissingImages(), 800);
  }
}

app.toggleFavFilter = () => {
  showFavoritesOnly = !showFavoritesOnly;
  renderOutfits();
};

function renderOutfitCard(outfit, num) {
  const oi = (outfit.itemIds || []).map(id => items.find(i => i.id === id)).filter(Boolean);
  const isFav = !!outfit.favorite;
  return `
    <div class="outfit-card-wide">
      <div class="outfit-number">Outfit #${num || ''}</div>
      <div class="outfit-card-row" onclick="app.showOutfitDetail('${outfit.id}')">
        <div class="outfit-card-ai">
          ${outfit.aiImageId
            ? `<img data-ai-image-id="${outfit.aiImageId}" class="lazy-ai-img" style="width:100%;height:100%;object-fit:cover">`
            : `<div style="width:100%;aspect-ratio:1;background:var(--bg);display:flex;align-items:center;justify-content:center;color:var(--text-secondary);font-size:12px">Generating...</div>`}
        </div>
        <div class="outfit-card-items">
          ${oi.map(item => `
            <div class="outfit-card-item">
              ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img">` :
                `<div class="outfit-card-item-placeholder" style="background:${item.colorProfile ? hslToCss(item.colorProfile.dominantColor) : 'var(--bg)'}">
                  ${CATEGORIES.find(c => c.id === item.category)?.icon || ''}
                </div>`}
              <span class="outfit-card-item-name">${esc(item.name)}</span>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="score-badge">
        <span class="pct ${scoreColor(outfit.overallScore)}">${Math.round(outfit.overallScore * 100)}%</span>
        <span style="color:var(--text-secondary)">${oi.length} items</span>
        <div style="display:flex;gap:8px;margin-left:auto" onclick="event.stopPropagation()">
          <button onclick="app.toggleFavorite('${outfit.id}')" style="border:none;background:none;font-size:18px;cursor:pointer;padding:2px">${isFav ? '❤️' : '🤍'}</button>
          <button onclick="app.quickDeleteOutfit('${outfit.id}')" style="border:none;background:none;font-size:18px;cursor:pointer;padding:2px">🗑️</button>
        </div>
      </div>
    </div>
  `;
}

app.showOutfitDetail = async (id) => {
  const outfit = outfits.find(o => o.id === id);
  if (!outfit) return;
  const oi = (outfit.itemIds || []).map(id => items.find(i => i.id === id)).filter(Boolean);

  // Find outfit number (position in saved list)
  const saved = outfits.filter(o => o.isSaved).sort((a, b) => b.dateCreated - a.dateCreated);
  const outfitNum = saved.findIndex(o => o.id === id) + 1;

  const isInWishlist = wishlist.some(w => w.outfitId === outfit.id);
  const isFav = !!outfit.favorite;

  // Score explanations
  const colorExpl = outfit.colorScore >= 0.7 ? 'Colors work very well together and match the palette' :
    outfit.colorScore >= 0.4 ? 'Colors are acceptable but could be more coordinated' :
    'Colors clash or don\'t match the palette well';
  const compExpl = outfit.completenessScore >= 0.7 ? 'Outfit has all key pieces (shirt, pants, shoes, etc.)' :
    outfit.completenessScore >= 0.4 ? 'Missing some optional pieces like belt or jacket' :
    'Missing essential items like pants or shirt';
  const styleExpl = outfit.styleScore >= 0.7 ? 'All items share a consistent style direction' :
    outfit.styleScore >= 0.4 ? 'Mix of styles — some items don\'t match the vibe' :
    'Items have very different style tags (e.g. formal + sporty)';

  openDetail(`
    <div class="detail-header">
      <button class="back-btn" onclick="app.closeDetail()">‹ Back</button>
      <h1 style="font-size:17px;flex:1">Outfit${outfitNum ? ' #' + outfitNum : ''}</h1>
      <button class="btn-icon" style="font-size:16px" onclick="app.deleteOutfit('${outfit.id}')">🗑️</button>
    </div>
    <div class="detail-body">
      <!-- Side-by-side: AI image left, items right -->
      <div class="outfit-detail-split">
        <div class="outfit-detail-left">
          <div class="ai-image-wishlist-wrap" onclick="app.showImageWishPicker('${outfit.id}')">
            ${outfit.aiImageId ?
              `<img data-ai-image-id="${outfit.aiImageId}" class="lazy-ai-img" style="width:100%;border-radius:var(--radius);background:var(--bg);display:block">` :
              `<div style="width:100%;aspect-ratio:3/4;background:var(--bg);border-radius:var(--radius);display:flex;align-items:center;justify-content:center;color:var(--text-secondary);font-size:13px">AI image generating...</div>`}
            <div class="ai-image-hint">Tap image to add items to Wish List</div>
          </div>
          <div style="display:flex;gap:8px;margin-top:12px">
            ${isInWishlist ? `<button class="btn btn-sm btn-secondary" style="flex:1" onclick="app.toggleWishlist('${outfit.id}')">✓ In Wish List</button>` :
              `<button class="btn btn-sm btn-outline" style="flex:1" onclick="app.showImageWishPicker('${outfit.id}')">🛒 Wish List</button>`}
            <button class="btn btn-sm btn-outline" style="flex:1" onclick="app.toggleFavoriteDetail('${outfit.id}')">
              ${isFav ? '❤️ Favorited' : '🤍 Favorite'}
            </button>
          </div>
        </div>
        <div class="outfit-detail-right">
          ${oi.map((item, idx) => {
            const cat = CATEGORIES.find(c => c.id === item.category);
            const isBuyChecked = (outfit.buyItems || []).includes(item.id);
            return `
              <div class="item-row" style="position:relative">
                <div class="wishlist-check ${isBuyChecked ? 'checked' : ''}" onclick="event.stopPropagation(); app.toggleOutfitBuyItem('${outfit.id}', '${item.id}')" style="cursor:pointer;flex-shrink:0" title="Mark to buy">
                  ${isBuyChecked ? '☑' : '☐'}
                </div>
                <div style="cursor:pointer;display:flex;align-items:center;gap:12px;flex:1;min-width:0" onclick="app.showItemDetail('${item.id}')">
                  ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img" style="width:60px;height:60px;border-radius:8px;object-fit:cover;flex-shrink:0">` :
                    `<div style="width:60px;height:60px;border-radius:8px;background:${item.colorProfile ? hslToCss(item.colorProfile.dominantColor) : 'var(--bg)'};display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0">${cat?.icon || ''}</div>`}
                  <div class="item-info" style="min-width:0">
                    <div class="name">${esc(item.name)}</div>
                    <div class="cat">${cat?.name || ''}</div>
                  </div>
                </div>
                <div style="font-size:11px;color:var(--accent);flex-shrink:0;cursor:pointer" onclick="app.showReplaceItem('${outfit.id}', ${idx})">Replace ›</div>
              </div>
            `;
          }).join('')}
          ${(() => {
            const presentCats = new Set(oi.map(i => i.category));
            const missing = CATEGORIES.filter(c => !presentCats.has(c.id));
            if (!missing.length) return '';
            return '<div style="margin-top:8px;padding:8px 10px;background:var(--accent-light);border-radius:8px;font-size:12px;color:var(--accent)">Missing: ' + missing.map(c => c.icon + ' ' + c.name).join(', ') + ' — regenerate to include them</div>';
          })()}
        </div>
      </div>

      <div class="divider"></div>

      <!-- Refine -->
      <div class="section-title">Refine with Text</div>
      <div style="display:flex;gap:8px;margin-bottom:16px">
        <input id="outfit-feedback-text" type="text" placeholder="e.g. make it more casual, swap belt..." style="flex:1;padding:10px 12px;border:1.5px solid var(--border);border-radius:var(--radius-sm);font-size:14px">
        <button class="btn btn-primary btn-sm" onclick="app.applyOutfitFeedback('${outfit.id}')">Apply</button>
      </div>

      <div class="divider"></div>

      <!-- Scores -->
      <div class="section-title">Score</div>
      <div class="score-row">
        <span class="label">Color Match</span>
        <span class="value ${scoreColor(outfit.colorScore)}">${Math.round(outfit.colorScore * 100)}%</span>
      </div>
      <div style="font-size:11px;color:var(--text-secondary);margin-bottom:10px;padding-left:2px">${colorExpl}</div>

      <div class="score-row">
        <span class="label">Completeness</span>
        <span class="value ${scoreColor(outfit.completenessScore)}">${Math.round(outfit.completenessScore * 100)}%</span>
      </div>
      <div style="font-size:11px;color:var(--text-secondary);margin-bottom:10px;padding-left:2px">${compExpl}</div>

      <div class="score-row">
        <span class="label">Style Harmony</span>
        <span class="value ${scoreColor(outfit.styleScore)}">${Math.round(outfit.styleScore * 100)}%</span>
      </div>
      <div style="font-size:11px;color:var(--text-secondary);margin-bottom:10px;padding-left:2px">${styleExpl}</div>

      <div class="divider"></div>
      <div class="score-row"><span class="label" style="font-weight:700">Overall</span><span class="value ${scoreColor(outfit.overallScore)}" style="font-weight:700;font-size:18px">${Math.round(outfit.overallScore * 100)}%</span></div>

      <div class="divider"></div>

      <!-- Color Harmony Wheel -->
      <div class="section-title">Color Harmony</div>
      <div style="display:flex;justify-content:center;margin-bottom:8px">
        <canvas id="outfit-color-wheel" width="260" height="260"></canvas>
      </div>
      <div id="outfit-harmony-label" style="text-align:center;font-size:13px;color:var(--text-secondary);margin-bottom:8px"></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-bottom:12px">
        ${oi.filter(i => i.colorProfile).map(item => {
          const cat = CATEGORIES.find(c => c.id === item.category);
          return `<div style="display:flex;align-items:center;gap:4px;padding:3px 10px;background:var(--bg);border-radius:12px;font-size:11px">
            <div style="width:12px;height:12px;border-radius:50%;background:${hslToCss(item.colorProfile.dominantColor)};border:1px solid rgba(0,0,0,0.15)"></div>
            ${cat?.name || ''}
          </div>`;
        }).join('')}
      </div>

      <div style="font-size:12px;color:var(--text-secondary);margin-top:16px;text-align:center">${new Date(outfit.dateCreated).toLocaleDateString()}</div>
    </div>
  `);
  lazyLoadImages();

  // Draw outfit color wheel
  setTimeout(() => {
    const colors = oi.filter(i => i.colorProfile).map(i => ({
      hue: i.colorProfile.dominantColor.hue,
      sat: i.colorProfile.dominantColor.saturation,
      light: i.colorProfile.dominantColor.lightness,
      name: CATEGORIES.find(c => c.id === i.category)?.name || '',
    }));
    drawOutfitColorWheel('outfit-color-wheel', colors);
  }, 50);
};

app.applyOutfitFeedback = async (outfitId) => {
  const feedback = document.getElementById('outfit-feedback-text')?.value?.trim();
  if (!feedback) { alert('Please type what you want to change.'); return; }

  const outfit = outfits.find(o => o.id === outfitId);
  if (!outfit) return;

  const oi = (outfit.itemIds || []).map(id => items.find(i => i.id === id)).filter(Boolean);
  const feedbackLower = feedback.toLowerCase();

  // Parse "no X" exclusions
  const noMatches = feedback.match(/no\s+(\w+)/gi) || [];
  const excludeTerms = noMatches.map(m => m.replace(/^no\s+/i, '').toLowerCase());

  // Parse "more X" / "add X" preferences
  const moreMatches = feedback.match(/(?:more|add)\s+(\w+)/gi) || [];
  const preferTerms = moreMatches.map(m => m.replace(/^(?:more|add)\s+/i, '').toLowerCase());

  // Find categories mentioned in feedback
  const categoriesToReplace = [];
  for (const cat of CATEGORIES) {
    if (feedbackLower.includes(cat.name.toLowerCase()) || feedbackLower.includes(cat.id)) {
      categoriesToReplace.push(cat.id);
    }
  }

  // Filter available items
  let filteredItems = items.filter(i =>
    !excludeTerms.some(t => i.name.toLowerCase().includes(t))
  );

  // Find best palette from current outfit
  let bestPalette = palettes[0];
  let bestAff = -1;
  for (const pal of palettes) {
    let aff = 0;
    for (const item of oi) aff += paletteAffinity(item, pal.colors);
    if (aff > bestAff) { bestAff = aff; bestPalette = pal; }
  }

  closeDetail();
  showLoading('Generating 4 revised looks...');

  // Generate 4 diverse variations
  const newOutfits = [];

  // Strategy: generate full outfit set, then pick top 4 diverse ones
  // For category-specific feedback, shuffle alternatives in those categories
  const results = generateOutfits(filteredItems, bestPalette);

  // Also try with different palettes for variety
  const otherPalettes = palettes.filter(p => p.id !== bestPalette.id).slice(0, 3);
  for (const pal of otherPalettes) {
    const moreResults = generateOutfits(filteredItems, pal);
    results.push(...moreResults);
  }

  // Deduplicate and filter out the original outfit
  const origIds = outfit.itemIds.sort().join(',');
  const seen = new Set([origIds]);
  const unique = [];
  for (const r of results) {
    const key = r.items.map(i => i.id).sort().join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }

  // Take top 4
  unique.sort((a, b) => b.overallScore - a.overallScore);
  const top4 = unique.slice(0, 4);

  for (const r of top4) {
    const idSet = r.items.map(i => i.id).sort().join(',');
    const exists = outfits.some(o => (o.itemIds || []).sort().join(',') === idSet);
    if (exists) continue;

    const newOutfit = createOutfit({
      itemIds: r.items.map(i => i.id),
      colorScore: r.colorScore,
      completenessScore: r.completenessScore,
      styleScore: r.styleScore,
      overallScore: r.overallScore,
    });
    await db.putOutfit(newOutfit);
    outfits.push(newOutfit);
    newOutfits.push(newOutfit);
  }

  hideLoading();

  if (!newOutfits.length) {
    openSheet(`
      <div style="text-align:center;padding:24px">
        <h2>No New Variations</h2>
        <p style="color:var(--text-secondary);margin-bottom:16px">Could not find different outfits matching "${esc(feedback)}". Try different guidance.</p>
        <button class="btn btn-primary" onclick="closeSheet()">OK</button>
      </div>
    `);
    return;
  }

  // Show results
  openSheet(`
    <h2>Revised Looks</h2>
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">${newOutfits.length} new outfits based on: "${esc(feedback)}"</p>
    <div class="outfit-list">
      ${newOutfits.map(o => {
        const oItems = o.itemIds.map(id => items.find(it => it.id === id)).filter(Boolean);
        return `
          <div class="outfit-card-wide" onclick="closeSheet(); app.showOutfitDetail('${o.id}')">
            <div class="outfit-card-row">
              <div class="outfit-card-ai">
                <div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--bg);flex-direction:column;gap:4px">
                  <div class="spinner" style="width:20px;height:20px;margin:0"></div>
                  <span style="font-size:10px;color:var(--text-secondary)">Generating...</span>
                </div>
              </div>
              <div class="outfit-card-items">
                ${oItems.map(item => `
                  <div class="outfit-card-item">
                    ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img">` :
                      `<div class="outfit-card-item-placeholder" style="background:${item.colorProfile ? hslToCss(item.colorProfile.dominantColor) : 'var(--bg)'}">
                        ${CATEGORIES.find(c => c.id === item.category)?.icon || ''}
                      </div>`}
                    <span class="outfit-card-item-name">${esc(item.name)}</span>
                  </div>
                `).join('')}
              </div>
            </div>
            <div class="score-badge">
              <span class="pct ${scoreColor(o.overallScore)}">${Math.round(o.overallScore * 100)}%</span>
              <span style="color:var(--text-secondary)">${oItems.length} items</span>
            </div>
          </div>
        `;
      }).join('')}
    </div>
    <button class="btn btn-secondary" style="margin-top:16px" onclick="app.closeSheetAndRender()">Done</button>
  `);
  lazyLoadImages();

  // Generate AI images in background
  generateAiImagesInBackground(newOutfits.map(o => ({
    items: o.itemIds.map(id => items.find(i => i.id === id)).filter(Boolean),
    _outfitObj: o,
  })));
};

app.toggleOutfitBuyItem = async (outfitId, itemId) => {
  const outfit = outfits.find(o => o.id === outfitId);
  if (!outfit) return;
  if (!outfit.buyItems) outfit.buyItems = [];
  const idx = outfit.buyItems.indexOf(itemId);
  if (idx >= 0) {
    outfit.buyItems.splice(idx, 1);
  } else {
    outfit.buyItems.push(itemId);
  }
  await db.putOutfit(outfit);
  app.showOutfitDetail(outfitId);
};

app.deleteOutfit = async (id) => {
  if (!confirm('Delete this outfit?')) return;
  const outfit = outfits.find(o => o.id === id);
  if (outfit) pushUndo({ type: 'delete-outfit', outfit: { ...outfit }, description: 'Restored deleted outfit' });
  await db.deleteOutfit(id);
  outfits = outfits.filter(o => o.id !== id);
  closeDetail();
  renderOutfits();
};

app.quickDeleteOutfit = async (id) => {
  if (!confirm('Delete this outfit?')) return;
  const outfit = outfits.find(o => o.id === id);
  if (outfit) pushUndo({ type: 'delete-outfit', outfit: { ...outfit }, description: 'Restored deleted outfit' });
  await db.deleteOutfit(id);
  outfits = outfits.filter(o => o.id !== id);
  renderOutfits();
};

app.toggleFavorite = async (id) => {
  const outfit = outfits.find(o => o.id === id);
  if (!outfit) return;
  outfit.favorite = !outfit.favorite;
  await db.putOutfit(outfit);
  renderOutfits();
};

app.toggleFavoriteDetail = async (id) => {
  const outfit = outfits.find(o => o.id === id);
  if (!outfit) return;
  outfit.favorite = !outfit.favorite;
  await db.putOutfit(outfit);
  app.showOutfitDetail(id);
};

// ══════════════════════════════════════
// ── NEED TO BUY (WISHLIST) ──
// ══════════════════════════════════════

app.toggleWishlist = async (outfitId) => {
  // If already in wishlist, remove it
  const existIdx = wishlist.findIndex(w => w.outfitId === outfitId);
  if (existIdx >= 0) {
    wishlist.splice(existIdx, 1);
    await saveWishlist();
    app.showOutfitDetail(outfitId);
    return;
  }

  // Show item picker — let user choose which items to add
  const outfit = outfits.find(o => o.id === outfitId);
  if (!outfit) return;
  const oi = (outfit.itemIds || []).map(id => items.find(i => i.id === id)).filter(Boolean);

  // Default: all items selected
  app._wishPickSelections = new Set(oi.map(i => i.id));
  app._wishPickOutfitId = outfitId;

  openSheet(`
    <h2>Add to Wish List</h2>
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">Pick the items you want to buy:</p>

    ${outfit.aiImageId ? `<img data-ai-image-id="${outfit.aiImageId}" class="lazy-ai-img" style="width:100%;max-height:200px;object-fit:contain;border-radius:var(--radius);background:var(--bg);margin-bottom:12px">` : ''}

    <div id="wish-pick-items">
      ${oi.map(item => {
        const cat = CATEGORIES.find(c => c.id === item.category);
        return `
          <div class="item-row" style="cursor:pointer" onclick="app.toggleWishPickItem('${item.id}')">
            <div class="wishlist-check checked" id="wish-pick-${item.id}" style="flex-shrink:0">☑</div>
            ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img" style="width:50px;height:50px;border-radius:8px;object-fit:cover;flex-shrink:0">` :
              `<div style="width:50px;height:50px;border-radius:8px;background:${item.colorProfile ? hslToCss(item.colorProfile.dominantColor) : 'var(--bg)'};display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">${cat?.icon || ''}</div>`}
            <div class="item-info" style="min-width:0">
              <div class="name">${esc(item.name)}</div>
              <div class="cat">${cat?.name || ''}</div>
            </div>
          </div>
        `;
      }).join('')}
    </div>

    <button class="btn btn-primary" style="margin-top:16px" onclick="app.confirmWishPick()">Add Selected to Wish List</button>
    <button class="btn btn-secondary" style="margin-top:8px" onclick="closeSheet()">Cancel</button>
  `);
  lazyLoadImages();
};

app.showImageWishPicker = (outfitId) => {
  const outfit = outfits.find(o => o.id === outfitId);
  if (!outfit) return;
  const oi = (outfit.itemIds || []).map(id => items.find(i => i.id === id)).filter(Boolean);

  // Approximate vertical positions for each category on a full-body AI image
  const catPositions = { shirt: 25, jacket: 30, pants: 55, belt: 45, shoes: 85 };

  openSheet(`
    <h2>Tap an item to add to Wish List</h2>
    <div class="ai-wish-picker" style="position:relative;margin-bottom:16px">
      ${outfit.aiImageId ? `<img data-ai-image-id="${outfit.aiImageId}" class="lazy-ai-img" style="width:100%;border-radius:var(--radius);display:block">` : ''}
      <div class="ai-wish-labels">
        ${oi.map(item => {
          const cat = CATEGORIES.find(c => c.id === item.category);
          const topPct = catPositions[item.category] || 50;
          return `
            <button class="ai-wish-label" style="top:${topPct}%" onclick="event.stopPropagation(); app.quickAddToWishlist('${outfitId}', '${item.id}')">
              ${cat?.icon || ''} ${cat?.name || ''}
            </button>
          `;
        }).join('')}
      </div>
    </div>
    <p style="font-size:12px;color:var(--text-secondary);text-align:center;margin-bottom:12px">Or add all items:</p>
    <button class="btn btn-outline" onclick="app.toggleWishlist('${outfitId}')">🛒 Add Entire Outfit</button>
    <button class="btn btn-secondary" style="margin-top:8px" onclick="closeSheet()">Cancel</button>
  `);
  lazyLoadImages();
};

app.quickAddToWishlist = async (outfitId, itemId) => {
  const outfit = outfits.find(o => o.id === outfitId);
  if (!outfit) return;
  const item = items.find(i => i.id === itemId);
  if (!item) return;

  // Check if outfit already in wishlist
  let entry = wishlist.find(w => w.outfitId === outfitId);
  if (entry) {
    // Add item if not already there
    if (!entry.items.some(i => i.id === itemId)) {
      entry.items.push({ name: item.name, category: item.category, id: item.id });
    }
  } else {
    // Create new wishlist entry with just this item
    entry = {
      outfitId,
      aiImageId: outfit.aiImageId || null,
      items: [{ name: item.name, category: item.category, id: item.id }],
      checkedItems: [],
      notes: '',
      dateAdded: Date.now(),
    };
    wishlist.push(entry);
  }

  await saveWishlist();
  closeSheet();

  // Show confirmation
  const cat = CATEGORIES.find(c => c.id === item.category);
  openSheet(`
    <div style="text-align:center;padding:24px">
      <div style="font-size:48px;margin-bottom:12px">${cat?.icon || '👔'}</div>
      <h2>Added to Wish List</h2>
      <p style="color:var(--text-secondary);margin-bottom:4px;font-size:14px">${esc(item.name)}</p>
      <p style="color:var(--text-secondary);margin-bottom:16px;font-size:12px">You can find it in the Wish List tab</p>
      <button class="btn btn-outline" style="margin-bottom:8px" onclick="closeSheet(); app.showImageWishPicker('${outfitId}')">Add Another Item</button>
      <button class="btn btn-secondary" onclick="closeSheet(); app.showOutfitDetail('${outfitId}')">Done</button>
    </div>
  `);
};

app.toggleWishPickItem = (itemId) => {
  if (app._wishPickSelections.has(itemId)) {
    app._wishPickSelections.delete(itemId);
  } else {
    app._wishPickSelections.add(itemId);
  }
  const el = document.getElementById(`wish-pick-${itemId}`);
  if (el) {
    const isOn = app._wishPickSelections.has(itemId);
    el.className = `wishlist-check ${isOn ? 'checked' : ''}`;
    el.textContent = isOn ? '☑' : '☐';
  }
};

app.confirmWishPick = async () => {
  const outfitId = app._wishPickOutfitId;
  const selectedIds = app._wishPickSelections;
  if (!selectedIds.size) { alert('Pick at least one item.'); return; }

  const outfit = outfits.find(o => o.id === outfitId);
  if (!outfit) return;
  const oi = (outfit.itemIds || []).map(id => items.find(i => i.id === id)).filter(Boolean);
  const selectedItems = oi.filter(i => selectedIds.has(i.id));

  wishlist.push({
    outfitId,
    aiImageId: outfit.aiImageId || null,
    items: selectedItems.map(i => ({ name: i.name, category: i.category, id: i.id })),
    checkedItems: [],
    notes: '',
    dateAdded: Date.now(),
  });
  await saveWishlist();
  closeSheet();
  app.showOutfitDetail(outfitId);
};

// ── My Wish List (custom items with photo + text) ──

app.showAddMyWishItem = () => {
  openSheet(`
    <h2>Add to My Wish List</h2>
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px">Add an item you want to buy — snap a photo or describe it.</p>

    <div id="mywish-photo-preview" style="margin-bottom:12px;display:none">
      <img id="mywish-photo-img" style="width:100%;max-height:200px;object-fit:contain;border-radius:var(--radius);background:var(--bg)">
    </div>

    <div style="display:flex;gap:8px;margin-bottom:16px">
      <label class="btn btn-outline" style="flex:1;text-align:center;cursor:pointer;margin:0" for="wishlist-camera-hidden">
        📷 Camera
      </label>
      <label class="btn btn-outline" style="flex:1;text-align:center;cursor:pointer;margin:0" for="wishlist-file-hidden">
        🖼️ Photo
      </label>
    </div>

    <textarea id="mywish-text" rows="3"
      style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:var(--radius-sm);font-size:14px;font-family:inherit;resize:vertical;margin-bottom:16px"
      placeholder="Describe the item (brand, color, where you saw it...)"></textarea>

    <button class="btn btn-primary" onclick="app.saveMyWishItem()">Add to Wish List</button>
    <button class="btn btn-secondary" style="margin-top:8px" onclick="closeSheet()">Cancel</button>
  `);
};

app._myWishPhotoData = null;

app.handleMyWishPhoto = (input) => {
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    app._myWishPhotoData = e.target.result;
    const preview = document.getElementById('mywish-photo-preview');
    const img = document.getElementById('mywish-photo-img');
    if (preview && img) {
      img.src = e.target.result;
      preview.style.display = 'block';
    }
  };
  reader.readAsDataURL(file);
  input.value = '';
};

app.saveMyWishItem = async () => {
  const text = document.getElementById('mywish-text')?.value?.trim() || '';
  const photoData = app._myWishPhotoData;

  if (!text && !photoData) {
    alert('Please add a photo or description.');
    return;
  }

  let imageId = null;
  if (photoData) {
    imageId = generateId();
    await db.saveImage(imageId, dataUrlToBlob(photoData));
  }

  myWishlist.push({
    id: generateId(),
    imageId,
    text,
    checked: false,
    dateAdded: Date.now(),
  });

  app._myWishPhotoData = null;
  await saveMyWishlist();
  closeSheet();
  app.showWishlist();
};

app.toggleMyWishItem = async (idx) => {
  const item = myWishlist[idx];
  if (!item) return;
  item.checked = !item.checked;
  await saveMyWishlist();
  app.showWishlist();
};

app.removeMyWishItem = async (idx) => {
  const item = myWishlist[idx];
  if (item?.imageId) {
    try { await db.deleteImage(item.imageId); } catch {}
  }
  myWishlist.splice(idx, 1);
  await saveMyWishlist();
  app.showWishlist();
};

app.editMyWishItem = (idx) => {
  const item = myWishlist[idx];
  if (!item) return;

  openSheet(`
    <h2>Edit Wish List Item</h2>

    <div id="mywish-photo-preview" style="margin-bottom:12px;${item.imageId ? '' : 'display:none'}">
      <img id="mywish-photo-img" ${item.imageId ? `data-image-id="${item.imageId}" class="lazy-img"` : ''} style="width:100%;max-height:200px;object-fit:contain;border-radius:var(--radius);background:var(--bg)">
    </div>

    <div style="display:flex;gap:8px;margin-bottom:16px">
      <label class="btn btn-outline" style="flex:1;text-align:center;cursor:pointer;margin:0" for="wishlist-camera-hidden">
        📷 Camera
      </label>
      <label class="btn btn-outline" style="flex:1;text-align:center;cursor:pointer;margin:0" for="wishlist-file-hidden">
        🖼️ Photo
      </label>
    </div>

    <textarea id="mywish-text" rows="3"
      style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:var(--radius-sm);font-size:14px;font-family:inherit;resize:vertical;margin-bottom:16px"
      placeholder="Describe the item...">${esc(item.text || '')}</textarea>

    <button class="btn btn-primary" onclick="app.updateMyWishItem(${idx})">Save Changes</button>
    <button class="btn btn-secondary" style="margin-top:8px" onclick="closeSheet(); app.showWishlist()">Cancel</button>
  `);
  app._myWishPhotoData = null;
  lazyLoadImages();
};

app.updateMyWishItem = async (idx) => {
  const item = myWishlist[idx];
  if (!item) return;

  const text = document.getElementById('mywish-text')?.value?.trim() || '';
  const photoData = app._myWishPhotoData;

  if (!text && !photoData && !item.imageId) {
    alert('Please add a photo or description.');
    return;
  }

  if (photoData) {
    // Delete old image if exists
    if (item.imageId) {
      try { await db.deleteImage(item.imageId); } catch {}
    }
    const imageId = generateId();
    await db.saveImage(imageId, dataUrlToBlob(photoData));
    item.imageId = imageId;
  }

  item.text = text;
  app._myWishPhotoData = null;
  await saveMyWishlist();
  closeSheet();
  app.showWishlist();
};

// ── Show Wishlist (both sections) ──

app.showWishlist = () => {
  const hasMyItems = myWishlist.length > 0;
  const hasOutfitRefs = wishlist.length > 0;

  if (!hasMyItems && !hasOutfitRefs) {
    openSheet(`
      <h2>Wish List</h2>
      <div class="empty-state" style="padding:32px">
        <div class="icon">🛒</div>
        <h3>Nothing Yet</h3>
        <p>Add items you want to buy, or tap "Wish List" on any outfit to save references.</p>
      </div>
      <button class="btn btn-primary" style="margin-bottom:8px" onclick="app.showAddMyWishItem()">+ Add Item</button>
      <button class="btn btn-secondary" onclick="closeSheet()">Close</button>
    `);
    return;
  }

  // ── My Wish List section ──
  const myWishHtml = `
    <div style="margin-bottom:24px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <h2 style="margin:0">My Wish List</h2>
        <button class="btn btn-sm btn-primary" onclick="app.showAddMyWishItem()" style="margin:0;padding:6px 14px">+ Add</button>
      </div>
      ${hasMyItems ? `
        <div class="my-wishlist-items">
          ${myWishlist.map((item, idx) => `
            <div class="mywish-card" style="display:flex;gap:12px;padding:12px;background:var(--card);border-radius:var(--radius);border:1.5px solid var(--border);margin-bottom:10px;${item.checked ? 'opacity:0.5' : ''}">
              <div class="wishlist-check ${item.checked ? 'checked' : ''}" onclick="app.toggleMyWishItem(${idx})" style="cursor:pointer;flex-shrink:0;margin-top:2px">
                ${item.checked ? '☑' : '☐'}
              </div>
              ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img" style="width:70px;height:70px;border-radius:8px;object-fit:cover;flex-shrink:0;cursor:pointer" onclick="app.editMyWishItem(${idx})">` : ''}
              <div style="flex:1;min-width:0;cursor:pointer" onclick="app.editMyWishItem(${idx})">
                <div style="font-size:14px;${item.checked ? 'text-decoration:line-through;' : ''}white-space:pre-wrap;word-break:break-word">${esc(item.text || 'No description')}</div>
                <div style="font-size:11px;color:var(--text-secondary);margin-top:4px">${new Date(item.dateAdded).toLocaleDateString()}</div>
              </div>
              <button onclick="app.removeMyWishItem(${idx})" style="background:none;border:none;color:var(--danger);font-size:18px;cursor:pointer;flex-shrink:0;padding:0 4px" title="Remove">✕</button>
            </div>
          `).join('')}
        </div>
      ` : `
        <p style="font-size:13px;color:var(--text-secondary);text-align:center;padding:16px 0">No items yet. Tap "+ Add" to get started.</p>
      `}
    </div>
  `;

  // ── Outfit References section ──
  const outfitRefHtml = hasOutfitRefs ? `
    <div style="border-top:2px solid var(--border);padding-top:16px">
      <h3 style="font-size:15px;color:var(--text-secondary);margin-bottom:12px">Outfit References</h3>
      <p style="font-size:12px;color:var(--text-secondary);margin-bottom:12px">${wishlist.length} outfit${wishlist.length !== 1 ? 's' : ''} saved for reference</p>
      <div class="outfit-list">
        ${wishlist.map((w, wi) => {
          const checkedItems = w.checkedItems || [];
          return `
            <div class="outfit-card-wide" style="margin-bottom:20px">
              <div style="padding:10px 12px;font-weight:700;font-size:14px;border-bottom:1px solid var(--border)">Outfit ${wi + 1}</div>
              ${w.aiImageId ? `<img data-ai-image-id="${w.aiImageId}" class="lazy-ai-img" style="width:100%;max-height:250px;object-fit:contain;background:var(--bg)">` : ''}
              <div style="padding:10px 12px">
                ${w.items.map((item, ii) => {
                  const cat = CATEGORIES.find(c => c.id === item.category);
                  const searchQuery = encodeURIComponent(item.name);
                  const isChecked = checkedItems.includes(ii);
                  return `
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                      <div class="wishlist-check ${isChecked ? 'checked' : ''}" onclick="app.toggleWishlistItem(${wi}, ${ii})" style="cursor:pointer;flex-shrink:0">
                        ${isChecked ? '☑' : '☐'}
                      </div>
                      <span style="font-size:16px;flex-shrink:0">${cat?.icon || '👔'}</span>
                      <span style="flex:1;font-size:13px;${isChecked ? 'font-weight:600' : ''}">${esc(item.name)}</span>
                      <a href="https://www.asos.com/search/?q=${searchQuery}" target="_blank" rel="noopener"
                         style="font-size:12px;color:var(--accent);text-decoration:none;padding:4px 10px;border:1px solid var(--accent);border-radius:14px;white-space:nowrap;flex-shrink:0"
                         onclick="event.stopPropagation()">
                        ASOS ›
                      </a>
                    </div>
                  `;
                }).join('')}

                <div style="margin-top:12px">
                  <label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px">My notes & links</label>
                  <textarea id="wishlist-notes-${wi}" rows="3"
                    style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:var(--radius-sm);font-size:13px;font-family:inherit;resize:vertical"
                    placeholder="Paste links you found, add notes..."
                    onblur="app.saveWishlistNotes(${wi}, this.value)">${esc(w.notes || '')}</textarea>
                </div>

                <button class="btn btn-sm btn-danger" style="margin-top:10px" onclick="app.removeFromWishlist(${wi})">Remove</button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  ` : '';

  openSheet(`
    ${myWishHtml}
    ${outfitRefHtml}
    <button class="btn btn-secondary" style="margin-top:8px" onclick="closeSheet()">Close</button>
  `);
  lazyLoadImages();
};

app.toggleWishlistItem = async (outfitIdx, itemIdx) => {
  const w = wishlist[outfitIdx];
  if (!w) return;
  if (!w.checkedItems) w.checkedItems = [];
  const pos = w.checkedItems.indexOf(itemIdx);
  if (pos >= 0) {
    w.checkedItems.splice(pos, 1);
  } else {
    w.checkedItems.push(itemIdx);
  }
  await saveWishlist();
  app.showWishlist();
};

app.saveWishlistNotes = async (outfitIdx, text) => {
  const w = wishlist[outfitIdx];
  if (!w) return;
  w.notes = text;
  await saveWishlist();
};

app.removeFromWishlist = async (index) => {
  wishlist.splice(index, 1);
  await saveWishlist();
  app.showWishlist();
};

// ══════════════════════════════════════
// ── OUTFIT GENERATOR ──
// ══════════════════════════════════════

let generatorSeedId = null;
let generatorPaletteId = null;
let generatorResults = [];

app.generateFromItem = (itemId) => {
  closeDetail();
  outfitSeedItem = items.find(i => i.id === itemId) || null;
  outfitVibe = null;
  outfitWeather = null;
  outfitNoJeans = false;
  showOutfitStep2();
};

app.generateFromPalette = (paletteId) => {
  closeDetail();
  generatorSeedId = null;
  generatorPaletteId = paletteId;
  generatorResults = [];
  showGeneratorView();
};

function showGeneratorView() {
  const seed = generatorSeedId ? items.find(i => i.id === generatorSeedId) : null;

  openDetail(`
    <div class="detail-header">
      <button class="back-btn" onclick="app.closeDetail()">‹ Back</button>
      <h1 style="font-size:17px;flex:1">Generate Outfits</h1>
    </div>
    <div class="detail-body">
      ${seed ? `
        <div class="section-label">Building around</div>
        <div class="item-row" style="margin-bottom:16px">
          ${seed.imageId ? `<img data-image-id="${seed.imageId}" class="lazy-img">` : ''}
          <div class="item-info">
            <div class="name">${esc(seed.name)}</div>
            <div class="cat">${CATEGORIES.find(c => c.id === seed.category)?.name || ''}</div>
          </div>
          ${seed.colorProfile ? `<div class="swatch md" style="background:${hslToCss(seed.colorProfile.dominantColor)}"></div>` : ''}
        </div>
      ` : ''}

      <div class="section-label">Color Palette</div>
      <div class="palette-selector">
        ${palettes.map(p => `
          <div class="palette-option ${generatorPaletteId === p.id ? 'selected' : ''}" onclick="app.selectGenPalette('${p.id}')">
            <div class="mini-bar">${p.colors.map(c => `<div style="background:${hslToCss(c)}"></div>`).join('')}</div>
            <div class="label">${esc(p.name)}</div>
          </div>
        `).join('')}
      </div>

      <button class="btn btn-primary" style="margin-top:16px" onclick="app.runGenerator()" ${!generatorPaletteId ? 'disabled' : ''}>
        ✨ Generate Outfits
      </button>

      <div id="gen-results"></div>
    </div>
  `);
  lazyLoadImages();
}

app.selectGenPalette = (id) => {
  generatorPaletteId = id;
  showGeneratorView();
};

app.runGenerator = () => {
  const palette = palettes.find(p => p.id === generatorPaletteId);
  if (!palette) return;
  const seed = generatorSeedId ? items.find(i => i.id === generatorSeedId) : null;

  document.getElementById('gen-results').innerHTML = `
    <div style="text-align:center;padding:24px"><div class="spinner"></div><p style="color:var(--text-secondary);font-size:13px">Generating outfits...</p></div>
  `;

  setTimeout(async () => {
    generatorResults = generateOutfits(items, palette, seed);
    await autoSaveOutfits(generatorResults);
    renderGeneratorResults();
  }, 50);
};

function renderGeneratorResults() {
  const div = document.getElementById('gen-results');
  if (!generatorResults.length) {
    div.innerHTML = `<p style="text-align:center;color:var(--text-secondary);padding:24px">No matching outfits found. Try a different palette or add more items.</p>`;
    return;
  }

  div.innerHTML = `
    <div class="section-title">Results</div>
    <div class="outfit-list">
      ${generatorResults.map((r, i) => `
        <div class="outfit-card-wide" onclick="app.showGeneratedDetail(${i})">
          <div class="outfit-card-row">
            <div class="outfit-card-ai">
              <div class="outfit-collage">
                ${r.items.slice(0, 4).map(item => `
                  ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img" style="background:var(--bg)">` :
                    `<div class="placeholder" style="background:${item.colorProfile ? hslToCss(item.colorProfile.dominantColor) : 'var(--bg)'}">
                      ${CATEGORIES.find(c => c.id === item.category)?.icon || ''}
                    </div>`}
                `).join('')}
                ${r.items.length < 4 ? Array(4 - Math.min(r.items.length, 4)).fill('<div class="placeholder"></div>').join('') : ''}
              </div>
            </div>
            <div class="outfit-card-items">
              ${r.items.map(item => `
                <div class="outfit-card-item">
                  ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img">` :
                    `<div class="outfit-card-item-placeholder" style="background:${item.colorProfile ? hslToCss(item.colorProfile.dominantColor) : 'var(--bg)'}">
                      ${CATEGORIES.find(c => c.id === item.category)?.icon || ''}
                    </div>`}
                  <span class="outfit-card-item-name">${esc(item.name)}</span>
                </div>
              `).join('')}
            </div>
          </div>
          <div class="score-badge">
            <span class="pct ${scoreColor(r.overallScore)}">${Math.round(r.overallScore * 100)}%</span>
            <span style="color:var(--text-secondary)">${r.items.length} items</span>
          </div>
        </div>
      `).join('')}
    </div>
  `;
  lazyLoadImages();

  // Progressive AI image generation
  setTimeout(() => {
    const cards = div.querySelectorAll('.outfit-card-wide');
    console.log('[AI] Generator: found', cards.length, 'outfit cards, starting DALL-E generation...');
    generatorResults.forEach((r, i) => {
      if (cards[i]) enqueueImageGeneration(r.items, cards[i]);
    });
  }, 500);
}

app.showGeneratedDetail = (idx) => {
  const r = generatorResults[idx];
  if (!r) return;

  const cacheKey2 = outfitImageCacheKey(r.items.map(i => i.id));
  const savedOutfit = outfits.find(o => outfitImageCacheKey(o.itemIds) === cacheKey2);
  const isInWishlist = savedOutfit && wishlist.some(w => w.outfitId === savedOutfit.id);

  const colorExpl = r.colorScore >= 0.7 ? 'Colors work very well together' : r.colorScore >= 0.4 ? 'Colors are acceptable but could improve' : 'Colors don\'t match well';
  const compExpl = r.completenessScore >= 0.7 ? 'Has all key pieces' : r.completenessScore >= 0.4 ? 'Missing some optional pieces' : 'Missing essential items';
  const styleExpl = r.styleScore >= 0.7 ? 'Consistent style direction' : r.styleScore >= 0.4 ? 'Mixed styles' : 'Conflicting styles';

  openSheet(`
    <h2>Outfit #${idx + 1}</h2>
    <img data-ai-cache-key="${cacheKey2}" class="lazy-ai-cache" style="width:100%;max-height:350px;object-fit:contain;border-radius:var(--radius);background:var(--bg);margin-bottom:12px">

    <div class="section-title">Items</div>
    ${r.items.map(item => {
      const cat = CATEGORIES.find(c => c.id === item.category);
      return `
        <div class="item-row" style="padding:6px 8px;margin-bottom:4px;cursor:pointer" onclick="closeSheet(); app.showItemDetail('${item.id}')">
          ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img" style="width:50px;height:50px;border-radius:6px">` : `<div style="width:50px;height:50px;border-radius:6px;background:${item.colorProfile ? hslToCss(item.colorProfile.dominantColor) : 'var(--bg)'};display:flex;align-items:center;justify-content:center;font-size:14px">${cat?.icon || ''}</div>`}
          <div class="item-info" style="min-width:0">
            <div class="name" style="font-size:13px">${esc(item.name)}</div>
            <div class="cat" style="font-size:11px">${cat?.name || ''}</div>
          </div>
        </div>
      `;
    }).join('')}

    ${savedOutfit ? `<button class="btn ${isInWishlist ? 'btn-secondary' : 'btn-outline'}" style="margin-top:10px" onclick="app.toggleWishlist('${savedOutfit.id}'); app.showGeneratedDetail(${idx})">
      ${isInWishlist ? '✓ In Wish List' : '🛒 Wish List'}
    </button>` : ''}

    <div class="divider"></div>
    <div class="score-row"><span class="label">Color Match</span><span class="value ${scoreColor(r.colorScore)}">${Math.round(r.colorScore * 100)}%</span></div>
    <div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px">${colorExpl}</div>
    <div class="score-row"><span class="label">Completeness</span><span class="value ${scoreColor(r.completenessScore)}">${Math.round(r.completenessScore * 100)}%</span></div>
    <div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px">${compExpl}</div>
    <div class="score-row"><span class="label">Style Harmony</span><span class="value ${scoreColor(r.styleScore)}">${Math.round(r.styleScore * 100)}%</span></div>
    <div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px">${styleExpl}</div>
    <div class="divider"></div>
    <div class="score-row"><span class="label" style="font-weight:700">Overall</span><span class="value ${scoreColor(r.overallScore)}" style="font-weight:700">${Math.round(r.overallScore * 100)}%</span></div>

    <div class="palette-bar" style="margin:16px 0">
      ${r.items.filter(i => i.colorProfile).map(i => `<div style="background:${hslToCss(i.colorProfile.dominantColor)}"></div>`).join('')}
    </div>

    <div style="text-align:center;font-size:13px;color:var(--success);margin-bottom:8px">Auto-saved to Outfits</div>
    <button class="btn btn-secondary" onclick="closeSheet()">‹ Back</button>
  `);
  lazyLoadImages();
};

app.saveGeneratedOutfit = async (idx) => {
  const r = generatorResults[idx];
  if (!r) return;

  const cacheKey = outfitImageCacheKey(r.items.map(i => i.id));
  const aiBlob = await db.loadImage(cacheKey);
  const outfit = createOutfit({
    itemIds: r.items.map(i => i.id),
    colorScore: r.colorScore,
    completenessScore: r.completenessScore,
    styleScore: r.styleScore,
    overallScore: r.overallScore,
    aiImageId: aiBlob ? cacheKey : null,
  });
  await db.putOutfit(outfit);
  outfits.push(outfit);
  closeSheet();
};

// ══════════════════════════════════════
// ── AUTO-SAVE OUTFITS ──
// ══════════════════════════════════════

async function autoSaveOutfits(results) {
  for (const r of results) {
    const itemIdSet = r.items.map(i => i.id).sort().join(',');
    const alreadyExists = outfits.some(o =>
      (o.itemIds || []).sort().join(',') === itemIdSet
    );
    if (alreadyExists) continue;

    const cacheKey = outfitImageCacheKey(r.items.map(i => i.id));
    const aiBlob = await db.loadImage(cacheKey);
    const outfit = createOutfit({
      itemIds: r.items.map(i => i.id),
      colorScore: r.colorScore,
      completenessScore: r.completenessScore,
      styleScore: r.styleScore,
      overallScore: r.overallScore,
      aiImageId: aiBlob ? cacheKey : null,
    });
    await db.putOutfit(outfit);
    outfits.push(outfit);
  }
}

// ══════════════════════════════════════
// ── REPLACE ITEM IN OUTFIT ──
// ══════════════════════════════════════

// Track selected replacements
app._replaceSelections = new Set();

app.showReplaceItem = async (outfitId, itemIndex) => {
  const outfit = outfits.find(o => o.id === outfitId);
  if (!outfit) return;

  const currentItemId = outfit.itemIds[itemIndex];
  const currentItem = items.find(i => i.id === currentItemId);
  if (!currentItem) return;

  const category = currentItem.category;
  const cat = CATEGORIES.find(c => c.id === category);
  const alternatives = items.filter(i => i.category === category && i.id !== currentItemId);

  if (!alternatives.length) {
    openSheet(`
      <h2>No Alternatives</h2>
      <p style="color:var(--text-secondary);margin-bottom:16px">
        You don't have other ${cat?.name?.toLowerCase() || 'item'}s in your wardrobe. Add more items first.
      </p>
      <button class="btn btn-primary" onclick="closeSheet()">OK</button>
    `);
    return;
  }

  // Auto-pick best 3-4 alternatives by color harmony with the other outfit items
  const otherItems = outfit.itemIds
    .filter((_, idx) => idx !== itemIndex)
    .map(id => items.find(i => i.id === id))
    .filter(Boolean);

  // Score each alternative by how well it fits with the rest
  const scored = alternatives.map(alt => {
    let score = 0;
    for (const pal of palettes) {
      score += paletteAffinity(alt, pal.colors);
    }
    // Bonus for harmony with other items
    if (alt.colorProfile && otherItems.length) {
      const testItems = [...otherItems, alt];
      for (const pal of palettes) {
        score += colorScore(testItems, pal.colors) * 2;
      }
    }
    return { item: alt, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const bestAlts = scored.slice(0, Math.min(4, scored.length)).map(s => s.item);

  // Auto-select and execute
  app._replaceSelections = new Set(bestAlts.map(a => a.id));
  app._replaceOutfitId = outfitId;
  app._replaceItemIndex = itemIndex;

  // Show what we're doing and auto-execute
  showLoading(`Creating ${bestAlts.length} variations with best ${cat?.name?.toLowerCase() || 'item'} matches...`);
  await new Promise(r => setTimeout(r, 100));
  await app.executeReplace();
};

// toggleReplaceSelection removed — replace is now fully automatic

app.executeReplace = async () => {
  const outfitId = app._replaceOutfitId;
  const itemIndex = app._replaceItemIndex;
  const selectedIds = [...app._replaceSelections];
  const outfit = outfits.find(o => o.id === outfitId);
  if (!outfit || !selectedIds.length) return;

  closeSheet();
  showLoading(`Creating ${selectedIds.length} outfit variation${selectedIds.length > 1 ? 's' : ''}...`);

  const newOutfits = [];

  for (let i = 0; i < selectedIds.length; i++) {
    showLoading(`Creating variation ${i + 1} / ${selectedIds.length}...`);

    // Clone the original outfit's item IDs and swap in the replacement
    const newItemIds = [...outfit.itemIds];
    newItemIds[itemIndex] = selectedIds[i];
    const outfitItems = newItemIds.map(id => items.find(it => it.id === id)).filter(Boolean);

    // Find best palette for scoring
    let bestPalette = palettes[0];
    let bestAff = -1;
    for (const pal of palettes) {
      let aff = 0;
      for (const item of outfitItems) aff += paletteAffinity(item, pal.colors);
      aff /= outfitItems.length;
      if (aff > bestAff) { bestAff = aff; bestPalette = pal; }
    }

    const paletteColors = bestPalette ? bestPalette.colors : [];
    const cs = colorScore(outfitItems, paletteColors);
    const completeness = computeCompleteness(outfitItems);
    const style = computeStyleScore(outfitItems);
    const overall = cs * 0.5 + completeness * 0.3 + style * 0.2;

    // Check for duplicates
    const idSet = newItemIds.sort().join(',');
    const exists = outfits.some(o => (o.itemIds || []).sort().join(',') === idSet);
    if (exists) continue;

    const newOutfit = createOutfit({
      itemIds: newItemIds,
      colorScore: cs,
      completenessScore: completeness,
      styleScore: style,
      overallScore: overall,
    });
    await db.putOutfit(newOutfit);
    outfits.push(newOutfit);
    newOutfits.push(newOutfit);
  }

  hideLoading();

  if (!newOutfits.length) {
    openSheet(`
      <div style="text-align:center;padding:24px">
        <h2>Already Exists</h2>
        <p style="color:var(--text-secondary);margin-bottom:16px">These outfit variations already exist in your collection.</p>
        <button class="btn btn-primary" onclick="closeSheet()">OK</button>
      </div>
    `);
    return;
  }

  // Show the new variations in a results sheet
  app._replaceResults = newOutfits;
  openSheet(`
    <h2>New Variations</h2>
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px">
      ${newOutfits.length} new outfit${newOutfits.length > 1 ? 's' : ''} saved to your collection
    </p>
    <div class="item-grid">
      ${newOutfits.map((o, i) => {
        const oi = o.itemIds.map(id => items.find(it => it.id === id)).filter(Boolean);
        return `
          <div class="outfit-card" onclick="closeSheet(); app.showOutfitDetail('${o.id}')">
            <div class="outfit-collage">
              ${oi.slice(0, 4).map(item => `
                ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img" style="background:var(--bg)">` :
                  `<div class="placeholder" style="background:${item.colorProfile ? hslToCss(item.colorProfile.dominantColor) : 'var(--bg)'}">
                    ${CATEGORIES.find(c => c.id === item.category)?.icon || ''}
                  </div>`}
              `).join('')}
              ${oi.length < 4 ? Array(4 - Math.min(oi.length, 4)).fill('<div class="placeholder"></div>').join('') : ''}
            </div>
            <div class="score-badge">
              <span class="pct ${scoreColor(o.overallScore)}">${Math.round(o.overallScore * 100)}%</span>
              <span style="color:var(--text-secondary)">${oi.length} items</span>
            </div>
          </div>
        `;
      }).join('')}
    </div>
    <button class="btn btn-secondary" style="margin-top:16px" onclick="app.closeSheetAndRender()">Done</button>
  `);
  lazyLoadImages();

  // Generate AI images for new outfits in background
  const apiKey = await db.getApiKey();
  if (apiKey) {
    for (const o of newOutfits) {
      try {
        const oi = o.itemIds.map(id => items.find(it => it.id === id)).filter(Boolean);
        const descriptions = oi.map(it => ({ name: it.name, color: it.colorProfile?.dominantColor }));
        const blob = await generateOutfitImage(descriptions, apiKey);
        const cacheKey = outfitImageCacheKey(o.itemIds);
        await db.saveImage(cacheKey, blob);
        o.aiImageId = cacheKey;
        await db.putOutfit(o);
      } catch (err) {
        console.error('[AI] Replace variation image failed:', err.message);
        break;
      }
    }
  }
};

// ══════════════════════════════════════
// ── HELPERS ──
// ══════════════════════════════════════

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function plural(name) {
  if (name.endsWith('s') || name.endsWith('sh') || name.endsWith('ch')) return name;
  return name + 's';
}

// ── Background Removal (flood-fill from corners) ──

async function removeBackground(blob) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const w = img.width, h = img.height;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, w, h);
      const data = imageData.data;
      const tolerance = 45;
      const visited = new Uint8Array(w * h);

      function colorDist(i, r, g, b) {
        return Math.abs(data[i] - r) + Math.abs(data[i+1] - g) + Math.abs(data[i+2] - b);
      }

      function floodFill(sx, sy) {
        const refIdx = (sy * w + sx) * 4;
        const rr = data[refIdx], rg = data[refIdx+1], rb = data[refIdx+2];
        const stack = [[sx, sy]];
        while (stack.length) {
          const [x, y] = stack.pop();
          if (x < 0 || x >= w || y < 0 || y >= h) continue;
          const pos = y * w + x;
          if (visited[pos]) continue;
          const idx = pos * 4;
          if (colorDist(idx, rr, rg, rb) > tolerance) continue;
          visited[pos] = 1;
          data[idx + 3] = 0; // make transparent
          stack.push([x+1,y],[x-1,y],[x,y+1],[x,y-1]);
        }
      }

      // Flood fill from corners and edge midpoints
      const seeds = [[0,0],[w-1,0],[0,h-1],[w-1,h-1],[Math.floor(w/2),0],[Math.floor(w/2),h-1],[0,Math.floor(h/2)],[w-1,Math.floor(h/2)]];
      for (const [sx, sy] of seeds) floodFill(sx, sy);

      ctx.putImageData(imageData, 0, 0);
      canvas.toBlob((b) => resolve(b || blob), 'image/png');
    };
    img.onerror = () => resolve(blob);
    img.src = URL.createObjectURL(blob);
  });
}

// Sheet (bottom modal)
function openSheet(html) {
  const overlay = document.getElementById('sheet-overlay');
  overlay.querySelector('.modal-sheet').innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close-btn" onclick="closeSheet()" aria-label="Close">✕</button>
    ${html}`;
  overlay.classList.add('open');
  overlay.onclick = (e) => { if (e.target === overlay) closeSheet(); };
  lazyLoadImages();
}

function closeSheet() {
  document.getElementById('sheet-overlay').classList.remove('open');
}
// Expose closeSheet globally so inline onclick handlers work
window.closeSheet = closeSheet;
app.closeSheet = closeSheet;

// Detail view (full screen overlay)
function openDetail(html) {
  const d = document.getElementById('detail-overlay');
  // Parse HTML to separate the header from the body
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const header = tmp.querySelector('.detail-header');
  const body = tmp.querySelector('.detail-body');
  if (header && body) {
    d.innerHTML = '';
    d.appendChild(header);
    const scroll = document.createElement('div');
    scroll.className = 'detail-scroll';
    scroll.appendChild(body);
    d.appendChild(scroll);
  } else {
    d.innerHTML = `<div class="detail-scroll">${html}</div>`;
  }
  d.classList.add('open');
  lazyLoadImages();
}

function closeDetail() {
  document.getElementById('detail-overlay').classList.remove('open');
}
app.closeDetail = closeDetail;

// Lazy load images from IndexedDB
function imgSrcFromLoaded(data) {
  if (!data) return null;
  if (typeof data === 'string') return data;  // data URL
  return URL.createObjectURL(data);            // blob
}

async function lazyLoadImages() {
  await new Promise(r => setTimeout(r, 10));
  const imgs = document.querySelectorAll('.lazy-img:not([src])');
  for (const img of imgs) {
    const imageId = img.dataset.imageId;
    if (!imageId) continue;
    try {
      const src = imgSrcFromLoaded(await db.loadImage(imageId));
      if (src) img.src = src;
    } catch {}
  }
  const aiImgs = document.querySelectorAll('.lazy-ai-img:not([src])');
  for (const img of aiImgs) {
    const imageId = img.dataset.aiImageId;
    if (!imageId) continue;
    try {
      const src = imgSrcFromLoaded(await db.loadImage(imageId));
      if (src) img.src = src;
    } catch {}
  }
  const aiCacheImgs = document.querySelectorAll('.lazy-ai-cache:not([src])');
  for (const img of aiCacheImgs) {
    const cacheKey = img.dataset.aiCacheKey;
    if (!cacheKey) continue;
    try {
      const src = imgSrcFromLoaded(await db.loadImage(cacheKey));
      if (src) img.src = src;
    } catch {}
  }
}

// ── Preset Palettes ──
function getPresetPalettes() {
  return [
    { name: 'Earth Tones', colors: [{hue:30,saturation:0.5,lightness:0.4},{hue:40,saturation:0.4,lightness:0.5},{hue:20,saturation:0.6,lightness:0.35},{hue:50,saturation:0.3,lightness:0.6}], harmonyType: 'analogous' },
    { name: 'Business Navy', colors: [{hue:220,saturation:0.7,lightness:0.25},{hue:0,saturation:0,lightness:0.95},{hue:210,saturation:0.3,lightness:0.5},{hue:30,saturation:0.4,lightness:0.35}], harmonyType: 'complementary' },
    { name: 'Monochrome', colors: [{hue:0,saturation:0,lightness:0.1},{hue:0,saturation:0,lightness:0.3},{hue:0,saturation:0,lightness:0.6},{hue:0,saturation:0,lightness:0.9}], harmonyType: 'monochromatic' },
    { name: 'Ocean Breeze', colors: [{hue:195,saturation:0.6,lightness:0.4},{hue:180,saturation:0.4,lightness:0.5},{hue:210,saturation:0.5,lightness:0.45},{hue:45,saturation:0.3,lightness:0.7}], harmonyType: 'analogous' },
    { name: 'Autumn Warmth', colors: [{hue:15,saturation:0.65,lightness:0.4},{hue:35,saturation:0.55,lightness:0.45},{hue:5,saturation:0.5,lightness:0.35},{hue:45,saturation:0.4,lightness:0.55}], harmonyType: 'analogous' },
    { name: 'Cool Contrast', colors: [{hue:240,saturation:0.5,lightness:0.35},{hue:60,saturation:0.5,lightness:0.55},{hue:0,saturation:0,lightness:0.15},{hue:0,saturation:0,lightness:0.85}], harmonyType: 'complementary' },
    { name: 'Forest Green', colors: [{hue:140,saturation:0.45,lightness:0.3},{hue:90,saturation:0.35,lightness:0.4},{hue:40,saturation:0.45,lightness:0.45},{hue:30,saturation:0.3,lightness:0.55}], harmonyType: 'analogous' },
    { name: 'Bold Triadic', colors: [{hue:0,saturation:0.6,lightness:0.45},{hue:120,saturation:0.5,lightness:0.35},{hue:240,saturation:0.55,lightness:0.4}], harmonyType: 'triadic' },
  ].map(p => createColorPalette({ ...p, isBuiltIn: true }));
}
