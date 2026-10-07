(function () {
  'use strict';
  const elements = {};
  document.querySelectorAll('[id]').forEach(element => { elements[element.id] = element; });
  let session = null;
  let catalogRequest = 0;
  let playerRequest = 0;
  let catalogSignature = '';
  let catalogLoaded = false;
  let audio = null;
  let lastBeep = '';
  let confettiPieces = [];
  let confettiFrame = null;
  let celebrationTimers = [];

  function stopCelebration() {
    celebrationTimers.forEach(clearTimeout);
    celebrationTimers = [];
    if (confettiFrame !== null) cancelAnimationFrame(confettiFrame);
    confettiFrame = null;
    confettiPieces = [];
    const canvas = elements.confetti;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    elements['player-view'].classList.remove('celebrate');
  }

  function launchConfetti() {
    const canvas = elements.confetti;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const colors = ['#fbbf24', '#f472b6', '#38bdf8', '#4ade80', '#f87171', '#a78bfa'];
    for (let index = 0; index < 220; index++) {
      confettiPieces.push({
        x: Math.random() * canvas.width, y: -20 - Math.random() * canvas.height * .5,
        width: 6 + Math.random() * 8, height: 8 + Math.random() * 10,
        vx: (Math.random() - .5) * 3, vy: 2 + Math.random() * 4,
        rotation: Math.random() * Math.PI, spin: (Math.random() - .5) * .2,
        color: colors[Math.floor(Math.random() * colors.length)]
      });
    }
    if (confettiFrame !== null) return;
    const context = canvas.getContext('2d');
    function animate() {
      context.clearRect(0, 0, canvas.width, canvas.height);
      confettiPieces.forEach(piece => {
        piece.x += piece.vx; piece.y += piece.vy; piece.rotation += piece.spin; piece.vy += .02;
        context.save();
        context.translate(piece.x, piece.y); context.rotate(piece.rotation);
        context.fillStyle = piece.color;
        context.fillRect(-piece.width / 2, -piece.height / 2, piece.width, piece.height);
        context.restore();
      });
      confettiPieces = confettiPieces.filter(piece => piece.y < canvas.height + 30);
      confettiFrame = confettiPieces.length ? requestAnimationFrame(animate) : null;
      if (confettiFrame === null) context.clearRect(0, 0, canvas.width, canvas.height);
    }
    confettiFrame = requestAnimationFrame(animate);
  }

  function tone(frequency, delay, duration, type, volume) {
    if (!audio || audio.state !== 'running') return;
    const start = audio.currentTime + delay;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + .02);
    gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
    oscillator.connect(gain); gain.connect(audio.destination);
    oscillator.start(start); oscillator.stop(start + duration + .05);
  }

  function celebrate() {
    if (session.celebrated) return;
    session.celebrated = true;
    elements['player-view'].classList.add('celebrate');
    launchConfetti();
    celebrationTimers = [setTimeout(launchConfetti, 1500), setTimeout(launchConfetti, 3200)];
    [[523.25, 0, .15], [659.25, .15, .15], [783.99, .3, .15], [1046.5, .45, .35],
      [698.46, .85, .15], [880, 1, .15], [1046.5, 1.15, .15], [1318.5, 1.3, .35],
      [1046.5, 1.75, .9], [1318.5, 1.75, .9], [1567.98, 1.75, .9]]
      .forEach(note => tone(note[0], note[1], note[2], 'triangle', .25));
  }

  function icons() { if (window.lucide) window.lucide.createIcons(); }
  function connection(text) { elements.connection.textContent = text; }
  function show(element, visible) { element.hidden = !visible; }
  async function request(url) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), 8000) : null;
    try {
      const response = await fetch(url, { cache: 'no-store', signal: controller ? controller.signal : undefined });
      if (!response.ok) {
        const error = new Error(response.status === 404 ? 'This quiz is no longer available.' : 'Unable to load content. Try refreshing.');
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } finally { clearTimeout(timeout); }
  }

  async function loadCatalog() {
    const version = ++catalogRequest;
    try {
      const quizzes = await request('/api/catalog');
      if (version !== catalogRequest || session) return;
      connection('Connected');
      catalogLoaded = true;
      elements['catalog-message'].textContent = quizzes.length ? '' : 'No active quizzes right now.';
      elements['catalog-count'].textContent = quizzes.length + ' active';
      const signature = JSON.stringify(quizzes);
      if (signature === catalogSignature) return;
      catalogSignature = signature;
      elements.catalog.textContent = '';
      quizzes.forEach(quiz => {
        const item = document.createElement('article');
        item.className = 'quiz-item';
        const title = document.createElement('h2');
        title.textContent = quiz.name;
        const run = document.createElement('p');
        run.textContent = quiz.runName;
        const count = document.createElement('p');
        count.textContent = quiz.questionCount + ' questions';
        const actions = document.createElement('div');
        actions.className = 'quiz-actions';
        [['quiz', 'Quiz', 'play'], ['cards', 'Flashcards', 'layers']].forEach(mode => {
          const button = document.createElement('button');
          if (mode[0] === 'quiz') button.className = 'primary';
          button.innerHTML = '<i data-lucide="' + mode[2] + '"></i><span>' + mode[1] + '</span>';
          button.setAttribute('aria-label', mode[1] + ': ' + quiz.name);
          button.disabled = quiz.questionCount === 0;
          button.addEventListener('click', () => { location.hash = '/' + mode[0] + '/' + encodeURIComponent(quiz.id); });
          actions.appendChild(button);
        });
        item.append(title, run, count, actions);
        elements.catalog.appendChild(item);
      });
      icons();
    } catch (error) {
      if (version !== catalogRequest || session) return;
      connection('Disconnected');
      elements['catalog-message'].textContent = 'Cannot reach the server. Connect and refresh to see active quizzes.';
      elements.catalog.textContent = '';
      elements['catalog-count'].textContent = '';
      catalogSignature = '';
    }
  }

  function resetPlayer() {
    stopCelebration();
    session.celebrated = false;
    session.started = null;
    session.paused = null;
    session.offset = 0;
    session.card = 0;
    session.revealed = false;
    session.frame = '';
    lastBeep = '';
  }

  async function loadPlayer() {
    const current = session;
    const version = ++playerRequest;
    try {
      const quiz = await request('/api/current/' + encodeURIComponent(current.id));
      if (session !== current || version !== playerRequest) return;
      connection('Connected');
      elements['player-message'].textContent = '';
      if (!quiz.published || !quiz.questions.length) {
        current.data = null;
        resetPlayer();
        elements['player-message'].textContent = 'This quiz has no active questions. Return to the library or refresh.';
      } else {
        const changed = current.data && (current.data.runId !== quiz.runId || JSON.stringify(current.data.questions) !== JSON.stringify(quiz.questions) || current.data.durationSeconds !== quiz.durationSeconds || current.data.answerSeconds !== quiz.answerSeconds);
        if (changed) {
          resetPlayer();
          elements['player-message'].textContent = 'The published quiz changed. Ready to start again.';
        }
        current.data = quiz;
      }
      elements['quiz-title'].textContent = quiz.name;
      elements['run-name'].textContent = quiz.runName || '';
      renderScores(quiz.participants || []);
      renderPlayer();
    } catch (error) {
      if (session !== current || version !== playerRequest) return;
      if (error.status === 404) {
        current.data = null;
        resetPlayer();
        renderScores([]);
        renderPlayer();
      }
      connection('Disconnected');
      if (!current.data) elements['player-message'].textContent = error.message === 'This quiz is no longer available.' ? error.message : 'Cannot reach the server. Connect and refresh.';
      else elements['player-message'].textContent = 'Connection lost. Playing loaded content; live scores and publication status are unavailable.';
    }
  }

  function renderScores(participants) {
    show(elements.scores, participants.length > 0);
    elements['score-list'].textContent = '';
    participants.slice().sort((first, second) => second.score - first.score).forEach((participant, index) => {
      const row = document.createElement('li');
      if (index === 0) row.className = 'top';
      const name = document.createElement('span');
      name.textContent = (index + 1) + '. ' + participant.name;
      const score = document.createElement('strong');
      score.textContent = participant.score;
      row.append(name, score);
      elements['score-list'].appendChild(row);
    });
  }

  function renderPlayer() {
    if (!session) return;
    const quiz = session.data;
    let frame = 'waiting';
    let question = '';
    let answer = '';
    let phase = 'Ready';
    let progress = '';
    let remaining = '';
    let finished = false;
    let ready = true;
    let answering = false;
    let winner = false;
    let meta = '';
    if (quiz) {
      const cards = session.mode === 'cards';
      let index = session.card;
      answering = session.revealed;
      ready = !cards && session.started === null;
      if (!cards && !ready) {
        const elapsed = ((session.paused === null ? Date.now() : session.paused) - session.started - session.offset) / 1000;
        const cycle = quiz.durationSeconds + quiz.answerSeconds;
        index = Math.floor(elapsed / cycle);
        finished = index >= quiz.questions.length;
        answering = elapsed % cycle >= quiz.durationSeconds;
        remaining = finished ? '' : Math.ceil((answering ? cycle : quiz.durationSeconds) - elapsed % cycle);
      }
      if (ready) {
        question = quiz.name + ' · ' + quiz.questions.length + ' question(s)';
        progress = quiz.questions.length + ' questions';
      } else if (finished) {
        phase = '';
        question = 'Quiz complete.';
        meta = quiz.name;
        const participants = quiz.participants || [];
        if (participants.length) {
          const best = Math.max.apply(null, participants.map(participant => participant.score));
          if (best > 0) {
            const winners = participants.filter(participant => participant.score === best);
            winner = true;
            phase = winners.length > 1 ? "It's a tie!" : 'Winner';
            question = winners.map(participant => participant.name).join(' & ');
            answer = best + ' point' + (best === 1 ? '' : 's') + (winners.length > 1 ? ' - shared victory!' : '');
          }
        }
      } else {
        question = !cards && answering ? '' : quiz.questions[index].text;
        answer = answering ? quiz.questions[index].answer || '(no answer provided)' : '';
        phase = answering ? 'Answer' : cards ? 'Flashcard' : 'Question';
        progress = (index + 1) + ' / ' + quiz.questions.length;
        meta = quiz.name + ' · ' + progress;
      }
      frame = [session.mode, index, answering, ready, finished, session.paused !== null, question, answer, phase].join('|');
      show(elements.start, !cards && (ready || finished));
      elements.start.textContent = finished ? 'Play again' : 'Start quiz';
      show(elements.pause, !cards && !ready && !finished);
      show(elements.previous, cards);
      show(elements.next, cards);
      show(elements.reveal, cards);
      elements.previous.disabled = index === 0;
      elements.next.disabled = index >= quiz.questions.length - 1;
      elements.reveal.textContent = session.revealed ? 'Hide answer' : 'Reveal answer';
    } else {
      ['start', 'pause', 'previous', 'next', 'reveal'].forEach(id => show(elements[id], false));
    }
    elements['quiz-meta'].textContent = meta;
    show(elements['paused-badge'], session.mode === 'quiz' && session.paused !== null && !finished);
    elements['player-view'].classList.toggle('answer-phase', answering && !finished);
    if (winner) celebrate();
    elements.timer.textContent = remaining;
    elements.timer.classList.toggle('low', !answering && remaining !== '' && remaining <= 5);
    if (audio && session.paused === null && !answering && remaining !== '' && remaining <= 5 && remaining >= 1) {
      const key = frame + remaining;
      if (key !== lastBeep) {
        lastBeep = key;
        tone(remaining === 1 ? 1200 : 880, 0, .18, 'sine', .3);
      }
    }
    if (frame === session.frame) return;
    session.frame = frame;
    elements.question.textContent = question;
    show(elements.question, !!question);
    elements.answer.textContent = answer;
    show(elements.answer, !!answer);
    elements.phase.textContent = phase;
    elements.progress.textContent = progress;
    const paused = session.paused !== null;
    elements.pause.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
    elements.pause.title = paused ? 'Resume' : 'Pause';
    elements.pause.innerHTML = '<i data-lucide="' + (paused ? 'play' : 'pause') + '"></i>';
    icons();
  }

  function route() {
    const match = location.hash.match(/^#\/(quiz|cards)\/([^/]+)$/);
    playerRequest++;
    catalogRequest++;
    stopCelebration();
    session = null;
    document.body.classList.toggle('quiz-mode', !!match && match[1] === 'quiz');
    show(elements['catalog-view'], !match);
    show(elements['player-view'], !!match);
    if (!match) {
      elements['catalog-message'].textContent = catalogLoaded ? '' : 'Loading active quizzes...';
      loadCatalog();
    } else {
      let id;
      try { id = decodeURIComponent(match[2]); } catch (error) { location.hash = ''; return; }
      session = { id: id, mode: match[1], data: null };
      resetPlayer();
      elements['quiz-title'].textContent = 'Loading...';
      elements['run-name'].textContent = '';
      elements['mode-label'].textContent = match[1] === 'cards' ? 'Flashcards' : 'Timed quiz';
      elements['player-message'].textContent = '';
      renderScores([]);
      renderPlayer();
      loadPlayer();
    }
    elements.main.focus();
  }

  function refresh() { if (session) loadPlayer(); else loadCatalog(); }
  elements.refresh.addEventListener('click', refresh);
  elements.back.addEventListener('click', () => { location.hash = ''; });
  elements.start.addEventListener('click', () => {
    if (!session || !session.data) return;
    resetPlayer();
    session.started = Date.now();
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (Audio && !audio) audio = new Audio();
      if (audio && audio.state === 'suspended') audio.resume().catch(() => {});
    } catch (error) { audio = null; }
    renderPlayer();
    elements.pause.focus();
  });
  elements.pause.addEventListener('click', () => {
    if (session.paused === null) session.paused = Date.now();
    else { session.offset += Date.now() - session.paused; session.paused = null; }
    renderPlayer();
  });
  elements.reveal.addEventListener('click', () => { session.revealed = !session.revealed; renderPlayer(); });
  elements.previous.addEventListener('click', () => { session.card = Math.max(0, session.card - 1); session.revealed = false; renderPlayer(); });
  elements.next.addEventListener('click', () => { session.card = Math.min(session.data.questions.length - 1, session.card + 1); session.revealed = false; renderPlayer(); });

  document.addEventListener('keydown', event => {
    if ((event.key === 'Escape' || event.keyCode === 461) && session) {
      event.preventDefault(); location.hash = ''; return;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(event.key) === -1) return;
    const controls = Array.from(document.querySelectorAll('button:not(:disabled), a')).filter(element => element.getClientRects().length);
    const active = document.activeElement;
    const origin = active.getBoundingClientRect();
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const candidates = controls.filter(element => element !== active).map(element => {
      const box = element.getBoundingClientRect();
      const delta = horizontal ? box.x + box.width / 2 - origin.x - origin.width / 2 : box.y + box.height / 2 - origin.y - origin.height / 2;
      const cross = horizontal ? Math.abs(box.y - origin.y) : Math.abs(box.x - origin.x);
      return { element: element, delta: delta, score: Math.abs(delta) + cross * 2 };
    }).filter(candidate => forward ? candidate.delta > 1 : candidate.delta < -1).sort((first, second) => first.score - second.score);
    event.preventDefault();
    if (controls.indexOf(active) === -1 && controls.length) controls[0].focus();
    else if (candidates.length) candidates[0].element.focus();
  });
  window.addEventListener('hashchange', route);
  window.addEventListener('online', refresh);
  window.addEventListener('offline', () => { connection('Disconnected'); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); renderPlayer(); } });
  setInterval(() => { if (!document.hidden && session) loadPlayer(); }, 2000);
  setInterval(() => { if (!document.hidden && !session) loadCatalog(); }, 15000);
  setInterval(renderPlayer, 100);
  icons();
  route();
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/app/sw.js').catch(() => {});
})();