import * as db from './db.js?v=8';
import { createClothingItem, createColorPalette, createOutfit } from './models.js?v=8';
import { extractColorProfile, extractFromRegion, paletteAffinity } from './color-engine.js?v=8';
import { generateOutfits } from './outfit-generator.js?v=8';
import { analyzeOutfitPhoto, generateOutfitImage } from './cloud-ai.js?v=8';
import { hslToCss, generateId, scoreColor, CATEGORIES, STYLE_TAGS, HARMONY_TYPES, VIBES } from './utils.js?v=8';

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
    const descriptions = outfitItems.map(i => i.name);
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

function replaceCollageWithAiImage(cardElement, blob) {
  const collage = cardElement.querySelector('.outfit-collage');
  if (!collage) return;
  const url = URL.createObjectURL(blob);
  collage.innerHTML = `<img src="${url}">`;
  collage.classList.add('ai-generated');
}

function showCardLoadingState(cardElement) {
  const collage = cardElement.querySelector('.outfit-collage');
  if (!collage) return;
  collage.style.position = 'relative';
  const overlay = document.createElement('div');
  overlay.className = 'ai-loading-overlay';
  overlay.innerHTML = '<div class="ai-shimmer"></div><div style="font-size:11px;color:var(--text-secondary);margin-top:8px">Generating AI image...</div>';
  collage.appendChild(overlay);
}

function removeCardLoadingState(cardElement) {
  const overlay = cardElement.querySelector('.ai-loading-overlay');
  if (overlay) overlay.remove();
}

function showCardErrorState(cardElement, message) {
  const collage = cardElement.querySelector('.outfit-collage');
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
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  await loadData();
  await ensureBuiltInPalettes();
  setupTabs();
  renderCurrentTab();
});

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
        ${items.length > 0 ? `<button class="btn-icon" onclick="app.deleteAllItems()" title="Delete all" style="font-size:16px">🗑️</button>` : ''}
        ${items.length > 0 ? `<button class="btn-icon" onclick="app.reanalyzeAll()" title="Re-analyze items" style="font-size:16px">🔄</button>` : ''}
        <button class="btn-icon" onclick="app.startCreateOutfit()" title="Create Outfit" style="font-size:16px">✨</button>
        <button class="btn-icon" onclick="app.showAddFlow()">+</button>
      </div>
    </div>
    <div style="padding-bottom:24px">
      ${sections.map(section => `
        <div class="category-section">
          <div class="category-header">
            <span class="cat-icon">${section.icon}</span>
            <span class="cat-name">${section.name}s</span>
            <span class="cat-count">(${section.items.length})</span>
          </div>
          ${section.items.length === 0 ? `
            <div class="category-empty">No ${section.name.toLowerCase()}s yet</div>
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
  return `
    <div class="item-card" onclick="app.showItemDetail('${item.id}')">
      <div class="thumb" id="thumb-${item.id}">
        ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img">` : `<span>${CATEGORIES.find(c => c.id === item.category)?.icon || '👔'}</span>`}
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
window.app = {};

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
    <div class="choice-card" onclick="app.triggerCamera()">
      <div class="icon-box">📷</div>
      <div class="text">
        <h4>Take Photo</h4>
        <p>Snap a picture of an item or outfit</p>
      </div>
      <div class="chevron">›</div>
    </div>
    <div class="choice-card" onclick="app.triggerPhotoPicker()">
      <div class="icon-box">🖼️</div>
      <div class="text">
        <h4>Choose from Photos</h4>
        <p>Select photos from your library</p>
      </div>
      <div class="chevron">›</div>
    </div>
    <input type="file" accept="image/*" multiple class="file-input" id="file-picker-hidden" onchange="app.handlePhotos(this)">
    <input type="file" accept="image/*" capture="environment" class="file-input" id="file-camera-hidden" onchange="app.handlePhotos(this)">

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

app.triggerPhotoPicker = async () => {
  const apiKey = document.getElementById('api-key-input')?.value?.trim() || await db.getApiKey();
  if (!apiKey) { alert('Please enter your OpenAI API key first.'); return; }
  await db.saveApiKey(apiKey);
  closeSheet();
  setTimeout(() => document.getElementById('file-picker-hidden').click(), 100);
};

app.triggerCamera = async () => {
  const apiKey = document.getElementById('api-key-input')?.value?.trim() || await db.getApiKey();
  if (!apiKey) { alert('Please enter your OpenAI API key first.'); return; }
  await db.saveApiKey(apiKey);
  closeSheet();
  setTimeout(() => document.getElementById('file-camera-hidden').click(), 100);
};

// ── Process photos through AI → save items → show results with outfit checkbox ──

app.handlePhotos = async (input) => {
  const files = Array.from(input.files);
  if (!files.length) return;
  input.value = '';

  const apiKey = await db.getApiKey();
  if (!apiKey) { alert('OpenAI API key not set.'); return; }

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

function showGeneratedOutfitsSheet(results, seedItems, vibe) {
  // Store results so event handlers can access them
  app._genResults = results;

  const seedNames = seedItems.map(i => i.name).join(', ');
  const vibeLabel = vibe ? `${vibe.icon} ${vibe.name}` : '';
  openSheet(`
    <h2>Outfit Ideas</h2>
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px">
      ${results.length} outfits generated${seedNames ? ` for: ${esc(seedNames)}` : ''}${vibeLabel ? ` — ${vibeLabel}` : ''}
    </p>
    <div class="item-grid">
      ${results.map((r, i) => `
        <div class="outfit-card" onclick="app.showGenOutfitDetail(${i})">
          <div class="outfit-collage">
            ${r.items.slice(0, 4).map(item => `
              ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img" style="background:var(--bg)">` :
                `<div class="placeholder" style="background:${item.colorProfile ? hslToCss(item.colorProfile.dominantColor) : 'var(--bg)'}">
                  ${CATEGORIES.find(c => c.id === item.category)?.icon || ''}
                </div>`}
            `).join('')}
            ${r.items.length < 4 ? Array(4 - Math.min(r.items.length, 4)).fill('<div class="placeholder"></div>').join('') : ''}
          </div>
          <div class="score-badge">
            <span class="pct ${scoreColor(r.overallScore)}">${Math.round(r.overallScore * 100)}%</span>
            <span style="color:var(--text-secondary)">${r.items.length} items</span>
          </div>
          <div class="palette-bar" style="height:6px;border-radius:0">
            ${r.items.filter(it => it.colorProfile).map(it => `<div style="background:${hslToCss(it.colorProfile.dominantColor)}"></div>`).join('')}
          </div>
        </div>
      `).join('')}
    </div>
    <button class="btn btn-secondary" style="margin-top:16px" onclick="app.closeSheetAndRender()">Close</button>
  `);
  lazyLoadImages();

  // AI status banner
  const statusBanner = document.createElement('div');
  statusBanner.id = 'ai-status';
  statusBanner.style.cssText = 'padding:8px 12px;background:#e8f0fe;border-radius:8px;font-size:12px;color:#1a73e8;margin-bottom:12px;text-align:center';
  statusBanner.textContent = 'Preparing AI outfit images...';
  const sheetContent = document.querySelector('#sheet-overlay .modal-sheet');
  if (sheetContent) sheetContent.insertBefore(statusBanner, sheetContent.children[1]);

  // Progressive AI image generation
  setTimeout(async () => {
    const cards = document.querySelectorAll('#sheet-overlay .outfit-card');
    const banner = document.getElementById('ai-status');

    if (!cards.length) {
      if (banner) banner.textContent = 'Error: No outfit cards found';
      return;
    }

    const apiKey = await db.getApiKey();
    if (!apiKey) {
      if (banner) banner.textContent = 'No API key found — skipping AI image generation';
      return;
    }

    if (banner) banner.textContent = `Generating AI images (0/${cards.length})... This takes ~15s per outfit.`;

    let done = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!cards[i]) continue;
      const cacheKey = outfitImageCacheKey(r.items.map(it => it.id));
      const cached = await db.loadImage(cacheKey);

      if (cached) {
        replaceCollageWithAiImage(cards[i], cached);
        done++;
        if (banner) banner.textContent = `AI images: ${done}/${results.length} done`;
        continue;
      }

      showCardLoadingState(cards[i]);
      try {
        const descriptions = r.items.map(it => it.name);
        const blob = await generateOutfitImage(descriptions, apiKey);
        await db.saveImage(cacheKey, blob);
        replaceCollageWithAiImage(cards[i], blob);
        done++;
        if (banner) banner.textContent = `AI images: ${done}/${results.length} done`;
      } catch (err) {
        removeCardLoadingState(cards[i]);
        if (banner) {
          banner.style.background = '#fce8e6';
          banner.style.color = '#c5221f';
          banner.textContent = `DALL-E error: ${err.message.slice(0, 100)}`;
        }
        break; // Stop trying if one fails (likely auth/billing issue)
      }
    }

    if (done === results.length && banner) {
      banner.style.background = '#e6f4ea';
      banner.style.color = '#137333';
      banner.textContent = `All ${done} AI outfit images generated!`;
      setTimeout(() => banner.remove(), 3000);
    }
  }, 500);
}

app.showGenOutfitDetail = (idx) => {
  const r = app._genResults[idx];
  if (!r) return;
  closeSheet();
  openSheet(`
    <h2>Outfit Detail</h2>
    ${r.items.map(item => {
      const cat = CATEGORIES.find(c => c.id === item.category);
      return `
        <div class="item-row">
          ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img">` :
            `<div style="width:50px;height:50px;border-radius:8px;background:${item.colorProfile ? hslToCss(item.colorProfile.dominantColor) : 'var(--bg)'};display:flex;align-items:center;justify-content:center">${cat?.icon || ''}</div>`}
          <div class="item-info">
            <div class="name">${esc(item.name)}</div>
            <div class="cat">${cat?.name || ''}</div>
          </div>
          ${item.colorProfile ? `<div class="swatch" style="background:${hslToCss(item.colorProfile.dominantColor)}"></div>` : ''}
        </div>
      `;
    }).join('')}
    <div class="divider"></div>
    <div class="score-row"><span class="label">Color Match</span><span class="value ${scoreColor(r.colorScore)}">${Math.round(r.colorScore * 100)}%</span></div>
    <div class="score-row"><span class="label">Completeness</span><span class="value ${scoreColor(r.completenessScore)}">${Math.round(r.completenessScore * 100)}%</span></div>
    <div class="score-row"><span class="label">Style Harmony</span><span class="value ${scoreColor(r.styleScore)}">${Math.round(r.styleScore * 100)}%</span></div>
    <div class="divider"></div>
    <div class="score-row"><span class="label" style="font-weight:700">Overall</span><span class="value ${scoreColor(r.overallScore)}" style="font-weight:700">${Math.round(r.overallScore * 100)}%</span></div>
    <div class="palette-bar" style="margin:16px 0">
      ${r.items.filter(it => it.colorProfile).map(it => `<div style="background:${hslToCss(it.colorProfile.dominantColor)}"></div>`).join('')}
    </div>
    <button class="btn btn-primary" onclick="app.saveGenOutfit(${idx})">Save Outfit</button>
    <button class="btn btn-secondary" style="margin-top:8px" onclick="app.backToGenResults()">Back to Results</button>
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

app.startCreateOutfit = () => {
  outfitSeedItem = null;
  outfitVibe = null;
  showOutfitStep1();
};

// Step 1: Pick an item (take new photo OR choose existing)
function showOutfitStep1() {
  openSheet(`
    <h2>Create Outfit</h2>
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px">
      Start with an item — take a new photo or pick from your wardrobe.
    </p>

    <div class="choice-card" onclick="app.outfitNewPhoto()">
      <div class="icon-box">📷</div>
      <div class="text">
        <h4>New Photo</h4>
        <p>Take a photo of an item to build an outfit around</p>
      </div>
      <div class="chevron">›</div>
    </div>

    ${items.length > 0 ? `
      <div class="section-label" style="margin-top:16px">Or pick from your wardrobe:</div>
      <div id="pick-item-list" style="max-height:300px;overflow-y:auto">
        ${CATEGORIES.map(cat => {
          const catItems = items.filter(i => i.category === cat.id);
          if (!catItems.length) return '';
          return `
            <div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin:10px 0 4px">${cat.icon} ${cat.name}s</div>
            ${catItems.map(item => `
              <div class="pick-item-row" onclick="app.pickExistingItem('${item.id}')">
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
    ` : ''}

    <input type="file" accept="image/*" capture="environment" class="file-input" id="file-outfit-new" onchange="app.handleOutfitNewPhoto(this)">
  `);
  lazyLoadImages();
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
  const seed = outfitSeedItem;
  const cat = CATEGORIES.find(c => c.id === seed?.category);

  openSheet(`
    <h2>Choose a Vibe</h2>
    <div style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg);border-radius:10px;margin-bottom:16px">
      ${seed?.imageId ? `<img data-image-id="${seed.imageId}" class="lazy-img" style="width:48px;height:48px;border-radius:8px;object-fit:cover">` :
        `<div style="width:48px;height:48px;border-radius:8px;background:var(--border);display:flex;align-items:center;justify-content:center">${cat?.icon || '👔'}</div>`}
      <div style="flex:1">
        <div style="font-size:14px;font-weight:600">${esc(seed?.name || 'Item')}</div>
        <div style="font-size:12px;color:var(--text-secondary)">${cat?.name || ''}</div>
      </div>
      ${seed?.colorProfile ? `<div class="swatch md" style="background:${hslToCss(seed.colorProfile.dominantColor)}"></div>` : ''}
    </div>

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

  setTimeout(() => {
    // Create a temporary palette from the vibe's colors
    const vibePalette = { id: 'vibe-temp', name: vibe.name, colors: vibe.colors, harmonyType: 'analogous', isBuiltIn: false };

    const results = generateOutfits(items, vibePalette, outfitSeedItem);

    hideLoading();

    if (results.length > 0) {
      app._genResults = results;
      showGeneratedOutfitsSheet(results, [outfitSeedItem], vibe);
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
    const blob = await db.loadImage(item.imageId);
    if (blob) imgSrc = URL.createObjectURL(blob);
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
    </div>
  `);
  lazyLoadImages();
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

function renderOutfits() {
  const view = document.getElementById('view-outfits');
  const saved = outfits.filter(o => o.isSaved).sort((a, b) => b.dateCreated - a.dateCreated);

  view.innerHTML = `
    <div class="view-header">
      <h1>Outfits</h1>
    </div>
    ${saved.length === 0 ? `
      <div class="empty-state">
        <div class="icon">✨</div>
        <h3>No Saved Outfits</h3>
        <p>Generate outfits from your wardrobe items and save your favorites</p>
      </div>
    ` : `
      <div class="item-grid" style="padding:12px 16px">
        ${saved.map(o => renderOutfitCard(o)).join('')}
      </div>
    `}
  `;
  lazyLoadImages();
}

function renderOutfitCard(outfit) {
  const oi = (outfit.itemIds || []).map(id => items.find(i => i.id === id)).filter(Boolean);
  const hasAiImage = !!outfit.aiImageId;
  return `
    <div class="outfit-card" onclick="app.showOutfitDetail('${outfit.id}')">
      <div class="outfit-collage${hasAiImage ? ' ai-generated' : ''}">
        ${hasAiImage
          ? `<img data-ai-image-id="${outfit.aiImageId}" class="lazy-ai-img" style="background:var(--bg)">`
          : `${oi.slice(0, 4).map(item => `
              ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img" style="background:var(--bg)">` :
                `<div class="placeholder" style="background:${item.colorProfile ? hslToCss(item.colorProfile.dominantColor) : 'var(--bg)'}">
                  ${CATEGORIES.find(c => c.id === item.category)?.icon || ''}
                </div>`}
            `).join('')}
            ${oi.length < 4 ? Array(4 - Math.min(oi.length, 4)).fill('<div class="placeholder"></div>').join('') : ''}`
        }
      </div>
      <div class="score-badge">
        <span class="pct ${scoreColor(outfit.overallScore)}">${Math.round(outfit.overallScore * 100)}%</span>
        <span style="color:var(--text-secondary)">${oi.length} items</span>
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
      ${outfit.aiImageId ? `<img data-ai-image-id="${outfit.aiImageId}" class="lazy-ai-img" style="width:100%;border-radius:var(--radius);margin-bottom:16px;background:var(--bg)">` : ''}
      <div class="section-title">Items</div>
      ${oi.map(item => `
        <div class="item-row">
          ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img">` : `<div style="width:50px;height:50px;border-radius:8px;background:${item.colorProfile ? hslToCss(item.colorProfile.dominantColor) : 'var(--bg)'};display:flex;align-items:center;justify-content:center">${CATEGORIES.find(c => c.id === item.category)?.icon || ''}</div>`}
          <div class="item-info">
            <div class="name">${esc(item.name)}</div>
            <div class="cat">${CATEGORIES.find(c => c.id === item.category)?.name || ''}</div>
          </div>
          ${item.colorProfile ? `<div class="swatch" style="background:${hslToCss(item.colorProfile.dominantColor)}"></div>` : ''}
        </div>
      `).join('')}

      <div class="divider"></div>

      <div class="section-title">Score Breakdown</div>
      <div class="score-row"><span class="label">Color Match</span><span class="value ${scoreColor(outfit.colorScore)}">${Math.round(outfit.colorScore * 100)}%</span></div>
      <div class="score-row"><span class="label">Completeness</span><span class="value ${scoreColor(outfit.completenessScore)}">${Math.round(outfit.completenessScore * 100)}%</span></div>
      <div class="score-row"><span class="label">Style Harmony</span><span class="value ${scoreColor(outfit.styleScore)}">${Math.round(outfit.styleScore * 100)}%</span></div>
      <div class="divider"></div>
      <div class="score-row"><span class="label" style="font-weight:700">Overall</span><span class="value ${scoreColor(outfit.overallScore)}" style="font-weight:700">${Math.round(outfit.overallScore * 100)}%</span></div>

      <div class="palette-bar" style="margin-top:16px">
        ${oi.filter(i => i.colorProfile).map(i => `<div style="background:${hslToCss(i.colorProfile.dominantColor)}"></div>`).join('')}
      </div>

      <div style="font-size:12px;color:var(--text-secondary);margin-top:12px">${new Date(outfit.dateCreated).toLocaleDateString()}</div>
    </div>
  `);
  lazyLoadImages();
};

app.deleteOutfit = async (id) => {
  if (!confirm('Delete this outfit?')) return;
  await db.deleteOutfit(id);
  outfits = outfits.filter(o => o.id !== id);
  closeDetail();
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

  setTimeout(() => {
    generatorResults = generateOutfits(items, palette, seed);
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
    <div class="item-grid">
      ${generatorResults.map((r, i) => `
        <div class="outfit-card" onclick="app.showGeneratedDetail(${i})">
          <div class="outfit-collage">
            ${r.items.slice(0, 4).map(item => `
              ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img" style="background:var(--bg)">` :
                `<div class="placeholder" style="background:${item.colorProfile ? hslToCss(item.colorProfile.dominantColor) : 'var(--bg)'}">
                  ${CATEGORIES.find(c => c.id === item.category)?.icon || ''}
                </div>`}
            `).join('')}
            ${r.items.length < 4 ? Array(4 - Math.min(r.items.length, 4)).fill('<div class="placeholder"></div>').join('') : ''}
          </div>
          <div class="score-badge">
            <span class="pct ${scoreColor(r.overallScore)}">${Math.round(r.overallScore * 100)}%</span>
            <span style="color:var(--text-secondary)">${r.items.length} items</span>
          </div>
          <div class="palette-bar" style="height:6px;border-radius:0">
            ${r.items.filter(i => i.colorProfile).map(i => `<div style="background:${hslToCss(i.colorProfile.dominantColor)}"></div>`).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;
  lazyLoadImages();

  // Progressive AI image generation
  setTimeout(() => {
    const cards = div.querySelectorAll('.outfit-card');
    console.log('[AI] Generator: found', cards.length, 'outfit cards, starting DALL-E generation...');
    generatorResults.forEach((r, i) => {
      if (cards[i]) enqueueImageGeneration(r.items, cards[i]);
    });
  }, 500);
}

app.showGeneratedDetail = (idx) => {
  const r = generatorResults[idx];
  if (!r) return;

  openSheet(`
    <h2>Outfit Detail</h2>
    ${r.items.map(item => `
      <div class="item-row">
        ${item.imageId ? `<img data-image-id="${item.imageId}" class="lazy-img">` : `<div style="width:50px;height:50px;border-radius:8px;background:${item.colorProfile ? hslToCss(item.colorProfile.dominantColor) : 'var(--bg)'};display:flex;align-items:center;justify-content:center">${CATEGORIES.find(c => c.id === item.category)?.icon || ''}</div>`}
        <div class="item-info">
          <div class="name">${esc(item.name)}</div>
          <div class="cat">${CATEGORIES.find(c => c.id === item.category)?.name || ''}</div>
        </div>
        ${item.colorProfile ? `<div class="swatch" style="background:${hslToCss(item.colorProfile.dominantColor)}"></div>` : ''}
      </div>
    `).join('')}

    <div class="divider"></div>
    <div class="score-row"><span class="label">Color Match</span><span class="value ${scoreColor(r.colorScore)}">${Math.round(r.colorScore * 100)}%</span></div>
    <div class="score-row"><span class="label">Completeness</span><span class="value ${scoreColor(r.completenessScore)}">${Math.round(r.completenessScore * 100)}%</span></div>
    <div class="score-row"><span class="label">Style Harmony</span><span class="value ${scoreColor(r.styleScore)}">${Math.round(r.styleScore * 100)}%</span></div>
    <div class="divider"></div>
    <div class="score-row"><span class="label" style="font-weight:700">Overall</span><span class="value ${scoreColor(r.overallScore)}" style="font-weight:700">${Math.round(r.overallScore * 100)}%</span></div>

    <div class="palette-bar" style="margin:16px 0">
      ${r.items.filter(i => i.colorProfile).map(i => `<div style="background:${hslToCss(i.colorProfile.dominantColor)}"></div>`).join('')}
    </div>

    <button class="btn btn-primary" onclick="app.saveGeneratedOutfit(${idx})">❤️ Save Outfit</button>
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
// ── HELPERS ──
// ══════════════════════════════════════

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
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

app.closeDetail = () => {
  document.getElementById('detail-overlay').classList.remove('open');
};

// Lazy load images from IndexedDB
async function lazyLoadImages() {
  await new Promise(r => setTimeout(r, 10));
  const imgs = document.querySelectorAll('.lazy-img:not([src])');
  for (const img of imgs) {
    const imageId = img.dataset.imageId;
    if (!imageId) continue;
    try {
      const blob = await db.loadImage(imageId);
      if (blob) img.src = URL.createObjectURL(blob);
    } catch {}
  }
  // AI-generated outfit images
  const aiImgs = document.querySelectorAll('.lazy-ai-img:not([src])');
  for (const img of aiImgs) {
    const imageId = img.dataset.aiImageId;
    if (!imageId) continue;
    try {
      const blob = await db.loadImage(imageId);
      if (blob) img.src = URL.createObjectURL(blob);
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
