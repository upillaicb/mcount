// Vocabulary flashcards: #/flashcards (deck list) and #/flashcards/<id>[/preview] (study).
// Study progress is kept per device in localStorage; there are no student accounts.
(function () {
  'use strict';
  let h = null;
  let el = null;
  let state = null;
  let listRequest = 0;
  let deckRequest = 0;
  let listSignature = '';
  let listLoaded = false;
  let currentAudio = null;
  let swipe = null;
  let suppressClickUntil = 0;
  const KNOWN_POS = ['noun', 'verb', 'adjective', 'adverb', 'pronoun', 'preposition', 'conjunction', 'interjection'];

  function prefs() {
    try { return JSON.parse(localStorage.getItem('mcount_flash_prefs')) || {}; } catch (error) { return {}; }
  }
  function savePrefs(value) {
    try { localStorage.setItem('mcount_flash_prefs', JSON.stringify(value)); } catch (error) {}
  }
  function loadMarks(id) {
    try { return JSON.parse(localStorage.getItem('mcount_deck_' + id)) || {}; } catch (error) { return {}; }
  }
  function saveMarks(id, marks) {
    try { localStorage.setItem('mcount_deck_' + id, JSON.stringify(marks)); } catch (error) {}
  }

  async function getJson(url, headers) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), 8000) : null;
    try {
      const response = await fetch(url, { cache: 'no-store', headers: headers || {}, signal: controller ? controller.signal : undefined });
      if (!response.ok) { const error = new Error('HTTP ' + response.status); error.status = response.status; throw error; }
      return await response.json();
    } finally { clearTimeout(timeout); }
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function posChip(pos) {
    const key = String(pos || 'other').toLowerCase();
    return make('span', 'pos-chip pos-' + (KNOWN_POS.indexOf(key) === -1 ? 'other' : key), key);
  }

  function shuffled(list) {
    const copy = list.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const swap = copy[i]; copy[i] = copy[j]; copy[j] = swap;
    }
    return copy;
  }

  // ---------- Audio ----------
  function canSpeak(card) { return !!card.audioUrl || 'speechSynthesis' in window; }

  function speakWithVoice(word) {
    if (!('speechSynthesis' in window)) return;
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = 'en-US';
    utterance.rate = .85;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  function stopAudio() {
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  function speak(card, button) {
    stopAudio();
    button.classList.add('playing');
    const done = () => button.classList.remove('playing');
    if (card.audioUrl) {
      currentAudio = new Audio(card.audioUrl);
      currentAudio.addEventListener('ended', done);
      currentAudio.play().catch(() => { done(); speakWithVoice(card.word); });
    } else {
      speakWithVoice(card.word);
      setTimeout(done, 900);
    }
  }

  function speakButton(card, large) {
    const button = make('button', 'speak' + (large ? ' speak-large' : ''));
    button.type = 'button';
    button.setAttribute('aria-label', 'Listen to how to say ' + card.word);
    button.title = 'Listen';
    button.innerHTML = '<i data-lucide="volume-2"></i>' + (large ? '<span>Listen</span>' : '');
    button.addEventListener('click', event => { event.stopPropagation(); speak(card, button); });
    return button;
  }

  // ---------- Card faces ----------
  function escapeRegExp(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // Highlights the word (and endings like -s, -ed) in the example, or blanks it in meaning-first mode.
  function exampleNode(example, word, hideWord) {
    const p = make('p', 'example');
    p.appendChild(document.createTextNode('“'));
    // Plain character class: older TV browsers lack Unicode property escapes.
    const pattern = new RegExp('(' + escapeRegExp(word) + '[A-Za-z\\u00C0-\\u024F]*)', 'gi');
    example.split(pattern).forEach((part, index) => {
      if (index % 2 === 0) { if (part) p.appendChild(document.createTextNode(part)); return; }
      p.appendChild(hideWord ? make('span', 'blank', '_____') : make('mark', '', part));
    });
    p.appendChild(document.createTextNode('”'));
    return p;
  }

  function wordSide(card, isAnswer) {
    const face = document.createDocumentFragment();
    const chips = make('div', 'pos-row');
    card.senses.map(sense => sense.partOfSpeech).filter((pos, i, all) => all.indexOf(pos) === i).forEach(pos => chips.appendChild(posChip(pos)));
    face.appendChild(chips);
    face.appendChild(make('h2', 'card-word', card.word));
    if (card.phonetic) face.appendChild(make('p', 'card-phonetic', card.phonetic));
    if (canSpeak(card)) face.appendChild(speakButton(card, true));
    face.appendChild(make('p', 'card-hint', isAnswer ? 'Did you get it right?' : 'Tap the card to see what it means'));
    return face;
  }

  function meaningSide(card, hideWord) {
    const face = document.createDocumentFragment();
    if (hideWord) {
      face.appendChild(make('p', 'card-hint card-hint-top', 'Which word means…'));
    } else {
      const head = make('div', 'meaning-head');
      head.appendChild(make('span', 'meaning-word', card.word));
      if (canSpeak(card)) head.appendChild(speakButton(card, false));
      face.appendChild(head);
    }
    const list = make('ol', 'senses' + (card.senses.length === 1 ? ' single' : ''));
    card.senses.forEach(sense => {
      const item = make('li', 'sense');
      item.appendChild(posChip(sense.partOfSpeech));
      item.appendChild(make('p', 'definition', sense.definition));
      if (sense.example) item.appendChild(exampleNode(sense.example, card.word, hideWord));
      if (sense.synonyms && sense.synonyms.length && !hideWord) {
        const similar = make('p', 'similar');
        similar.appendChild(make('span', 'similar-label', 'Similar:'));
        sense.synonyms.slice(0, 3).forEach(word => similar.appendChild(make('span', 'similar-word', word)));
        item.appendChild(similar);
      }
      list.appendChild(item);
    });
    face.appendChild(list);
    if (hideWord) face.appendChild(make('p', 'card-hint', 'Say the word, then flip to check'));
    return face;
  }

  // ---------- Deck list ----------
  async function loadList() {
    const version = ++listRequest;
    try {
      const decks = await getJson('/api/flashcards');
      if (version !== listRequest || state) return;
      h.connection('Connected');
      listLoaded = true;
      el['decks-message'].textContent = decks.length ? '' : 'No flashcards yet. Check back soon!';
      el['decks-count'].textContent = decks.length ? decks.length + ' deck' + (decks.length === 1 ? '' : 's') : '';
      const signature = JSON.stringify(decks);
      if (signature === listSignature) return;
      listSignature = signature;
      el.decks.textContent = '';
      decks.forEach(deck => {
        const marks = loadMarks(deck.id);
        const known = Object.keys(marks).filter(word => marks[word] === 'known').length;
        const item = make('article', 'quiz-item deck-item');
        item.appendChild(make('h2', '', deck.name));
        if (deck.description) item.appendChild(make('p', '', deck.description));
        item.appendChild(make('p', '', deck.cardCount + ' word' + (deck.cardCount === 1 ? '' : 's')));
        if (known) {
          const meter = make('div', 'deck-meter');
          const bar = make('div');
          bar.style.width = Math.min(100, Math.round(known * 100 / Math.max(1, deck.cardCount))) + '%';
          meter.appendChild(bar);
          item.appendChild(meter);
          item.appendChild(make('p', 'deck-known', 'You know ' + Math.min(known, deck.cardCount) + ' of ' + deck.cardCount));
        }
        const actions = make('div', 'quiz-actions');
        const button = make('button', 'primary');
        button.innerHTML = '<i data-lucide="layers"></i><span>Study</span>';
        button.setAttribute('aria-label', 'Study: ' + deck.name);
        button.disabled = !deck.cardCount;
        button.addEventListener('click', () => { location.hash = '/flashcards/' + encodeURIComponent(deck.id); });
        actions.appendChild(button);
        item.appendChild(actions);
        el.decks.appendChild(item);
      });
      h.icons();
    } catch (error) {
      if (version !== listRequest || state) return;
      h.connection('Disconnected');
      el['decks-message'].textContent = 'Cannot reach the server. Connect and refresh to see flashcards.';
      el.decks.textContent = '';
      el['decks-count'].textContent = '';
      listSignature = '';
    }
  }

  // ---------- Study ----------
  async function loadDeck() {
    const current = state;
    const version = ++deckRequest;
    const url = current.preview ? '/api/admin/decks/' + encodeURIComponent(current.id) + '/preview' : '/api/flashcards/' + encodeURIComponent(current.id);
    const headers = current.preview ? { 'X-Admin-Token': localStorage.getItem('mcount_token') || '' } : {};
    try {
      const deck = await getJson(url, headers);
      if (state !== current || version !== deckRequest) return;
      h.connection('Connected');
      const changed = !current.deck || JSON.stringify(current.deck.cards) !== JSON.stringify(deck.cards);
      current.deck = deck;
      el['deck-title'].textContent = deck.name;
      el['deck-message'].textContent = deck.problems && deck.problems.length ? 'Not ready to publish: ' + deck.problems.join(' ') : '';
      if (!deck.cards.length) {
        el['deck-message'].textContent = 'This deck has no cards yet.';
        current.order = [];
      } else if (changed) {
        startSession('all');
        return;
      }
      render();
    } catch (error) {
      if (state !== current || version !== deckRequest) return;
      h.connection(error.status ? 'Connected' : 'Disconnected');
      if (!current.deck) el['deck-title'].textContent = 'Flashcards';
      el['deck-message'].textContent =
        error.status === 401 ? 'Preview needs the admin token. Set it in the admin console, then refresh.'
        : error.status === 404 ? 'This deck isn\'t available. It may have been unpublished.'
        : current.deck ? 'Connection lost. You can keep studying the cards already loaded.'
        : 'Cannot reach the server. Connect and refresh.';
      render();
    }
  }

  function startSession(mode) {
    const marks = loadMarks(state.id);
    let order = state.deck.cards.map((card, index) => index);
    if (mode === 'learning') order = order.filter(index => marks[state.deck.cards[index].word] === 'learning');
    if (state.shuffle) order = shuffled(order);
    state.order = order;
    state.pos = 0;
    state.flipped = false;
    state.finished = false;
    render();
    el['card-flip'].focus();
  }

  function setFace(face, content, hidden) {
    face.textContent = '';
    face.appendChild(content);
    face.setAttribute('aria-hidden', hidden ? 'true' : 'false');
    face.inert = hidden;
  }

  function render() {
    if (!state) return;
    const deck = state.deck;
    const studying = !!deck && state.order && state.order.length > 0 && !state.finished;
    h.show(el['preview-banner'], state.preview);
    h.show(el['deck-study'], studying);
    h.show(el['deck-summary'], !!deck && state.finished);
    el['deck-shuffle'].setAttribute('aria-pressed', String(state.shuffle));
    el['deck-reverse'].setAttribute('aria-pressed', String(state.reverse));
    if (!studying) {
      el['deck-progress-text'].textContent = '';
      el['deck-progress-bar'].style.width = state.finished ? '100%' : '0';
      if (state.finished) renderSummary();
      h.icons();
      return;
    }
    const card = deck.cards[state.order[state.pos]];
    const total = state.order.length;
    el['deck-progress-text'].textContent = (state.pos + 1) + ' / ' + total;
    el['deck-progress-bar'].style.width = Math.round(state.pos * 100 / total) + '%';
    if (state.rendered !== card || state.renderedReverse !== state.reverse) {
      state.rendered = card;
      state.renderedReverse = state.reverse;
      setFace(el['card-front'], state.reverse ? meaningSide(card, true) : wordSide(card, false), state.flipped);
      setFace(el['card-back'], state.reverse ? wordSide(card, true) : meaningSide(card, false), !state.flipped);
    } else {
      [['card-front', state.flipped], ['card-back', !state.flipped]].forEach(pair => {
        el[pair[0]].setAttribute('aria-hidden', pair[1] ? 'true' : 'false');
        el[pair[0]].inert = pair[1];
      });
    }
    el.flashcard.classList.toggle('flipped', state.flipped);
    el.flashcard.setAttribute('aria-label', 'Card ' + (state.pos + 1) + ' of ' + total + ', ' + (state.flipped ? 'back' : 'front'));
    el['card-flip'].querySelector('span').textContent = state.flipped ? 'Flip back' : state.reverse ? 'Show the word' : 'Show meaning';
    el['card-prev'].disabled = state.pos === 0;
    el['card-next'].setAttribute('aria-label', state.pos === total - 1 ? 'Finish' : 'Next card');
    h.show(el['card-grade'], state.flipped);
    h.icons();
  }

  function renderSummary() {
    const marks = loadMarks(state.id);
    const words = state.order.map(index => state.deck.cards[index].word);
    const known = words.filter(word => marks[word] === 'known').length;
    const learning = words.filter(word => marks[word] === 'learning').length;
    el['summary-title'].textContent = known === words.length ? 'Amazing! You know all ' + words.length + ' words!' : 'Nice work!';
    el['summary-text'].textContent = 'You know ' + known + ' of ' + words.length + ' words.' +
      (learning ? ' ' + learning + ' still learning. Practice makes perfect!' : '');
    h.show(el['summary-review'], learning > 0);
    el['summary-review-label'].textContent = 'Review ' + learning + ' still learning';
  }

  function flip() {
    if (!state || !state.deck || state.finished) return;
    state.flipped = !state.flipped;
    render();
  }

  function go(step) {
    if (!state || !state.order.length) return;
    stopAudio();
    const next = state.pos + step;
    if (next < 0) return;
    if (next >= state.order.length) { state.finished = true; render(); el['summary-restart'].focus(); return; }
    state.pos = next;
    state.flipped = false;
    render();
  }

  function grade(mark) {
    const marks = loadMarks(state.id);
    marks[state.deck.cards[state.order[state.pos]].word] = mark;
    saveMarks(state.id, marks);
    listSignature = '';
    go(1);
    if (!state.finished) el['card-flip'].focus();
  }

  // ---------- Public interface (used by app.js routing) ----------
  function show(id, preview) {
    stopAudio();
    h.show(el['decks-view'], !id);
    h.show(el['deck-view'], !!id);
    if (!id) {
      state = null;
      deckRequest++;
      el['decks-message'].textContent = listLoaded ? '' : 'Loading flashcards...';
      loadList();
      return;
    }
    const saved = prefs();
    state = { id: id, preview: preview, deck: null, order: [], pos: 0, flipped: false, finished: false, shuffle: !!saved.shuffle, reverse: !!saved.reverse };
    listRequest++;
    el['deck-title'].textContent = 'Loading...';
    el['deck-message'].textContent = '';
    render();
    loadDeck();
  }

  function hide() {
    stopAudio();
    state = null;
    listRequest++;
    deckRequest++;
    h.show(el['decks-view'], false);
    h.show(el['deck-view'], false);
  }

  // Background refreshes keep the list current but never interrupt a study session.
  function refresh(manual) {
    if (!state) loadList();
    else if (manual || !state.deck) loadDeck();
  }

  function handleKey(event) {
    if (!state) return false;
    if (event.key === 'Escape' || event.keyCode === 461) {
      event.preventDefault();
      location.hash = '/flashcards';
      return true;
    }
    const tag = document.activeElement && document.activeElement.tagName;
    if ((event.key === ' ' || event.key === 'Enter') && tag !== 'BUTTON' && tag !== 'A' && !state.finished) {
      event.preventDefault();
      flip();
      return true;
    }
    return false;
  }

  function init(helpers) {
    h = helpers;
    el = helpers.elements;
    el['deck-back'].addEventListener('click', () => { location.hash = '/flashcards'; });
    el['card-flip'].addEventListener('click', flip);
    el['card-prev'].addEventListener('click', () => go(-1));
    el['card-next'].addEventListener('click', () => go(1));
    el['card-known'].addEventListener('click', () => grade('known'));
    el['card-learning'].addEventListener('click', () => grade('learning'));
    el['summary-review'].addEventListener('click', () => startSession('learning'));
    el['summary-restart'].addEventListener('click', () => startSession('all'));
    el['summary-back'].addEventListener('click', () => { location.hash = '/flashcards'; });
    el['deck-shuffle'].addEventListener('click', () => {
      state.shuffle = !state.shuffle;
      savePrefs({ shuffle: state.shuffle, reverse: state.reverse });
      if (state.deck && state.deck.cards.length) startSession('all');
    });
    el['deck-reverse'].addEventListener('click', () => {
      state.reverse = !state.reverse;
      state.flipped = false;
      savePrefs({ shuffle: state.shuffle, reverse: state.reverse });
      render();
    });
    el.flashcard.addEventListener('click', event => {
      if (Date.now() < suppressClickUntil) return;
      if (!event.target.closest('button')) flip();
    });
    // Swipe left/right on touch screens to change cards.
    el.flashcard.addEventListener('pointerdown', event => { swipe = { x: event.clientX, y: event.clientY }; });
    el.flashcard.addEventListener('pointerup', event => {
      if (!swipe) return;
      const dx = event.clientX - swipe.x;
      const dy = event.clientY - swipe.y;
      swipe = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) { suppressClickUntil = Date.now() + 400; go(dx < 0 ? 1 : -1); }
    });
    el.flashcard.addEventListener('pointercancel', () => { swipe = null; });
  }

  window.MCountFlashcards = { init: init, show: show, hide: hide, refresh: refresh, handleKey: handleKey };
})();
