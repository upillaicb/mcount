// One-off import of the legacy SQLite database (mcount.db) into Postgres.
// Usage: npm run db:import-sqlite [-- path/to/mcount.db]
// Targets DATABASE_URL (local Supabase by default). Refuses to run if quizzes already exist.
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { sql } = require('../db');

async function main() {
  const file = process.argv[2] || path.join(__dirname, '..', 'mcount.db');
  const lite = new DatabaseSync(file, { readOnly: true });
  const quizzes = lite.prepare('SELECT * FROM quizzes').all();
  const questions = lite.prepare('SELECT * FROM questions').all();
  const runs = lite.prepare('SELECT * FROM runs').all().map(r => ({
    ...r, randomized: !!r.randomized, question_order: JSON.parse(r.question_order || '[]')
  }));
  const participants = lite.prepare('SELECT * FROM participants').all();
  lite.close();

  const [{ count }] = await sql`SELECT COUNT(*) AS count FROM quizzes`;
  if (count > 0) throw new Error(`target already has ${count} quizzes; aborting`);

  await sql.begin(async tx => {
    if (quizzes.length) await tx`INSERT INTO quizzes ${tx(quizzes, 'id', 'name', 'duration_seconds', 'answer_seconds', 'created_at')}`;
    // Question ids are kept because runs.question_order refers to them.
    if (questions.length) await tx`INSERT INTO questions ${tx(questions, 'id', 'quiz_id', 'position', 'text', 'answer')}`;
    for (const r of runs) {
      await tx`INSERT INTO runs (id, quiz_id, name, status, randomized, question_order, created_at, published_at, completed_at)
               VALUES (${r.id}, ${r.quiz_id}, ${r.name}, ${r.status}, ${r.randomized}, ${tx.json(r.question_order)},
                       ${r.created_at}, ${r.published_at}, ${r.completed_at})`;
    }
    if (participants.length) await tx`INSERT INTO participants ${tx(participants, 'id', 'run_id', 'name', 'score', 'created_at')}`;
    await tx`SELECT setval(pg_get_serial_sequence('questions', 'id'), COALESCE((SELECT MAX(id) FROM questions), 0) + 1, false)`;
  });

  console.log(`Imported ${quizzes.length} quizzes, ${questions.length} questions, ${runs.length} runs, ${participants.length} participants.`);
}

main()
  .catch(e => { console.error(e.message); process.exitCode = 1; })
  .finally(() => sql.end());
