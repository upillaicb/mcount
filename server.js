const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 5555;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin123';

app.use(express.json({ limit: '2mb' }));
app.use('/api/admin/quizzes/:id/upload', express.text({ type: '*/*', limit: '2mb' }));

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

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
// Serves the currently active (published) run for the quiz slug.
app.get('/api/current/:slug', (req, res) => {
  const quiz = db.getQuiz(req.params.slug);
  if (!quiz) return res.status(404).json({ error: 'quiz not found' });
  const run = db.getActiveRunForQuiz(quiz.id);
  const participants = run ? db.listParticipants(run.id) : [];
  const questions = run ? db.getRunQuestions(run) : [];
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
});

// ---------- Admin: Quizzes ----------
app.get('/api/admin/quizzes', requireAdmin, (req, res) => res.json(db.listQuizzes()));

app.post('/api/admin/quizzes', requireAdmin, (req, res) => {
  const name = (req.body.name || '').trim() || 'Untitled quiz';
  res.json(db.createQuiz(name));
});

app.get('/api/admin/quizzes/:id', requireAdmin, (req, res) => {
  const quiz = db.getQuiz(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'not found' });
  quiz.questions = db.listQuestions(req.params.id);
  quiz.runs = db.listRuns(req.params.id);
  res.json(quiz);
});

app.delete('/api/admin/quizzes/:id', requireAdmin, (req, res) => {
  db.deleteQuiz(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/quizzes/:id/rename', requireAdmin, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  res.json(db.renameQuiz(req.params.id, name));
});

app.post('/api/admin/quizzes/:id/duration', requireAdmin, (req, res) => {
  const n = parseInt(req.body.durationSeconds, 10);
  if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: 'invalid duration' });
  res.json(db.setQuizDuration(req.params.id, n));
});

app.post('/api/admin/quizzes/:id/answer-duration', requireAdmin, (req, res) => {
  const n = parseInt(req.body.answerSeconds, 10);
  if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: 'invalid duration' });
  res.json(db.setQuizAnswerDuration(req.params.id, n));
});

app.post('/api/admin/quizzes/:id/slug', requireAdmin, (req, res) => {
  const slug = String(req.body.slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(slug)) {
    return res.status(400).json({ error: 'slug must be 2-40 chars, letters/digits/_/-, starting with letter or digit' });
  }
  try { res.json(db.changeQuizSlug(req.params.id, slug)); }
  catch (e) {
    if (e.code === 'DUP') return res.status(409).json({ error: 'slug already in use' });
    res.status(500).json({ error: e.message });
  }
});

// ---------- Admin: Questions (template on quiz) ----------
app.post('/api/admin/quizzes/:id/questions', requireAdmin, (req, res) => {
  const { text, answer } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
  res.json(db.addQuestion(req.params.id, text.trim(), (answer || '').trim()));
});

app.delete('/api/admin/quizzes/:id/questions/:i', requireAdmin, (req, res) => {
  db.deleteQuestionByPosition(req.params.id, parseInt(req.params.i, 10));
  res.json({ ok: true });
});

app.post('/api/admin/quizzes/:id/clear', requireAdmin, (req, res) => {
  db.clearQuestions(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/quizzes/:id/upload', requireAdmin, (req, res) => {
  try {
    const items = parseUpload(req.body);
    db.replaceQuestions(req.params.id, items);
    res.json({ ok: true, count: items.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Admin: Runs ----------
app.get('/api/admin/quizzes/:id/runs', requireAdmin, (req, res) => {
  res.json(db.listRuns(req.params.id));
});

app.post('/api/admin/quizzes/:id/runs', requireAdmin, (req, res) => {
  const { name, randomized } = req.body;
  const run = db.createRun(req.params.id, (name || '').trim(), !!randomized);
  if (!run) return res.status(404).json({ error: 'quiz not found' });
  res.json(run);
});

app.get('/api/admin/runs/:rid', requireAdmin, (req, res) => {
  const run = db.getRun(req.params.rid);
  if (!run) return res.status(404).json({ error: 'not found' });
  const quiz = db.getQuiz(run.quizId);
  run.quiz = quiz;
  run.participants = db.listParticipants(run.id);
  run.questions = db.getRunQuestions(run);
  res.json(run);
});

app.post('/api/admin/runs/:rid/rename', requireAdmin, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  res.json(db.renameRun(req.params.rid, name));
});

app.post('/api/admin/runs/:rid/reshuffle', requireAdmin, (req, res) => {
  const r = db.reshuffleRun(req.params.rid);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r);
});

app.post('/api/admin/runs/:rid/reset-order', requireAdmin, (req, res) => {
  const r = db.resetRunOrder(req.params.rid);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r);
});

app.post('/api/admin/runs/:rid/publish', requireAdmin, (req, res) => res.json(db.publishRun(req.params.rid)));
app.post('/api/admin/runs/:rid/unpublish', requireAdmin, (req, res) => res.json(db.unpublishRun(req.params.rid)));
app.post('/api/admin/runs/:rid/complete', requireAdmin, (req, res) => res.json(db.completeRun(req.params.rid)));

app.delete('/api/admin/runs/:rid', requireAdmin, (req, res) => {
  db.deleteRun(req.params.rid);
  res.json({ ok: true });
});

// ---------- Admin: Participants (per run) ----------
app.get('/api/admin/runs/:rid/participants', requireAdmin, (req, res) => {
  res.json(db.listParticipants(req.params.rid));
});

app.post('/api/admin/runs/:rid/participants', requireAdmin, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  res.json(db.addParticipant(req.params.rid, name));
});

app.delete('/api/admin/runs/:rid/participants/:pid', requireAdmin, (req, res) => {
  db.deleteParticipant(req.params.pid);
  res.json({ ok: true });
});

app.post('/api/admin/runs/:rid/participants/:pid/score', requireAdmin, (req, res) => {
  const delta = parseInt(req.body.delta, 10);
  if (!Number.isFinite(delta)) return res.status(400).json({ error: 'delta required' });
  res.json(db.scoreParticipant(req.params.pid, delta));
});

app.post('/api/admin/runs/:rid/participants/reset', requireAdmin, (req, res) => {
  db.resetRunScores(req.params.rid);
  res.json({ ok: true });
});

// ---------- Static + routing ----------
app.get('/q/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'quiz.html')));
app.get('/', (req, res) => res.redirect('/admin.html'));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MCount running at http://localhost:${PORT}`);
  console.log(`Admin console: http://localhost:${PORT}/admin.html (token: ${ADMIN_TOKEN})`);
});
