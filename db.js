const postgres = require('postgres');
const crypto = require('crypto');

// Local Supabase default (npx supabase start). Hosted deployments must set DATABASE_URL.
const LOCAL_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const DATABASE_URL = process.env.DATABASE_URL || (process.env.VERCEL ? null : LOCAL_DATABASE_URL);
if (!DATABASE_URL) throw new Error('DATABASE_URL must be set');

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);

const sql = postgres(DATABASE_URL, {
  // Supabase's transaction pooler (port 6543) does not support prepared statements.
  prepare: false,
  // Serverless instances each hold their own pool; keep it small.
  max: process.env.VERCEL ? 1 : 10,
  idle_timeout: 20,
  ssl: isLocal ? false : 'require',
  // COUNT(*) and bigint columns (ids, epoch ms) fit safely in a JS number.
  types: {
    bigint: { to: 20, from: [20], serialize: x => String(x), parse: x => Number(x) }
  }
});

function newId(n = 4) { return crypto.randomBytes(n).toString('hex'); }
function now() { return Date.now(); }

// ---------- Quizzes ----------
function selectQuizzes(where) {
  return sql`
    SELECT q.*,
      (SELECT COUNT(*) FROM questions WHERE quiz_id = q.id) AS question_count,
      (SELECT COUNT(*) FROM runs WHERE quiz_id = q.id) AS run_count,
      (SELECT id FROM runs WHERE quiz_id = q.id AND status='published' ORDER BY published_at DESC LIMIT 1) AS active_run_id
    FROM quizzes q ${where} ORDER BY q.created_at DESC`;
}

async function listQuizzes() {
  return (await selectQuizzes(sql``)).map(mapQuiz);
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

async function getQuiz(id) {
  const [r] = await selectQuizzes(sql`WHERE q.id = ${id}`);
  return mapQuiz(r);
}

async function createQuiz(name) {
  const id = newId();
  await sql`INSERT INTO quizzes (id, name, duration_seconds, answer_seconds, created_at)
            VALUES (${id}, ${name || 'Untitled quiz'}, 30, 5, ${now()})`;
  return getQuiz(id);
}

async function renameQuiz(id, name) {
  await sql`UPDATE quizzes SET name=${name} WHERE id=${id}`;
  return getQuiz(id);
}

async function setQuizDuration(id, sec) {
  await sql`UPDATE quizzes SET duration_seconds=${sec} WHERE id=${id}`;
  return getQuiz(id);
}
async function setQuizAnswerDuration(id, sec) {
  await sql`UPDATE quizzes SET answer_seconds=${sec} WHERE id=${id}`;
  return getQuiz(id);
}

// questions.quiz_id and runs.quiz_id cascade on update.
async function changeQuizSlug(id, newSlug) {
  const dup = () => { const err = new Error('slug already in use'); err.code = 'DUP'; return err; };
  const [exists] = await sql`SELECT 1 FROM quizzes WHERE id=${newSlug}`;
  if (exists) throw dup();
  try {
    await sql`UPDATE quizzes SET id=${newSlug} WHERE id=${id}`;
  } catch (e) {
    if (e.code === '23505') throw dup();
    throw e;
  }
  return getQuiz(newSlug);
}

async function deleteQuiz(id) {
  await sql`DELETE FROM quizzes WHERE id=${id}`;
}

// ---------- Questions ----------
function listQuestions(quizId) {
  return sql`SELECT id, text, answer FROM questions WHERE quiz_id=${quizId} ORDER BY position`;
}

async function addQuestion(quizId, text, answer) {
  const [row] = await sql`
    INSERT INTO questions (quiz_id, position, text, answer)
    VALUES (${quizId}, (SELECT COALESCE(MAX(position), -1) + 1 FROM questions WHERE quiz_id=${quizId}), ${text}, ${answer || ''})
    RETURNING id, text, answer`;
  return row;
}

async function deleteQuestionByPosition(quizId, position) {
  await sql.begin(async tx => {
    const rows = await tx`SELECT id FROM questions WHERE quiz_id=${quizId} ORDER BY position`;
    if (!(position >= 0 && position < rows.length)) return;
    await tx`DELETE FROM questions WHERE id=${rows[position].id}`;
    await tx`
      UPDATE questions q SET position = r.rn - 1
      FROM (SELECT id, row_number() OVER (ORDER BY position) AS rn FROM questions WHERE quiz_id=${quizId}) r
      WHERE q.id = r.id`;
  });
}

async function clearQuestions(quizId) {
  await sql`DELETE FROM questions WHERE quiz_id=${quizId}`;
}

async function replaceQuestions(quizId, items) {
  const rows = items.map((it, i) => ({ quiz_id: quizId, position: i, text: it.text, answer: it.answer || '' }));
  await sql.begin(async tx => {
    await tx`DELETE FROM questions WHERE quiz_id=${quizId}`;
    if (rows.length) await tx`INSERT INTO questions ${tx(rows, 'quiz_id', 'position', 'text', 'answer')}`;
  });
}

async function questionIds(quizId) {
  return (await sql`SELECT id FROM questions WHERE quiz_id=${quizId} ORDER BY position`).map(x => x.id);
}

// ---------- Runs ----------
function mapRun(r) {
  if (!r) return null;
  return {
    id: r.id, quizId: r.quiz_id, name: r.name, status: r.status,
    randomized: !!r.randomized,
    questionOrder: r.question_order || [],
    createdAt: r.created_at,
    publishedAt: r.published_at,
    completedAt: r.completed_at
  };
}

async function listRuns(quizId) {
  const rows = await sql`
    SELECT r.*, COUNT(p.id) AS participant_count, MAX(p.score) AS top_score
    FROM runs r LEFT JOIN participants p ON p.run_id = r.id
    WHERE r.quiz_id=${quizId}
    GROUP BY r.id ORDER BY r.created_at DESC`;
  return rows.map(r => Object.assign(mapRun(r), { participantCount: r.participant_count, topScore: r.top_score }));
}

async function getRun(runId) {
  const [r] = await sql`SELECT * FROM runs WHERE id=${runId}`;
  return mapRun(r);
}

async function createRun(quizId, name, randomized) {
  const quiz = await getQuiz(quizId);
  if (!quiz) return null;
  const qs = await questionIds(quizId);
  const order = randomized ? shuffle(qs.slice()) : qs;
  const id = newId();
  await sql`INSERT INTO runs (id, quiz_id, name, status, randomized, question_order, created_at)
            VALUES (${id}, ${quizId}, ${name || `Run ${new Date().toLocaleString()}`}, 'draft', ${!!randomized}, ${sql.json(order)}, ${now()})`;
  return getRun(id);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function renameRun(runId, name) {
  await sql`UPDATE runs SET name=${name} WHERE id=${runId}`;
  return getRun(runId);
}

async function reshuffleRun(runId) {
  const run = await getRun(runId);
  if (!run) return null;
  const order = shuffle(await questionIds(run.quizId));
  await sql`UPDATE runs SET randomized=true, question_order=${sql.json(order)} WHERE id=${runId}`;
  return getRun(runId);
}

async function resetRunOrder(runId) {
  const run = await getRun(runId);
  if (!run) return null;
  const qs = await questionIds(run.quizId);
  await sql`UPDATE runs SET randomized=false, question_order=${sql.json(qs)} WHERE id=${runId}`;
  return getRun(runId);
}

async function publishRun(runId) {
  const run = await getRun(runId);
  if (!run) return null;
  await sql.begin(async tx => {
    // Only one published run per quiz (also enforced by idx_runs_one_published).
    await tx`UPDATE runs SET status='draft' WHERE quiz_id=${run.quizId} AND status='published' AND id<>${runId}`;
    await tx`UPDATE runs SET status='published', published_at=${now()}, completed_at=NULL WHERE id=${runId}`;
  });
  return getRun(runId);
}

async function unpublishRun(runId) {
  await sql`UPDATE runs SET status='draft' WHERE id=${runId}`;
  return getRun(runId);
}

async function completeRun(runId) {
  await sql`UPDATE runs SET status='completed', completed_at=${now()} WHERE id=${runId}`;
  return getRun(runId);
}

async function deleteRun(runId) {
  await sql`DELETE FROM runs WHERE id=${runId}`;
}

async function getActiveRunForQuiz(quizId) {
  const [r] = await sql`SELECT * FROM runs WHERE quiz_id=${quizId} AND status='published' ORDER BY published_at DESC LIMIT 1`;
  return mapRun(r);
}

// Expands questionOrder ids to full question objects for the participant view.
async function getRunQuestions(run) {
  if (!run.questionOrder.length) return [];
  const rows = await sql`SELECT id, text, answer FROM questions WHERE id IN ${sql(run.questionOrder)}`;
  const byId = new Map(rows.map(r => [r.id, r]));
  return run.questionOrder.map(id => byId.get(id)).filter(Boolean).map(({ text, answer }) => ({ text, answer }));
}

// Published runs for the client library, in one query.
async function listCatalog() {
  const rows = await sql`
    SELECT q.id, q.name, q.duration_seconds, q.answer_seconds, r.id AS run_id, r.name AS run_name,
      (SELECT COUNT(*) FROM questions qq
        WHERE qq.id IN (SELECT jsonb_array_elements_text(r.question_order)::bigint)) AS question_count
    FROM quizzes q
    JOIN LATERAL (
      SELECT * FROM runs WHERE quiz_id = q.id AND status='published' ORDER BY published_at DESC LIMIT 1
    ) r ON true
    ORDER BY q.created_at DESC`;
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    runId: r.run_id,
    runName: r.run_name,
    questionCount: r.question_count,
    durationSeconds: r.duration_seconds,
    answerSeconds: r.answer_seconds
  }));
}

// ---------- Participants ----------
function listParticipants(runId) {
  return sql`SELECT id, name, score FROM participants WHERE run_id=${runId} ORDER BY score DESC, created_at ASC`;
}

async function addParticipant(runId, name) {
  const [row] = await sql`
    INSERT INTO participants (id, run_id, name, score, created_at)
    VALUES (${newId()}, ${runId}, ${name}, 0, ${now()})
    RETURNING id, name, score`;
  return row;
}

async function deleteParticipant(pid) {
  await sql`DELETE FROM participants WHERE id=${pid}`;
}

async function scoreParticipant(pid, delta) {
  const [row] = await sql`UPDATE participants SET score = score + ${delta} WHERE id=${pid} RETURNING id, name, score`;
  return row;
}

async function resetRunScores(runId) {
  await sql`UPDATE participants SET score=0 WHERE run_id=${runId}`;
}

// ---------- Flashcard decks ----------
function mapDeck(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, description: r.description,
    maxSenses: r.max_senses,
    status: r.status,
    createdAt: r.created_at, updatedAt: r.updated_at, publishedAt: r.published_at,
    // A published deck whose draft was edited after publishing.
    hasUnpublishedChanges: r.status === 'published' && r.updated_at > r.published_at,
    publishedCardCount: Array.isArray(r.published_cards) ? r.published_cards.length : 0,
    wordCount: r.word_count
  };
}

function selectDecks(where) {
  return sql`
    SELECT d.*, (SELECT COUNT(*) FROM deck_words WHERE deck_id = d.id) AS word_count
    FROM decks d ${where} ORDER BY d.created_at DESC`;
}

async function listDecks() {
  return (await selectDecks(sql``)).map(mapDeck);
}

async function getDeck(id) {
  const [r] = await selectDecks(sql`WHERE d.id = ${id}`);
  return mapDeck(r);
}

async function createDeck(name) {
  const id = newId();
  const t = now();
  await sql`INSERT INTO decks (id, name, created_at, updated_at) VALUES (${id}, ${name || 'Untitled deck'}, ${t}, ${t})`;
  return getDeck(id);
}

async function updateDeck(id, { name, description, maxSenses }) {
  await sql`
    UPDATE decks SET
      name = COALESCE(${name ?? null}, name),
      description = COALESCE(${description ?? null}, description),
      max_senses = COALESCE(${maxSenses ?? null}::int, max_senses)
    WHERE id = ${id}`;
  return getDeck(id);
}

// deck_words.deck_id cascades on update.
async function changeDeckSlug(id, newSlug) {
  const dup = () => { const err = new Error('slug already in use'); err.code = 'DUP'; return err; };
  const [exists] = await sql`SELECT 1 FROM decks WHERE id=${newSlug}`;
  if (exists) throw dup();
  try {
    await sql`UPDATE decks SET id=${newSlug} WHERE id=${id}`;
  } catch (e) {
    if (e.code === '23505') throw dup();
    throw e;
  }
  return getDeck(newSlug);
}

async function deleteDeck(id) {
  await sql`DELETE FROM decks WHERE id=${id}`;
}

function touchDeck(tx, deckId) {
  return tx`UPDATE decks SET updated_at=${now()} WHERE id=${deckId}`;
}

function renumberDeckWords(tx, deckId) {
  return tx`
    UPDATE deck_words w SET position = r.rn - 1
    FROM (SELECT id, row_number() OVER (ORDER BY position) AS rn FROM deck_words WHERE deck_id=${deckId}) r
    WHERE w.id = r.id`;
}

function mapWord(r) {
  return { id: r.id, word: r.word, position: r.position, senses: r.senses || [] };
}

async function listDeckWords(deckId) {
  return (await sql`SELECT * FROM deck_words WHERE deck_id=${deckId} ORDER BY position`).map(mapWord);
}

async function getDeckWord(deckId, wordId) {
  const [r] = await sql`SELECT * FROM deck_words WHERE deck_id=${deckId} AND id=${wordId}`;
  return r ? mapWord(r) : null;
}

// Adds [{ word, senses }]. Existing words (case-insensitive) are skipped unless replace is set.
async function addDeckWords(deckId, entries, replace) {
  return sql.begin(async tx => {
    if (replace) await tx`DELETE FROM deck_words WHERE deck_id=${deckId}`;
    const [{ m }] = await tx`SELECT COALESCE(MAX(position), -1) AS m FROM deck_words WHERE deck_id=${deckId}`;
    const rows = entries.map((e, i) => ({ deck_id: deckId, position: m + 1 + i, word: e.word, senses: sql.json(e.senses) }));
    const inserted = rows.length
      ? await tx`INSERT INTO deck_words ${tx(rows, 'deck_id', 'position', 'word', 'senses')}
                 ON CONFLICT (deck_id, lower(word)) DO NOTHING RETURNING id`
      : [];
    await renumberDeckWords(tx, deckId);
    await touchDeck(tx, deckId);
    return { added: inserted.length, skipped: entries.length - inserted.length };
  });
}

// Throws err.code 'DUP' if the new spelling is already in the deck.
async function updateDeckWord(deckId, wordId, { word, senses }) {
  try {
    await sql.begin(async tx => {
      await tx`UPDATE deck_words SET word=${word}, senses=${sql.json(senses)} WHERE deck_id=${deckId} AND id=${wordId}`;
      await touchDeck(tx, deckId);
    });
  } catch (e) {
    if (e.code === '23505') { const err = new Error('word already in this deck'); err.code = 'DUP'; throw err; }
    throw e;
  }
  return getDeckWord(deckId, wordId);
}

async function deleteDeckWord(deckId, wordId) {
  await sql.begin(async tx => {
    await tx`DELETE FROM deck_words WHERE deck_id=${deckId} AND id=${wordId}`;
    await renumberDeckWords(tx, deckId);
    await touchDeck(tx, deckId);
  });
}

// Student-facing card.
function toCard(w) {
  return {
    word: w.word,
    senses: w.senses.map(s => ({ partOfSpeech: s.partOfSpeech, definition: s.definition, example: s.example || '' }))
  };
}

// Cards as students would see them now, plus reasons the deck can't be published yet.
async function draftDeckCards(deckId) {
  const deck = await getDeck(deckId);
  if (!deck) return null;
  const words = await listDeckWords(deckId);
  const problems = [];
  const empty = words.filter(w => !w.senses.length);
  const tooMany = words.filter(w => w.senses.length > deck.maxSenses);
  if (!words.length) problems.push('Add at least one word.');
  if (empty.length) problems.push('No meaning yet for: ' + empty.map(w => w.word).join(', '));
  if (tooMany.length) problems.push(`More than ${deck.maxSenses} meaning(s) for: ` + tooMany.map(w => w.word).join(', '));
  return { deck, cards: words.filter(w => w.senses.length).map(toCard), problems };
}

async function publishDeck(deckId) {
  const draft = await draftDeckCards(deckId);
  if (!draft) return null;
  if (draft.problems.length) {
    const err = new Error(draft.problems.join(' ')); err.code = 'INVALID'; err.problems = draft.problems; throw err;
  }
  // published_at is set past updated_at so the deck reads as up to date.
  await sql`UPDATE decks SET status='published', published_cards=${sql.json(draft.cards)},
            published_at=GREATEST(${now()}, updated_at) WHERE id=${deckId}`;
  return getDeck(deckId);
}

async function unpublishDeck(deckId) {
  await sql`UPDATE decks SET status='draft' WHERE id=${deckId}`;
  return getDeck(deckId);
}

async function listPublishedDecks() {
  const rows = await sql`
    SELECT id, name, description, published_at, jsonb_array_length(published_cards) AS card_count
    FROM decks WHERE status='published' ORDER BY published_at DESC`;
  return rows.map(r => ({ id: r.id, name: r.name, description: r.description, cardCount: r.card_count, publishedAt: r.published_at }));
}

async function getPublishedDeck(id) {
  const [r] = await sql`SELECT id, name, description, published_at, published_cards FROM decks WHERE id=${id} AND status='published'`;
  return r ? { id: r.id, name: r.name, description: r.description, publishedAt: r.published_at, cards: r.published_cards || [] } : null;
}

module.exports = {
  sql, newId,
  listQuizzes, getQuiz, createQuiz, renameQuiz, setQuizDuration, setQuizAnswerDuration,
  changeQuizSlug, deleteQuiz,
  listQuestions, addQuestion, deleteQuestionByPosition, clearQuestions, replaceQuestions,
  listRuns, getRun, createRun, renameRun, reshuffleRun, resetRunOrder,
  publishRun, unpublishRun, completeRun, deleteRun,
  getActiveRunForQuiz, getRunQuestions, listCatalog,
  listParticipants, addParticipant, deleteParticipant, scoreParticipant, resetRunScores,
  listDecks, getDeck, createDeck, updateDeck, changeDeckSlug, deleteDeck,
  listDeckWords, getDeckWord, addDeckWords, updateDeckWord, deleteDeckWord,
  draftDeckCards, publishDeck, unpublishDeck, listPublishedDecks, getPublishedDeck
};
