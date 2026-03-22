// ═══════════════════════════════════════════════════════════════════════════
// SNAKE MULTIPLAYER — Client
// ═══════════════════════════════════════════════════════════════════════════

(() => {
  'use strict';
  
  // Debug catcher
  window.onerror = function(msg, url, line, col, error) {
    alert("CRASH: " + msg + " (Línea: " + line + ")");
  };

  // ── Socket connection ──────────────────────────────────────────────────
  const socket = io();

  // ── DOM Elements ───────────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const lobbyScreen   = $('#lobby-screen');
  const gameScreen    = $('#game-screen');
  const resultScreen  = $('#result-screen');
  const waitingOverlay    = $('#waitingOverlay');
  const countdownOverlay  = $('#countdownOverlay');
  const countdownNumber   = $('#countdownNumber');

  const playerNameInput = $('#playerName');
  const cardGrid        = $('#cardGrid');
  const cardCounter     = $('#cardCounter');
  const btnFindMatch    = $('#btnFindMatch');
  const btnPlayAgain    = $('#btnPlayAgain');

  const canvas  = $('#gameCanvas');
  const ctx     = canvas.getContext('2d');
  const cardHud = $('#cardHud');

  const hudP1Name  = $('#hudP1Name');
  const hudP1Score = $('#hudP1Score');
  const hudP1Dot   = $('#hudP1Dot');
  const hudP2Name  = $('#hudP2Name');
  const hudP2Score = $('#hudP2Score');
  const hudP2Dot   = $('#hudP2Dot');
  const hudTimer   = $('#hudTimer');

  const resultLabel      = $('#resultLabel');
  const resultWinner     = $('#resultWinner');
  const resultScores     = $('#resultScores');
  const resultDisconnect = $('#resultDisconnect');

  // ── State ──────────────────────────────────────────────────────────────
  let ownedCards = JSON.parse(localStorage.getItem('snakeOwnedCards') || '[]');
  if (ownedCards.length > 0 && typeof ownedCards[0] === 'string') {
    ownedCards = [];
    localStorage.setItem('snakeOwnedCards', '[]');
  }
  
  let favorites = new Set(JSON.parse(localStorage.getItem('snakeFavCards') || '[]'));
  if (favorites.size > 0 && typeof [...favorites][0] === 'string' && ![...favorites][0].includes('-')) {
    favorites = new Set();
    localStorage.setItem('snakeFavCards', '[]');
  }
  
  let selectedCards = []; // array of card objects now
  let activeTab = 'all';
  let gameState = null;
  let myId = null;
  let animFrameId = null;
  let prevState = null;
  let lerpT = 0;
  let lastTickTime = 0;
  const TICK_MS = 1000 / 15;

  function saveCollection() {
    localStorage.setItem('snakeOwnedCards', JSON.stringify(ownedCards));
  }

  function saveFavorites() {
    localStorage.setItem('snakeFavCards', JSON.stringify([...favorites]));
  }

  // ── Tab elements ──────────────────────────────────────────────────────
  const tabAll  = $('#tabAll');
  const tabFavs = $('#tabFavs');

  tabAll.addEventListener('click', () => switchTab('all'));
  tabFavs.addEventListener('click', () => switchTab('favs'));

  function updateTabCounters() {
    const favCount = favorites.size;
    tabFavs.textContent = favCount > 0 ? `❤ Favoritas (${favCount})` : '♡ Favoritas';
  }

  function switchTab(tab) {
    activeTab = tab;
    tabAll.classList.toggle('active', tab === 'all');
    tabFavs.classList.toggle('active', tab === 'favs');
    updateTabCounters();
    renderCardGrid();
  }

  // ── Screen management ──────────────────────────────────────────────────
  function showScreen(screen) {
    [lobbyScreen, gameScreen, resultScreen].forEach(s => s.classList.remove('active'));
    screen.classList.add('active');
  }

  // ── LOBBY: Card selection ──────────────────────────────────────────────
  socket.on('connect', () => {
    // Wait for the UI flow to naturally call renderCardGrid().
    updateTabCounters();
    renderCardGrid();
  });

  function renderCardGrid() {
    cardGrid.innerHTML = '';

    // Determine which cards to show
    const entries = ownedCards.filter(card => {
      if (activeTab === 'favs') return favorites.has(card.id);
      return true;
    });

    if (entries.length === 0) {
      const msg = document.createElement('div');
      msg.classList.add('card-empty-msg');
      if (ownedCards.length === 0) {
        msg.textContent = 'Aún no tenés ninguna carta. ¡Abrí sobres gratis tocando el ícono 🎁 arriba a la izquierda para empezar tu mazo!';
      } else if (activeTab === 'favs') {
        msg.textContent = 'No tenés favoritas aún. Tocá el ♡ en cualquier carta para agregarla.';
      } else {
        msg.textContent = 'No tenés cartas para mostrar.';
      }
      cardGrid.appendChild(msg);
      return;
    }

    for (const card of entries) {
      const el = document.createElement('div');
      el.classList.add('card-option');
      el.dataset.cardId = card.id;

      // Restore selected state
      if (selectedCards.some(c => c.id === card.id)) el.classList.add('selected');

      const isFaved = favorites.has(card.id);
      el.innerHTML = `
        <button class="card-fav-btn ${isFaved ? 'faved' : ''}" data-fav-id="${card.id}" title="${isFaved ? 'Quitar de favoritas' : 'Agregar a favoritas'}">${isFaved ? '❤' : '♡'}</button>
        <div class="card-image-placeholder" style="width:100%; height:80px; background:#444; border-radius:4px; margin-bottom:8px;"></div>
        <div class="card-name">${card.name}</div>
        <div class="card-type ${card.type}">${card.type === 'passive' ? 'Pasiva' : 'Activa'}${card.cooldown ? ` · ${card.cooldown}s` : ''}</div>
        <div class="card-desc">${card.description}</div>
      `;

      // Heart toggle (stop propagation to not trigger card select)
      const heartBtn = el.querySelector('.card-fav-btn');
      const heartHandler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleFavorite(card.id);
      };
      heartBtn.addEventListener('click', heartHandler);
      heartBtn.addEventListener('touchstart', heartHandler, { passive: false });

      // Card select toggle
      el.addEventListener('click', () => toggleCard(card, el));
      el.addEventListener('touchstart', (e) => {
        // Only toggle if not tapping heart
        if (e.target.closest('.card-fav-btn')) return;
        e.preventDefault();
        toggleCard(card, el);
      }, { passive: false });

      cardGrid.appendChild(el);
    }
  }

  function toggleFavorite(id) {
    if (favorites.has(id)) {
      favorites.delete(id);
    } else {
      favorites.add(id);
    }
    saveFavorites();
    // Update tab label count
    const favCount = favorites.size;
    tabFavs.textContent = favCount > 0 ? `❤ Favoritas (${favCount})` : '♡ Favoritas';
    renderCardGrid();
  }

  function toggleCard(card, el) {
    if (selectedCards.some(c => c.id === card.id)) {
      selectedCards = selectedCards.filter(c => c.id !== card.id);
      el.classList.remove('selected');
    } else if (selectedCards.length < 5) {
      selectedCards.push(card);
      el.classList.add('selected');
    }
    cardCounter.textContent = `${selectedCards.length} / 5`;
  }

  // ── Pack Logic ─────────────────────────────────────────────────────────
  const btnOpenPack = $('#btnOpenPack');
  const packOverlay = $('#packOverlay');
  const packCardsContainer = $('#packCardsContainer');
  const btnClosePack = $('#btnClosePack');
  const packLimitText = $('#packLimitText');

  let freePacksOpened = parseInt(localStorage.getItem('snakeFreePacks') || '0', 10);
  
  function updatePackButton() {
    if (freePacksOpened >= 3) {
      btnOpenPack.classList.add('disabled');
      btnOpenPack.style.opacity = '0.5';
      btnOpenPack.style.pointerEvents = 'none';
      if(packLimitText) packLimitText.textContent = '3/3';
    } else {
      if(packLimitText) packLimitText.textContent = `${freePacksOpened}/3`;
    }
  }
  updatePackButton();

  btnOpenPack.addEventListener('click', () => {
    if (freePacksOpened >= 3) return;
    socket.emit('openPack');
  });

  btnClosePack.addEventListener('click', () => {
    packOverlay.classList.remove('active');
    renderCardGrid();
  });

  socket.on('packOpened', (packCards) => {
    freePacksOpened++;
    localStorage.setItem('snakeFreePacks', freePacksOpened.toString());
    updatePackButton();
    
    packCardsContainer.innerHTML = '';
    
    // Assign to owned collection
    for (const card of packCards) {
        ownedCards.push(card);
    }
    saveCollection();

    // Render in overlay
    packCards.forEach(card => {
      const isFaved = favorites.has(card.id);
      
      const el = document.createElement('div');
      el.classList.add('pack-card');
      el.innerHTML = `
        <button class="card-fav-btn ${isFaved ? 'faved' : ''}" data-fav-id="${card.id}" title="${isFaved ? 'Quitar de favoritas' : 'Agregar a favoritas'}">${isFaved ? '❤' : '♡'}</button>
        <div class="card-image-placeholder" style="width:100%; height:80px; background:#444; border-radius:4px; margin-bottom:8px;"></div>
        <div class="pack-name">${card.name}</div>
        <div class="pack-type ${card.type}">${card.type === 'passive' ? 'Pasiva' : 'Activa'}</div>
        <div class="pack-desc">${card.description}</div>
      `;

      const heartBtn = el.querySelector('.card-fav-btn');
      const heartHandler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (favorites.has(card.id)) {
          favorites.delete(card.id);
          heartBtn.classList.remove('faved');
          heartBtn.textContent = '♡';
          heartBtn.title = 'Agregar a favoritas';
        } else {
          favorites.add(card.id);
          heartBtn.classList.add('faved');
          heartBtn.textContent = '❤';
          heartBtn.title = 'Quitar de favoritas';
        }
        saveFavorites();
        const favCount = favorites.size;
        tabFavs.textContent = favCount > 0 ? `❤ Favoritas (${favCount})` : '♡ Favoritas';
      };
      
      heartBtn.addEventListener('click', heartHandler);
      heartBtn.addEventListener('touchstart', heartHandler, { passive: false });

      packCardsContainer.appendChild(el);
    });

    packOverlay.classList.add('active');
  });

  // ── Find Match & Sacrifice ─────────────────────────────────────────────
  const sacrificeOverlay = $('#sacrificeOverlay');
  const sacrificeCardsContainer = $('#sacrificeCardsContainer');
  const sacrificeEmptyMsg = $('#sacrificeEmptyMsg');
  const btnCancelSacrifice = $('#btnCancelSacrifice');

  btnFindMatch.addEventListener('click', () => {
    sacrificeCardsContainer.innerHTML = '';
    let sacCount = 0;

    for (const card of ownedCards) {
      if (favorites.has(card.id)) continue; // Don't show favorites
      
      sacCount++;
      const el = document.createElement('div');
      el.classList.add('pack-card');
      el.style.cursor = 'pointer';
      
      el.innerHTML = `
        <div class="card-image-placeholder" style="width:100%; height:80px; background:#444; border-radius:4px; margin-bottom:8px;"></div>
        <div class="pack-name" style="color: var(--danger);">${card.name}</div>
        <div class="pack-type ${card.type}">${card.type === 'passive' ? 'Pasiva' : 'Activa'}</div>
        <div class="pack-desc">${card.description}</div>
      `;
      
      el.addEventListener('click', () => {
        // Sacrifice it!
        const objIdx = ownedCards.findIndex(c => c.id === card.id);
        if (objIdx > -1) ownedCards.splice(objIdx, 1);
        
        saveCollection();
        sacrificeOverlay.classList.remove('active');
        
        const selIdx = selectedCards.findIndex(c => c.id === card.id);
        if (selIdx > -1) selectedCards.splice(selIdx, 1);

        renderCardGrid();

        // Start search
        btnFindMatch.disabled = true;
        const name = playerNameInput.value.trim() || 'Player';
        socket.emit('findMatch', { name, cards: selectedCards });
      });
      
      sacrificeCardsContainer.appendChild(el);
    }
    
    sacrificeEmptyMsg.style.display = sacCount === 0 ? 'block' : 'none';
    sacrificeOverlay.classList.add('active');
  });

  btnCancelSacrifice.addEventListener('click', () => {
    sacrificeOverlay.classList.remove('active');
  });

  socket.on('waiting', () => {
    waitingOverlay.classList.add('active');
  });

  socket.on('matchFound', ({ roomId, players }) => {
    waitingOverlay.classList.remove('active');
    myId = socket.id;
    showScreen(gameScreen);

    // Set up HUD player names/colors
    const me = players.find(p => p.id === myId);
    const opp = players.find(p => p.id !== myId);

    if (me && opp) {
      hudP1Name.textContent = me.name;
      hudP2Name.textContent = opp.name;
    }

    // Build card HUD
    buildCardHud(me ? me.cards : []);
    resizeCanvas();
  });

  socket.on('countdown', (num) => {
    countdownOverlay.classList.add('active');
    countdownNumber.textContent = num;
    countdownNumber.style.animation = 'none';
    // Trigger reflow
    void countdownNumber.offsetWidth;
    countdownNumber.style.animation = 'countPulse 1s ease-in-out';
  });

  socket.on('gameStart', () => {
    countdownOverlay.classList.remove('active');
    startRenderLoop();
  });

  // ── Game State ─────────────────────────────────────────────────────────
  socket.on('gameState', (state) => {
    prevState = gameState;
    gameState = state;
    lastTickTime = performance.now();
    lerpT = 0;
    updateHud(state);
    updateCardHud(state);
  });

  socket.on('gameOver', (result) => {
    stopRenderLoop();
    showResult(result);
  });

  // ── HUD Update ─────────────────────────────────────────────────────────
  function updateHud(state) {
    if (!state || !state.players) return;

    const me = state.players.find(p => p.id === myId);
    const opp = state.players.find(p => p.id !== myId);

    if (me) {
      hudP1Name.textContent = me.name;
      hudP1Score.textContent = me.score;
      hudP1Dot.style.background = me.color;
    }
    if (opp) {
      hudP2Name.textContent = opp.name;
      hudP2Score.textContent = opp.score;
      hudP2Dot.style.background = opp.color;
    }

    const mins = Math.floor(state.timeLeft / 60);
    const secs = state.timeLeft % 60;
    hudTimer.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
    hudTimer.classList.toggle('danger', state.timeLeft <= 15);
  }

  // ── Card HUD ───────────────────────────────────────────────────────────
  const CARD_HOTKEYS = ['Q', 'W', 'E', 'R', 'T'];
  let cardHudOrder = []; // track card IDs in order for hotkey mapping

  function buildCardHud(cards) {
    cardHud.innerHTML = '';
    cardHudOrder = [];
    let hotkeyIdx = 0;
    
    // cards are full object literals now
    for (const card of cards) {
      if (card.type !== 'active') continue;

      const hotkey = CARD_HOTKEYS[hotkeyIdx] || '';
      cardHudOrder.push(card.id);
      hotkeyIdx++;

      const btn = document.createElement('div');
      btn.classList.add('card-btn');
      btn.dataset.cardId = card.id;
      // Storing original cooldown for percentage calc
      btn.dataset.baseCooldown = card.cooldown;
      
      btn.innerHTML = `
        ${hotkey ? `<span class="card-hotkey">${hotkey}</span>` : ''}
        <div class="card-label" style="font-size: 0.65rem; margin-top: 0; line-height: 1.1; text-align: center;">${card.name}</div>
        <div class="cooldown-overlay"></div>
        <div class="cooldown-text"></div>
      `;

      const handler = (e) => {
        e.preventDefault();
        socket.emit('useCard', { cardId: card.id });
      };
      btn.addEventListener('click', handler);
      btn.addEventListener('touchstart', handler, { passive: false });

      cardHud.appendChild(btn);
    }
  }

  function updateCardHud(state) {
    if (!state) return;
    const me = state.players.find(p => p.id === myId);
    if (!me) return;

    const btns = cardHud.querySelectorAll('.card-btn');
    btns.forEach(btn => {
      const cardId = btn.dataset.cardId;
      const baseCooldown = parseFloat(btn.dataset.baseCooldown) || 1;
      const cd = me.cooldowns[cardId] || 0;

      const overlayEl = btn.querySelector('.cooldown-overlay');
      const textEl = btn.querySelector('.cooldown-text');

      if (cd > 0) {
        btn.classList.add('on-cooldown');
        const pct = (cd / baseCooldown) * 100;
        overlayEl.style.height = pct + '%';
        textEl.textContent = Math.ceil(cd) + 's';
      } else {
        btn.classList.remove('on-cooldown');
        overlayEl.style.height = '0%';
        textEl.textContent = '';
      }

      // Active effect highlight (now handled by tracking effects on players)
      // Active effects object maps templateId or uuid to state
      // Since templateId varies, generic active effect coloring might need tweaking later.
      if (me.activeEffects[cardId] && me.activeEffects[cardId] > 0) {
        btn.classList.add('active-effect');
      } else {
        btn.classList.remove('active-effect');
      }
    });
  }

  // ── Canvas Rendering ───────────────────────────────────────────────────
  let cellSize = 0;

  function resizeCanvas() {
    const wrapper = canvas.parentElement;
    const wrapperW = wrapper.clientWidth;
    const wrapperH = wrapper.clientHeight;

    const gridW = gameState ? gameState.gridW : 30;
    const gridH = gameState ? gameState.gridH : 30;

    cellSize = Math.floor(Math.min(wrapperW / gridW, wrapperH / gridH));
    canvas.width = cellSize * gridW;
    canvas.height = cellSize * gridH;
    canvas.style.width = canvas.width + 'px';
    canvas.style.height = canvas.height + 'px';
  }

  window.addEventListener('resize', resizeCanvas);

  function startRenderLoop() {
    stopRenderLoop();
    function loop() {
      render();
      animFrameId = requestAnimationFrame(loop);
    }
    animFrameId = requestAnimationFrame(loop);
  }

  function stopRenderLoop() {
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
  }

  function render() {
    if (!gameState) return;
    resizeCanvas();

    const { gridW, gridH, players, apples, walls } = gameState;

    // Clear
    ctx.fillStyle = '#0a0e1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 0.5;
    for (let x = 0; x <= gridW; x++) {
      ctx.beginPath();
      ctx.moveTo(x * cellSize, 0);
      ctx.lineTo(x * cellSize, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y <= gridH; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * cellSize);
      ctx.lineTo(canvas.width, y * cellSize);
      ctx.stroke();
    }

    // ── Apples ──
    for (const apple of apples) {
      const cx = apple.x * cellSize + cellSize / 2;
      const cy = apple.y * cellSize + cellSize / 2;
      const r = cellSize * 0.4;

      // Glow
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, cellSize);
      glow.addColorStop(0, 'rgba(239, 68, 68, 0.25)');
      glow.addColorStop(1, 'rgba(239, 68, 68, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(apple.x * cellSize - cellSize * 0.5, apple.y * cellSize - cellSize * 0.5, cellSize * 2, cellSize * 2);

      // Apple body
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();

      // Shine
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.beginPath();
      ctx.arc(cx - r * 0.25, cy - r * 0.25, r * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }

    // ── Walls ──
    if (walls) {
      for (const w of walls) {
        const x = w.x * cellSize;
        const y = w.y * cellSize;
        
        ctx.fillStyle = '#475569'; // Base stone color
        roundRect(ctx, x + 1, y + 1, cellSize - 2, cellSize - 2, 3);
        ctx.fill();
        
        // Inner highlights/details to look like a wall
        ctx.fillStyle = '#64748b';
        ctx.fillRect(x + 3, y + 3, cellSize - 6, cellSize / 2 - 4);
        ctx.fillRect(x + 3, y + cellSize / 2 + 1, cellSize - 6, cellSize / 2 - 4);
      }
    }

    // ── Snakes ──
    for (const player of players) {
      if (!player.alive && player.body.length === 0) continue;

      const isMe = player.id === myId;
      const isGhost = !player.alive;
      const isSpectral = player.activeEffects && player.activeEffects.modo_espectro > 0;
      const baseColor = player.color || (isMe ? '#00f0ff' : '#ff3e8e');
      
      let alpha = isSpectral ? 0.45 : 1;
      if (!isMe && player.camuflado) {
        alpha = 0.15; // Barely visible
      }

      if (isGhost) {
        // Intermittently flashes between ghost and solid. Phase offset by player ID so they blink independently.
        const phaseOffset = player.id.charCodeAt(0) * 100;
        alpha = 0.6 + Math.sin((performance.now() + phaseOffset) / 150) * 0.4;
      }

      for (let i = player.body.length - 1; i >= 0; i--) {
        const seg = player.body[i];
        const x = seg.x * cellSize;
        const y = seg.y * cellSize;
        const pad = i === 0 ? 0 : 1;

        // Body gradient (fade to darker toward tail)
        const fade = 1 - (i / (player.body.length + 5)) * 0.6;
        ctx.globalAlpha = alpha * fade;

        if (i === 0) {
          // Head — slightly larger, rounded
          const headPad = -1;
          ctx.fillStyle = baseColor;
          roundRect(ctx, x + headPad, y + headPad, cellSize - headPad * 2, cellSize - headPad * 2, 4);
          ctx.fill();

          // Eyes
          ctx.globalAlpha = alpha;
          ctx.fillStyle = '#0a0e1a';
          const eyeR = cellSize * 0.12;
          const eyeOff = cellSize * 0.22;

          if (player.dir === 'right' || player.dir === 'left') {
            const eyeX = player.dir === 'right' ? x + cellSize * 0.65 : x + cellSize * 0.35;
            ctx.beginPath();
            ctx.arc(eyeX, y + cellSize * 0.3, eyeR, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(eyeX, y + cellSize * 0.7, eyeR, 0, Math.PI * 2);
            ctx.fill();
          } else {
            const eyeY = player.dir === 'down' ? y + cellSize * 0.65 : y + cellSize * 0.35;
            ctx.beginPath();
            ctx.arc(x + cellSize * 0.3, eyeY, eyeR, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(x + cellSize * 0.7, eyeY, eyeR, 0, Math.PI * 2);
            ctx.fill();
          }
        } else {
          ctx.fillStyle = baseColor;
          roundRect(ctx, x + pad, y + pad, cellSize - pad * 2, cellSize - pad * 2, 3);
          ctx.fill();
        }
      }

      ctx.globalAlpha = 1;

      // Spectral aura
      if (isSpectral && alpha > 0.3) {
        const head = player.body[0];
        if (head) {
          const cx = head.x * cellSize + cellSize / 2;
          const cy = head.y * cellSize + cellSize / 2;
          const aura = ctx.createRadialGradient(cx, cy, 0, cx, cy, cellSize * 2);
          aura.addColorStop(0, 'rgba(168, 85, 247, 0.2)');
          aura.addColorStop(1, 'rgba(168, 85, 247, 0)');
          ctx.fillStyle = aura;
          ctx.fillRect(cx - cellSize * 2, cy - cellSize * 2, cellSize * 4, cellSize * 4);
        }
      }
    }

    // ── Ceguera Nocturna (Blindness) ──
    const me = players.find(p => p.id === myId);
    if (me && me.activeEffects && me.activeEffects.ceguera > 0 && me.body.length > 0) {
      const head = me.body[0];
      const hx = head.x * cellSize + cellSize / 2;
      const hy = head.y * cellSize + cellSize / 2;
      
      const grad = ctx.createRadialGradient(hx, hy, cellSize * 1.5, hx, hy, cellSize * 5);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,0.98)');
      
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // ── Input: Keyboard ────────────────────────────────────────────────────
  const KEY_MAP = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  };

  const HOTKEY_MAP = { q: 0, w: 1, e: 2, r: 3, t: 4, Q: 0, W: 1, E: 2, R: 3, T: 4 };

  document.addEventListener('keydown', (e) => {
    const dir = KEY_MAP[e.key];
    if (dir) {
      e.preventDefault();
      socket.emit('input', { dir });
      return;
    }

    // Card hotkeys Q, W, E, R, T
    if (e.key in HOTKEY_MAP) {
      const idx = HOTKEY_MAP[e.key];
      if (idx < cardHudOrder.length) {
        e.preventDefault();
        socket.emit('useCard', { cardId: cardHudOrder[idx] });
      }
    }
  });

  // ── Input: D-Pad (touch) ───────────────────────────────────────────────
  document.querySelectorAll('.dpad-btn').forEach(btn => {
    const dir = btn.dataset.dir;

    const sendDir = (e) => {
      e.preventDefault();
      socket.emit('input', { dir });
    };

    btn.addEventListener('touchstart', sendDir, { passive: false });
    btn.addEventListener('mousedown', sendDir);
  });

  // ── Input: Swipe (touch) ───────────────────────────────────────────────
  let touchStartX = 0;
  let touchStartY = 0;
  const SWIPE_THRESHOLD = 30;

  canvas.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
  }, { passive: true });

  canvas.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;

    if (Math.abs(dx) < SWIPE_THRESHOLD && Math.abs(dy) < SWIPE_THRESHOLD) return;

    let dir;
    if (Math.abs(dx) > Math.abs(dy)) {
      dir = dx > 0 ? 'right' : 'left';
    } else {
      dir = dy > 0 ? 'down' : 'up';
    }
    socket.emit('input', { dir });
  }, { passive: true });

  // ── Result Screen ──────────────────────────────────────────────────────
  function showResult(result) {
    showScreen(resultScreen);

    if (result.disconnected) {
      resultDisconnect.style.display = 'block';
    } else {
      resultDisconnect.style.display = 'none';
    }

    if (result.tie) {
      resultLabel.textContent = '¡Empate!';
      resultWinner.textContent = '🤝';
    } else if (result.winner) {
      const isMe = result.winner.id === myId;
      resultLabel.textContent = isMe ? '¡Victoria!' : 'Derrota';
      resultWinner.textContent = result.winner.name;
    }

    resultScores.innerHTML = '';
    for (const s of result.scores) {
      const div = document.createElement('div');
      div.classList.add('result-player');
      const isMe = s.id === myId;
      div.innerHTML = `
        <div class="rp-name" style="color: ${isMe ? '#00f0ff' : '#ff3e8e'}">${s.name}</div>
        <div class="rp-score">${s.score}</div>
      `;
      resultScores.appendChild(div);
    }
  }

  btnPlayAgain.addEventListener('click', () => {
    selectedCards = [];
    cardCounter.textContent = '0 / 5';
    btnFindMatch.disabled = false;
    switchTab('all');
    showScreen(lobbyScreen);
  });

  // ── Prevent zoom/scroll on mobile ──────────────────────────────────────
  document.addEventListener('touchmove', (e) => {
    if (gameScreen.classList.contains('active')) {
      e.preventDefault();
    }
  }, { passive: false });
})();
