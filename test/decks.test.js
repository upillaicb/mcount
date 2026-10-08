const assert = require('node:assert/strict');
const { test } = require('node:test');
const { cleanWord, parseWordList, cleanSenses } = require('../decks');

test('cleanWord accepts words and phrases, rejects anything else', () => {
  assert.equal(cleanWord('  ice   cream '), 'ice cream');
  assert.equal(cleanWord("don't"), "don't");
  assert.equal(cleanWord('well-known'), 'well-known');
  assert.equal(cleanWord('café'), 'café');
  for (const bad of ['', '   ', '123', '-dash', 'a'.repeat(49), '<b>', 'two|parts', null, undefined]) {
    assert.equal(cleanWord(bad), null, String(bad));
  }
});

test('parseWordList reads words with optional meanings', () => {
  const { entries, invalid } = parseWordList([
    'curious',
    'enormous | very large',
    'whisper | Verb | to speak very softly | She whispered a secret.',
    'whisper | noun | a soft voice',
    '  ice   cream  ',
    'CURIOUS | adjective | eager to know',
    '123',
    '',
    'bad | noun | ' + 'x'.repeat(501)
  ].join('\n'));
  assert.deepEqual(entries, [
    { word: 'curious', senses: [{ partOfSpeech: 'adjective', definition: 'eager to know', example: '' }] },
    { word: 'enormous', senses: [{ partOfSpeech: 'other', definition: 'very large', example: '' }] },
    { word: 'whisper', senses: [
      { partOfSpeech: 'verb', definition: 'to speak very softly', example: 'She whispered a secret.' },
      { partOfSpeech: 'noun', definition: 'a soft voice', example: '' }
    ] },
    { word: 'ice cream', senses: [] }
  ]);
  assert.equal(invalid.length, 2);
  assert.throws(() => parseWordList(Array.from({ length: 301 }, (_, i) => 'w' + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26))).join('\n')), /at most 300/);
});

test('cleanSenses enforces the per-deck limit and field sizes', () => {
  const [clean] = cleanSenses([{ partOfSpeech: ' Noun ', definition: '  A place for money. ', example: 'x', extra: 'dropped' }], 3);
  assert.deepEqual(clean, { partOfSpeech: 'noun', definition: 'A place for money.', example: 'x' });
  assert.equal(cleanSenses([{ definition: 'd' }], 3)[0].partOfSpeech, 'other');
  assert.throws(() => cleanSenses([clean, clean], 1), /at most 1/);
  assert.throws(() => cleanSenses([{ definition: ' ' }], 3), /required/);
  assert.throws(() => cleanSenses([{ definition: 'x'.repeat(501) }], 3), /too long/);
  assert.throws(() => cleanSenses('nope', 3), /list/);
});
