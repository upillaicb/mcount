// Vocabulary flashcards: #/flashcards (deck list) and #/flashcards/<id>[/preview] (study).
(function () {
  'use strict';
  let h = null;
  let el = null;
  let state = null;
  let listRequest = 0;
  let deckRequest = 0;
  let listSignature = '';
  let listLoaded = false;
  let swipe = null;
  let suppressClickUntil = 0;
  const KNOWN_POS = ['noun', 'verb', 'adjective', 'adverb', 'pronoun', 'preposition', 'conjunction', 'interjection'];

  function prefs() {
    try { return JSON.parse(localStorage.getItem('mcount_flash_prefs')) || {}; } catch (error) { return {}; }
  }
  function savePrefs(value) {
    try { localStorage.setItem('mcount_flash_prefs', JSON.stringify(value)); } catch (error) {}
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

  // ---------- Pronunciation (device text-to-speech) ----------
  let currentButton = null;
  const canSpeak = 'speechSynthesis' in window;

  function stopAudio() {
    if (currentButton) { currentButton.classList.remove('playing'); currentButton = null; }
    const synth = window.speechSynthesis;
    if (synth && (synth.speaking || synth.pending)) synth.cancel();
  }

  function speak(card, button) {
    const synth = window.speechSynthesis;
    stopAudio();
    currentButton = button;
    const utterance = new SpeechSynthesisUtterance(card.word);
    utterance.lang = 'en-US';
    utterance.rate = .85;
    utterance.onend = utterance.onerror = () => button.classList.remove('playing');
    button.classList.add('playing');
    // Chrome can drop an utterance spoken right after cancel(); leave a short gap.
    setTimeout(() => { synth.speak(utterance); if (synth.paused) synth.resume(); }, 50);
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

  function wordSide(card) {
    const face = document.createDocumentFragment();
    const chips = make('div', 'pos-row');
    card.senses.map(sense => sense.partOfSpeech).filter((pos, i, all) => all.indexOf(pos) === i).forEach(pos => chips.appendChild(posChip(pos)));
    face.appendChild(chips);
    face.appendChild(make('h2', 'card-word', card.word));
    if (canSpeak) face.appendChild(speakButton(card, true));
    return face;
  }

  function meaningSide(card, hideWord) {
    const face = document.createDocumentFragment();
    if (hideWord) {
      face.appendChild(make('p', 'card-hint-top', 'Which word means…'));
    } else {
      const head = make('div', 'meaning-head');
      head.appendChild(make('span', 'meaning-word', card.word));
      if (canSpeak) head.appendChild(speakButton(card, false));
      face.appendChild(head);
    }
    const list = make('ol', 'senses' + (card.senses.length === 1 ? ' single' : ''));
    card.senses.forEach(sense => {
      const item = make('li', 'sense');
      item.appendChild(posChip(sense.partOfSpeech));
      item.appendChild(make('p', 'definition', sense.definition));
      if (sense.example) item.appendChild(exampleNode(sense.example, card.word, hideWord));
      list.appendChild(item);
    });
    face.appendChild(list);
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
        const item = make('article', 'quiz-item deck-item');
        item.appendChild(make('h2', '', deck.name));
        if (deck.description) item.appendChild(make('p', '', deck.description));
        item.appendChild(make('p', '', deck.cardCount + ' word' + (deck.cardCount === 1 ? '' : 's')));
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
      if (!deck.cards.length) el['deck-message'].textContent = 'This deck has no cards yet.';
      if (changed) { startSession(); return; }
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

  function startSession() {
    const order = state.deck.cards.map((card, index) => index);
    state.order = state.shuffle ? shuffled(order) : order;
    state.pos = 0;
    state.flipped = false;
    render();
    if (state.order.length) el.flashcard.focus();
  }

  function setFace(face, content, hidden) {
    face.textContent = '';
    face.appendChild(content);
    face.setAttribute('aria-hidden', hidden ? 'true' : 'false');
    face.inert = hidden;
  }

  function render() {
    if (!state) return;
    const studying = !!state.deck && state.order.length > 0;
    h.show(el['preview-banner'], state.preview);
    h.show(el['deck-study'], studying);
    el['deck-shuffle'].setAttribute('aria-pressed', String(state.shuffle));
    el['deck-reverse'].setAttribute('aria-pressed', String(state.reverse));
    if (!studying) {
      el['deck-progress-text'].textContent = '';
      el['deck-progress-bar'].style.width = '0';
      return;
    }
    const card = state.deck.cards[state.order[state.pos]];
    const total = state.order.length;
    el['deck-progress-text'].textContent = (state.pos + 1) + ' / ' + total;
    el['deck-progress-bar'].style.width = Math.round((state.pos + 1) * 100 / total) + '%';
    if (state.rendered !== card || state.renderedReverse !== state.reverse) {
      state.rendered = card;
      state.renderedReverse = state.reverse;
      setFace(el['card-front'], state.reverse ? meaningSide(card, true) : wordSide(card), state.flipped);
      setFace(el['card-back'], state.reverse ? wordSide(card) : meaningSide(card, false), !state.flipped);
    } else {
      [['card-front', state.flipped], ['card-back', !state.flipped]].forEach(pair => {
        el[pair[0]].setAttribute('aria-hidden', pair[1] ? 'true' : 'false');
        el[pair[0]].inert = pair[1];
      });
    }
    el.flashcard.classList.toggle('flipped', state.flipped);
    el.flashcard.setAttribute('aria-label', 'Card ' + (state.pos + 1) + ' of ' + total + ', ' + (state.flipped ? 'back' : 'front') + '. Press Enter to flip.');
    el['card-prev'].disabled = state.pos === 0;
    el['card-next'].disabled = state.pos === total - 1;
    h.icons();
  }

  function flip() {
    if (!state || !state.deck || !state.order.length) return;
    state.flipped = !state.flipped;
    render();
  }

  function go(step) {
    if (!state || !state.order.length) return;
    const next = Math.max(0, Math.min(state.order.length - 1, state.pos + step));
    if (next === state.pos) return;
    stopAudio();
    state.pos = next;
    state.flipped = false;
    render();
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
    state = { id: id, preview: preview, deck: null, order: [], pos: 0, flipped: false, shuffle: !!saved.shuffle, reverse: !!saved.reverse };
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

  // Left/Right change cards (also on TV remotes); Enter/Space flips the focused card.
  function handleKey(event) {
    if (!state) return false;
    if (event.key === 'Escape' || event.keyCode === 461) {
      event.preventDefault();
      location.hash = '/flashcards';
      return true;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      go(event.key === 'ArrowRight' ? 1 : -1);
      return true;
    }
    const active = document.activeElement;
    if ((event.key === ' ' || event.key === 'Enter') && (active === el.flashcard || active === document.body || active === el.main)) {
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
    el['card-prev'].addEventListener('click', () => go(-1));
    el['card-next'].addEventListener('click', () => go(1));
    el['deck-shuffle'].addEventListener('click', () => {
      state.shuffle = !state.shuffle;
      savePrefs({ shuffle: state.shuffle, reverse: state.reverse });
      if (state.deck && state.deck.cards.length) startSession();
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
