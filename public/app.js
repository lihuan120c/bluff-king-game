const socket = io({ reconnection: true, reconnectionDelay: 1000, reconnectionAttempts: Infinity });

let myNickname = '';
let myAccount = '';
let currentRoomId = null;
let currentRoomState = null;
let pendingJoinRoomId = null;

// --- 断线重连 ---
socket.on('connect', () => {
  if (myAccount) {
    socket.emit('login', { account: myAccount }, (res) => {
      if (res.ok) {
        myNickname = res.nickname;
        if (currentRoomId) {
          socket.emit('rejoinRoom', { roomId: currentRoomId }, (rr) => {
            if (rr.ok) {
              showPage('page-room');
            } else {
              currentRoomId = null;
              currentRoomState = null;
              showPage('page-lobby');
              socket.emit('getRooms');
            }
          });
        } else {
          showPage('page-lobby');
          socket.emit('getRooms');
        }
        announce('已重新连接');
      }
    });
  }
});

socket.on('disconnect', () => {
  if (myAccount) announce('连接断开，正在重连...');
});

// --- Page Navigation ---
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// --- Auth ---
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('form-login').classList.toggle('hidden', tab !== 'login');
    document.getElementById('form-register').classList.toggle('hidden', tab !== 'register');
    document.getElementById('auth-msg').textContent = '';
  });
});

document.getElementById('btn-register').addEventListener('click', () => {
  const account = document.getElementById('reg-account').value.trim();
  const nickname = document.getElementById('reg-nickname').value.trim();
  if (!account || !nickname) return showAuthMsg('请填写账号和昵称', false);
  socket.emit('register', { account, nickname }, (res) => {
    if (res.ok) {
      showAuthMsg('注册成功，请登录！', true);
      document.querySelectorAll('.tab-btn')[0].click();
      document.getElementById('login-account').value = account;
    } else {
      showAuthMsg(res.msg, false);
    }
  });
});

document.getElementById('btn-login').addEventListener('click', () => {
  const account = document.getElementById('login-account').value.trim();
  if (!account) return showAuthMsg('请输入账号', false);
  socket.emit('login', { account }, (res) => {
    if (res.ok) {
      myNickname = res.nickname;
      myAccount = account;
      document.getElementById('lobby-user').textContent = myNickname;
      document.getElementById('dropdown-nickname').textContent = myNickname;
      document.getElementById('dropdown-account').textContent = '账号: ' + account;
      showPage('page-lobby');
      socket.emit('getRooms');
    } else {
      showAuthMsg(res.msg, false);
    }
  });
});

function showAuthMsg(msg, success) {
  const el = document.getElementById('auth-msg');
  el.textContent = msg;
  el.className = 'msg' + (success ? ' success' : '');
}

// --- User dropdown ---
document.getElementById('lobby-user').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('user-dropdown').classList.toggle('hidden');
});
document.addEventListener('click', () => {
  document.getElementById('user-dropdown').classList.add('hidden');
});
document.getElementById('user-dropdown').addEventListener('click', (e) => {
  e.stopPropagation();
});
document.getElementById('btn-logout').addEventListener('click', () => {
  myNickname = '';
  myAccount = '';
  currentRoomId = null;
  currentRoomState = null;
  document.getElementById('user-dropdown').classList.add('hidden');
  document.getElementById('login-account').value = '';
  showPage('page-auth');
  socket.disconnect();
  socket.connect();
});

// --- Lobby ---
const createFormEl = document.getElementById('create-room-form');
const needPwdEl = document.getElementById('room-need-pwd');
const roomPwdEl = document.getElementById('room-pwd');

document.getElementById('btn-show-create').addEventListener('click', () => {
  createFormEl.classList.toggle('hidden');
});
document.getElementById('btn-cancel-create').addEventListener('click', () => {
  createFormEl.classList.add('hidden');
});

needPwdEl.addEventListener('change', () => {
  roomPwdEl.classList.toggle('hidden', !needPwdEl.checked);
});

document.getElementById('btn-create-room').addEventListener('click', () => {
  const name = document.getElementById('room-name').value.trim() || '未命名房间';
  const password = needPwdEl.checked ? roomPwdEl.value.trim() : '';
  socket.emit('createRoom', { name, password }, (res) => {
    if (res.ok) {
      currentRoomId = res.roomId;
      showPage('page-room');
      createFormEl.classList.add('hidden');
    }
  });
});

socket.on('roomList', (rooms) => {
  const list = document.getElementById('room-list');
  if (rooms.length === 0) {
    list.innerHTML = '<p class="empty-hint">暂无房间，快来创建一个吧！</p>';
    return;
  }
  list.innerHTML = rooms.map(r => `
    <div class="room-card" data-id="${r.id}">
      <div class="room-info">
        <h3>${esc(r.name)} ${r.hasPassword ? '🔒' : ''}</h3>
        <div class="room-meta">
          <span>房主: ${esc(r.creator)}</span>
          <span>👥 ${r.playerCount}</span>
          ${r.started
            ? '<span class="tag tag-playing">游戏中</span>'
            : '<span class="tag tag-waiting">等待中</span>'}
        </div>
      </div>
      <button class="btn-join" ${r.started ? 'disabled' : ''}
        onclick="joinRoom('${r.id}', ${r.hasPassword}, ${r.started})">
        ${r.started ? '进行中' : '加入'}
      </button>
    </div>
  `).join('');
});

window.joinRoom = function(roomId, hasPassword, started) {
  if (started) return;
  if (hasPassword) {
    pendingJoinRoomId = roomId;
    document.getElementById('pwd-modal').classList.remove('hidden');
    document.getElementById('join-pwd').value = '';
    document.getElementById('join-pwd').focus();
  } else {
    doJoin(roomId, '');
  }
};

document.getElementById('btn-join-confirm').addEventListener('click', () => {
  const pwd = document.getElementById('join-pwd').value;
  document.getElementById('pwd-modal').classList.add('hidden');
  doJoin(pendingJoinRoomId, pwd);
});
document.getElementById('btn-join-cancel').addEventListener('click', () => {
  document.getElementById('pwd-modal').classList.add('hidden');
});

function doJoin(roomId, password) {
  socket.emit('joinRoom', { roomId, password }, (res) => {
    if (res.ok) {
      currentRoomId = roomId;
      showPage('page-room');
    } else {
      alert(res.msg);
    }
  });
}

// --- Room ---
document.getElementById('btn-leave-room').addEventListener('click', () => {
  if (currentRoomState && currentRoomState.started) {
    if (!confirm('游戏正在进行中，确定要离开吗？')) return;
  }
  socket.emit('leaveRoom', () => {
    currentRoomId = null;
    currentRoomState = null;
    showPage('page-lobby');
    socket.emit('getRooms');
  });
});

document.getElementById('btn-scoreboard').addEventListener('click', () => {
  showScoreboard();
});
document.getElementById('btn-close-score').addEventListener('click', () => {
  document.getElementById('score-modal').classList.add('hidden');
});

function showScoreboard() {
  if (!currentRoomState) return;
  const players = [...currentRoomState.players].sort((a, b) => b.score - a.score);
  const ranks = ['🥇', '🥈', '🥉'];
  document.getElementById('score-list').innerHTML = players.map((p, i) => `
    <div class="score-row">
      <span class="score-rank">${ranks[i] || (i + 1)}</span>
      <span class="score-name">${esc(p.nickname)} ${p.isCreator ? '👑' : ''}</span>
      <span class="score-pts">${p.score} 分</span>
    </div>
  `).join('');
  document.getElementById('score-modal').classList.remove('hidden');
}

socket.on('roomState', (state) => {
  currentRoomState = state;
  renderRoom(state);
});

socket.on('roomDissolved', () => {
  currentRoomId = null;
  currentRoomState = null;
  showPage('page-lobby');
  socket.emit('getRooms');
  announce('房间已被房主解散');
});

function renderRoom(state) {
  document.getElementById('room-title').textContent = state.name;

  // Player list
  const plEl = document.getElementById('player-list');
  plEl.innerHTML = state.players.map(p => {
    let cls = 'player-chip';
    if (p.isCreator) cls += ' creator';
    if (p.id === socket.id) cls += ' me';
    return `<span class="${cls}">${p.isCreator ? '👑 ' : ''}${esc(p.nickname)}${p.id === socket.id ? ' (我)' : ''}</span>`;
  }).join('');

  // Controls
  const ctrlEl = document.getElementById('room-controls');
  const isCreator = state.creatorId === socket.id;

  if (isCreator && !state.started) {
    ctrlEl.innerHTML = `
      <button class="btn-primary" id="btn-start" ${state.players.length < 3 ? 'disabled' : ''}>
        开始游戏 ${state.players.length < 3 ? '(需3人)' : ''}
      </button>
      <button class="btn-danger" id="btn-dissolve">解散房间</button>
    `;
    document.getElementById('btn-start').onclick = () => {
      socket.emit('startGame', (res) => { if (!res.ok) alert(res.msg); });
    };
    document.getElementById('btn-dissolve').onclick = () => {
      if (confirm('确定要解散房间吗？')) {
        socket.emit('dissolveRoom', () => {
          currentRoomId = null;
          currentRoomState = null;
          showPage('page-lobby');
          socket.emit('getRooms');
        });
      }
    };
  } else if (isCreator && state.started) {
    ctrlEl.innerHTML = `
      <button class="btn-warning" id="btn-pause">暂停游戏</button>
      <button class="btn-danger" id="btn-dissolve2">解散房间</button>
    `;
    document.getElementById('btn-pause').onclick = () => {
      socket.emit('pauseGame', () => {});
    };
    document.getElementById('btn-dissolve2').onclick = () => {
      if (confirm('确定要解散房间吗？')) {
        socket.emit('dissolveRoom', () => {
          currentRoomId = null;
          currentRoomState = null;
          showPage('page-lobby');
          socket.emit('getRooms');
        });
      }
    };
  } else {
    ctrlEl.innerHTML = '';
  }

  // Game area
  const gameEl = document.getElementById('game-area');
  if (!state.started || !state.gameState) {
    gameEl.innerHTML = '<p style="color:var(--text-dim);padding:40px 0;">等待房主开始游戏...</p>';
    return;
  }

  renderGameState(state.gameState, gameEl);
}

function renderGameState(gs, el) {
  const phase = gs.phase;

  if (phase === 'choosing') {
    if (gs.wordOptions && gs.guesserId === socket.id) {
      el.innerHTML = `
        <div class="phase-label">选词阶段</div>
        <p>你是本轮的<span class="role-badge role-guesser">猜词人</span></p>
        <p style="color:var(--text-dim);font-size:13px;margin:8px 0;">请从以下词条中选择一个：</p>
        <div class="word-options">
          ${gs.wordOptions.map(w => `
            <button class="word-option-btn" onclick="selectWord('${esc(w.name)}')">${esc(w.name)}</button>
          `).join('')}
        </div>
        <button class="btn-refresh" onclick="refreshWords()">🔄 换一批词条</button>
      `;
    } else {
      el.innerHTML = `
        <div class="phase-label">选词阶段</div>
        <p style="font-size:16px;">猜词人 <strong>${esc(gs.guesserNickname)}</strong> 正在选择词条...</p>
        <div class="timer-display pulse">🤔</div>
      `;
    }
  } else if (phase === 'countdown_reveal') {
    el.innerHTML = `
      <div class="phase-label">词条揭晓</div>
      <div class="word-display fade-in">${esc(gs.wordName)}</div>
      <p style="color:var(--text-dim);">即将进入看题环节...</p>
    `;
  } else if (phase === 'viewing') {
    let roleHtml = '';
    if (gs.role === 'honest') {
      roleHtml = `
        <span class="role-badge role-honest">老实人</span>
        <div class="word-desc">${esc(gs.wordDescription)}</div>
      `;
    } else if (gs.role === 'guesser') {
      roleHtml = `<span class="role-badge role-guesser">猜词人</span>`;
    } else {
      roleHtml = `<span class="role-badge role-bluffer">瞎掰人</span>`;
    }
    el.innerHTML = `
      <div class="phase-label">看题阶段</div>
      <div class="word-display">${esc(gs.wordName)}</div>
      ${roleHtml}
      <div class="timer-display">${gs.timer || 0}s</div>
      <p style="color:var(--text-dim);font-size:12px;">认真记忆词条信息！</p>
    `;
  } else if (phase === 'preparing') {
    let roleHtml = '';
    if (gs.role === 'honest') roleHtml = '<span class="role-badge role-honest">老实人</span>';
    else if (gs.role === 'guesser') roleHtml = '<span class="role-badge role-guesser">猜词人</span>';
    else roleHtml = '<span class="role-badge role-bluffer">瞎掰人</span>';

    el.innerHTML = `
      <div class="phase-label">准备环节</div>
      <div class="word-display">${esc(gs.wordName)}</div>
      ${roleHtml}
      <div class="timer-display">${gs.timer || 0}s</div>
      <p style="color:var(--text-dim);font-size:12px;">准备好你的回答！</p>
    `;
  } else if (phase === 'answering') {
    let roleHtml = '';
    if (gs.role === 'honest') roleHtml = '<span class="role-badge role-honest">老实人</span>';
    else if (gs.role === 'guesser') roleHtml = '<span class="role-badge role-guesser">猜词人</span>';
    else if (gs.role === 'bluffer') roleHtml = '<span class="role-badge role-bluffer">瞎掰人</span>';

    el.innerHTML = `
      <div class="phase-label">🎤 开始答题！</div>
      <div class="word-display">${esc(gs.wordName)}</div>
      ${roleHtml}
      <div class="order-list">
        <p style="color:var(--text-dim);font-size:13px;margin-bottom:8px;">答题顺序：</p>
        ${gs.answerOrder.map((p, i) => `
          <div class="order-item">
            <span class="order-num">${i + 1}</span>
            <span>${esc(p.nickname)} ${p.id === socket.id ? '(我)' : ''}</span>
          </div>
        `).join('')}
      </div>
      ${gs.guesserId === socket.id ? `
        <button class="btn-primary" style="width:100%;margin-top:12px;" onclick="startJudging()">
          所有人答完了，开始判断
        </button>
      ` : '<p style="color:var(--text-dim);font-size:13px;margin-top:12px;">等待所有人线下答题完毕...</p>'}
    `;
  } else if (phase === 'judging') {
    if (gs.isJudging) {
      renderJudgingUI(el, gs);
    } else {
      el.innerHTML = `
        <div class="phase-label">判断阶段</div>
        <div class="word-display">${esc(gs.wordName)}</div>
        <p style="font-size:16px;">猜词人 <strong>${esc(gs.guesserNickname)}</strong> 正在做出判断...</p>
        <div class="timer-display pulse">🧐</div>
      `;
    }
  } else if (phase === 'reveal') {
    const jr = gs.judgmentResult;
    const rr = gs.revealResult;
    let resultHtml = '';
    if (jr) {
      resultHtml += `
        <div class="result-box">
          <p>猜词人的判断：</p>
          <p>老实人 → <strong>${esc(jr.chosenHonestNickname)}</strong></p>
          <p>瞎掰王 → <strong>${esc(jr.chosenBluffKingNickname)}</strong></p>
        </div>
      `;
    }
    if (rr) {
      resultHtml += `
        <div class="result-box" style="margin-top:12px;">
          <p class="${rr.correct ? 'result-correct' : 'result-wrong'}">
            ${rr.correct ? '✅ 猜对了！' : '❌ 猜错了！'}
          </p>
          <p>真正的老实人是：<strong>${esc(rr.realHonestNickname)}</strong></p>
          ${rr.correct
            ? '<p style="color:var(--success);">猜词人和老实人各 +1 分</p>'
            : `<p style="color:var(--danger);">${esc(jr.chosenHonestNickname)} 骗过了猜词人，+2 分</p>`
          }
        </div>
      `;
    } else {
      resultHtml += '<p style="margin-top:16px;color:var(--text-dim);">即将揭晓真相...</p>';
    }
    el.innerHTML = `
      <div class="phase-label">揭晓结果</div>
      <div class="word-display">${esc(gs.wordName)}</div>
      ${resultHtml}
    `;
  } else if (phase === 'gameOver') {
    const players = [...currentRoomState.players].sort((a, b) => b.score - a.score);
    const ranks = ['🥇', '🥈', '🥉'];
    el.innerHTML = `
      <div class="phase-label">🎉 游戏结束</div>
      <h2 style="margin:16px 0;">最终排名</h2>
      ${players.map((p, i) => `
        <div class="score-row" style="margin-bottom:6px;">
          <span class="score-rank">${ranks[i] || (i + 1)}</span>
          <span class="score-name">${esc(p.nickname)}</span>
          <span class="score-pts">${p.score} 分</span>
        </div>
      `).join('')}
    `;
  } else if (phase === 'no_words') {
    el.innerHTML = `
      <div class="phase-label">词库已空</div>
      <p>所有词条都已经玩过了！</p>
    `;
  } else {
    el.innerHTML = '<p style="color:var(--text-dim);">等待中...</p>';
  }
}

// Judging UI state
let judgeHonestId = null;
let judgeBluffKingId = null;

function renderJudgingUI(el, gs) {
  const otherPlayers = currentRoomState.players.filter(p => p.id !== gs.guesserId);

  el.innerHTML = `
    <div class="phase-label">判断阶段</div>
    <div class="word-display">${esc(gs.wordName)}</div>
    <div class="judge-section">
      <div class="judge-label">选择你认为的 <strong style="color:var(--success);">老实人</strong>：</div>
      <div class="judge-players" id="judge-honest">
        ${otherPlayers.map(p => `
          <button class="judge-player-btn ${judgeHonestId === p.id ? 'selected' : ''}"
            onclick="pickHonest('${p.id}')">${esc(p.nickname)}</button>
        `).join('')}
      </div>
      <div class="judge-label">选择你认为的 <strong style="color:var(--danger);">瞎掰王</strong>：</div>
      <div class="judge-players" id="judge-king">
        ${otherPlayers.map(p => `
          <button class="judge-player-btn ${judgeBluffKingId === p.id ? 'selected-king' : ''}"
            onclick="pickBluffKing('${p.id}')">${esc(p.nickname)}</button>
        `).join('')}
      </div>
      <button class="btn-primary" style="width:100%;"
        ${judgeHonestId && judgeBluffKingId ? '' : 'disabled'}
        onclick="submitJudgment()">确认判断</button>
    </div>
  `;
}

window.pickHonest = function(id) {
  judgeHonestId = id;
  if (judgeBluffKingId === id) judgeBluffKingId = null;
  renderRoom(currentRoomState);
};

window.pickBluffKing = function(id) {
  judgeBluffKingId = id;
  if (judgeHonestId === id) judgeHonestId = null;
  renderRoom(currentRoomState);
};

window.submitJudgment = function() {
  if (!judgeHonestId || !judgeBluffKingId) return;
  socket.emit('submitJudgment', { honestId: judgeHonestId, bluffKingId: judgeBluffKingId }, () => {
    judgeHonestId = null;
    judgeBluffKingId = null;
  });
};

window.selectWord = function(name) {
  socket.emit('selectWord', { wordName: name }, (res) => {
    if (!res.ok) alert('选择失败');
  });
};

window.refreshWords = function() {
  socket.emit('refreshWords', (res) => {
    if (!res.ok) alert(res.msg || '刷新失败');
  });
};

window.startJudging = function() {
  judgeHonestId = null;
  judgeBluffKingId = null;
  socket.emit('startJudging', () => {});
};

// --- Announcements ---
socket.on('announcement', (msg) => {
  announce(msg);
});

function announce(msg) {
  const container = document.getElementById('announcements');
  const div = document.createElement('div');
  div.className = 'announce-item';
  div.textContent = msg;
  container.appendChild(div);
  setTimeout(() => { div.remove(); }, 4000);
}

// --- Utility ---
function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
