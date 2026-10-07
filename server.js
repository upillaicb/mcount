const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 5555;
const DEFAULT_ADMIN_TOKEN = 'admin123';
// The local default is never used on Vercel; a public deployment must set ADMIN_TOKEN.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || (process.env.VERCEL ? null : DEFAULT_ADMIN_TOKEN);
if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN must be set');

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
