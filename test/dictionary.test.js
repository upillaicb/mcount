const assert = require('node:assert/strict');
const { test } = require('node:test');
const dictionary = require('../dictionary');

// Shape of https://api.dictionaryapi.dev/api/v2/entries/en/bank (trimmed): two homograph entries.
const BANK = [
  {
    word: 'bank',
    phonetic: '/bæŋk/',
    phonetics: [
      { text: '/bæŋk/', audio: '' },
      { text: '/bæŋk/', audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/bank-uk.mp3' },
      { text: '/bæŋk/', audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/bank-us.mp3' }
    ],
    meanings: [
      {
        partOfSpeech: 'noun',
        definitions: [
          { definition: 'An institution where one can place and borrow money.', example: 'I went to the bank to deposit my check.', synonyms: ['lender'], antonyms: [] },
          { definition: 'A building of such an institution.', synonyms: [], antonyms: [] }
        ],
        synonyms: ['depository'], antonyms: []
      },
      {
        partOfSpeech: 'verb',
        definitions: [{ definition: 'To deposit in a bank.', example: 'I banked the check this morning.', synonyms: [], antonyms: [] }],
        synonyms: [], antonyms: []
      }
    ]
  },
  {
    word: 'bank',
    phonetics: [{ audio: '//ssl.gstatic.com/dictionary/static/sounds/bank-au.mp3' }],
    meanings: [
      { partOfSpeech: 'noun', definitions: [{ definition: 'The edge of a river, lake, or other watercourse.', synonyms: [], antonyms: [] }, { definition: '' }], synonyms: [], antonyms: [] },
      { partOfSpeech: 'adjective', definitions: [], synonyms: [], antonyms: [] }
    ]
  }
];

test('parseWordList splits, trims, dedupes, and rejects non-words', () => {
  const { words, invalid } = dictionary.parseWordList('curious\n  Enormous ,whisper;curious\r\nice cream\tWHISPER\n123\nhttp://x\n\n');
  assert.deepEqual(words, ['curious', 'Enormous', 'whisper', 'ice cream']);
  assert.deepEqual(invalid, ['123', 'http://x']);
  assert.throws(() => dictionary.parseWordList(Array.from({ length: 301 }, (_, i) => 'w' + 'a'.repeat(i % 40) + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26))).join('\n')), /at most 300/);
});

test('normalize flattens entries, keeps every meaning, and collects https audio', () => {
  const n = dictionary.normalize(BANK);
  assert.equal(n.phonetic, '/bæŋk/');
  assert.deepEqual(n.audio.map(a => a.accent), ['UK', 'US', 'AU']);
  assert.ok(n.audio.every(a => a.url.startsWith('https://')));
  assert.deepEqual(n.meanings.map(m => m.partOfSpeech), ['noun', 'verb', 'noun']);
  assert.equal(n.meanings[0].definitions.length, 2);
  assert.deepEqual(n.meanings[0].definitions[0].synonyms, ['lender', 'depository']);
  assert.equal(n.meanings[0].definitions[1].example, '');
  assert.equal(n.meanings[2].definitions.length, 1, 'empty definitions are dropped');
  assert.deepEqual(dictionary.normalize(null), { phonetic: null, audio: [], meanings: [] });
});

test('defaultSelection picks the first meaning and prefers US audio', () => {
  const pick = dictionary.defaultSelection(dictionary.normalize(BANK));
  assert.equal(pick.audioUrl, 'https://api.dictionaryapi.dev/media/pronunciations/en/bank-us.mp3');
  assert.equal(pick.senses.length, 1);
  assert.equal(pick.senses[0].partOfSpeech, 'noun');
  assert.equal(pick.senses[0].source, pick.senses[0].definition);
  assert.deepEqual(dictionary.defaultSelection(dictionary.normalize([])).senses, []);
});

test('cleanSenses enforces the per-deck limit and field sizes', () => {
  const sense = { partOfSpeech: 'noun', definition: '  A place for money. ', example: 'x', synonyms: ['a', '', 'b'], custom: true, extra: 'dropped' };
  const [clean] = dictionary.cleanSenses([sense], 3);
  assert.deepEqual(clean, { partOfSpeech: 'noun', definition: 'A place for money.', example: 'x', synonyms: ['a', 'b'], custom: true, source: null });
  assert.throws(() => dictionary.cleanSenses([sense, sense], 1), /at most 1/);
  assert.throws(() => dictionary.cleanSenses([{ definition: ' ' }], 3), /required/);
  assert.throws(() => dictionary.cleanSenses([{ definition: 'x'.repeat(501) }], 3), /too long/);
  assert.throws(() => dictionary.cleanSenses('nope', 3), /list/);
  assert.equal(dictionary.cleanSenses([{ definition: 'd' }], 3)[0].partOfSpeech, 'other');
});

test('lookup uses the cache, caches 404s, and does not cache server errors', async () => {
  const store = new Map();
  const cache = { get: async w => store.get(w) || null, set: async (w, status, response) => { store.set(w, { status, response }); } };
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.endsWith('/bank')) return { ok: true, status: 200, json: async () => BANK };
    if (url.endsWith('/qwzx')) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: false, status: 429, json: async () => ({}) };
  };
  assert.equal((await dictionary.lookup('Bank', cache, { fetchImpl })).status, 200);
  assert.equal((await dictionary.lookup('bank', cache, { fetchImpl })).status, 200);
  assert.equal(calls.length, 1, 'second lookup is served from cache');
  await dictionary.lookup('bank', cache, { fetchImpl, force: true });
  assert.equal(calls.length, 2, 'force bypasses the cache');
  assert.deepEqual(await dictionary.lookup('qwzx', cache, { fetchImpl }), { status: 404, response: null });
  assert.equal(store.get('qwzx').status, 404);
  const before = calls.length;
  await assert.rejects(dictionary.lookup('busy', cache, { fetchImpl, retryDelays: [0, 0] }), /busy \(429/);
  assert.equal(calls.length - before, 3, 'rate-limited lookups are retried twice');
  assert.equal(store.has('busy'), false);
  assert.ok(calls[0].endsWith('/entries/en/bank'));
});

test('lookup retries transient failures and reports why it failed', async () => {
  const store = new Map();
  const cache = { get: async w => store.get(w) || null, set: async (w, status, response) => { store.set(w, { status, response }); } };
  let attempts = 0;
  const flaky = async () => (++attempts === 1 ? { ok: false, status: 429 } : { ok: true, status: 200, json: async () => BANK });
  assert.equal((await dictionary.lookup('giggle', cache, { fetchImpl: flaky, retryDelays: [0, 0] })).status, 200);
  assert.equal(attempts, 2);

  const offline = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; };
  await assert.rejects(dictionary.lookup('offline', cache, { fetchImpl: offline, retryDelays: [0] }), /Could not reach the dictionary \(ENOTFOUND\)/);

  const hang = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  await assert.rejects(dictionary.fetchEntry('slow', { fetchImpl: hang, timeoutMs: 20 }), /did not respond within 0.02s/);

  let serverErrors = 0;
  const broken = async () => { serverErrors++; return { ok: false, status: 400 }; };
  await assert.rejects(dictionary.lookup('bad', cache, { fetchImpl: broken, retryDelays: [0, 0] }), /Dictionary error \(400\)/);
  assert.equal(serverErrors, 1, 'non-transient errors are not retried');
});

test('httpsUrl only accepts https and protocol-relative URLs', () => {
  assert.equal(dictionary.httpsUrl('//a.b/c.mp3'), 'https://a.b/c.mp3');
  assert.equal(dictionary.httpsUrl('http://a.b/c.mp3'), null);
  assert.equal(dictionary.httpsUrl('javascript:alert(1)'), null);
  assert.equal(dictionary.httpsUrl(''), null);
});
