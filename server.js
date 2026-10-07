const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const dictionary = require('./dictionary');

const app = express();
const PORT = process.env.PORT || 5555;
const DEFAULT_ADMIN_TOKEN = 'admin123';
// The local default is never used on Vercel; a public deployment must set ADMIN_TOKEN.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || (process.env.VERCEL ? null : DEFAULT_ADMIN_TOKEN);
if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN must be set');

// Log slow API requests so delays can be traced to the server, the database, or the dictionary.
app.use('/api', (req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    if (ms > 1500) console.warn(`slow request: ${req.method} ${req.originalUrl} -> ${res.statusCode} in ${ms}ms`);
  });
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use('/api/admin/quizzes/:id/upload', express.text({ type: '*/*', limit: '2mb' }));

function digest(s) { return crypto.createHash('sha256').update(String(s)).digest(); }
const ADMIN_DIGEST = digest(ADMIN_TOKEN);

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !crypto.timingSafeEqual(digest(token), ADMIN_DIGEST)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// Express 4 does not catch rejected promises; forward them to the error handler.
const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

function parseUpload(body) {
  body = (body || '').toString().trim();
  if (!body) throw new Error('empty file');
  let items = [];
  if (body.startsWith('[')) {
    const arr = JSON.parse(body);
    items = arr.map(x => ({ text: String(x.text || x.question || '').trim(), answer: String(x.answer || '').trim() }));
  } else if (/^\s*Q\s*[:\-]/im.test(body)) {
    let cur = null;
    for (const line of body.split(/\r?\n/)) {
      const q = line.match(/^\s*Q\s*[:\-]\s*(.*)$/i);
      const a = line.match(/^\s*A\s*[:\-]\s*(.*)$/i);
      if (q) { if (cur) items.push(cur); cur = { text: q[1].trim(), answer: '' }; }
      else if (a && cur) { cur.answer = a[1].trim(); }
    }
    if (cur) items.push(cur);
  } else {
    for (const line of body.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      const parts = s.split('|');
      if (parts.length >= 2) items.push({ text: parts[0].trim(), answer: parts.slice(1).join('|').trim() });
      else items.push({ text: s, answer: '' });
    }
  }
  items = items.filter(x => x.text);
  if (!items.length) throw new Error('no questions parsed');
  return items;
}

// ---------- Public (participant) ----------
app.get('/api/catalog', route(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await db.listCatalog());
}));

// Serves the currently active (published) run for the quiz slug.
app.get('/api/current/:slug', route(async (req, res) => {
  const [quiz, run] = await Promise.all([db.getQuiz(req.params.slug), db.getActiveRunForQuiz(req.params.slug)]);
  if (!quiz) return res.status(404).json({ error: 'quiz not found' });
  const [participants, questions] = run
    ? await Promise.all([db.listParticipants(run.id), db.getRunQuestions(run)])
    : [[], []];
  res.json({
    id: quiz.id,
    name: quiz.name,
    published: !!run && run.status === 'published',
    durationSeconds: quiz.durationSeconds,
    answerSeconds: quiz.answerSeconds,
    runId: run ? run.id : null,
    runName: run ? run.name : null,
    questions: (run && run.status === 'published') ? questions : [],
    participants
  });
}));

// ---------- Admin: Quizzes ----------
app.get('/api/admin/quizzes', requireAdmin, route(async (req, res) => res.json(await db.listQuizzes())));

app.post('/api/admin/quizzes', requireAdmin, route(async (req, res) => {
  const name = (req.body.name || '').trim() || 'Untitled quiz';
  res.json(await db.createQuiz(name));
}));

app.get('/api/admin/quizzes/:id', requireAdmin, route(async (req, res) => {
  const quiz = await db.getQuiz(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'not found' });
  [quiz.questions, quiz.runs] = await Promise.all([db.listQuestions(req.params.id), db.listRuns(req.params.id)]);
  res.json(quiz);
}));

app.delete('/api/admin/quizzes/:id', requireAdmin, route(async (req, res) => {
  await db.deleteQuiz(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/admin/quizzes/:id/rename', requireAdmin, route(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  res.json(await db.renameQuiz(req.params.id, name));
}));

app.post('/api/admin/quizzes/:id/duration', requireAdmin, route(async (req, res) => {
  const n = parseInt(req.body.durationSeconds, 10);
  if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: 'invalid duration' });
  res.json(await db.setQuizDuration(req.params.id, n));
}));

app.post('/api/admin/quizzes/:id/answer-duration', requireAdmin, route(async (req, res) => {
  const n = parseInt(req.body.answerSeconds, 10);
  if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: 'invalid duration' });
  res.json(await db.setQuizAnswerDuration(req.params.id, n));
}));

app.post('/api/admin/quizzes/:id/slug', requireAdmin, route(async (req, res) => {
  const slug = String(req.body.slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(slug)) {
    return res.status(400).json({ error: 'slug must be 2-40 chars, letters/digits/_/-, starting with letter or digit' });
  }
  try { res.json(await db.changeQuizSlug(req.params.id, slug)); }
  catch (e) {
    if (e.code === 'DUP') return res.status(409).json({ error: 'slug already in use' });
    throw e;
  }
}));

// ---------- Admin: Questions (template on quiz) ----------
app.post('/api/admin/quizzes/:id/questions', requireAdmin, route(async (req, res) => {
  const { text, answer } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
  res.json(await db.addQuestion(req.params.id, text.trim(), (answer || '').trim()));
}));

app.delete('/api/admin/quizzes/:id/questions/:i', requireAdmin, route(async (req, res) => {
  await db.deleteQuestionByPosition(req.params.id, parseInt(req.params.i, 10));
  res.json({ ok: true });
}));

app.post('/api/admin/quizzes/:id/clear', requireAdmin, route(async (req, res) => {
  await db.clearQuestions(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/admin/quizzes/:id/upload', requireAdmin, route(async (req, res) => {
  let items;
  try { items = parseUpload(req.body); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  await db.replaceQuestions(req.params.id, items);
  res.json({ ok: true, count: items.length });
}));

// ---------- Admin: Runs ----------
app.get('/api/admin/quizzes/:id/runs', requireAdmin, route(async (req, res) => {
  res.json(await db.listRuns(req.params.id));
}));

app.post('/api/admin/quizzes/:id/runs', requireAdmin, route(async (req, res) => {
  const { name, randomized } = req.body;
  const run = await db.createRun(req.params.id, (name || '').trim(), !!randomized);
  if (!run) return res.status(404).json({ error: 'quiz not found' });
  res.json(run);
}));

app.get('/api/admin/runs/:rid', requireAdmin, route(async (req, res) => {
  const run = await db.getRun(req.params.rid);
  if (!run) return res.status(404).json({ error: 'not found' });
  [run.quiz, run.participants, run.questions] = await Promise.all([
    db.getQuiz(run.quizId), db.listParticipants(run.id), db.getRunQuestions(run)
  ]);
  res.json(run);
}));

app.post('/api/admin/runs/:rid/rename', requireAdmin, route(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  res.json(await db.renameRun(req.params.rid, name));
}));

app.post('/api/admin/runs/:rid/reshuffle', requireAdmin, route(async (req, res) => {
  const r = await db.reshuffleRun(req.params.rid);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r);
}));

app.post('/api/admin/runs/:rid/reset-order', requireAdmin, route(async (req, res) => {
  const r = await db.resetRunOrder(req.params.rid);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r);
}));

app.post('/api/admin/runs/:rid/publish', requireAdmin, route(async (req, res) => res.json(await db.publishRun(req.params.rid))));
app.post('/api/admin/runs/:rid/unpublish', requireAdmin, route(async (req, res) => res.json(await db.unpublishRun(req.params.rid))));
app.post('/api/admin/runs/:rid/complete', requireAdmin, route(async (req, res) => res.json(await db.completeRun(req.params.rid))));

app.delete('/api/admin/runs/:rid', requireAdmin, route(async (req, res) => {
  await db.deleteRun(req.params.rid);
  res.json({ ok: true });
}));

// ---------- Admin: Participants (per run) ----------
app.get('/api/admin/runs/:rid/participants', requireAdmin, route(async (req, res) => {
  res.json(await db.listParticipants(req.params.rid));
}));

app.post('/api/admin/runs/:rid/participants', requireAdmin, route(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  res.json(await db.addParticipant(req.params.rid, name));
}));

app.delete('/api/admin/runs/:rid/participants/:pid', requireAdmin, route(async (req, res) => {
  await db.deleteParticipant(req.params.pid);
  res.json({ ok: true });
}));

app.post('/api/admin/runs/:rid/participants/:pid/score', requireAdmin, route(async (req, res) => {
  const delta = parseInt(req.body.delta, 10);
  if (!Number.isFinite(delta)) return res.status(400).json({ error: 'delta required' });
  res.json(await db.scoreParticipant(req.params.pid, delta));
}));

app.post('/api/admin/runs/:rid/participants/reset', requireAdmin, route(async (req, res) => {
  await db.resetRunScores(req.params.rid);
  res.json({ ok: true });
}));

// ---------- Public: Flashcard decks ----------
// Published decks only change on publish, so the CDN may cache them briefly.
const PUBLIC_CACHE = 'public, max-age=0, s-maxage=30, stale-while-revalidate=60';

app.get('/api/flashcards', route(async (req, res) => {
  res.set('Cache-Control', PUBLIC_CACHE);
  res.json(await db.listPublishedDecks());
}));

app.get('/api/flashcards/:id', route(async (req, res) => {
  const deck = await db.getPublishedDeck(req.params.id);
  if (!deck) return res.status(404).json({ error: 'deck not found' });
  res.set('Cache-Control', PUBLIC_CACHE);
  res.json(deck);
}));

// Stored pronunciation recordings. Content for an id never changes, so it is cached for a year.
// Supports byte ranges, which Safari requires before it will play audio.
app.param('aid', (req, res, next, aid) => /^\d{1,15}$/.test(aid) ? next() : res.status(404).end());

app.get('/api/audio/:aid', route(async (req, res) => {
  const file = await db.getAudio(req.params.aid);
  if (!file) return res.status(404).end();
  const total = file.data.length;
  res.set({ 'Content-Type': file.contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable' });
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    const start = m[1] ? parseInt(m[1], 10) : Math.max(0, total - parseInt(m[2], 10));
    const end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
    if (start >= total || start > end) return res.status(416).set('Content-Range', `bytes */${total}`).end();
    res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 });
    return res.end(req.method === 'HEAD' ? undefined : file.data.subarray(start, end + 1));
  }
  res.set('Content-Length', total);
  res.end(req.method === 'HEAD' ? undefined : file.data);
}));

// ---------- Admin: Flashcard decks ----------
// Words are looked up one at a time (the free API throttles bursts), and each request
// stops starting new words after LOOKUP_BUDGET_MS so it stays well inside serverless limits.
const LOOKUP_BATCH = 10;
const LOOKUP_BUDGET_MS = 20000;
const dictionaryCache = { get: w => db.getDictionaryCache(w), set: (w, s, r) => db.setDictionaryCache(w, s, r) };

// Looks a word up and stores the default selection. Never throws; failures mark the word 'error'.
async function lookupDeckWord(deckId, row, force) {
  const started = Date.now();
  try {
    const result = await dictionary.lookup(row.word, dictionaryCache, { force });
    console.log(`lookup "${row.word}": ${result.status} in ${Date.now() - started}ms`);
    if (result.status === 404) {
      await db.setWordLookup(deckId, row.id, { lookupStatus: 'not_found', senses: [] });
    } else {
      const pick = dictionary.defaultSelection(dictionary.normalize(result.response));
      await db.setWordLookup(deckId, row.id, { lookupStatus: pick.senses.length ? 'ready' : 'not_found', ...pick });
    }
  } catch (e) {
    console.error(`lookup failed for "${row.word}":`, e.message);
    await db.setWordLookup(deckId, row.id, { lookupStatus: 'error', senses: [], lookupError: e.message });
  }
}

// Downloads the word's chosen recording into the database (reusing a stored copy of the
// same source). Never throws; failures are saved so the admin can see them and retry.
async function saveWordAudio(deckId, row) {
  const started = Date.now();
  try {
    let audioId = await db.getAudioIdByUrl(row.audio_url);
    if (!audioId) {
      const file = await dictionary.fetchAudio(row.audio_url);
      audioId = await db.saveAudio(row.audio_url, file.contentType, file.data);
      console.log(`recording "${row.word}": ${file.data.length} bytes in ${Date.now() - started}ms`);
    }
    await db.setWordAudio(deckId, row.id, row.audio_url, { audioId });
  } catch (e) {
    console.error(`recording failed for "${row.word}":`, e.message);
    await db.setWordAudio(deckId, row.id, row.audio_url, { audioError: e.message });
  }
}

app.param('wid', (req, res, next, wid) => /^\d{1,15}$/.test(wid) ? next() : res.status(404).json({ error: 'not found' }));

function parseSlug(raw) {
  const slug = String(raw || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{1,39}$/.test(slug) ? slug : null;
}

app.get('/api/admin/decks', requireAdmin, route(async (req, res) => res.json(await db.listDecks())));

app.post('/api/admin/decks', requireAdmin, route(async (req, res) => {
  const name = (req.body.name || '').trim() || 'Untitled deck';
  res.json(await db.createDeck(name));
}));

app.get('/api/admin/decks/:id', requireAdmin, route(async (req, res) => {
  const deck = await db.getDeck(req.params.id);
  if (!deck) return res.status(404).json({ error: 'not found' });
  deck.words = await db.listDeckWords(req.params.id);
  res.json(deck);
}));

app.delete('/api/admin/decks/:id', requireAdmin, route(async (req, res) => {
  await db.deleteDeck(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/admin/decks/:id/settings', requireAdmin, route(async (req, res) => {
  const update = {};
  if (req.body.name !== undefined) {
    update.name = String(req.body.name).trim();
    if (!update.name) return res.status(400).json({ error: 'name required' });
  }
  if (req.body.description !== undefined) update.description = String(req.body.description).trim().slice(0, 300);
  if (req.body.maxSenses !== undefined) {
    const n = parseInt(req.body.maxSenses, 10);
    if (!(n >= 1 && n <= 10)) return res.status(400).json({ error: 'meanings per card must be 1-10' });
    update.maxSenses = n;
  }
  const deck = await db.updateDeck(req.params.id, update);
  if (!deck) return res.status(404).json({ error: 'not found' });
  res.json(deck);
}));

app.post('/api/admin/decks/:id/slug', requireAdmin, route(async (req, res) => {
  const slug = parseSlug(req.body.slug);
  if (!slug) return res.status(400).json({ error: 'slug must be 2-40 chars, letters/digits/_/-, starting with letter or digit' });
  try { res.json(await db.changeDeckSlug(req.params.id, slug)); }
  catch (e) {
    if (e.code === 'DUP') return res.status(409).json({ error: 'slug already in use' });
    throw e;
  }
}));

app.post('/api/admin/decks/:id/words', requireAdmin, route(async (req, res) => {
  if (!(await db.getDeck(req.params.id))) return res.status(404).json({ error: 'not found' });
  let parsed;
  try { parsed = dictionary.parseWordList(req.body.text); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  if (!parsed.words.length) return res.status(400).json({ error: 'no valid words found' });
  const result = await db.addDeckWords(req.params.id, parsed.words, !!req.body.replace);
  res.json({ ...result, invalid: parsed.invalid });
}));

// Background work for a deck: dictionary lookups first, then saving recordings.
// The admin page calls this until remaining is 0.
app.post('/api/admin/decks/:id/lookup', requireAdmin, route(async (req, res) => {
  const started = Date.now();
  const outOfTime = () => Date.now() - started > LOOKUP_BUDGET_MS;
  let processed = 0;
  for (const row of await db.pendingDeckWords(req.params.id, LOOKUP_BATCH)) {
    if (processed && outOfTime()) break;
    await lookupDeckWord(req.params.id, row, false);
    processed++;
  }
  if (!outOfTime()) {
    for (const row of await db.pendingAudioWords(req.params.id, LOOKUP_BATCH)) {
      if (processed && outOfTime()) break;
      await saveWordAudio(req.params.id, row);
      processed++;
    }
  }
  const deck = await db.getDeck(req.params.id);
  res.json({ processed, remaining: deck ? deck.pendingCount + deck.pendingAudioCount : 0 });
}));

app.post('/api/admin/decks/:id/retry-failed', requireAdmin, route(async (req, res) => {
  res.json({ retried: await db.retryFailedWords(req.params.id) });
}));

// A word plus every dictionary meaning, for the admin's picker.
app.get('/api/admin/decks/:id/words/:wid', requireAdmin, route(async (req, res) => {
  const [deck, word] = await Promise.all([db.getDeck(req.params.id), db.getDeckWord(req.params.id, req.params.wid)]);
  if (!deck || !word) return res.status(404).json({ error: 'not found' });
  const cached = await db.getDictionaryCache(word.word.toLowerCase());
  word.dictionary = cached && cached.status === 200 ? dictionary.normalize(cached.response) : null;
  word.maxSenses = deck.maxSenses;
  res.json(word);
}));

app.put('/api/admin/decks/:id/words/:wid', requireAdmin, route(async (req, res) => {
  const deck = await db.getDeck(req.params.id);
  if (!deck || !(await db.getDeckWord(req.params.id, req.params.wid))) return res.status(404).json({ error: 'not found' });
  let senses;
  try { senses = dictionary.cleanSenses(req.body.senses, deck.maxSenses); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const phonetic = String(req.body.phonetic || '').trim().slice(0, 60) || null;
  const requested = dictionary.httpsUrl(String(req.body.audioUrl || '').trim());
  const audioUrl = requested && dictionary.isAllowedAudioUrl(requested) ? requested : null;
  const word = await db.updateDeckWord(req.params.id, req.params.wid, { senses, phonetic, audioUrl });
  // Save a newly chosen recording now so the picker and preview can play it straight away.
  if (word.audioUrl && !word.audioId && !word.audioError) {
    await saveWordAudio(req.params.id, { id: word.id, word: word.word, audio_url: word.audioUrl });
    return res.json(await db.getDeckWord(req.params.id, req.params.wid));
  }
  res.json(word);
}));

app.post('/api/admin/decks/:id/words/:wid/relookup', requireAdmin, route(async (req, res) => {
  const word = await db.getDeckWord(req.params.id, req.params.wid);
  if (!word) return res.status(404).json({ error: 'not found' });
  await lookupDeckWord(req.params.id, word, true);
  const fresh = await db.getDeckWord(req.params.id, req.params.wid);
  if (fresh.audioUrl && !fresh.audioId && !fresh.audioError) {
    await saveWordAudio(req.params.id, { id: fresh.id, word: fresh.word, audio_url: fresh.audioUrl });
    return res.json(await db.getDeckWord(req.params.id, req.params.wid));
  }
  res.json(fresh);
}));

app.delete('/api/admin/decks/:id/words/:wid', requireAdmin, route(async (req, res) => {
  await db.deleteDeckWord(req.params.id, req.params.wid);
  res.json({ ok: true });
}));

// Draft cards in the same shape as /api/flashcards/:id, for the student-view preview.
app.get('/api/admin/decks/:id/preview', requireAdmin, route(async (req, res) => {
  const draft = await db.draftDeckCards(req.params.id);
  if (!draft) return res.status(404).json({ error: 'not found' });
  res.set('Cache-Control', 'no-store');
  res.json({ id: draft.deck.id, name: draft.deck.name, description: draft.deck.description, preview: true, problems: draft.problems, cards: draft.cards });
}));

app.post('/api/admin/decks/:id/publish', requireAdmin, route(async (req, res) => {
  try {
    const deck = await db.publishDeck(req.params.id);
    if (!deck) return res.status(404).json({ error: 'not found' });
    res.json(deck);
  } catch (e) {
    if (e.code === 'INVALID') return res.status(409).json({ error: e.message, problems: e.problems });
    throw e;
  }
}));

app.post('/api/admin/decks/:id/unpublish', requireAdmin, route(async (req, res) => res.json(await db.unpublishDeck(req.params.id))));

// ---------- Static + routing ----------
// On Vercel, public/ is served by the CDN and vercel.json handles /q/:slug and /.
app.get('/app/vendor/lucide.js', (req, res) => res.sendFile(require.resolve('lucide/dist/umd/lucide.js')));
app.get('/q/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'quiz.html')));
app.get('/', (req, res) => res.redirect('/admin.html'));
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`MCount running at http://localhost:${PORT}`);
    const shown = ADMIN_TOKEN === DEFAULT_ADMIN_TOKEN ? ` (token: ${DEFAULT_ADMIN_TOKEN})` : '';
    console.log(`Admin console: http://localhost:${PORT}/admin.html${shown}`);
  });
}
