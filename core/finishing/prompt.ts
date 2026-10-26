/**
 * Prompts for LTX finishing.
 *
 * Tiled passes (Refine, Restore): every spatial tile receives the WHOLE prompt.
 * A subject named in it — "a woman", "the red car" — can stamp itself into
 * every tile of a 49-tile 4K canvas (the Refine card: "a subject named in it can
 * be painted into tiles that do not contain it"; the notes of the official Upscale
 * workflow give the same advice). So the card's field is
 * called "Look" and describes only the rendering — sharpness, grain, light —
 * and a Restore look describes the period, the place, the light, the materials
 * and what people wear, with everything the model must not invent in the
 * negative (Lightricks' Restore card).
 *
 * The check is a heuristic, said as such in the card, and cheap enough to run on
 * every keystroke:
 *   1. a word list (English and Italian) of people, animals, vehicles and
 *      objects, and counting words ("two", "tre") — JustAE Flow 2's list;
 *   2. JustAE Flow: the word after a determiner (a, an, the, two, un, il…), past
 *      any rendering adjectives, must itself be a rendering term — "a boat",
 *      "the lighthouse" are caught without being in any list; "the light",
 *      "a subtle film grain" pass.
 *
 * Single-pass IC-LoRAs (Deblur, Decompression, Colorization, Clean Plate,
 * Day-To-Night) are not tiled: their cards ask for the scene to be described,
 * in a trained sentence pattern, which the templates below fill in.
 */

export const DEFAULT_PROMPTS = {
  positive: 'The same footage, sharper and more detailed: fine natural textures, crisp focus, clean edges, subtle film grain, faithful colour and light.',
  negative: 'blurry, soft focus, smeared detail, oversharpened halos, ringing, banding, blocky compression artifacts, waxy plastic texture',
  restorePositive: 'Restored archival footage, period-accurate look: natural film grain, stable exposure, clean fine detail, faithful colours of the time.',
  restoreNegative: 'modern objects, smartphones, modern vehicles, logos, brand signage, lettering, modern clothing, plastic, LED lights, digital oversharpening',
} as const;

export interface PromptIssue {
  word: string;
  category: 'person' | 'animal' | 'vehicle' | 'object' | 'count' | 'named';
}

const LISTS: Record<Exclude<PromptIssue['category'], 'count' | 'named'>, string[]> = {
  person: [
    'man', 'men', 'woman', 'women', 'girl', 'girls', 'boy', 'boys', 'child', 'children', 'kid', 'kids',
    'baby', 'person', 'actor', 'actress', 'dancer', 'singer', 'player', 'face', 'faces', 'portrait',
    'uomo', 'uomini', 'donna', 'donne', 'ragazza', 'ragazze', 'ragazzo', 'ragazzi', 'bambino', 'bambina',
    'bambini', 'bimbo', 'bimba', 'neonato', 'attore', 'attrice', 'ballerina', 'ballerino', 'cantante',
    'giocatore', 'volto', 'volti', 'viso', 'ritratto', 'signora', 'signore',
  ],
  animal: [
    'dog', 'dogs', 'cat', 'cats', 'horse', 'horses', 'bird', 'birds', 'cow', 'fish',
    'cane', 'cani', 'gatto', 'gatti', 'cavallo', 'cavalli', 'uccello', 'uccelli', 'mucca', 'pesce',
  ],
  vehicle: [
    'car', 'cars', 'bus', 'truck', 'bike', 'bicycle', 'motorcycle', 'train', 'plane', 'boat', 'ship', 'tram',
    'sailboat', 'yacht',
    'auto', 'automobile', 'macchina', 'camion', 'moto', 'motocicletta', 'bicicletta', 'treno', 'aereo',
    'barca', 'nave',
  ],
  object: [
    'phone', 'smartphone', 'laptop', 'computer', 'building', 'tower', 'tree', 'trees', 'house', 'table',
    'chair', 'sign', 'logo', 'bottle', 'cup', 'lamp', 'flower', 'flowers', 'statue', 'church',
    'telefono', 'cellulare', 'edificio', 'palazzo', 'torre', 'albero', 'alberi', 'casa', 'tavolo',
    'sedia', 'insegna', 'bottiglia', 'tazza', 'bicchiere', 'lampada', 'fiore', 'fiori', 'statua', 'chiesa',
  ],
};

/** Counting a subject is naming it: "two", "tre", "a couple of". */
const COUNTS = [
  'two', 'three', 'four', 'five', 'several', 'couple',
  'due', 'tre', 'quattro', 'cinque', 'alcuni', 'alcune', 'coppia',
];

/**
 * Words in a Restore prompt that describe what people wear or the crowd as a
 * whole are what the card asks for — they are not flagged there.
 */
const RESTORE_OK = new Set(['people', 'crowd', 'persone', 'folla', 'gente']);

/** JustAE Flow: words after which the next noun is what the text is about. */
const DETERMINERS = new Set([
  // Not "this", "that" (they also start clauses: "grain that feels natural"), not Italian "i" (English "I").
  'a', 'an', 'the', 'one', 'my', 'our', 'his', 'her', 'their', 'its',
  'un', 'uno', 'una', "un'", 'il', 'lo', 'la', 'gli', 'le', "l'", 'del', 'della', 'dei', 'delle', 'questo', 'questa',
]);

/**
 * JustAE Flow: the rendering vocabulary — what a Look may name. Light, colour, texture, lens, film, motion, quality
 * and the words of the period/place/material description a Restore look asks for. Anything after a determiner
 * that is not one of these is taken as a subject.
 */
const RENDERING = new Set([
  // the image
  'footage', 'image', 'images', 'picture', 'frame', 'frames', 'shot', 'scene', 'video', 'clip', 'look', 'style', 'render', 'rendering',
  'detail', 'details', 'texture', 'textures', 'grain', 'noise', 'sharpness', 'focus', 'edge', 'edges', 'contrast', 'exposure',
  'resolution', 'clarity', 'quality', 'definition', 'surface', 'surfaces', 'finish', 'patina',
  // light and colour
  'light', 'lighting', 'shadow', 'shadows', 'highlight', 'highlights', 'glow', 'haze', 'colour', 'color', 'colours', 'colors',
  'palette', 'tone', 'tones', 'grade', 'grading', 'saturation', 'hue', 'warmth', 'daylight', 'sunlight', 'moonlight', 'dusk', 'dawn',
  'golden', 'hour', 'night', 'day', 'morning', 'evening', 'twilight', 'atmosphere', 'mood', 'temperature', 'balance',
  // lens and film
  'lens', 'film', 'stock', 'emulsion', 'kodak', 'fuji', 'celluloid', 'bokeh', 'depth', 'field', 'aperture', 'camera', 'cinema',
  'look', 'photograph', 'photography', 'documentary', 'broadcast', 'archive', 'archival', 'newsreel', 'print', 'scan', 'transfer',
  // motion and time
  'motion', 'movement', 'blur', 'period', 'era', 'decade', 'century', 'time', 'times',
  // adjectives that often follow a determiner
  'same', 'sharp', 'sharper', 'crisp', 'fine', 'subtle', 'natural', 'soft', 'clean', 'faithful', 'rich', 'deep', 'high', 'low', 'warm',
  'cool', 'cold', 'gentle', 'stable', 'even', 'filmic', 'cinematic', 'photographic', 'detailed', 'realistic', 'photoreal', 'organic',
  'light', 'dark', 'bright', 'muted', 'vivid', 'pale', 'faded', 'neutral', 'true', 'accurate', 'original', 'fresh', 'little', 'slight',
  'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'brown', 'black', 'white', 'grey', 'gray', 'teal', 'amber',
  'whole', 'entire', 'full', 'overall', 'native', 'modern', 'vintage', 'old', 'classic', 'analog', 'analogue', 'digital',
  // Italian
  'immagine', 'immagini', 'inquadratura', 'scena', 'resa', 'dettaglio', 'dettagli', 'texture', 'grana', 'nitidezza', 'fuoco', 'bordi',
  'contrasto', 'esposizione', 'luce', 'luci', 'ombra', 'ombre', 'colore', 'colori', 'tono', 'toni', 'tavolozza', 'atmosfera',
  'pellicola', 'obiettivo', 'stessa', 'stesso', 'nitida', 'nitido', 'morbida', 'morbido', 'naturale', 'calda', 'caldo', 'fredda', 'freddo',
  'alba', 'tramonto', 'notte', 'giorno', 'sera', 'mattina', 'epoca', 'periodo', 'archivio',
]);

const WORD = /[a-zà-ÿ']+/gi;

/**
 * Subjects found in a prompt. Negatives are never checked: naming what must not appear is their job.
 * `mode`: 'refine' (a Refine look) or 'restore' (a Restore look — it may describe people as a crowd and what they wear).
 */
export function lintPrompt(text: string, mode: 'refine' | 'restore'): PromptIssue[] {
  const words = (text.toLowerCase().match(WORD) ?? []).map((w) => w.replace(/^'+|'+$/g, '')).filter(Boolean);
  const seen = new Set<string>();
  const issues: PromptIssue[] = [];
  const push = (word: string, category: PromptIssue['category']): void => {
    if (seen.has(word)) return;
    seen.add(word);
    issues.push({ word, category });
  };
  for (const w of words) {
    if (mode === 'restore' && RESTORE_OK.has(w)) continue;
    for (const [cat, list] of Object.entries(LISTS) as Array<[Exclude<PromptIssue['category'], 'count' | 'named'>, string[]]>) {
      if (list.includes(w)) push(w, cat);
    }
    if (COUNTS.includes(w)) push(w, 'count');
  }
  // Refine prompts must not describe people at all, not even as a crowd.
  if (mode === 'refine') for (const w of words) if (RESTORE_OK.has(w)) push(w, 'person');
  // JustAE Flow: what follows a determiner, past rendering adjectives, is a rendering term or a subject.
  for (let i = 0; i < words.length; i++) {
    if (!DETERMINERS.has(words[i]) && !COUNTS.includes(words[i])) continue;
    let j = i + 1;
    while (j < words.length && RENDERING.has(words[j]) && j + 1 < words.length && !DETERMINERS.has(words[j + 1]) && isAdjectiveLike(words[j])) j++;
    const w = words[j];
    if (!w || DETERMINERS.has(w) || RENDERING.has(w) || w.length < 3) continue;
    if (mode === 'restore' && RESTORE_OK.has(w)) continue;
    push(w, 'named');
  }
  return issues;
}

/** A rendering word that can stand before a noun ("subtle", "film", "golden"): the scan goes on past it. */
function isAdjectiveLike(w: string): boolean {
  return /(al|ic|ous|ive|ful|ed|er|est|ish|y|en)$/.test(w) || ['film', 'golden', 'fine', 'soft', 'sharp', 'crisp', 'clean', 'deep', 'high', 'low', 'warm', 'cool', 'cold', 'same', 'true', 'rich', 'pale', 'dark', 'light', 'bright', 'whole', 'full', 'old', 'red', 'blue', 'green', 'white', 'black', 'grey', 'gray', 'pink', 'brown', 'teal', 'amber', 'stable', 'gentle', 'subtle', 'vivid', 'muted', 'faded', 'neutral', 'native', 'modern', 'vintage', 'classic', 'analog', 'analogue', 'digital', 'organic', 'photoreal', 'natural', 'faithful', 'slight', 'little', 'fresh', 'original', 'accurate', 'cinema', 'night', 'day', 'morning', 'evening'].includes(w);
}

/** What the card says about the check, once, so it is never mistaken for a guarantee. */
export const LINT_EXPLAINED = 'A simple check: it looks for people, animals, vehicles and objects by name, and for any word after "a", "the", "two"… that is not a rendering term (sharpness, grain, light, colour…). It can miss a subject or flag a harmless word.';

/** One sentence for the card. Empty when the prompt is clean. */
export function describeIssues(issues: PromptIssue[], mode: 'refine' | 'restore'): string {
  if (!issues.length) return '';
  const list = issues.map((i) => `"${i.word}"`).join(', ');
  return mode === 'refine'
    ? `Every tile gets the whole prompt: ${list} could appear in every tile. Describe the rendering (sharpness, grain, light), not who or what is in the shot.`
    : `Every tile gets the whole prompt: ${list} could be stamped into every tile. Describe period, place, light, materials and clothing — and put what must not be invented in the negative.`;
}

/* ─── Single-pass IC-LoRAs: the trained sentence of each card ───────── */

/**
 * The prompt conventions their model cards document (read 25 Oct 2026), with the user's words where the card puts
 * the scene. Deblur and Decompression put the same scene in both halves; Colorization a grey description, then the
 * colours; Clean Plate describes the empty place; Day-To-Night the night look. Alpha Gen takes no prompt.
 */
export function singlePrompt(lora: 'deblur' | 'decompression' | 'colorize' | 'cleanplate' | 'daynight' | 'alpha', scene: string, extra = ''): { positive: string; negative: string } {
  const s = scene.trim().replace(/[.\s]+$/, '');
  const x = extra.trim().replace(/[.\s]+$/, '');
  switch (lora) {
    case 'deblur':
      return {
        positive: `Reference shows ${s}, heavily out of focus with soft defocused blur and no fine detail. Edited shows the same scene in sharp focus with crisp detail and clean edges. DEBLUR ${s}. Subject identity, framing, and background geometry are identical to the reference; only focus and sharpness differ between reference and edited.`,
        negative: 'worst quality, blurry, out of focus, defocused, soft, hazy, smeared, low detail, jittery, distorted, oversharpened, haloing, ringing',
      };
    case 'decompression':
      return {
        positive: `Reference shows ${s}, heavily compressed with visible macroblocking, chroma bleed, and ringing artifacts. Edited shows the same scene restored to high quality with sharp detail, clean edges, and no compression artifacts. ENHANCE QUALITY ${s}. Subject identity, framing, and background geometry are identical to the reference; only compression artifacts and image quality differ between reference and edited.`,
        negative: '',
      };
    case 'colorize':
      return {
        positive: `Reference shows ${s}, in grayscale. Edited shows the same scene with natural colors restored. COLORIZE ${x ? `${s}: ${x}` : s}. Subject identity, framing, and background geometry are identical to the reference; only color information differs between reference and edited.`,
        negative: '',
      };
    case 'cleanplate': {
      const gone = x ? ` No ${x.split(/\s*,\s*/).filter(Boolean).join(', no ')} anywhere in the frame.` : '';
      return {
        positive: `An empty clean plate of the exact same location: ${s}, identical background, environment, structures and lighting as the source video, with no people, no humans, no figures, and no body parts such as arms, hands or legs anywhere in the frame.${gone} Static photorealistic footage, natural light, high detail.`,
        negative: `person, people, human, figure, limb, arm, hand, leg, body part, backpack, shadow of a person, leftover people, leftover figures, ghosting, semi-transparent remnants, blurry, soft, distorted, inconsistent motion, jitter, worst quality, cartoon, video game, ugly${x ? `, ${x}` : ''}`,
      };
    }
    case 'daynight':
      return {
        positive: `${s || 'A realistic nighttime scene, photorealistic moonlight, deep natural shadows'}. Only the lighting changes from day to night; identical composition, framing, camera movement and motion.`,
        negative: 'daytime, bright sunlight, blue sky, overexposed, worst quality, inconsistent motion, blurry, jittery, distorted',
      };
    case 'alpha':
      return { positive: '', negative: '' };
  }
}
