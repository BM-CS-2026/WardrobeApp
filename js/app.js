import * as db from './db.js?v=25';
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

// ── AI Outfit Image Generation ──
function outfitImageCacheKey(itemIds) {
  return 'outfit-img-' + [...itemIds].sort().join('-');
}

const imageGenQueue = [];
let isProcessingQueue = false;

function enqueueImageGeneration(outfitItems, cardElement, outfitObj = null) {
  imageGenQueue.push({ outfitItems, cardElement, outfitObj });
  processImageQueue();
}

async function processImageQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  while (imageGenQueue.length > 0) {
    const { outfitItems, cardElement, outfitObj } = imageGenQueue.shift();
    if (!document.body.contains(cardElement)) continue;
    await triggerOutfitImageGeneration(outfitItems, cardElement, outfitObj);
  }
  isProcessingQueue = false;
}

async function triggerOutfitImageGeneration(outfitItems, cardElement, outfitObj) {
  const cacheKey = outfitImageCacheKey(outfitItems.map(i => i.id));

  // Check cache first
  const cached = await db.loadImage(cacheKey);
  if (cached) {
    replaceCollageWithAiImage(cardElement, cached);
    if (outfitObj && !outfitObj.aiImageId) {
      outfitObj.aiImageId = cacheKey;
      await db.putOutfit(outfitObj);
    }
    return;
  }

  // Show loading state
  showCardLoadingState(cardElement);
  console.log('[AI] Generating outfit image...', outfitItems.map(i => i.name));

  try {
    const apiKey = await db.getApiKey();
    if (!apiKey) {
      console.warn('[AI] No API key found, skipping image generation');
      removeCardLoadingState(cardElement);
      return;
    }
    const descriptions = outfitItems.map(i => ({ name: i.name, color: i.colorProfile?.dominantColor }));
    const blob = await generateOutfitImage(descriptions, apiKey);
    await db.saveImage(cacheKey, blob);
    replaceCollageWithAiImage(cardElement, blob);
    console.log('[AI] Outfit image generated successfully');
    if (outfitObj && !outfitObj.aiImageId) {
      outfitObj.aiImageId = cacheKey;
      await db.putOutfit(outfitObj);
    }
  } catch (err) {
    console.error('[AI] DALL-E generation failed:', err.message);
    removeCardLoadingState(cardElement);
    showCardErrorState(cardElement, err.message);
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

  // Sync first if configured (pull remote data before rendering)
  const syncUrl = db.getSyncUrl();
  if (syncUrl) {
    showLoading('Syncing data...');
    try {
      await db.pullOnce(syncUrl, (info) => {
        document.getElementById('loading-msg').textContent = `Syncing... ${info.docs_written} docs`;
      });
    } catch (e) {
      console.warn('[Sync] Initial pull failed:', e);
    }
    hideLoading();
  }

  await loadData();
  await ensureBuiltInPalettes();
  setupTabs();
  renderCurrentTab();

  // Start live sync for ongoing changes
  startSyncIfConfigured();

  // Wire up persistent file inputs
  document.getElementById('file-picker-hidden').onchange = function() { app.handlePhotos(this); };
  document.getElementById('file-camera-hidden').onchange = function() { app.handlePhotos(this); };
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
  openSheet(`
    <h2>Cloud Sync</h2>
    <p style="color:var(--text-secondary);font-size:13px;margin-bottom:12px">
      Enter your Cloudant database URL to sync between devices.<br>
      Format: <code style="font-size:11px">https://apikey:pass@account.cloudantnosqldb.appdomain.cloud/wardrobe</code>
    </p>
    <div class="form-group">
      <input id="sync-url-input" type="url" placeholder="https://..." value="${currentUrl}" style="font-size:13px">
    </div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn-primary" onclick="app.saveSyncUrl()" style="flex:1">Save & Sync</button>
      ${currentUrl ? '<button class="btn btn-secondary" onclick="app.disconnectSync()" style="flex:1">Disconnect</button>' : ''}
    </div>
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

async function loadData() {
  [items, palettes, outfits] = await Promise.all([
    db.getAllItems(),
    db.getAllPalettes(),
    db.getAllOutfits(),
  ]);
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
        ${items.length > 0 ? `<button class="btn-icon" onclick="app.reanalyzeAll()" title="Re-analyze items" style="font-size:16px">🔄</button>` : ''}
        ${items.length > 0 ? `<button class="btn-icon" onclick="app.exportWardrobe()" title="Export" style="font-size:16px">📤</button>` : ''}
        <button class="btn-icon" onclick="app.showImportWardrobe()" title="Import" style="font-size:16px">📥</button>
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
            <div class="item-scroll-row">
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
          ${cp ? `<div class="swatch" style="background:${hslToCss(cp.dominantColor)}"></div>` : ''}
          ${(cp?.secondaryColors || []).slice(0, 2).map(c => `<div class="swatch" style="background:${hslToCss(c)};width:12px;height:12px"></div>`).join('')}
        </div>
      </div>
    </div>
  `;
}

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

        if (garment.boundingBox) {
          const result = await extractFromRegion(files[i], garment.boundingBox);
          croppedBlob = result.croppedBlob;
          profile = result.profile;
        } else {
          profile = await extractColorProfile(files[i]);
          croppedBlob = files[i];
        }

        const imageId = generateId();
        await db.saveImage(imageId, croppedBlob);

        const category = CATEGORIES.find(c => c.id === garment.category)?.id || 'shirt';

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
  if (!confirm(`Delete ${count} selected item${count > 1 ? 's' : ''}? This cannot be undone.`)) return;

  showLoading(`Deleting ${count} items...`);
  for (const id of selectedItems) {
    const item = items.find(i => i.id === id);
    if (item?.imageId) await db.deleteImage(item.imageId).catch(() => {});
    await db.deleteItem(id);
  }
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
          const result = await extractFromRegion(blob, b);
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
            const result = await extractFromRegion(blob, g.boundingBox);
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
  closeSheet();
  openSheet(`
    <h2>Outfit Detail</h2>
    <div class="outfit-side-by-side">
      <div class="outfit-side-ai">
        <img data-ai-cache-key="${cacheKey}" class="lazy-ai-cache" style="width:100%;border-radius:var(--radius);background:var(--bg)">
      </div>
      <div class="outfit-side-items">
        ${r.items.map(item => {
          const cat = CATEGORIES.find(c => c.id === item.category);
          return `
            <div class="item-row" style="padding:6px 8px;margin-bottom:4px">
              ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img" style="width:40px;height:40px;border-radius:6px">` :
                `<div style="width:40px;height:40px;border-radius:6px;background:${item.colorProfile ? hslToCss(item.colorProfile.dominantColor) : 'var(--bg)'};display:flex;align-items:center;justify-content:center;font-size:14px">${cat?.icon || ''}</div>`}
              <div class="item-info" style="min-width:0">
                <div class="name" style="font-size:12px">${esc(item.name)}</div>
                <div class="cat" style="font-size:10px">${cat?.name || ''}</div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
    <div class="divider"></div>
    <div class="score-row"><span class="label">Color Match</span><span class="value ${scoreColor(r.colorScore)}">${Math.round(r.colorScore * 100)}%</span></div>
    <div class="score-row"><span class="label">Completeness</span><span class="value ${scoreColor(r.completenessScore)}">${Math.round(r.completenessScore * 100)}%</span></div>
    <div class="score-row"><span class="label">Style Harmony</span><span class="value ${scoreColor(r.styleScore)}">${Math.round(r.styleScore * 100)}%</span></div>
    <div class="divider"></div>
    <div class="score-row"><span class="label" style="font-weight:700">Overall</span><span class="value ${scoreColor(r.overallScore)}" style="font-weight:700">${Math.round(r.overallScore * 100)}%</span></div>
    <div class="palette-bar" style="margin:16px 0">
      ${r.items.filter(it => it.colorProfile).map(it => `<div style="background:${hslToCss(it.colorProfile.dominantColor)}"></div>`).join('')}
    </div>
    <div style="text-align:center;font-size:13px;color:var(--success);margin-bottom:8px">Auto-saved to Outfits</div>
    <button class="btn btn-secondary" onclick="app.backToGenResults()">Back to Results</button>
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

app._seedSelections = new Set();
app._outfitGuidance = '';

app.startCreateOutfit = () => {
  app._seedSelections = new Set();
  app._outfitGuidance = '';
  outfitSeedItem = null;
  outfitVibe = null;
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

    if (garment.boundingBox) {
      const result = await extractFromRegion(file, garment.boundingBox);
      croppedBlob = result.croppedBlob;
      profile = result.profile;
    }

    const imageId = generateId();
    await db.saveImage(imageId, croppedBlob);

    const category = CATEGORIES.find(c => c.id === garment.category)?.id || 'shirt';
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
      if (g.boundingBox) {
        const res = await extractFromRegion(file, g.boundingBox);
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
    ${app._outfitGuidance ? `<div style="padding:8px 10px;background:var(--accent-light);border-radius:8px;font-size:12px;color:var(--accent);margin-bottom:8px">${esc(app._outfitGuidance)}</div>` : ''}

    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">What's the occasion?</p>
    <div class="vibe-grid">
      ${VIBES.map(v => `
        <div class="vibe-card ${outfitVibe === v.id ? 'selected' : ''}" onclick="app.selectVibe('${v.id}')">
          <div class="vibe-icon">${v.icon}</div>
          <div class="vibe-name">${v.name}</div>
        </div>
      `).join('')}
    </div>

    <button class="btn btn-primary" style="margin-top:20px" id="generate-btn" onclick="app.runVibeOutfitGen()" ${!outfitVibe ? 'disabled' : ''}>
      ✨ Generate Outfits
    </button>
  `);
  lazyLoadImages();
}

app.selectVibe = (vibeId) => {
  outfitVibe = vibeId;
  // Re-render to show selected state
  showOutfitStep2();
};

app.runVibeOutfitGen = () => {
  if (!outfitSeedItem || !outfitVibe) return;
  const vibe = VIBES.find(v => v.id === outfitVibe);
  if (!vibe) return;

  closeSheet();
  showLoading('Generating outfits...');

  const seeds = Array.isArray(outfitSeedItem) ? outfitSeedItem : [outfitSeedItem];

  setTimeout(() => {
    const vibePalette = { id: 'vibe-temp', name: vibe.name, colors: vibe.colors, harmonyType: 'analogous', isBuiltIn: false };

    // Filter items by guidance (e.g. "no jeans" removes jeans)
    let filteredItems = items;
    const guidance = (app._outfitGuidance || '').toLowerCase().trim();
    if (guidance) {
      const noMatches = guidance.match(/no\s+(\w+)/gi) || [];
      const excludeTerms = noMatches.map(m => m.replace(/^no\s+/i, '').toLowerCase());
      if (excludeTerms.length) {
        filteredItems = items.filter(item => {
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
      <button class="back-btn" onclick="app.closeDetail()">‹</button>
      <h1 style="font-size:17px;flex:1">${esc(item.name)}</h1>
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
        <div class="section-title">Colors</div>
        <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px">
          <div style="text-align:center">
            <div class="swatch lg" style="background:${hslToCss(cp.dominantColor)}"></div>
            <div style="font-size:10px;color:var(--text-secondary);margin-top:4px">Dominant</div>
          </div>
          ${cp.secondaryColors.map(c => `
            <div style="text-align:center">
              <div class="swatch md" style="background:${hslToCss(c)}"></div>
              <div style="font-size:10px;color:var(--text-secondary);margin-top:4px">Secondary</div>
            </div>
          `).join('')}
        </div>
        <div class="palette-bar" style="margin-bottom:16px">
          <div style="background:${hslToCss(cp.dominantColor)}"></div>
          ${cp.secondaryColors.map(c => `<div style="background:${hslToCss(c)}"></div>`).join('')}
        </div>
      ` : ''}

      <button class="btn btn-primary" onclick="app.generateFromItem('${item.id}')">✨ Generate Outfits</button>
      <button class="btn btn-outline" style="margin-top:8px" onclick="app.pickSecondItem('${item.id}')">+ Add Another Item & Generate</button>
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
  showOutfitStep2();
};

app.saveItemName = async (id) => {
  const newName = document.getElementById('item-name-edit')?.value?.trim();
  if (!newName) return;
  const item = items.find(i => i.id === id);
  if (!item) return;
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

app.deleteItem = async (id) => {
  if (!confirm('Delete this item?')) return;
  const item = items.find(i => i.id === id);
  if (item?.imageId) await db.deleteImage(item.imageId);
  await db.deleteItem(id);
  items = items.filter(i => i.id !== id);
  closeDetail();
  renderWardrobe();
};

// ══════════════════════════════════════
// ── PALETTES TAB ──
// ══════════════════════════════════════

function renderPalettes() {
  const view = document.getElementById('view-palettes');
  const builtIn = palettes.filter(p => p.isBuiltIn);
  const custom = palettes.filter(p => !p.isBuiltIn);

  view.innerHTML = `
    <div class="view-header">
      <h1>Palettes</h1>
      <button class="btn-icon" onclick="app.showPaletteEditor()">+</button>
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
      <button class="back-btn" onclick="app.closeDetail()">‹</button>
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
        ${displayed.map(o => renderOutfitCard(o)).join('')}
      </div>
    `}
  `;
  lazyLoadImages();
}

app.toggleFavFilter = () => {
  showFavoritesOnly = !showFavoritesOnly;
  renderOutfits();
};

function renderOutfitCard(outfit) {
  const oi = (outfit.itemIds || []).map(id => items.find(i => i.id === id)).filter(Boolean);
  const isFav = !!outfit.favorite;
  return `
    <div class="outfit-card-wide">
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

  openDetail(`
    <div class="detail-header">
      <button class="back-btn" onclick="app.closeDetail()">‹</button>
      <h1 style="font-size:17px;flex:1">Outfit</h1>
      <button class="btn-icon" style="font-size:16px" onclick="app.deleteOutfit('${outfit.id}')">🗑️</button>
    </div>
    <div class="detail-body">
      ${outfit.aiImageId ?
        `<img data-ai-image-id="${outfit.aiImageId}" class="lazy-ai-img" style="width:100%;border-radius:var(--radius);background:var(--bg);margin-bottom:12px">` :
        `<div style="width:100%;aspect-ratio:4/3;background:var(--bg);border-radius:var(--radius);display:flex;align-items:center;justify-content:center;color:var(--text-secondary);font-size:13px;margin-bottom:12px">AI image generating...</div>`}

      <div class="section-title">Items (tap to replace)</div>
      <div style="display:flex;gap:10px;overflow-x:auto;padding:4px 0 12px;scrollbar-width:none">
        ${oi.map((item, idx) => `
          <div style="flex-shrink:0;text-align:center;cursor:pointer" onclick="app.showReplaceItem('${outfit.id}', ${idx})">
            ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img" style="width:100px;height:100px;border-radius:8px;object-fit:cover;display:block">` : `<div style="width:100px;height:100px;border-radius:8px;background:${item.colorProfile ? hslToCss(item.colorProfile.dominantColor) : 'var(--bg)'};display:flex;align-items:center;justify-content:center;font-size:20px">${CATEGORIES.find(c => c.id === item.category)?.icon || ''}</div>`}
            <div style="font-size:11px;font-weight:600;margin-top:4px;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.name)}</div>
            <div style="font-size:10px;color:var(--accent)">Replace ›</div>
          </div>
        `).join('')}
      </div>

      <div class="divider"></div>

      <div class="section-title">Refine with Text</div>
      <div style="display:flex;gap:8px;margin-bottom:16px">
        <input id="outfit-feedback-text" type="text" placeholder="e.g. make it more casual, swap belt..." style="flex:1;padding:10px 12px;border:1.5px solid var(--border);border-radius:var(--radius-sm);font-size:14px">
        <button class="btn btn-primary btn-sm" onclick="app.applyOutfitFeedback('${outfit.id}')">Apply</button>
      </div>

      <div class="section-title">Score</div>
      <div class="score-row"><span class="label">Color Match</span><span class="value ${scoreColor(outfit.colorScore)}">${Math.round(outfit.colorScore * 100)}%</span></div>
      <div class="score-row"><span class="label">Completeness</span><span class="value ${scoreColor(outfit.completenessScore)}">${Math.round(outfit.completenessScore * 100)}%</span></div>
      <div class="score-row"><span class="label">Style Harmony</span><span class="value ${scoreColor(outfit.styleScore)}">${Math.round(outfit.styleScore * 100)}%</span></div>
      <div class="divider"></div>
      <div class="score-row"><span class="label" style="font-weight:700">Overall</span><span class="value ${scoreColor(outfit.overallScore)}" style="font-weight:700">${Math.round(outfit.overallScore * 100)}%</span></div>

      <div style="font-size:12px;color:var(--text-secondary);margin-top:12px">${new Date(outfit.dateCreated).toLocaleDateString()}</div>
    </div>
  `);
  lazyLoadImages();
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

app.deleteOutfit = async (id) => {
  if (!confirm('Delete this outfit?')) return;
  await db.deleteOutfit(id);
  outfits = outfits.filter(o => o.id !== id);
  closeDetail();
  renderOutfits();
};

app.quickDeleteOutfit = async (id) => {
  if (!confirm('Delete this outfit?')) return;
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
      <button class="back-btn" onclick="app.closeDetail()">‹</button>
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
  openSheet(`
    <h2>Outfit Detail</h2>
    <div class="outfit-side-by-side">
      <div class="outfit-side-ai">
        <img data-ai-cache-key="${cacheKey2}" class="lazy-ai-cache" style="width:100%;border-radius:var(--radius);background:var(--bg)">
      </div>
      <div class="outfit-side-items">
        ${r.items.map(item => `
          <div class="item-row" style="padding:6px 8px;margin-bottom:4px">
            ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img" style="width:40px;height:40px;border-radius:6px">` : `<div style="width:40px;height:40px;border-radius:6px;background:${item.colorProfile ? hslToCss(item.colorProfile.dominantColor) : 'var(--bg)'};display:flex;align-items:center;justify-content:center;font-size:14px">${CATEGORIES.find(c => c.id === item.category)?.icon || ''}</div>`}
            <div class="item-info" style="min-width:0">
              <div class="name" style="font-size:12px">${esc(item.name)}</div>
              <div class="cat" style="font-size:10px">${CATEGORIES.find(c => c.id === item.category)?.name || ''}</div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="divider"></div>
    <div class="score-row"><span class="label">Color Match</span><span class="value ${scoreColor(r.colorScore)}">${Math.round(r.colorScore * 100)}%</span></div>
    <div class="score-row"><span class="label">Completeness</span><span class="value ${scoreColor(r.completenessScore)}">${Math.round(r.completenessScore * 100)}%</span></div>
    <div class="score-row"><span class="label">Style Harmony</span><span class="value ${scoreColor(r.styleScore)}">${Math.round(r.styleScore * 100)}%</span></div>
    <div class="divider"></div>
    <div class="score-row"><span class="label" style="font-weight:700">Overall</span><span class="value ${scoreColor(r.overallScore)}" style="font-weight:700">${Math.round(r.overallScore * 100)}%</span></div>

    <div class="palette-bar" style="margin:16px 0">
      ${r.items.filter(i => i.colorProfile).map(i => `<div style="background:${hslToCss(i.colorProfile.dominantColor)}"></div>`).join('')}
    </div>

    <div style="text-align:center;font-size:13px;color:var(--success);margin-bottom:8px">Auto-saved to Outfits</div>
    <button class="btn btn-secondary" onclick="closeSheet()">Close</button>
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

// Sheet (bottom modal)
function openSheet(html) {
  const overlay = document.getElementById('sheet-overlay');
  overlay.querySelector('.modal-sheet').innerHTML = `<div class="sheet-handle"></div>${html}`;
  overlay.classList.add('open');
  overlay.onclick = (e) => { if (e.target === overlay) closeSheet(); };
  lazyLoadImages();
}

function closeSheet() {
  document.getElementById('sheet-overlay').classList.remove('open');
}

// Detail view (full screen overlay)
function openDetail(html) {
  const d = document.getElementById('detail-overlay');
  d.innerHTML = html;
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
