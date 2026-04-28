import { colorScore, paletteAffinity } from './color-engine.js';
import { CATEGORIES, TOP_CATEGORIES, hueDistance, hslDistance } from './utils.js';

const MAX_RESULTS = 5;
const TOP_PER_CATEGORY = 14;
const COMBO_CAP = 12000;

// seedItem can be a single item OR an array of items
// selectedVibe: vibe id used to filter out excluded items
// excludeColors: array of HSL colors {hue,saturation,lightness} from prior batches
//   for the same seed/day — outfits whose non-seed items match these get penalized
//   so that "Generate again" produces visibly different palettes.
export function generateOutfits(allItems, palette, seedItem = null, selectedVibe = null, excludeColors = []) {
  const paletteColors = palette.colors;
  if (!paletteColors.length) return [];

  const seeds = seedItem ? (Array.isArray(seedItem) ? seedItem : [seedItem]) : [];
  const seedIds = new Set(seeds.map(s => s.id));
  const seedCats = new Set(seeds.map(s => s.category));

  const buckets = {};
  for (const item of allItems) {
    if (seedIds.has(item.id)) continue;
    if (selectedVibe && item.excludeOccasions?.length) {
      if (item.excludeOccasions.includes(selectedVibe)) continue;
    }
    const catKey = TOP_CATEGORIES.includes(item.category) ? 'top' : item.category;
    if (!buckets[catKey]) buckets[catKey] = [];
    buckets[catKey].push(item);
  }

  // Pre-filter top items per category by affinity
  for (const cat in buckets) {
    buckets[cat].sort((a, b) => paletteAffinity(b, paletteColors) - paletteAffinity(a, paletteColors));
    buckets[cat] = buckets[cat].slice(0, TOP_PER_CATEGORY);
  }

  const seedIsTop = seeds.some(s => TOP_CATEGORIES.includes(s.category));
  const slots = [];

  if (!seedIsTop) {
    const tops = buckets['top'] || [];
    if (tops.length) slots.push(tops);
    else return [];
  }

  const required = CATEGORIES.filter(c => c.required && !seedCats.has(c.id) && !TOP_CATEGORIES.includes(c.id));
  for (const cat of required) {
    const items = buckets[cat.id] || [];
    if (!items.length) return [];
    slots.push(items);
  }

  const optional = CATEGORIES.filter(c => !c.required && !seedCats.has(c.id));
  for (const cat of optional) {
    const catItems = buckets[cat.id] || [];
    if (cat.id === 'shoes' && catItems.length > 0) {
      slots.push(catItems);
    } else if (cat.id === 'belt' && catItems.length > 0) {
      slots.push([...catItems, null]);
    } else {
      slots.push([null, ...catItems]);
    }
  }

  let combos = [[]];
  for (const slot of slots) {
    const next = [];
    for (const combo of combos) {
      for (const option of slot) {
        next.push([...combo, option]);
        if (next.length > COMBO_CAP) break;
      }
      if (next.length > COMBO_CAP) break;
    }
    combos = next;
  }

  const candidates = combos.map(combo => {
    const items = seeds.length ? [...seeds, ...combo.filter(Boolean)] : combo.filter(Boolean);
    if (!items.length) return null;

    const cs = colorScore(items, paletteColors);
    const completeness = computeCompleteness(items);
    const style = computeStyleScore(items);
    const overall = cs * 0.5 + completeness * 0.3 + style * 0.2;

    // Penalty for any non-seed item whose color is close to a previously-used color.
    // We want each "Generate again" to look palette-fresh, not just item-fresh.
    let historyPenalty = 0;
    if (excludeColors.length) {
      const nonSeedColors = items
        .filter(i => !seedIds.has(i.id) && i.colorProfile?.dominantColor)
        .map(i => i.colorProfile.dominantColor);
      for (const c of nonSeedColors) {
        const closest = Math.min(...excludeColors.map(e => hslDistance(c, e)));
        if (closest < 0.12) historyPenalty += 0.18;
        else if (closest < 0.22) historyPenalty += 0.08;
      }
    }

    return {
      items,
      colorScore: cs,
      completenessScore: completeness,
      styleScore: style,
      overallScore: Math.max(0, overall - historyPenalty),
      _baseScore: overall,
    };
  }).filter(Boolean);

  candidates.sort((a, b) => b.overallScore - a.overallScore);
  if (!candidates.length) return [];

  // Greedy diversity selection with HARD uniqueness on top and pants.
  // Across the 5 results, no non-seed top may repeat and no non-seed pants may
  // repeat — even if that means returning fewer than 5 outfits when the
  // wardrobe doesn't have enough variety. Within that hard constraint we
  // still prefer color-different picks via a similarity penalty.
  const picked = [];
  const usedTopIds = new Set();
  const usedPantsIds = new Set();

  const topOf = c => c.items.find(i => !seedIds.has(i.id) && TOP_CATEGORIES.includes(i.category));
  const pantsOf = c => c.items.find(i => !seedIds.has(i.id) && i.category === 'pants');

  const violatesUniqueness = c => {
    const t = topOf(c);
    if (t && usedTopIds.has(t.id)) return true;
    const p = pantsOf(c);
    if (p && usedPantsIds.has(p.id)) return true;
    return false;
  };

  const commit = c => {
    const t = topOf(c);
    if (t) usedTopIds.add(t.id);
    const p = pantsOf(c);
    if (p) usedPantsIds.add(p.id);
    picked.push(c);
  };

  // Seed the picks with the highest-scoring legal candidate.
  for (let i = 0; i < candidates.length; i++) {
    if (!violatesUniqueness(candidates[i])) {
      commit(candidates[i]);
      candidates.splice(i, 1);
      break;
    }
  }
  if (!picked.length) return [];

  while (picked.length < MAX_RESULTS) {
    let bestIdx = -1;
    let bestAdj = -Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (violatesUniqueness(c)) continue;
      let maxSim = 0;
      for (const p of picked) {
        const sim = outfitSimilarity(c, p, seedIds);
        if (sim > maxSim) maxSim = sim;
      }
      const adj = c.overallScore - 0.55 * maxSim;
      if (adj > bestAdj) { bestAdj = adj; bestIdx = i; }
    }
    if (bestIdx === -1) break; // no more legal candidates — return what we have
    commit(candidates[bestIdx]);
    candidates.splice(bestIdx, 1);
  }

  // Strip helper field
  return picked.map(p => {
    const { _baseScore, ...rest } = p;
    return rest;
  });
}

// Similarity between two candidate outfits in [0,1].
// 1 = identical/near-duplicate, 0 = very different.
function outfitSimilarity(a, b, seedIds) {
  const aNon = a.items.filter(i => !seedIds.has(i.id));
  const bNon = b.items.filter(i => !seedIds.has(i.id));
  if (!aNon.length || !bNon.length) return 0;

  // Item overlap component
  const aIds = new Set(aNon.map(i => i.id));
  let shared = 0;
  for (const i of bNon) if (aIds.has(i.id)) shared++;
  const itemSim = shared / Math.max(aNon.length, bNon.length);

  // Hue closeness component — average min-hue-distance, normalized to [0,1].
  const aHues = aNon.map(i => i.colorProfile?.dominantColor?.hue).filter(h => h !== undefined);
  const bHues = bNon.map(i => i.colorProfile?.dominantColor?.hue).filter(h => h !== undefined);
  let hueSim = 0;
  if (aHues.length && bHues.length) {
    const dists = [];
    for (const h of aHues) {
      const minD = Math.min(...bHues.map(bh => hueDistance(h, bh)));
      dists.push(minD);
    }
    const avgDist = dists.reduce((s, d) => s + d, 0) / dists.length; // 0..180
    // Outfits whose hues are within ~25° on average are "similar"
    hueSim = Math.max(0, 1 - avgDist / 60);
  }

  // Lightness/saturation closeness — distinguishes "all dark" vs "all light"
  // outfits even when hues happen to coincide (e.g. lots of neutrals).
  const aTones = aNon.map(i => i.colorProfile?.dominantColor).filter(Boolean);
  const bTones = bNon.map(i => i.colorProfile?.dominantColor).filter(Boolean);
  let toneSim = 0;
  if (aTones.length && bTones.length) {
    const aL = aTones.reduce((s, c) => s + c.lightness, 0) / aTones.length;
    const bL = bTones.reduce((s, c) => s + c.lightness, 0) / bTones.length;
    const aS = aTones.reduce((s, c) => s + c.saturation, 0) / aTones.length;
    const bS = bTones.reduce((s, c) => s + c.saturation, 0) / bTones.length;
    toneSim = Math.max(0, 1 - (Math.abs(aL - bL) + Math.abs(aS - bS)));
  }

  return Math.max(itemSim, 0.6 * hueSim + 0.4 * toneSim);
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
