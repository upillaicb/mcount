const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5555;
const DATA_FILE = path.join(__dirname, 'data.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin123';
const ANSWER_SECONDS = 5;

app.use(express.json({ limit: '2mb' }));
app.use('/api/admin/quizzes/:id/upload', express.text({ type: '*/*', limit: '2mb' }));

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return { quizzes: {} }; }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }
function newId() { return crypto.randomBytes(4).toString('hex'); }

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function withQuiz(req, res, mutate) {
  const d = loadData();
  const q = d.quizzes[req.params.id];
  if (!q) return res.status(404).json({ error: 'quiz not found' });
  const result = mutate(q, d);
  if (result === false) return;
  saveData(d);
  res.json(q);
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
app.get('/api/current/:id', (req, res) => {
  const d = loadData();
  const q = d.quizzes[req.params.id];
  if (!q) return res.status(404).json({ error: 'not found' });
  const participants = (q.participants || []).slice().sort((a, b) => b.score - a.score);
  res.json({
    id: q.id,
    name: q.name,
    published: q.published,
    durationSeconds: q.durationSeconds,
    answerSeconds: q.answerSeconds || ANSWER_SECONDS,
    questions: q.published ? q.questions : [],
    participants
  });
});

// ---------- Admin ----------
app.get('/api/admin/quizzes', requireAdmin, (req, res) => {
  const d = loadData();
  const list = Object.values(d.quizzes).map(q => ({
    id: q.id, name: q.name, questionCount: q.questions.length,
    published: q.published, durationSeconds: q.durationSeconds
  }));
  res.json(list);
});

app.post('/api/admin/quizzes', requireAdmin, (req, res) => {
  const name = (req.body.name || '').trim() || 'Untitled quiz';
  const d = loadData();
  const id = newId();
  d.quizzes[id] = {
    id, name, durationSeconds: 30, answerSeconds: ANSWER_SECONDS,
    published: false, questions: [], participants: []
  };
  saveData(d);
  res.json(d.quizzes[id]);
});

app.get('/api/admin/quizzes/:id', requireAdmin, (req, res) => {
  const d = loadData();
  const q = d.quizzes[req.params.id];
  if (!q) return res.status(404).json({ error: 'not found' });
  res.json(q);
});

app.delete('/api/admin/quizzes/:id', requireAdmin, (req, res) => {
  const d = loadData();
  if (!d.quizzes[req.params.id]) return res.status(404).json({ error: 'not found' });
  delete d.quizzes[req.params.id];
  saveData(d);
  res.json({ ok: true });
});

app.post('/api/admin/quizzes/:id/rename', requireAdmin, (req, res) => {
  withQuiz(req, res, q => { q.name = (req.body.name || '').trim() || q.name; });
});

app.post('/api/admin/quizzes/:id/duration', requireAdmin, (req, res) => {
  withQuiz(req, res, q => {
    const n = parseInt(req.body.durationSeconds, 10);
    q.durationSeconds = Number.isFinite(n) && n > 0 ? n : q.durationSeconds;
  });
});

app.post('/api/admin/quizzes/:id/questions', requireAdmin, (req, res) => {
  withQuiz(req, res, q => {
    const { text, answer } = req.body;
    if (!text || !text.trim()) { res.status(400).json({ error: 'text required' }); return false; }
    q.questions.push({ text: text.trim(), answer: (answer || '').trim() });
  });
});

app.delete('/api/admin/quizzes/:id/questions/:i', requireAdmin, (req, res) => {
  withQuiz(req, res, q => {
    const i = parseInt(req.params.i, 10);
    if (i >= 0 && i < q.questions.length) q.questions.splice(i, 1);
  });
});

app.post('/api/admin/quizzes/:id/clear', requireAdmin, (req, res) => {
  withQuiz(req, res, q => { q.questions = []; });
});

app.post('/api/admin/quizzes/:id/publish', requireAdmin, (req, res) => {
  withQuiz(req, res, q => { q.published = true; });
});

app.post('/api/admin/quizzes/:id/unpublish', requireAdmin, (req, res) => {
  withQuiz(req, res, q => { q.published = false; });
});

app.post('/api/admin/quizzes/:id/participants', requireAdmin, (req, res) => {
  withQuiz(req, res, q => {
    const name = (req.body.name || '').trim();
    if (!name) { res.status(400).json({ error: 'name required' }); return false; }
    q.participants = q.participants || [];
    q.participants.push({ id: newId(), name, score: 0 });
  });
});

app.delete('/api/admin/quizzes/:id/participants/:pid', requireAdmin, (req, res) => {
  withQuiz(req, res, q => {
    q.participants = (q.participants || []).filter(p => p.id !== req.params.pid);
  });
});

app.post('/api/admin/quizzes/:id/participants/:pid/score', requireAdmin, (req, res) => {
  withQuiz(req, res, q => {
    const delta = parseInt(req.body.delta, 10);
    if (!Number.isFinite(delta)) { res.status(400).json({ error: 'delta required' }); return false; }
    const p = (q.participants || []).find(p => p.id === req.params.pid);
    if (!p) { res.status(404).json({ error: 'participant not found' }); return false; }
    p.score += delta;
  });
});

app.post('/api/admin/quizzes/:id/participants/reset', requireAdmin, (req, res) => {
  withQuiz(req, res, q => {
    (q.participants || []).forEach(p => { p.score = 0; });
  });
});

app.post('/api/admin/quizzes/:id/upload', requireAdmin, (req, res) => {
  try {
    const items = parseUpload(req.body);
    withQuiz(req, res, q => { q.questions = items; });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Static + routing ----------
app.get('/q/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'quiz.html')));
app.get('/', (req, res) => res.redirect('/admin.html'));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MCount running at http://localhost:${PORT}`);
  console.log(`Admin console: http://localhost:${PORT}/admin.html (token: ${ADMIN_TOKEN})`);
});
