// Parsing and validation for admin-entered flashcard decks.

const MAX_WORDS = 300;

function field(value, max, name) {
  const s = String(value ?? '').trim();
  if (s.length > max) throw new Error(`${name} is too long (max ${max} characters)`);
  return s;
}

// One entry per line:
//   word
//   word | meaning
//   word | part of speech | meaning
//   word | part of speech | meaning | example
// A word on several lines gets several meanings. Words are matched case-insensitively.
function parseWordList(text) {
  const byKey = new Map();
  const invalid = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('|').map(p => p.trim());
    const word = parts[0].replace(/\s+/g, ' ');
    if (!/^\p{L}[\p{L}\p{M}'’ -]{0,47}$/u.test(word)) { invalid.push(line.trim()); continue; }
    let sense = null;
    try {
      if (parts.length === 2 && parts[1]) sense = { partOfSpeech: 'other', definition: field(parts[1], 500, 'meaning') };
      else if (parts.length >= 3 && parts[2]) {
        sense = { partOfSpeech: field(parts[1].toLowerCase(), 30, 'part of speech') || 'other', definition: field(parts[2], 500, 'meaning') };
        if (parts[3]) sense.example = field(parts.slice(3).join('|'), 300, 'example');
      }
    } catch (e) { invalid.push(line.trim()); continue; }
    const key = word.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, { word, senses: [] });
    if (sense) byKey.get(key).senses.push({ example: '', ...sense });
  }
  const entries = [...byKey.values()];
  if (entries.length > MAX_WORDS) throw new Error(`at most ${MAX_WORDS} words per upload`);
  return { entries, invalid };
}

// Validates meanings submitted from the word editor. Throws with a message on bad input.
function cleanSenses(senses, maxSenses) {
  if (!Array.isArray(senses)) throw new Error('meanings must be a list');
  if (senses.length > maxSenses) throw new Error(`at most ${maxSenses} meanings per card`);
  return senses.map(s => {
    const definition = field(s.definition, 500, 'meaning');
    if (!definition) throw new Error('meaning is required');
    return {
      partOfSpeech: field(s.partOfSpeech, 30, 'part of speech').toLowerCase() || 'other',
      definition,
      example: field(s.example, 300, 'example')
    };
  });
}

module.exports = { parseWordList, cleanSenses };
