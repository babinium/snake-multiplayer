const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── CONFIGURATION ──────────────────────────────────────────────────────────
const PORT = 3000;
const TICK_RATE = 15;
const TICK_INTERVAL = 1000 / TICK_RATE;
const GRID_W = 40;
const GRID_H = 40;
const MATCH_DURATION = 120; // seconds
const INITIAL_SNAKE_LENGTH = 3;
const APPLE_MAX = 2;
const POINTS_PER_APPLE = 10;

const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { v4: uuidv4 } = require('uuid');

// ─── CARD LOGIC (DYNAMIC CSV PARSE) ─────────────────────────────────────────
let CARD_POOL = [];

try {
  const fileData = fs.readFileSync(path.join(__dirname, 'estadisticas_cartas.csv'), 'utf8');
  CARD_POOL = parse(fileData, { columns: true, skip_empty_lines: true });
  console.log(`Loaded ${CARD_POOL.length} card templates from CSV.`);
} catch (e) {
  console.error("Error loading estadisticas_cartas.csv", e);
}

function generateCardInstance(template) {
  let value = 0;
  let desc = template.Descripcion;
  let cooldownNum = 0;
  
  if (template['Tiempo de Reuso'] && template['Tiempo de Reuso'] !== '-') {
    if (template['Tiempo de Reuso'].toLowerCase().includes('una vez')) {
      cooldownNum = 9999;
    } else {
      const cdMatch = template['Tiempo de Reuso'].match(/([\d.]+)/);
      if (cdMatch) cooldownNum = parseFloat(cdMatch[1]);
    }
  }
  
  const rangeStr = template['Rango de Valor Potencial'];
  const rangeMatch = rangeStr ? rangeStr.match(/\[(.*?) - (.*?)\](.*)/) : null;
  if (rangeMatch) {
    const min = parseFloat(rangeMatch[1].replace(/[^\d.-]/g, ''));
    const max = parseFloat(rangeMatch[2].replace(/[^\d.-]/g, ''));
    const unitPart = rangeMatch[3] || '';
    
    const stepStr = template['Incremento de Variante'];
    const stepMatch = stepStr ? stepStr.match(/([\d.]+)/) : null;
    const step = stepMatch ? parseFloat(stepMatch[1]) : 1;
    
    const finalStep = step > 0 ? step : 1;
    const stepsCount = Math.floor((max - min) / finalStep);
    const randomStep = Math.floor(Math.random() * (stepsCount + 1));
    value = min + randomStep * finalStep;
    
    value = Math.round(value * 1000) / 1000;
    
    let displayValue = value.toString();
    if (rangeStr.includes('%')) {
        displayValue += '%';
    } else if (unitPart.trim() && !unitPart.includes('%')) {
        displayValue += ` ${unitPart.trim()}`;
    }
    
    desc = desc.replace('[rango]', displayValue);
  }

  const tid = template['Nombre de la Carta'].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, '_');

  return {
    id: uuidv4(),
    templateId: tid,
    name: template['Nombre de la Carta'],
    type: template['Tipo'].toLowerCase() === 'activa' ? 'active' : 'passive',
    cooldown: cooldownNum,
    description: desc,
    value: value
  };
}

// ─── GAME ROOMS ─────────────────────────────────────────────────────────────
const rooms = {};
let waitingPlayer = null;

function randomPos(exclude = []) {
  let pos;
  let attempts = 0;
  do {
    pos = { x: Math.floor(Math.random() * GRID_W), y: Math.floor(Math.random() * GRID_H) };
    attempts++;
  } while (attempts < 500 && exclude.some(p => p.x === pos.x && p.y === pos.y));
  return pos;
}

function createSnake(startX, startY, dir) {
  const body = [];
  for (let i = 0; i < INITIAL_SNAKE_LENGTH; i++) {
    body.push({
      x: startX - (dir === 'right' ? i : dir === 'left' ? -i : 0),
      y: startY - (dir === 'down' ? i : dir === 'up' ? -i : 0),
    });
  }
  return body;
}

function spawnApples(room) {
  if (room.apples.length > 0) return; // Only spawn when field is empty
  const occupied = [];
  for (const pid of Object.keys(room.players)) {
    occupied.push(...room.players[pid].body);
  }
  const count = 1 + Math.floor(Math.random() * APPLE_MAX); // 1 or 2
  for (let i = 0; i < count; i++) {
    const pos = randomPos([...occupied, ...room.apples]);
    room.apples.push(pos);
  }
}

function createRoom(roomId) {
  return {
    id: roomId,
    players: {},
    apples: [],
    walls: [], // { x, y, ownerId, ttl }
    tickTimer: null,
    timeLeft: MATCH_DURATION,
    timeAccum: 0,
    state: 'waiting', // waiting | countdown | playing | finished
    countdownValue: 3,
  };
}

function initPlayer(socket, name, cards, startX, startY, dir, color) {
  // cards is now an array of full card objects
  const validCards = (cards || []).slice(0, 5);
  const cooldowns = {};
  const activeEffects = {};
  validCards.forEach(c => {
    if (c.type === 'active') {
      cooldowns[c.id] = 0;
    }
  });

  const hasPiel = validCards.find(c => c.templateId === 'piel_gruesa');
  const snakeLen = hasPiel ? Math.max(INITIAL_SNAKE_LENGTH, Math.floor(hasPiel.value)) : INITIAL_SNAKE_LENGTH;
  
  const body = [];
  for (let i = 0; i < snakeLen; i++) {
    body.push({
      x: startX - (dir === 'right' ? i : dir === 'left' ? -i : 0),
      y: startY - (dir === 'down' ? i : dir === 'up' ? -i : 0),
    });
  }

  const hasRayo = validCards.find(c => c.templateId === 'rayo_veloz');
  const speedBoost = !!hasRayo;
  const speedBonus = hasRayo ? (hasRayo.value / 100) : 0; 
  // currently standard speedBoost gives +0.5 multiplier, we can keep the boolean flag but augment it later

  return {
    id: socket.id,
    name: name || 'Player',
    body: body,
    dir: dir,
    nextDir: dir,
    score: 0,
    cards: validCards,
    cooldowns: cooldowns,
    activeEffects: activeEffects,
    color: color,
    alive: true,
    speedBoost: speedBoost,
    speedBonus: speedBonus,
    speedAccum: 0,
  };
}

function prepareRespawn(player) {
  const dirs = ['right', 'left', 'up', 'down'];
  const dir = dirs[Math.floor(Math.random() * dirs.length)];
  const sx = 5 + Math.floor(Math.random() * (GRID_W - 10));
  const sy = 5 + Math.floor(Math.random() * (GRID_H - 10));
  
  const hasPiel = player.cards.find(c => c.templateId === 'piel_gruesa');
  const snakeLen = hasPiel ? Math.max(INITIAL_SNAKE_LENGTH, Math.floor(hasPiel.value)) : INITIAL_SNAKE_LENGTH;
  
  const body = [];
  for (let i = 0; i < snakeLen; i++) {
    body.push({
      x: sx - (dir === 'right' ? i : dir === 'left' ? -i : 0),
      y: sy - (dir === 'down' ? i : dir === 'up' ? -i : 0),
    });
  }
  
  player.body = body;
  player.dir = dir;
  player.nextDir = dir;
  player.score = Math.floor(player.score / 2); // future: apply seguro de vida here 
  player.activeEffects = {};
}

// ─── DIRECTION HELPERS ──────────────────────────────────────────────────────
const DIR_VEC = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const OPPOSITE = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

// ─── GAME TICK ──────────────────────────────────────────────────────────────
function gameTick(room) {
  if (room.state !== 'playing') return;

  const playerIds = Object.keys(room.players);

  // Update timer
  room.timeAccum += TICK_INTERVAL;
  if (room.timeAccum >= 1000) {
    room.timeAccum -= 1000;
    room.timeLeft--;
    if (room.timeLeft <= 0) {
      endGame(room);
      return;
    }
  }

  // Decay wall TTLs
  room.walls = room.walls.filter(w => {
    w.ttl -= TICK_INTERVAL / 1000;
    return w.ttl > 0;
  });

  // Process each player
  for (const pid of playerIds) {
    const p = room.players[pid];
    if (!p.alive) continue;

    // Frozen? Skip movement
    if (p.activeEffects.congelacion && p.activeEffects.congelacion > 0) {
      // Still update cooldowns/effects below, but skip movement
    } else {
      // Apply direction (with poison inversion)
      let desiredDir = p.nextDir;
      if (p.activeEffects.veneno && p.activeEffects.veneno > 0) {
        desiredDir = OPPOSITE[desiredDir];
      }
      if (desiredDir !== OPPOSITE[p.dir]) {
        p.dir = desiredDir;
      }

      // Determine move count (speed boost)
      let speedMult = 1.0;

      // 1. Rayo Veloz
      const rayoInfo = p.cards.find(c => c.templateId === 'rayo_veloz');
      if (rayoInfo) speedMult += rayoInfo.value / 100;

      // 2. Frenesí Asesino
      if (p.activeEffects.frenesi_asesino > 0) speedMult += 0.5;

      // Opponent debuffs
      const opponent = playerIds.map(id => room.players[id]).find(op => op.id !== p.id);
      if (opponent && opponent.alive) {
        // 3. Grilletes
        const grillInfo = opponent.cards.find(c => c.templateId === 'grilletes');
        if (grillInfo) speedMult -= grillInfo.value / 100;
        
        // 4. Aura Pesada
        const auraInfo = opponent.cards.find(c => c.templateId === 'aura_pesada');
        if (auraInfo) {
          const dx = Math.abs(p.body[0].x - opponent.body[0].x);
          const dy = Math.abs(p.body[0].y - opponent.body[0].y);
          if (dx + dy <= 3) speedMult -= auraInfo.value / 100;
        }
      }

      // 5. Aceleración Térmica
      const termInfo = p.cards.find(c => c.templateId === 'aceleracion_termica');
      if (termInfo) {
        const aliveSecs = p.timeAlive || 0;
        speedMult += Math.floor(aliveSecs / 10) * (termInfo.value / 100);
      }

      // 6. Transferencia Cinética (Steal buff)
      if (p.activeEffects.transferencia_cinetica > 0) speedMult += 0.3;
      if (p.activeEffects.transferencia_cinetica_debuff > 0) speedMult -= 0.3;

      // 7. Persecución Magnética
      const perseInfo = p.cards.find(c => c.templateId === 'persecucion_magnetica');
      if (perseInfo && room.apples.length > 0) {
        const head = p.body[0];
        const target = room.apples[0];
        const vec = DIR_VEC[p.dir];
        if (
          (vec.x === 1 && target.x > head.x && target.y === head.y) ||
          (vec.x === -1 && target.x < head.x && target.y === head.y) ||
          (vec.y === 1 && target.y > head.y && target.x === head.x) ||
          (vec.y === -1 && target.y < head.y && target.x === head.x)
        ) {
          speedMult += perseInfo.value / 100;
        }
      }

      // Active skills manual override
      if (p.speedBoost) speedMult += 0.5;

      speedMult = Math.max(0.1, speedMult);
      p.speedAccum += speedMult;
      p.timeAlive = (p.timeAlive || 0) + (TICK_INTERVAL / 1000);

      let moves = 0;
      while (p.speedAccum >= 1.0) {
        p.speedAccum -= 1.0;
        moves++;
      }

      for (let m = 0; m < moves; m++) {
        const head = p.body[0];
        const vec = DIR_VEC[p.dir];
        let newHead = { x: head.x + vec.x, y: head.y + vec.y };

        const isSpectral = p.activeEffects.modo_espectro && p.activeEffects.modo_espectro > 0;
        const hasShield = p.activeEffects.escudo && p.activeEffects.escudo > 0;

        const siluetaInfo = p.cards.find(c=>c.templateId==='silueta_fina');
        const evadeHitbox = siluetaInfo && Math.random() < (siluetaInfo.value / 100);

        // Wall collision (borders)
        if (newHead.x < 0 || newHead.x >= GRID_W || newHead.y < 0 || newHead.y >= GRID_H) {
          if (isSpectral || evadeHitbox) {
            newHead.x = ((newHead.x % GRID_W) + GRID_W) % GRID_W;
            newHead.y = ((newHead.y % GRID_H) + GRID_H) % GRID_H;
          } else if (hasShield) {
            delete p.activeEffects.escudo;
            break;
          } else {
            const gomaInfo = p.cards.find(c=>c.templateId==='serpiente_de_goma');
            p.bounces = p.bounces || 0;
            if (gomaInfo && p.bounces < gomaInfo.value) {
               p.bounces++;
               p.dir = OPPOSITE[p.dir];
               p.nextDir = p.dir;
               break;
            }
            killPlayer(room, p);
            break;
          }
        }

        // Placed wall collision
        if (!isSpectral && !evadeHitbox && room.walls.some(w => w.x === newHead.x && w.y === newHead.y && w.ownerId !== p.id)) {
          if (hasShield) {
            delete p.activeEffects.escudo;
            break;
          } else {
            killPlayer(room, p);
            break;
          }
        }

        // Self collision
        if (!isSpectral && !evadeHitbox && p.body.some((seg, i) => i > 0 && seg.x === newHead.x && seg.y === newHead.y)) {
          if (hasShield) {
            delete p.activeEffects.escudo;
            break;
          } else {
            killPlayer(room, p);
            break;
          }
        }

        // Opponent collision
        const opponent = playerIds.map(id => room.players[id]).find(op => op.id !== p.id);
        if (!isSpectral && opponent && opponent.alive) {
          if (opponent.body.some(seg => seg.x === newHead.x && seg.y === newHead.y)) {
             const espInfo = p.cards.find(c=>c.templateId==='espejismo');
             const evadeFrontal = espInfo && Math.random() < (espInfo.value / 100);
             if (evadeFrontal) {
                p.activeEffects.escudo = 1; // grant 1s invuln to ghost through safely next tick
                break;
             }
             if (hasShield) {
                delete p.activeEffects.escudo;
                break;
             } else {
                killPlayer(room, p);
                break;
             }
          }
        }

        // Move
        p.body.unshift(newHead);

        // Check apple
        const appleIdx = room.apples.findIndex(a => a.x === newHead.x && a.y === newHead.y);
        if (appleIdx !== -1) {
          const apple = room.apples[appleIdx];
          
          if (apple.type === 'poison') {
             p.score = Math.max(0, p.score - 10);
             room.apples.splice(appleIdx, 1);
          } else {
             const opponent = playerIds.map(id => room.players[id]).find(op => op.id !== p.id);
             
             // Base point calculation
             let pts = apple.type === 'golden' ? POINTS_PER_APPLE * 3 : POINTS_PER_APPLE;
             
             const multInfo = p.cards.find(c=>c.templateId==='multiplicador');
             if (multInfo) pts += multInfo.value;
             
             const heroInfo = p.cards.find(c=>c.templateId==='espiritu_heroico');
             if (heroInfo && opponent && p.score < opponent.score) {
                pts += pts * (heroInfo.value / 100);
             }
             
             p.score += Math.floor(pts);
             
             // Esteroides
             const estInfo = p.cards.find(c=>c.templateId==='esteroides');
             if (estInfo) {
                const grows = Math.floor(estInfo.value);
                for(let g=0; g<grows; g++) {
                    p.body.push({...p.body[p.body.length-1]});
                }
             }

             // Momento Perfecto
             p.consecutiveApples = (p.consecutiveApples || 0) + 1;
             if (p.consecutiveApples >= 5) {
                const mpInfo = p.cards.find(c=>c.templateId==='momento_perfecto');
                if (mpInfo) p.score += Math.floor(pts * (mpInfo.value / 100)); // Percentage bonus of the apple
                p.consecutiveApples = 0; // reset combo
             }
             
             // Gula Tóxica
             const gulaInfo = p.cards.find(c=>c.templateId==='gula_toxica');
             if (gulaInfo && opponent) {
                opponent.score = Math.max(0, opponent.score - gulaInfo.value);
             }
             
             // Cronófago
             const cronoInfo = p.cards.find(c=>c.templateId==='cronofago');
             if (cronoInfo) {
                for (const cardId of Object.keys(p.cooldowns)) {
                   p.cooldowns[cardId] = Math.max(0, p.cooldowns[cardId] * (1 - cronoInfo.value / 100));
                }
             }

             // Espinas Venenosas
             const espinasInfo = p.cards.find(c=>c.templateId==='espinas_venenosas');
             if (espinasInfo && Math.random() < (espinasInfo.value / 100)) {
                // Spawn a poison apple directly behind the snake
                const tail = p.body[p.body.length-1];
                room.apples.push({ x: tail.x, y: tail.y, type: 'poison' });
             }

             // Albañil Nato
             const albaInfo = p.cards.find(c=>c.templateId==='albanil_nato');
             if (albaInfo && Math.random() < (albaInfo.value / 100)) {
                room.walls.forEach(w => {
                   if (w.ownerId === p.id) w.ttl += 5; // restore wall health
                });
             }

             // Transferencia Cinética (5% to 15% steal buff)
             const tranInfo = p.cards.find(c=>c.templateId==='transferencia_cinetica');
             if (tranInfo && Math.random() < (tranInfo.value / 100)) {
                p.activeEffects.transferencia_cinetica = 5;
                if (opponent) opponent.activeEffects.transferencia_cinetica_debuff = 5;
             }

             // Cosecha Abundante
             const cosechaInfo = p.cards.find(c=>c.templateId==='cosecha_abundante');
             if (cosechaInfo && Math.random() < (cosechaInfo.value / 100)) {
                // Relocate immediately instead of consuming
                apple.x = Math.floor(Math.random() * GRID_W);
                apple.y = Math.floor(Math.random() * GRID_H);
             } else {
                room.apples.splice(appleIdx, 1);
             }
          }
          p.timeSinceLastMeal = 0; // reset logic
        } else {
          p.body.pop();
        }

        // Passive: cola_corta — cap body length
        if (p.cards.some(c=>c.templateId==='cola_corta') && p.body.length > 15) {
          p.body.length = 15;
        }
      }
    } // end of movement block

    // Update cooldowns
    for (const cardId of Object.keys(p.cooldowns)) {
      if (p.cooldowns[cardId] > 0) {
        p.cooldowns[cardId] = Math.max(0, p.cooldowns[cardId] - TICK_INTERVAL / 1000);
      }
    }

    // Update active effects & Passive Trackers
    p.timeSinceLastMeal = (p.timeSinceLastMeal || 0) + (TICK_INTERVAL / 1000);
    const dietaInfo = p.cards.find(c => c.templateId === 'dieta_estricta');
    if (dietaInfo && p.timeSinceLastMeal >= dietaInfo.value) {
      if (p.body.length > 1) p.body.pop();
      p.timeSinceLastMeal = 0;
    }

    // 10-second tick tracker
    p.tenSecTimer = (p.tenSecTimer || 0) + (TICK_INTERVAL / 1000);
    if (p.tenSecTimer >= 10) {
       p.tenSecTimer -= 10;
       
       const interesInfo = p.cards.find(c=>c.templateId==='interes_compuesto');
       if (interesInfo) p.score += Math.floor(interesInfo.value);
       
       const sangInfo = p.cards.find(c=>c.templateId==='sanguijuela');
       if (sangInfo) {
          const opponent = playerIds.map(id => room.players[id]).find(op => op.id !== p.id);
          if (opponent) {
             const steal = Math.min(opponent.score, Math.floor(sangInfo.value));
             opponent.score -= steal;
             p.score += steal;
          }
       }
    }

    for (const eff of Object.keys(p.activeEffects)) {
      p.activeEffects[eff] -= TICK_INTERVAL / 1000;
      if (p.activeEffects[eff] <= 0) {
        delete p.activeEffects[eff];
      }
    }
  }

  // Passive: iman OR micro_gravedad — attract nearby apples
  for (const pid of playerIds) {
    const p = room.players[pid];
    if (!p.alive) continue;
    
    let pullDist = 0;
    const imanInfo = p.cards.find(c=>c.templateId==='iman');
    if (imanInfo) pullDist = Math.max(pullDist, imanInfo.value);
    
    const microInfo = p.cards.find(c=>c.templateId==='micro_gravedad');
    if (microInfo) pullDist = Math.max(pullDist, microInfo.value);

    if (pullDist > 0) {
      const head = p.body[0];
      for (const apple of room.apples) {
        if (apple.type === 'poison') continue; // poison immune to gravity!
        const dx = head.x - apple.x;
        const dy = head.y - apple.y;
        const dist = Math.abs(dx) + Math.abs(dy); // Manhattan distance
        if (dist > 0 && dist <= pullDist) {
          // Move apple 1 step toward the head
          if (Math.abs(dx) >= Math.abs(dy)) {
            apple.x += Math.sign(dx);
          } else {
            apple.y += Math.sign(dy);
          }
        }
      }
    }
  }

  // Respawn apples
  spawnApples(room);

  // Broadcast state
  broadcastState(room);
}

function killPlayer(room, player) {
  const armaduraInfo = player.cards.find(c=>c.templateId==='armadura_desgastada');
  if (armaduraInfo && Math.random() < (armaduraInfo.value / 100)) {
     player.activeEffects.escudo = 2; // grant 2s invuln to escape
     return;
  }

  player.alive = false;
  player.timeAlive = 0;
  player.consecutiveApples = 0;
  player.deathCount = (player.deathCount || 0) + 1;

  const playerIds = Object.keys(room.players);
  const opp = playerIds.map(id => room.players[id]).find(op => op.id !== player.id);

  // Points loss
  const seguroInfo = player.cards.find(c=>c.templateId==='seguro_de_vida');
  const retainPct = seguroInfo ? (seguroInfo.value / 100) : 0;
  const lostScore = Math.floor(player.score * (0.5 - (0.5 * retainPct)));
  player.score = Math.max(0, player.score - lostScore);

  if (opp) {
    opp.activeEffects.frenesi_asesino = 5;

    // --- Carroñero ---
    const carrInfo = opp.cards.find(c=>c.templateId==='carronero');
    if (carrInfo) opp.score += Math.floor(lostScore * (carrInfo.value / 100));

    // --- Último Aliento ---
    const alientoInfo = player.cards.find(c=>c.templateId==='ultimo_aliento');
    if (alientoInfo) opp.score = Math.max(0, opp.score - Math.floor(alientoInfo.value));

    // --- Humillación ---
    opp.deathCount = 0;
    if (player.deathCount >= 3) {
       const humInfo = opp.cards.find(c=>c.templateId==='humillacion');
       if (humInfo) {
           player.score = Math.max(0, player.score + Math.floor(humInfo.value));
           player.deathCount = 0;
       }
    }
    
    // --- Supernova Helada ---
    const supernovaInfo = player.cards.find(c=>c.templateId==='supernova_helada');
    if (supernovaInfo) {
       const dx = Math.abs(player.body[0].x - opp.body[0].x);
       const dy = Math.abs(player.body[0].y - opp.body[0].y);
       if (dx + dy <= supernovaInfo.value) opp.activeEffects.congelacion = 3;
    }
  }

  // --- Maldición Post-Mortem ---
  const maldInfo = player.cards.find(c=>c.templateId==='maldicion_post-mortem');
  if (maldInfo && room.apples.length > 0) {
     const idx = Math.floor(Math.random() * room.apples.length);
     room.apples[idx].type = 'poison';
  }

  prepareRespawn(player);
  player.bounces = 0;

  const regenInfo = player.cards.find(c=>c.templateId==='regeneracion');
  const respawnMs = regenInfo ? Math.floor(regenInfo.value * 1000) : 5000;
  
  setTimeout(() => {
    if (room.state === 'playing') {
      player.alive = true;
      const angelInfo = player.cards.find(c=>c.templateId==='angel_guardian');
      if (angelInfo) player.activeEffects.escudo = angelInfo.value;
    }
  }, respawnMs);
}

function endGame(room) {
  room.state = 'finished';
  clearInterval(room.tickTimer);

  const playerIds = Object.keys(room.players);
  let winner = null;
  let winnerScore = -1;
  let tie = false;

  for (const pid of playerIds) {
    const p = room.players[pid];
    if (p.score > winnerScore) {
      winnerScore = p.score;
      winner = p;
      tie = false;
    } else if (p.score === winnerScore) {
      tie = true;
    }
  }

  const result = {
    winner: tie ? null : { id: winner.id, name: winner.name },
    tie: tie,
    scores: playerIds.map(pid => ({
      id: pid,
      name: room.players[pid].name,
      score: room.players[pid].score,
    })),
  };

  io.to(room.id).emit('gameOver', result);

  // Cleanup after a delay
  setTimeout(() => {
    delete rooms[room.id];
  }, 10000);
}

function broadcastState(room) {
  const playerIds = Object.keys(room.players);
  const state = {
    players: playerIds.map(pid => {
      const p = room.players[pid];

      const camInfo = p.cards.find(c=>c.templateId==='camuflaje_activo');
      let camuflado = false;
      if (camInfo) {
         camuflado = Math.floor(room.timeLeft / Math.max(1, Math.floor(camInfo.value))) % 2 === 0;
      }

      return {
        id: p.id,
        name: p.name,
        body: p.body,
        dir: p.dir,
        score: p.score,
        color: p.color,
        alive: p.alive,
        cards: p.cards,
        cooldowns: { ...p.cooldowns },
        activeEffects: { ...p.activeEffects },
        camuflado: camuflado
      };
    }),
    apples: room.apples,
    walls: room.walls,
    timeLeft: room.timeLeft,
    gridW: GRID_W,
    gridH: GRID_H,
  };
  io.to(room.id).emit('gameState', state);
}

// ─── CARD ACTIVATION ────────────────────────────────────────────────────────
function activateCard(room, player, cardId) {
  const cardDef = player.cards.find(c => c.id === cardId);
  if (!cardDef || cardDef.type !== 'active') return;
  if (player.cooldowns[cardId] > 0) return;

  const playerIds = Object.keys(room.players);
  const opponent = playerIds.map(id => room.players[id]).find(op => op.id !== player.id);

  switch (cardDef.templateId) {
    case 'dash': {
      const vec = DIR_VEC[player.dir];
      const head = player.body[0];
      
      let dashDist = Math.floor(cardDef.value) || 4;
      const saltoInfo = player.cards.find(c=>c.templateId==='gran_salto');
      if (saltoInfo) dashDist += Math.floor(saltoInfo.value);

      const newHead = {
        x: head.x + vec.x * dashDist,
        y: head.y + vec.y * dashDist,
      };
      const isSpectral = player.activeEffects.modo_espectro && player.activeEffects.modo_espectro > 0;
      if (isSpectral) {
        newHead.x = ((newHead.x % GRID_W) + GRID_W) % GRID_W;
        newHead.y = ((newHead.y % GRID_H) + GRID_H) % GRID_H;
      } else {
        newHead.x = Math.max(0, Math.min(GRID_W - 1, newHead.x));
        newHead.y = Math.max(0, Math.min(GRID_H - 1, newHead.y));
      }
      player.body.unshift(newHead);
      ensureBodyLength(player); // simple tail pop logic later
      player.body.pop();
      break;
    }
    case 'magia_frutal': {
      const fertInfo = p.cards.find(c=>c.templateId==='fertilizante');
      const fertRate = fertInfo ? (fertInfo.value / 100) : 0;
      for (let i = 0; i < 3; i++) {
        const isGold = Math.random() < fertRate;
        room.apples.push({ 
          x: Math.floor(Math.random() * GRID_W), 
          y: Math.floor(Math.random() * GRID_H),
          type: isGold ? 'golden' : 'normal'
        });
      }
      break;
    }
    case 'arbol_sagrado': {
      for (let i = 0; i < 3; i++) {
        room.apples.push({ 
          x: Math.floor(Math.random() * GRID_W), 
          y: Math.floor(Math.random() * GRID_H),
          type: 'golden'
        });
      }
      break;
    }
    case 'modo_espectro': {
      const p = player;
      let defInfo = p.cards.find(c=>c.templateId==='maestria_defensiva');
      let extra = defInfo ? defInfo.value : 0;
      
      const vagaInfo = p.cards.find(c=>c.templateId==='vagabundo_del_vacio');
      if (vagaInfo) extra += vagaInfo.value; // Extrapolates out-of-bounds duration logic simply by extending time
      
      player.activeEffects.modo_espectro = (cardDef.value || 4) + extra;
      break;
    }
    case 'escudo': {
      const p = player;
      const defInfo = p.cards.find(c=>c.templateId==='maestria_defensiva');
      const extra = defInfo ? defInfo.value : 0;
      player.activeEffects.escudo = (cardDef.value || 5) + extra;
      break;
    }
    case 'congelacion': {
      if (opponent && opponent.alive) {
        const espejoInfo = opponent.cards.find(c=>c.templateId==='espejo_karmico');
        if (espejoInfo && Math.random() < (espejoInfo.value / 100)) {
           player.activeEffects.congelacion = cardDef.value || 3;
        } else {
           const aceroInfo = opponent.cards.find(c=>c.templateId==='piel_de_acero');
           const reduct = aceroInfo ? (1 - aceroInfo.value / 100) : 1;
           opponent.activeEffects.congelacion = (cardDef.value || 3) * reduct;
        }
      }
      break;
    }
    case 'veneno': {
      if (opponent && opponent.alive) {
        const espejoInfo = opponent.cards.find(c=>c.templateId==='espejo_karmico');
        if (espejoInfo && Math.random() < (espejoInfo.value / 100)) {
           player.activeEffects.veneno = cardDef.value || 4;
        } else {
           const aceroInfo = opponent.cards.find(c=>c.templateId==='piel_de_acero');
           const reduct = aceroInfo ? (1 - aceroInfo.value / 100) : 1;
           opponent.activeEffects.veneno = (cardDef.value || 4) * reduct;
        }
      }
      break;
    }
    case 'teletransporte': {
      const occupied = [];
      const p = player;
      for (const pid of playerIds) {
        occupied.push(...room.players[pid].body);
      }
      occupied.push(...room.walls);
      const safePos = randomPos(occupied);
      const dirs = ['right', 'left', 'up', 'down'];
      const newDir = dirs[Math.floor(Math.random() * dirs.length)];
      player.body = createSnake(safePos.x, safePos.y, newDir);
      player.dir = newDir;
      player.nextDir = newDir;
      break;
    }
    case 'muro': {
      const oppVec = DIR_VEC[OPPOSITE[player.dir]];
      const tail = player.body[player.body.length - 1];
      const p = player;
      
      let wallLen = Math.floor(cardDef.value) || 3;
      const archiInfo = p.cards.find(c=>c.templateId==='gran_arquitecto');
      if (archiInfo) wallLen += Math.floor(archiInfo.value);

      const concInfo = p.cards.find(c=>c.templateId==='concreto_reforzado');
      const wallTtl = 15 + (concInfo ? Math.floor(concInfo.value) : 0);

      for (let i = 1; i <= wallLen; i++) {
        const wx = tail.x + oppVec.x * i;
        const wy = tail.y + oppVec.y * i;
        if (wx >= 0 && wx < GRID_W && wy >= 0 && wy < GRID_H) {
          const onBody = playerIds.some(pid => room.players[pid].body.some(s => s.x === wx && s.y === wy));
          if (!onBody) {
            room.walls.push({ x: wx, y: wy, ownerId: player.id, ttl: wallTtl });
          }
        }
      }
      break;
    }
    case 'robo': {
      const p = player;
      if (opponent) {
        let stolen = Math.min(Math.floor(cardDef.value) || 15, opponent.score);
        
        const granInfo = p.cards.find(c=>c.templateId==='gran_ladron');
        if (granInfo) stolen += granInfo.value;
        
        const bovedaInfo = opponent.cards.find(c=>c.templateId==='boveda_cerrada');
        if (bovedaInfo) stolen = Math.floor(stolen * (1 - bovedaInfo.value / 100));

        opponent.score -= stolen;
        player.score += stolen;
      }
      break;
    }
    case 'manipula-tiempo': {
      const timeCut = Math.floor(cardDef.value) || 10;
      room.timeLeft = Math.max(1, room.timeLeft - timeCut);
      break;
    }
    case 'ceguera_nocturna': {
      if (opponent && opponent.alive) {
         opponent.activeEffects.ceguera = cardDef.value || 5;
      }
      break;
    }
  }

  let finalCd = cardDef.cooldown > 0 ? cardDef.cooldown : 10;
  
  const relojInfo = player.cards.find(c=>c.templateId==='reloj_magico');
  if (relojInfo) finalCd *= (1 - relojInfo.value / 100);
  
  if (opponent && opponent.alive) {
     const sabInfo = opponent.cards.find(c=>c.templateId==='sabotaje_magico');
     if (sabInfo) finalCd += sabInfo.value;
     
     if (player.body.length >= 13) {
        const obesInfo = opponent.cards.find(c=>c.templateId==='obesidad_forzada');
        if (obesInfo) finalCd += obesInfo.value;
     }
  }

  player.cooldowns[cardId] = finalCd;
}

// Ensure body pops on dash
function ensureBodyLength(player) {
  // dummy function as pop handles basic logic, but could be extended
}

// ─── SOCKET HANDLING ────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`⚡ Player connected: ${socket.id}`);

  // Dynamic endpoint to open pack on demand
  socket.on('openPack', () => {
    if (CARD_POOL.length === 0) return;
    const pack = [];
    for (let i = 0; i < 5; i++) {
        const rIndex = Math.floor(Math.random() * CARD_POOL.length);
        pack.push(generateCardInstance(CARD_POOL[rIndex]));
    }
    socket.emit('packOpened', pack);
  });

  socket.on('findMatch', ({ name, cards }) => {
    const playerName = (name || 'Player').substring(0, 16);
    // cards should be valid UUID objects sent from the client
    const playerCards = (cards || []).slice(0, 5);

    if (waitingPlayer && waitingPlayer.socket.id !== socket.id && waitingPlayer.socket.connected) {
      // Create room
      const roomId = 'room_' + Date.now();
      const room = createRoom(roomId);
      rooms[roomId] = room;

      const wp = waitingPlayer;
      waitingPlayer = null;

      // Initialize players
      room.players[wp.socket.id] = initPlayer(wp.socket, wp.name, wp.cards, 5, Math.floor(GRID_H / 2), 'right', '#00f0ff');
      room.players[socket.id] = initPlayer(socket, playerName, playerCards, GRID_W - 6, Math.floor(GRID_H / 2), 'left', '#ff3e8e');

      wp.socket.join(roomId);
      socket.join(roomId);

      wp.socket.roomId = roomId;
      socket.roomId = roomId;

      // Spawn apples
      spawnApples(room);

      // Countdown
      room.state = 'countdown';
      room.countdownValue = 3;

      io.to(roomId).emit('matchFound', {
        roomId,
        players: [
          { id: wp.socket.id, name: wp.name, cards: wp.cards },
          { id: socket.id, name: playerName, cards: playerCards },
        ],
      });

      let countdown = 3;
      const countdownInterval = setInterval(() => {
        io.to(roomId).emit('countdown', countdown);
        countdown--;
        if (countdown < 0) {
          clearInterval(countdownInterval);
          room.state = 'playing';
          room.tickTimer = setInterval(() => gameTick(room), TICK_INTERVAL);
          io.to(roomId).emit('gameStart');
          broadcastState(room);
        }
      }, 1000);

    } else {
      waitingPlayer = { socket, name: playerName, cards: playerCards };
      socket.emit('waiting');
    }
  });

  socket.on('input', ({ dir }) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const player = room.players[socket.id];
    if (!player || !player.alive) return;

    if (['up', 'down', 'left', 'right'].includes(dir) && dir !== OPPOSITE[player.dir]) {
      player.nextDir = dir;
    }
  });

  socket.on('useCard', ({ cardId }) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    if (room.state !== 'playing') return;
    const player = room.players[socket.id];
    if (!player || !player.alive) return;

    activateCard(room, player, cardId);
  });

  socket.on('disconnect', () => {
    console.log(`💔 Player disconnected: ${socket.id}`);

    if (waitingPlayer && waitingPlayer.socket.id === socket.id) {
      waitingPlayer = null;
    }

    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      if (room.state === 'playing' || room.state === 'countdown') {
        // End game, other player wins
        const otherId = Object.keys(room.players).find(id => id !== socket.id);
        if (otherId) {
          const other = room.players[otherId];
          room.state = 'finished';
          clearInterval(room.tickTimer);
          io.to(roomId).emit('gameOver', {
            winner: { id: other.id, name: other.name },
            tie: false,
            scores: Object.keys(room.players).map(pid => ({
              id: pid,
              name: room.players[pid].name,
              score: room.players[pid].score,
            })),
            disconnected: true,
          });
          setTimeout(() => delete rooms[roomId], 5000);
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`🐍 Snake server running on http://localhost:${PORT}`);
});
