export async function analyzeOutfitPhoto(imageBlob, apiKey) {
  if (!apiKey) throw new Error('OpenAI API key not set. Go to Settings to configure it.');

  const base64 = await blobToBase64(imageBlob);

  const prompt = `You are a fashion AI. Analyze this photo carefully and identify EVERY visible clothing item or accessory worn by the person.

You MUST look for ALL of these categories and include each one you can see:
- "shirt" — any top: t-shirt, button-down, polo, blouse, sweater, hoodie, tank top, etc.
- "pants" — any bottoms: jeans, trousers, shorts, chinos, sweatpants, skirt, etc.
- "shoes" — any footwear: sneakers, boots, sandals, dress shoes, heels, etc.
- "jacket" — any outerwear: blazer, coat, hoodie over a shirt, cardigan, vest, etc.
- "belt" — any belt visible at the waist

IMPORTANT RULES:
- You MUST return ALL visible items, not just one. Most outfit photos have at least 2-3 items.
- If a person is wearing a shirt AND pants, return BOTH as separate entries.
- If shoes are visible, include them too.
- Provide accurate bounding boxes so each item can be cropped individually.
- The boundingBox must tightly fit the specific garment, NOT the whole person.

For each item provide:
- category: one of "shirt" (for t-shirts, polo shirts, knit tops), "button_down" (for button-down/dress shirts with collar and buttons), "pants", "shoes", "belt", "jacket"
- description: DETAILED description including: exact color (be very specific — e.g. "charcoal" not just "gray", "burgundy" not just "red"), material/fabric (cotton, wool, linen, suede, leather, denim, polyester, knit, etc.), texture (ribbed, smooth, woven, matte, glossy), fit (slim, relaxed, straight-leg, oversized), and any unique features (buttons, zipper, collar style, pattern, stitching, buckle type)
- boundingBox: normalized coordinates (0-1) as {x, y, width, height} — this MUST tightly crop just this garment

Respond ONLY with a JSON array, no other text.

Example for a full outfit:
[
  {"category":"shirt","description":"light blue Oxford cotton button-down shirt with spread collar and chest pocket, slim fit","boundingBox":{"x":0.15,"y":0.1,"width":0.7,"height":0.3}},
  {"category":"pants","description":"charcoal gray wool flat-front dress trousers with pressed crease, straight-leg fit","boundingBox":{"x":0.2,"y":0.4,"width":0.6,"height":0.35}},
  {"category":"shoes","description":"tan suede double monk strap shoes with brass buckles and leather sole","boundingBox":{"x":0.2,"y":0.78,"width":0.6,"height":0.18}}
]`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
        ],
      }],
      max_tokens: 1500,
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  const content = json.choices?.[0]?.message?.content || '';

  // Extract JSON array
  const match = content.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('AI did not return a valid JSON array');

  const garments = JSON.parse(match[0]);

  // Validate and normalize
  const validCategories = ['shirt', 'button_down', 'pants', 'shoes', 'belt', 'jacket'];
  return garments.filter(g => {
    if (!g.category || !validCategories.includes(g.category)) return false;
    if (!g.boundingBox) return false;
    // Clamp bounding box values
    const b = g.boundingBox;
    b.x = Math.max(0, Math.min(1, b.x || 0));
    b.y = Math.max(0, Math.min(1, b.y || 0));
    b.width = Math.max(0.05, Math.min(1 - b.x, b.width || 0.5));
    b.height = Math.max(0.05, Math.min(1 - b.y, b.height || 0.3));
    return true;
  });
}

// itemDescriptions can be strings OR objects { name, color } for better accuracy
export async function generateOutfitImage(itemDescriptions, apiKey) {
  if (!apiKey) throw new Error('OpenAI API key not set.');

  const itemList = itemDescriptions.map(d => {
    if (typeof d === 'object' && d.color) {
      return `${d.name} (exact color: hsl ${Math.round(d.color.hue)}°, ${Math.round(d.color.saturation * 100)}% saturation, ${Math.round(d.color.lightness * 100)}% lightness)`;
    }
    return typeof d === 'object' ? d.name : d;
  }).join('; ');

  // Extract shoe description if present for emphasis
  const shoeDesc = itemDescriptions.find(d => {
    const name = (typeof d === 'object' ? d.name : d).toLowerCase();
    return name.includes('shoe') || name.includes('sneaker') || name.includes('boot') || name.includes('loafer') || name.includes('oxford') || name.includes('derby');
  });
  const shoeEmphasis = shoeDesc ? `His feet are wearing: ${typeof shoeDesc === 'object' ? shoeDesc.name : shoeDesc}. The shoes are resting flat on the gray floor and are sharply in focus.` : '';

  const prompt = `A fashion catalog photograph shot in a professional studio. The scene: a polished light gray concrete floor stretches across the bottom of the frame. Standing on this floor is a tall, lean man in his late 40s, dark brown wavy hair, short salt-and-pepper stubble, olive/Mediterranean skin, angular jawline, rectangular brown-frame glasses. The camera is positioned 4 meters away at knee height, tilted slightly upward, capturing his ENTIRE body from the floor beneath his shoes to above his head. The composition has 15% empty floor visible below his feet and 10% empty space above his head. He is wearing EXACTLY: ${itemList}. ${shoeEmphasis} The man stands in a relaxed pose with weight evenly distributed. Studio lighting from above-left creates clean shadows. Sharp detail on every fabric texture and material. The image is framed like a full-length mirror reflection showing every item from head to toe. No text, no watermarks, no cropping.`;

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size: '1024x1792',
      quality: 'standard',
      response_format: 'b64_json',
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`DALL-E API error ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error('No image data returned from DALL-E');

  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
