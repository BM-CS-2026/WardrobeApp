import { rgbToHsl, hslDistance, hueDistance, isBackground, HARMONY_ANGLES } from './utils.js';

// Extract color profile from an image element or blob
export async function extractColorProfile(imageSource) {
  const img = await loadImageElement(imageSource);
  const canvas = document.createElement('canvas');
  const size = 300;
  const scale = Math.min(size / img.width, size / img.height, 1);
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // Grid sampling (5x5)
  const gridSize = 5;
  const cellW = canvas.width / gridSize;
  const cellH = canvas.height / gridSize;
  const samples = [];

  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const x = Math.round(col * cellW);
      const y = Math.round(row * cellH);
      const w = Math.round(cellW);
      const h = Math.round(cellH);
      const data = ctx.getImageData(x, y, w, h).data;

      // Average color of this cell
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      for (let i = 0; i < data.length; i += 4) {
        rSum += data[i];
        gSum += data[i + 1];
        bSum += data[i + 2];
        count++;
      }
      if (count > 0) {
        samples.push(rgbToHsl(rSum / count, gSum / count, bSum / count));
      }
    }
  }

  // Filter out background colors
  const filtered = samples.filter(c => !isBackground(c));
  if (filtered.length === 0) {
    const avg = averageHSL(samples);
    return { dominantColor: avg, secondaryColors: [], averageColor: avg };
  }

  // K-means clustering (k=4)
  const clusters = kMeans(filtered, Math.min(4, filtered.length), 20);
  clusters.sort((a, b) => b.members.length - a.members.length);

  const dominant = clusters[0].centroid;
  const secondary = clusters.slice(1, 4).map(c => c.centroid);
  const avg = averageHSL(filtered);

  return { dominantColor: dominant, secondaryColors: secondary, averageColor: avg };
}

// Crop to bounding box — zooms in on the item, centered, no background removal
export async function extractFromRegion(imageSource, box, category = null) {
  const img = await loadImageElement(imageSource);

  // Add padding around the bounding box — shoes and belts need more padding to avoid cutting
  const needsExtraPad = category === 'shoes' || category === 'belt';
  const padX = needsExtraPad ? 0.12 : 0.02;
  const padY = needsExtraPad ? 0.15 : 0.02;
  const bx = Math.max(0, box.x - padX);
  const by = Math.max(0, box.y - padY);
  const bw = Math.min(1 - bx, box.width + padX * 2);
  const bh = Math.min(1 - by, box.height + padY * 2);

  const sx = Math.round(bx * img.width);
  const sy = Math.round(by * img.height);
  const sw = Math.round(bw * img.width);
  const sh = Math.round(bh * img.height);

  // Output as a square-ish image with the item centered
  const outSize = Math.max(sw, sh);
  const canvas = document.createElement('canvas');
  canvas.width = outSize;
  canvas.height = outSize;
  const ctx = canvas.getContext('2d');

  // Fill with a neutral background (in case crop is not square)
  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(0, 0, outSize, outSize);

  // Center the crop in the square
  const dx = Math.round((outSize - sw) / 2);
  const dy = Math.round((outSize - sh) / 2);
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, sw, sh);

  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
  const profile = await extractColorProfile(blob);
  return { profile, croppedBlob: blob };
}

// Palette match score
export function paletteMatchScore(items, paletteColors) {
  const scores = items.filter(i => i.colorProfile).map(item => {
    const dominant = item.colorProfile.dominantColor;
    const minDist = Math.min(...paletteColors.map(c => hslDistance(dominant, c)));
    return Math.max(0, 1 - minDist / 0.5);
  });
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
}

// Inter-item harmony score
export function interItemHarmonyScore(items) {
  const colors = items.filter(i => i.colorProfile).map(i => i.colorProfile.dominantColor);
  if (colors.length < 2) return 1;

  const pairScores = [];
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const hueDist = hueDistance(colors[i].hue, colors[j].hue);
      const best = Math.max(...HARMONY_ANGLES.map(angle => {
        const dev = Math.abs(hueDist - angle);
        return Math.max(0, 1 - dev / 15);
      }));
      pairScores.push(best);
    }
  }
  return pairScores.reduce((a, b) => a + b, 0) / pairScores.length;
}

// Combined color score
export function colorScore(items, paletteColors) {
  if (!items.length || !paletteColors.length) return 0;
  return 0.6 * paletteMatchScore(items, paletteColors) + 0.4 * interItemHarmonyScore(items);
}

// Palette affinity for a single item
export function paletteAffinity(item, paletteColors) {
  if (!item.colorProfile) return 0;
  const dominant = item.colorProfile.dominantColor;
  const minDist = Math.min(...paletteColors.map(c => hslDistance(dominant, c)));
  return Math.max(0, 1 - minDist / 0.5);
}

// --- Internal helpers ---

function loadImageElement(source) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    if (source instanceof Blob) {
      img.src = URL.createObjectURL(source);
    } else if (typeof source === 'string') {
      img.src = source;
    } else {
      resolve(source); // already an HTMLImageElement
    }
  });
}

function averageHSL(colors) {
  if (!colors.length) return { hue: 0, saturation: 0, lightness: 0.5 };
  let sinSum = 0, cosSum = 0, satSum = 0, lightSum = 0;
  for (const c of colors) {
    const rad = c.hue * Math.PI / 180;
    sinSum += Math.sin(rad);
    cosSum += Math.cos(rad);
    satSum += c.saturation;
    lightSum += c.lightness;
  }
  const n = colors.length;
  let avgHue = Math.atan2(sinSum / n, cosSum / n) * 180 / Math.PI;
  if (avgHue < 0) avgHue += 360;
  return { hue: avgHue, saturation: satSum / n, lightness: lightSum / n };
}

function kMeans(colors, k, maxIter) {
  // Init centroids evenly spaced
  let centroids = [];
  const step = Math.max(1, Math.floor(colors.length / k));
  for (let i = 0; i < k; i++) {
    centroids.push({ ...colors[Math.min(i * step, colors.length - 1)] });
  }

  let clusters = [];
  for (let iter = 0; iter < maxIter; iter++) {
    clusters = centroids.map(c => ({ centroid: c, members: [] }));

    // Assign
    for (const color of colors) {
      let minDist = Infinity, bestIdx = 0;
      for (let i = 0; i < centroids.length; i++) {
        const d = hslDistance(color, centroids[i]);
        if (d < minDist) { minDist = d; bestIdx = i; }
      }
      clusters[bestIdx].members.push(color);
    }

    // Recalculate
    const newCentroids = clusters.map(cl =>
      cl.members.length ? averageHSL(cl.members) : cl.centroid
    );

    const converged = centroids.every((c, i) => hslDistance(c, newCentroids[i]) < 0.01);
    centroids = newCentroids;
    if (converged) break;
  }

  return clusters.map((cl, i) => ({ centroid: centroids[i], members: cl.members }));
}
