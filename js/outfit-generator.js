import { colorScore, paletteAffinity } from './color-engine.js';
import { CATEGORIES } from './utils.js';

const MAX_RESULTS = 8;
const TOP_PER_CATEGORY = 5;

// seedItem can be a single item OR an array of items
export function generateOutfits(allItems, palette, seedItem = null) {
  const paletteColors = palette.colors;
  if (!paletteColors.length) return [];

  // Normalize seeds to array
  const seeds = seedItem ? (Array.isArray(seedItem) ? seedItem : [seedItem]) : [];
  const seedIds = new Set(seeds.map(s => s.id));
  const seedCats = new Set(seeds.map(s => s.category));

  // Partition by category, exclude seeds
  const buckets = {};
  for (const item of allItems) {
    if (seedIds.has(item.id)) continue;
    if (!buckets[item.category]) buckets[item.category] = [];
    buckets[item.category].push(item);
  }

  // Pre-filter top items per category by affinity
  for (const cat in buckets) {
    buckets[cat].sort((a, b) => paletteAffinity(b, paletteColors) - paletteAffinity(a, paletteColors));
    buckets[cat] = buckets[cat].slice(0, TOP_PER_CATEGORY);
  }

  // Determine required/optional slots (excluding seed categories)
  const required = CATEGORIES.filter(c => c.required && !seedCats.has(c.id));
  const optional = CATEGORIES.filter(c => !c.required && !seedCats.has(c.id));

  // Build slot arrays — for belt, put items first (before null) to favor inclusion
  const slots = [];
  for (const cat of required) {
    const items = buckets[cat.id] || [];
    if (!items.length) return []; // can't form outfit
    slots.push(items);
  }
  for (const cat of optional) {
    const catItems = buckets[cat.id] || [];
    if (cat.id === 'belt' && catItems.length > 0) {
      // Favor belts: put items first so they're more likely picked before null
      slots.push([...catItems, null]);
    } else {
      slots.push([null, ...catItems]);
    }
  }

  // Cartesian product (capped to prevent explosion)
  let combos = [[]];
  for (const slot of slots) {
    const next = [];
    for (const combo of combos) {
      for (const option of slot) {
        next.push([...combo, option]);
        if (next.length > 5000) break; // safety cap
      }
      if (next.length > 5000) break;
    }
    combos = next;
  }

  // Score each
  const candidates = combos.map(combo => {
    const items = seeds.length ? [...seeds, ...combo.filter(Boolean)] : combo.filter(Boolean);
    if (!items.length) return null;

    const cs = colorScore(items, paletteColors);
    const completeness = computeCompleteness(items);
    const style = computeStyleScore(items);
    const overall = cs * 0.5 + completeness * 0.3 + style * 0.2;

    return { items, colorScore: cs, completenessScore: completeness, styleScore: style, overallScore: overall };
  }).filter(Boolean);

  candidates.sort((a, b) => b.overallScore - a.overallScore);

  // Enforce diversity: pick top results that differ by at least 2 items
  const diverse = [];
  for (const c of candidates) {
    if (diverse.length >= MAX_RESULTS) break;
    const cIds = new Set(c.items.map(i => i.id));
    const tooSimilar = diverse.some(d => {
      const dIds = new Set(d.items.map(i => i.id));
      let shared = 0;
      for (const id of cIds) { if (dIds.has(id)) shared++; }
      // If they share all but 0 or 1 items, skip (too similar)
      return shared >= Math.max(cIds.size, dIds.size) - 1;
    });
    if (!tooSimilar) diverse.push(c);
  }

  // If diversity filter was too strict, fill remaining slots from top candidates
  if (diverse.length < MAX_RESULTS) {
    for (const c of candidates) {
      if (diverse.length >= MAX_RESULTS) break;
      if (!diverse.includes(c)) diverse.push(c);
    }
  }

  return diverse;
}

export function computeCompleteness(items) {
  const cats = new Set(items.map(i => i.category));
  const reqCats = CATEGORIES.filter(c => c.required);
  const optCats = CATEGORIES.filter(c => !c.required);

  const reqCovered = reqCats.filter(c => cats.has(c.id)).length;
  const optCovered = optCats.filter(c => cats.has(c.id)).length;

  const reqScore = reqCovered / Math.max(reqCats.length, 1);
  const optBonus = optCovered / Math.max(optCats.length, 1) * 0.2;

  return Math.min(reqScore + optBonus, 1);
}

export function computeStyleScore(items) {
  const allTags = items.flatMap(i => i.styleTags || []);
  if (!allTags.length) return 0.5;

  const counts = {};
  for (const t of allTags) counts[t] = (counts[t] || 0) + 1;
  const maxCount = Math.max(...Object.values(counts));
  return maxCount / items.length;
}
