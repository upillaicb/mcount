// dictionaryapi.dev client and helpers for building flashcards.
// Data is from Wiktionary (CC BY-SA); the student view shows attribution.

const API = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const MAX_WORDS = 300;
const MAX_SYNONYMS = 5;

// Splits an uploaded list on newlines, commas, semicolons, or tabs. Dedupes case-insensitively.
function parseWordList(text) {
  const seen = new Set();
  const words = [];
  const invalid = [];
  for (const raw of String(text || '').split(/[\n\r,;\t]+/)) {
    const word = raw.trim().replace(/\s+/g, ' ');
    if (!word) continue;
    if (!/^\p{L}[\p{L}\p{M}'’ -]{0,47}$/u.test(word)) { invalid.push(word); continue; }
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word);
  }
  if (words.length > MAX_WORDS) throw new Error(`at most ${MAX_WORDS} words per upload`);
  return { words, invalid };
}

// Returns { status, response }. 200 and 404 are cacheable; anything else throws.
async function fetchEntry(word, { timeoutMs = 5000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(API + encodeURIComponent(word.toLowerCase()), {
      headers: { Accept: 'application/json' }, signal: controller.signal
    });
    if (res.status === 404) return { status: 404, response: null };
    if (!res.ok) throw new Error(`dictionary lookup failed (${res.status})`);
    return { status: 200, response: await res.json() };
  } finally {
    clearTimeout(timer);
  }
}

// Uses the cache ({ get(word), set(word, status, response) }) unless force is set.
async function lookup(word, cache, { force = false, fetchImpl } = {}) {
  const key = word.toLowerCase();
  if (!force) {
    const hit = await cache.get(key);
    if (hit) return hit;
  }
  const fresh = await fetchEntry(key, { fetchImpl });
  await cache.set(key, fresh.status, fresh.response);
  return fresh;
}

function accentOf(url) {
  const m = /-(us|uk|au|ca|nz|ie|in|sco)\.mp3$/i.exec(url);
  return m ? m[1].toUpperCase() : 'Audio';
}

function httpsUrl(url) {
  if (!url) return null;
  if (url.startsWith('//')) url = 'https:' + url;
  return /^https:\/\//.test(url) ? url : null;
}

// Flattens the API's entries[] into { phonetic, audio[], meanings[] } for the picker.
function normalize(response) {
  const entries = Array.isArray(response) ? response : [];
  let phonetic = null;
  const audio = [];
  const seenAudio = new Set();
  const meanings = [];
  for (const entry of entries) {
    if (!phonetic && entry.phonetic) phonetic = entry.phonetic;
    for (const p of entry.phonetics || []) {
      if (!phonetic && p.text) phonetic = p.text;
      const url = httpsUrl(p.audio);
      if (url && !seenAudio.has(url)) {
        seenAudio.add(url);
        audio.push({ url, text: p.text || null, accent: accentOf(url) });
      }
    }
    for (const m of entry.meanings || []) {
      const shared = m.synonyms || [];
      meanings.push({
        partOfSpeech: m.partOfSpeech || 'other',
        definitions: (m.definitions || []).filter(d => d.definition).map(d => ({
          definition: d.definition,
          example: d.example || '',
          synonyms: [...new Set([...(d.synonyms || []), ...shared])].slice(0, MAX_SYNONYMS)
        }))
      });
    }
  }
  return { phonetic, audio, meanings: meanings.filter(m => m.definitions.length) };
}

function preferredAudio(audio) {
  const us = audio.find(a => a.accent === 'US');
  return (us || audio[0] || {}).url || null;
}

// First definition of the first meaning, so a fresh deck can be previewed right away.
function defaultSelection(normalized) {
  const m = normalized.meanings[0];
  const d = m && m.definitions[0];
  const senses = d ? [{ partOfSpeech: m.partOfSpeech, ...d, custom: false, source: d.definition }] : [];
  return { phonetic: normalized.phonetic, audioUrl: preferredAudio(normalized.audio), senses };
}

// Validates admin-submitted senses. Throws with a message on bad input.
function cleanSenses(senses, maxSenses) {
  if (!Array.isArray(senses)) throw new Error('senses must be a list');
  if (senses.length > maxSenses) throw new Error(`at most ${maxSenses} meanings per card`);
  const text = (v, max, field) => {
    const s = String(v ?? '').trim();
    if (s.length > max) throw new Error(`${field} is too long (max ${max} characters)`);
    return s;
  };
  return senses.map(s => {
    const definition = text(s.definition, 500, 'definition');
    if (!definition) throw new Error('definition is required');
    return {
      partOfSpeech: text(s.partOfSpeech, 30, 'part of speech') || 'other',
      definition,
      example: text(s.example, 300, 'example'),
      synonyms: (Array.isArray(s.synonyms) ? s.synonyms : []).slice(0, MAX_SYNONYMS).map(x => text(x, 40, 'synonym')).filter(Boolean),
      custom: !!s.custom,
      // Original dictionary definition, so the admin picker can match a reworded meaning.
      source: s.source ? text(s.source, 1000, 'source') : null
    };
  });
}

module.exports = { parseWordList, fetchEntry, lookup, normalize, defaultSelection, cleanSenses, httpsUrl };
