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

function lookupError(message, retryable) {
  const err = new Error(message);
  err.retryable = retryable;
  return err;
}

// Returns { status, response }. 200 and 404 are cacheable; anything else throws an
// error with an admin-readable message and a retryable flag.
async function fetchEntry(word, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(API + encodeURIComponent(word.toLowerCase()), {
        headers: { Accept: 'application/json' }, signal: controller.signal
      });
    } catch (e) {
      if (e.name === 'AbortError') throw lookupError(`Dictionary did not respond within ${timeoutMs / 1000}s`, true);
      const cause = e.cause && (e.cause.code || e.cause.message);
      throw lookupError('Could not reach the dictionary' + (cause ? ` (${cause})` : ''), true);
    }
    if (res.status === 404) return { status: 404, response: null };
    if (res.status === 429) throw lookupError('Dictionary is busy (429 rate limited)', true);
    if (!res.ok) throw lookupError(`Dictionary error (${res.status})`, res.status >= 500);
    try {
      return { status: 200, response: await res.json() };
    } catch (e) {
      throw lookupError(e.name === 'AbortError' ? `Dictionary did not respond within ${timeoutMs / 1000}s` : 'Dictionary sent an unreadable response', true);
    }
  } finally {
    clearTimeout(timer);
  }
}

// Recordings are only downloaded from the dictionary's own hosts.
const AUDIO_HOSTS = ['api.dictionaryapi.dev', 'ssl.gstatic.com'];
const MAX_AUDIO_BYTES = 1024 * 1024;

function isAllowedAudioUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && AUDIO_HOSTS.includes(u.hostname);
  } catch (e) {
    return false;
  }
}

// Downloads a recording. Returns { contentType, data: Buffer }.
async function fetchAudio(url, { timeoutMs = 20000, fetchImpl = fetch } = {}) {
  if (!isAllowedAudioUrl(url)) throw lookupError('Recording is not from the dictionary site', false);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw lookupError(`Recording download failed (${res.status})`, res.status === 429 || res.status >= 500);
    let contentType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('audio/')) {
      if (/\.mp3$/i.test(new URL(url).pathname)) contentType = 'audio/mpeg';
      else throw lookupError('Recording is not an audio file', false);
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (!data.length) throw lookupError('Recording is empty', false);
    if (data.length > MAX_AUDIO_BYTES) throw lookupError('Recording is too large', false);
    return { contentType, data };
  } catch (e) {
    if (e.name === 'AbortError') throw lookupError(`Recording did not download within ${timeoutMs / 1000}s`, true);
    if (e.retryable !== undefined) throw e;
    const cause = e.cause && (e.cause.code || e.cause.message);
    throw lookupError('Could not download the recording' + (cause ? ` (${cause})` : ''), true);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Uses the cache ({ get(word), set(word, status, response) }) unless force is set.
// Retries slow or rate-limited requests; the free API is often both.
async function lookup(word, cache, { force = false, fetchImpl, retryDelays = [1000, 3000] } = {}) {
  const key = word.toLowerCase();
  if (!force) {
    const hit = await cache.get(key);
    if (hit) return hit;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const fresh = await fetchEntry(key, { fetchImpl });
      await cache.set(key, fresh.status, fresh.response);
      return fresh;
    } catch (e) {
      if (!e.retryable || attempt >= retryDelays.length) throw e;
      await sleep(retryDelays[attempt]);
    }
  }
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

module.exports = {
  parseWordList, fetchEntry, lookup, normalize, defaultSelection, cleanSenses, httpsUrl,
  isAllowedAudioUrl, fetchAudio
};
