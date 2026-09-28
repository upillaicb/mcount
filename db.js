const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = path.join(__dirname, 'mcount.db');

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS quizzes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 30,
  answer_seconds INTEGER NOT NULL DEFAULT 5,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_questions_quiz ON questions(quiz_id, position);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | published | completed
  randomized INTEGER NOT NULL DEFAULT 0,
  question_order TEXT NOT NULL DEFAULT '[]', -- JSON array of question ids in run order
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_quiz ON runs(quiz_id);

CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_participants_run ON participants(run_id);
`);

function newId(n = 4) { return crypto.randomBytes(n).toString('hex'); }
function now() { return Date.now(); }

// ---------- Quizzes ----------
function listQuizzes() {
  const rows = db.prepare(`
    SELECT q.*,
      (SELECT COUNT(*) FROM questions WHERE quiz_id = q.id) AS question_count,
      (SELECT COUNT(*) FROM runs WHERE quiz_id = q.id) AS run_count,
      (SELECT id FROM runs WHERE quiz_id = q.id AND status='published' ORDER BY published_at DESC LIMIT 1) AS active_run_id
    FROM quizzes q ORDER BY q.created_at DESC
  `).all();
  return rows.map(mapQuiz);
}

function mapQuiz(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name,
    durationSeconds: r.duration_seconds,
    answerSeconds: r.answer_seconds,
    createdAt: r.created_at,
    questionCount: r.question_count,
    runCount: r.run_count,
    activeRunId: r.active_run_id || null
  };
}

function getQuiz(id) {
  const r = db.prepare(`
    SELECT q.*,
      (SELECT COUNT(*) FROM questions WHERE quiz_id = q.id) AS question_count,
      (SELECT COUNT(*) FROM runs WHERE quiz_id = q.id) AS run_count,
      (SELECT id FROM runs WHERE quiz_id = q.id AND status='published' ORDER BY published_at DESC LIMIT 1) AS active_run_id
    FROM quizzes q WHERE q.id=?`).get(id);
  return mapQuiz(r);
}

function createQuiz(name) {
  const id = newId();
  db.prepare(`INSERT INTO quizzes (id, name, duration_seconds, answer_seconds, created_at)
              VALUES (?, ?, 30, 5, ?)`).run(id, name || 'Untitled quiz', now());
  return getQuiz(id);
}

function renameQuiz(id, name) {
  db.prepare(`UPDATE quizzes SET name=? WHERE id=?`).run(name, id);
  return getQuiz(id);
}

function setQuizDuration(id, sec) {
  db.prepare(`UPDATE quizzes SET duration_seconds=? WHERE id=?`).run(sec, id);
  return getQuiz(id);
}
function setQuizAnswerDuration(id, sec) {
  db.prepare(`UPDATE quizzes SET answer_seconds=? WHERE id=?`).run(sec, id);
  return getQuiz(id);
}

function changeQuizSlug(id, newSlug) {
  if (db.prepare(`SELECT 1 FROM quizzes WHERE id=?`).get(newSlug)) {
    const err = new Error('slug already in use'); err.code = 'DUP'; throw err;
  }
  db.transaction(() => {
    db.prepare(`UPDATE quizzes SET id=? WHERE id=?`).run(newSlug, id);
  })();
  return getQuiz(newSlug);
}

function deleteQuiz(id) {
  db.prepare(`DELETE FROM quizzes WHERE id=?`).run(id);
}

// ---------- Questions ----------
function listQuestions(quizId) {
  return db.prepare(`SELECT id, text, answer FROM questions WHERE quiz_id=? ORDER BY position`).all(quizId);
}

function addQuestion(quizId, text, answer) {
  const max = db.prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM questions WHERE quiz_id=?`).get(quizId).m;
  const info = db.prepare(`INSERT INTO questions (quiz_id, position, text, answer) VALUES (?, ?, ?, ?)`)
    .run(quizId, max + 1, text, answer || '');
  return db.prepare(`SELECT id, text, answer FROM questions WHERE id=?`).get(info.lastInsertRowid);
}

function deleteQuestionByPosition(quizId, position) {
  const rows = db.prepare(`SELECT id FROM questions WHERE quiz_id=? ORDER BY position`).all(quizId);
  if (position < 0 || position >= rows.length) return;
  db.prepare(`DELETE FROM questions WHERE id=?`).run(rows[position].id);
  const remaining = db.prepare(`SELECT id FROM questions WHERE quiz_id=? ORDER BY position`).all(quizId);
  const upd = db.prepare(`UPDATE questions SET position=? WHERE id=?`);
  db.transaction(() => { remaining.forEach((r, i) => upd.run(i, r.id)); })();
}

function clearQuestions(quizId) {
  db.prepare(`DELETE FROM questions WHERE quiz_id=?`).run(quizId);
}

function replaceQuestions(quizId, items) {
  db.transaction(() => {
    db.prepare(`DELETE FROM questions WHERE quiz_id=?`).run(quizId);
    const ins = db.prepare(`INSERT INTO questions (quiz_id, position, text, answer) VALUES (?, ?, ?, ?)`);
    items.forEach((it, i) => ins.run(quizId, i, it.text, it.answer || ''));
  })();
}

// ---------- Runs ----------
function mapRun(r) {
  if (!r) return null;
  return {
    id: r.id, quizId: r.quiz_id, name: r.name, status: r.status,
    randomized: !!r.randomized,
    questionOrder: JSON.parse(r.question_order || '[]'),
    createdAt: r.created_at,
    publishedAt: r.published_at,
    completedAt: r.completed_at
  };
}

function listRuns(quizId) {
  const rows = db.prepare(`SELECT * FROM runs WHERE quiz_id=? ORDER BY created_at DESC`).all(quizId);
  return rows.map(r => {
    const run = mapRun(r);
    run.participantCount = db.prepare(`SELECT COUNT(*) AS c FROM participants WHERE run_id=?`).get(run.id).c;
    const top = db.prepare(`SELECT MAX(score) AS m FROM participants WHERE run_id=?`).get(run.id).m;
    run.topScore = top;
    return run;
  });
}

function getRun(runId) {
  const r = db.prepare(`SELECT * FROM runs WHERE id=?`).get(runId);
  return mapRun(r);
}

function createRun(quizId, name, randomized) {
  const quiz = getQuiz(quizId);
  if (!quiz) return null;
  const qs = db.prepare(`SELECT id FROM questions WHERE quiz_id=? ORDER BY position`).all(quizId).map(x => x.id);
  const order = randomized ? shuffle(qs.slice()) : qs;
  const id = newId();
  db.prepare(`INSERT INTO runs (id, quiz_id, name, status, randomized, question_order, created_at)
              VALUES (?, ?, ?, 'draft', ?, ?, ?)`)
    .run(id, quizId, name || `Run ${new Date().toLocaleString()}`, randomized ? 1 : 0, JSON.stringify(order), now());
  return getRun(id);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function renameRun(runId, name) {
  db.prepare(`UPDATE runs SET name=? WHERE id=?`).run(name, runId);
  return getRun(runId);
}

function reshuffleRun(runId) {
  const run = getRun(runId);
  if (!run) return null;
  const qs = db.prepare(`SELECT id FROM questions WHERE quiz_id=? ORDER BY position`).all(run.quizId).map(x => x.id);
  const order = shuffle(qs.slice());
  db.prepare(`UPDATE runs SET randomized=1, question_order=? WHERE id=?`).run(JSON.stringify(order), runId);
  return getRun(runId);
}

function resetRunOrder(runId) {
  const run = getRun(runId);
  if (!run) return null;
  const qs = db.prepare(`SELECT id FROM questions WHERE quiz_id=? ORDER BY position`).all(run.quizId).map(x => x.id);
  db.prepare(`UPDATE runs SET randomized=0, question_order=? WHERE id=?`).run(JSON.stringify(qs), runId);
  return getRun(runId);
}

function publishRun(runId) {
  const run = getRun(runId);
  if (!run) return null;
  db.transaction(() => {
    // Only one published run per quiz.
    db.prepare(`UPDATE runs SET status='draft' WHERE quiz_id=? AND status='published' AND id<>?`).run(run.quizId, runId);
    db.prepare(`UPDATE runs SET status='published', published_at=?, completed_at=NULL WHERE id=?`).run(now(), runId);
  })();
  return getRun(runId);
}

function unpublishRun(runId) {
  db.prepare(`UPDATE runs SET status='draft' WHERE id=?`).run(runId);
  return getRun(runId);
}

function completeRun(runId) {
  db.prepare(`UPDATE runs SET status='completed', completed_at=? WHERE id=?`).run(now(), runId);
  return getRun(runId);
}

function deleteRun(runId) {
  db.prepare(`DELETE FROM runs WHERE id=?`).run(runId);
}

function getActiveRunForQuiz(quizId) {
  const r = db.prepare(`SELECT * FROM runs WHERE quiz_id=? AND status='published' ORDER BY published_at DESC LIMIT 1`).get(quizId);
  return mapRun(r);
}

// Expands questionOrder ids to full question objects for the participant view.
function getRunQuestions(run) {
  if (!run.questionOrder.length) return [];
  const placeholders = run.questionOrder.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, text, answer FROM questions WHERE id IN (${placeholders})`).all(...run.questionOrder);
  const byId = new Map(rows.map(r => [r.id, r]));
  return run.questionOrder.map(id => byId.get(id)).filter(Boolean).map(({ text, answer }) => ({ text, answer }));
}

// ---------- Participants ----------
function listParticipants(runId) {
  return db.prepare(`SELECT id, name, score FROM participants WHERE run_id=? ORDER BY score DESC, created_at ASC`).all(runId);
}

function addParticipant(runId, name) {
  const id = newId();
  db.prepare(`INSERT INTO participants (id, run_id, name, score, created_at) VALUES (?, ?, ?, 0, ?)`)
    .run(id, runId, name, now());
  return db.prepare(`SELECT id, name, score FROM participants WHERE id=?`).get(id);
}

function deleteParticipant(pid) {
  db.prepare(`DELETE FROM participants WHERE id=?`).run(pid);
}

function scoreParticipant(pid, delta) {
  db.prepare(`UPDATE participants SET score = score + ? WHERE id=?`).run(delta, pid);
  return db.prepare(`SELECT id, name, score FROM participants WHERE id=?`).get(pid);
}

function resetRunScores(runId) {
  db.prepare(`UPDATE participants SET score=0 WHERE run_id=?`).run(runId);
}

// ---------- Migration from legacy data.json ----------
function migrateFromJsonIfPresent() {
  const jsonFile = path.join(__dirname, 'data.json');
  if (!fs.existsSync(jsonFile)) return;
  const already = db.prepare(`SELECT COUNT(*) AS c FROM quizzes`).get().c;
  if (already > 0) return;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(jsonFile, 'utf8')); } catch (e) { return; }
  const quizzes = raw.quizzes || {};
  const t = now();
  db.transaction(() => {
    for (const q of Object.values(quizzes)) {
      db.prepare(`INSERT OR IGNORE INTO quizzes (id, name, duration_seconds, answer_seconds, created_at)
                  VALUES (?, ?, ?, ?, ?)`)
        .run(q.id, q.name || 'Untitled', q.durationSeconds || 30, q.answerSeconds || 5, t);
      (q.questions || []).forEach((qq, i) => {
        db.prepare(`INSERT INTO questions (quiz_id, position, text, answer) VALUES (?, ?, ?, ?)`)
          .run(q.id, i, qq.text || '', qq.answer || '');
      });
      // Create an initial run and carry over participants + published state.
      const runId = newId();
      const order = db.prepare(`SELECT id FROM questions WHERE quiz_id=? ORDER BY position`).all(q.id).map(r => r.id);
      const status = q.published ? 'published' : 'draft';
      db.prepare(`INSERT INTO runs (id, quiz_id, name, status, randomized, question_order, created_at, published_at)
                  VALUES (?, ?, 'Run 1', ?, 0, ?, ?, ?)`)
        .run(runId, q.id, status, JSON.stringify(order), t, q.published ? t : null);
      (q.participants || []).forEach(p => {
        db.prepare(`INSERT INTO participants (id, run_id, name, score, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run(p.id || newId(), runId, p.name || 'Unknown', p.score || 0, t);
      });
    }
  })();
  // Keep data.json as backup; rename so we don't migrate twice.
  try { fs.renameSync(jsonFile, jsonFile + '.migrated'); } catch (e) {}
}

migrateFromJsonIfPresent();

module.exports = {
  db, newId,
  listQuizzes, getQuiz, createQuiz, renameQuiz, setQuizDuration, setQuizAnswerDuration,
  changeQuizSlug, deleteQuiz,
  listQuestions, addQuestion, deleteQuestionByPosition, clearQuestions, replaceQuestions,
  listRuns, getRun, createRun, renameRun, reshuffleRun, resetRunOrder,
  publishRun, unpublishRun, completeRun, deleteRun,
  getActiveRunForQuiz, getRunQuestions,
  listParticipants, addParticipant, deleteParticipant, scoreParticipant, resetRunScores
};
