// HSL utilities

export function hslToRgb(h, s, l) {
  h /= 360;
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
    h *= 360;
  }
  return { hue: h, saturation: s, lightness: l };
}

export function hslToCss(hsl) {
  return `hsl(${Math.round(hsl.hue)}, ${Math.round(hsl.saturation * 100)}%, ${Math.round(hsl.lightness * 100)}%)`;
}

export function hslDistance(a, b) {
  const hueDiff = Math.min(Math.abs(a.hue - b.hue), 360 - Math.abs(a.hue - b.hue)) / 180;
  const satDiff = Math.abs(a.saturation - b.saturation);
  const lightDiff = Math.abs(a.lightness - b.lightness);
  return (hueDiff * 2 + satDiff + lightDiff) / 4;
}

export function hueDistance(h1, h2) {
  const d = Math.abs(h1 - h2);
  return Math.min(d, 360 - d);
}

export function isBackground(hsl) {
  // Aggressive filter: photos are on white/cream sheets, cropped regions have gray fill
  if (hsl.lightness > 0.82 || hsl.lightness < 0.12) return true;
  if (hsl.saturation < 0.08) return true;
  // Light grays with very low saturation (sheet/background)
  if (hsl.lightness > 0.7 && hsl.saturation < 0.15) return true;
  return false;
}

export function generateId() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function scoreColor(score) {
  if (score >= 0.7) return 'score-good';
  if (score >= 0.4) return 'score-ok';
  return 'score-bad';
}

export const CATEGORIES = [
  { id: 'shirt', name: 'Shirt', icon: '👔', required: true },
  { id: 'pants', name: 'Pants', icon: '👖', required: true },
  { id: 'shoes', name: 'Shoes', icon: '👟', required: true },
  { id: 'belt', name: 'Belt', icon: '🪢', required: false },
  { id: 'jacket', name: 'Jacket', icon: '🧥', required: false },
];

export const STYLE_TAGS = ['casual', 'formal', 'business', 'sporty', 'streetwear', 'evening'];

export const HARMONY_TYPES = [
  { id: 'complementary', name: 'Complementary', offsets: [0, 180] },
  { id: 'analogous', name: 'Analogous', offsets: [0, 30, 60] },
  { id: 'triadic', name: 'Triadic', offsets: [0, 120, 240] },
  { id: 'monochromatic', name: 'Monochromatic', offsets: [0] },
];

export const HARMONY_ANGLES = [0, 30, 60, 120, 150, 180];

// Style vibes — each has a palette and preferred style tags
export const VIBES = [
  {
    id: 'business', name: 'Business', icon: '💼',
    colors: [{hue:220,saturation:0.7,lightness:0.25},{hue:0,saturation:0,lightness:0.95},{hue:0,saturation:0,lightness:0.3},{hue:30,saturation:0.4,lightness:0.35}],
    tags: ['business', 'formal'],
  },
  {
    id: 'business_casual', name: 'Business Casual', icon: '👔',
    colors: [{hue:210,saturation:0.4,lightness:0.45},{hue:40,saturation:0.35,lightness:0.55},{hue:0,saturation:0,lightness:0.9},{hue:25,saturation:0.5,lightness:0.4}],
    tags: ['business', 'casual'],
  },
  {
    id: 'daily_office', name: 'Daily Office', icon: '🏢',
    colors: [{hue:220,saturation:0.3,lightness:0.4},{hue:0,saturation:0,lightness:0.85},{hue:40,saturation:0.3,lightness:0.5},{hue:200,saturation:0.2,lightness:0.5}],
    tags: ['business', 'casual'],
  },
  {
    id: 'casual', name: 'Casual', icon: '😎',
    colors: [{hue:210,saturation:0.3,lightness:0.5},{hue:40,saturation:0.4,lightness:0.6},{hue:0,saturation:0,lightness:0.9},{hue:150,saturation:0.25,lightness:0.45}],
    tags: ['casual', 'streetwear'],
  },
  {
    id: 'beach', name: 'Beach', icon: '🏖️',
    colors: [{hue:195,saturation:0.6,lightness:0.5},{hue:45,saturation:0.5,lightness:0.65},{hue:0,saturation:0,lightness:0.95},{hue:30,saturation:0.4,lightness:0.55}],
    tags: ['casual', 'sporty'],
  },
  {
    id: 'evening', name: 'Evening Out', icon: '🍸',
    colors: [{hue:0,saturation:0,lightness:0.1},{hue:0,saturation:0,lightness:0.2},{hue:0,saturation:0.7,lightness:0.35},{hue:45,saturation:0.5,lightness:0.5}],
    tags: ['evening', 'formal'],
  },
  {
    id: 'sporty', name: 'Sporty', icon: '🏃',
    colors: [{hue:0,saturation:0,lightness:0.15},{hue:0,saturation:0,lightness:0.9},{hue:210,saturation:0.6,lightness:0.5},{hue:140,saturation:0.5,lightness:0.45}],
    tags: ['sporty', 'casual'],
  },
  {
    id: 'date_night', name: 'Date Night', icon: '❤️',
    colors: [{hue:0,saturation:0,lightness:0.12},{hue:0,saturation:0.5,lightness:0.35},{hue:30,saturation:0.4,lightness:0.4},{hue:0,saturation:0,lightness:0.85}],
    tags: ['evening', 'formal'],
  },
];
