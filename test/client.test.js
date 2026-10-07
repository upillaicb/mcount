const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const express = require('express');

test('client catalog and assets are additive to existing routes', async context => {
  const quiz = { id: 'active', name: 'Active quiz', activeRunId: 'run-1', durationSeconds: 30, answerSeconds: 5 };
  const run = { id: 'run-1', name: 'Published run', status: 'published' };
  const questions = [{ id: 1, text: '2 + 2?', answer: '4' }];
  let quizzes = [quiz, { id: 'draft', name: 'Draft quiz', activeRunId: null }];
  let activeRun = run;
  const card = { word: 'bank', phonetic: '/bæŋk/', audioUrl: null, senses: [{ partOfSpeech: 'noun', definition: 'A place for money.', example: '', synonyms: [] }] };
  const fixture = {
    listCatalog: async () => quizzes.filter(q => q.activeRunId).map(q => ({
      id: q.id, name: q.name, runId: activeRun.id, runName: activeRun.name,
      questionCount: questions.length, durationSeconds: q.durationSeconds, answerSeconds: q.answerSeconds
    })),
    listQuizzes: () => quizzes,
    getQuiz: id => id === quiz.id ? quiz : null,
    getActiveRunForQuiz: () => activeRun,
    getRunQuestions: () => questions,
    listParticipants: () => [],
    listPublishedDecks: async () => [{ id: 'words', name: 'Week 1', description: '', cardCount: 1, publishedAt: 1 }],
    getPublishedDeck: async id => id === 'words' ? { id, name: 'Week 1', description: '', publishedAt: 1, cards: [card] } : null
  };
  let application;
  const filename = path.join(__dirname, '..', 'server.js');
  const isolated = new Module(filename, module);
  isolated.filename = filename;
  isolated.paths = module.paths;
  isolated.require = name => {
    if (name === './db') return fixture;
    if (name === 'express') return Object.assign(() => {
      application = express();
      application.listen = () => {};
      return application;
    }, express);
    return require(name.startsWith('./') ? path.join(__dirname, '..', name) : name);
  };
  isolated._compile(fs.readFileSync(filename, 'utf8'), filename);
  const server = http.createServer(application);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port;

  const response = await fetch(base + '/api/catalog');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), [{
    id: 'active', name: 'Active quiz', runId: 'run-1', runName: 'Published run',
    questionCount: 1, durationSeconds: 30, answerSeconds: 5
  }]);
  quizzes = [];
  assert.deepEqual(await (await fetch(base + '/api/catalog')).json(), []);
  assert.equal((await fetch(base + '/api/admin/quizzes')).status, 401);
  assert.equal((await fetch(base + '/api/admin/quizzes?token=admin123')).status, 401);
  assert.equal((await fetch(base + '/api/admin/quizzes', { headers: { 'X-Admin-Token': 'wrong' } })).status, 401);
  assert.deepEqual(await (await fetch(base + '/api/admin/quizzes', { headers: { 'X-Admin-Token': 'admin123' } })).json(), []);
  assert.equal((await fetch(base + '/', { redirect: 'manual' })).headers.get('location'), '/admin.html');
  assert.equal((await fetch(base + '/q/active')).status, 200);
  assert.equal((await fetch(base + '/admin.html')).status, 200);
  const current = await (await fetch(base + '/api/current/active')).json();
  assert.equal(current.published, true);
  assert.deepEqual(current.questions, questions);
  activeRun = null;
  const inactive = await (await fetch(base + '/api/current/active')).json();
  assert.equal(inactive.published, false);
  assert.deepEqual(inactive.questions, []);
  assert.equal((await fetch(base + '/api/current/missing')).status, 404);

  const decks = await fetch(base + '/api/flashcards');
  assert.equal(decks.status, 200);
  assert.match(decks.headers.get('cache-control'), /s-maxage=30/);
  assert.equal((await decks.json())[0].id, 'words');
  assert.deepEqual((await (await fetch(base + '/api/flashcards/words')).json()).cards, [card]);
  assert.equal((await fetch(base + '/api/flashcards/missing')).status, 404);
  assert.equal((await fetch(base + '/api/admin/decks')).status, 401);
  assert.equal((await fetch(base + '/api/admin/decks/words/preview')).status, 401);
  assert.equal((await fetch(base + '/api/admin/decks/words/words/abc', { headers: { 'X-Admin-Token': 'admin123' } })).status, 404);

  for (const asset of ['/app/', '/app/app.js', '/app/flashcards.js', '/app/styles.css', '/app/sw.js', '/app/vendor/lucide.js']) {
    assert.equal((await fetch(base + asset)).status, 200, asset);
  }
  const manifest = await (await fetch(base + '/app/manifest.webmanifest')).json();
  assert.equal(manifest.scope, '/app/');
  assert.equal(manifest.start_url, '/app/');
  for (const icon of manifest.icons) {
    const response = await fetch(base + icon.src);
    assert.equal(response.status, 200);
    const image = Buffer.from(await response.arrayBuffer());
    assert.equal(image.subarray(1, 4).toString(), 'PNG');
    assert.equal(image.readUInt32BE(16), Number(icon.sizes.split('x')[0]));
  }
  assert.equal((await fetch(base + '/app/icons/apple-touch-icon.png')).status, 200);
});