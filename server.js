const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
const { WORD_LIBRARY } = require('./words');
const { User, PlayedWords } = require('./models');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/bluffking';
let dbConnected = false;
mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 }).then(() => {
  dbConnected = true;
  console.log('MongoDB 连接成功');
}).catch(err => {
  console.error('MongoDB 连接失败:', err.message);
  console.log('将使用内存模式运行（数据不会持久化）');
});
mongoose.connection.on('connected', () => { dbConnected = true; });
mongoose.connection.on('disconnected', () => { dbConnected = false; });

// 房间与会话状态（内存）。玩家身份一律以 account 为准，socket.id 仅用于消息路由
const rooms = new Map();
const accountSockets = new Map();      // account -> socket.id
const playedWordsByAccount = new Map(); // account -> Set<wordName>
const memoryUsers = new Map();          // 数据库不可用时的降级存储

function getSocketByAccount(account) {
  const sid = accountSockets.get(account);
  return sid ? io.sockets.sockets.get(sid) : null;
}

function emitToPlayer(account, event, data) {
  const s = getSocketByAccount(account);
  if (s) s.emit(event, data);
}

function announceRoom(roomId, msg) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const p of room.players) emitToPlayer(p.account, 'announcement', msg);
}

function findRoomByAccount(account) {
  for (const [rid, room] of rooms) {
    if (room.players.find(p => p.account === account)) return rid;
  }
  return null;
}

function broadcastRoomList() {
  const roomList = [];
  for (const [id, room] of rooms) {
    roomList.push({
      id,
      name: room.name,
      creator: room.creatorNickname,
      hasPassword: !!room.password,
      playerCount: room.players.length,
      started: room.started
    });
  }
  io.emit('roomList', roomList);
}

function broadcastRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const playerList = room.players.map(p => ({
    account: p.account,
    nickname: p.nickname,
    score: p.score,
    online: p.online,
    isCreator: p.account === room.creatorAccount
  }));
  for (const p of room.players) {
    const sock = getSocketByAccount(p.account);
    if (sock) {
      sock.emit('roomState', {
        id: roomId,
        name: room.name,
        started: room.started,
        paused: room.paused,
        creatorAccount: room.creatorAccount,
        players: playerList,
        gameState: room.gameState ? buildPersonalGameState(room, p.account) : null
      });
    }
  }
}

function buildPersonalGameState(room, account) {
  const gs = room.gameState;
  if (!gs) return null;
  const base = {
    phase: gs.phase,
    guesserAccount: gs.guesserAccount,
    guesserNickname: gs.guesserNickname,
    roundNumber: gs.roundNumber,
    totalRounds: gs.totalRounds,
    timer: gs.timer,
    answerOrder: gs.answerOrder,
    judgmentResult: gs.judgmentResult,
    revealResult: gs.revealResult
  };

  const role = account === gs.honestAccount ? 'honest'
    : account === gs.guesserAccount ? 'guesser' : 'bluffer';

  if (gs.phase === 'choosing') {
    if (account === gs.guesserAccount) base.wordOptions = gs.wordOptions;
  } else if (['countdown_reveal', 'viewing', 'preparing', 'answering', 'judging', 'reveal'].includes(gs.phase)) {
    base.wordName = gs.wordName;
    base.categories = gs.categories;
    if (gs.phase !== 'countdown_reveal') base.role = role;
    if (gs.phase === 'viewing' && role === 'honest') {
      base.wordDescription = gs.wordDescription;
    }
    if (gs.phase === 'judging' && role === 'guesser') {
      base.isJudging = true;
    }
    if (gs.phase === 'reveal' && gs.revealResult) {
      base.wordDescription = gs.wordDescription;
      base.correctCategory = gs.correctCategory;
    }
  }

  return base;
}

function getAvailableWords(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  const usedWords = new Set();
  for (const p of room.players) {
    const played = playedWordsByAccount.get(p.account) || new Set();
    for (const w of played) usedWords.add(w);
  }
  return WORD_LIBRARY.filter(w => !usedWords.has(w.name));
}

function pickRandomWords(roomId, count = 5) {
  const available = getAvailableWords(roomId);
  const shuffled = [...available].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

// --- 统一的阶段计时器：暂停时冻结剩余秒数，恢复时继续 ---

function clearRoomTimer(roomId) {
  const room = rooms.get(roomId);
  if (room && room._timer) {
    clearInterval(room._timer);
    room._timer = null;
  }
}

function runRoomInterval(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearRoomTimer(roomId);
  room._timer = setInterval(() => {
    const r = rooms.get(roomId);
    if (!r || !r.gameState) { clearRoomTimer(roomId); return; }
    if (r.paused) return;
    r.gameState.timer--;
    broadcastRoomState(roomId);
    if (r.gameState.timer <= 0) {
      clearInterval(r._timer);
      r._timer = null;
      const next = r._timerNext;
      r._timerNext = null;
      phaseAdvance(roomId, next);
    }
  }, 1000);
}

function startPhaseTimer(roomId, seconds, nextKey) {
  const room = rooms.get(roomId);
  if (!room || !room.gameState) return;
  room.gameState.timer = seconds;
  room._timerNext = nextKey;
  broadcastRoomState(roomId);
  runRoomInterval(roomId);
}

function phaseAdvance(roomId, next) {
  const room = rooms.get(roomId);
  if (!room || !room.gameState) return;
  const gs = room.gameState;

  if (next === 'toViewing') {
    gs.phase = 'viewing';
    startPhaseTimer(roomId, 20, 'toPreparing');
  } else if (next === 'toPreparing') {
    gs.phase = 'preparing';
    announceRoom(roomId, '准备环节开始！所有人只能看到词条名称');
    startPhaseTimer(roomId, 20, 'toAnswering');
  } else if (next === 'toAnswering') {
    gs.phase = 'answering';
    gs.timer = null;
    const others = room.players.filter(p => p.account !== gs.guesserAccount);
    const shuffled = [...others].sort(() => Math.random() - 0.5);
    gs.answerOrder = shuffled.map(p => ({ account: p.account, nickname: p.nickname }));
    broadcastRoomState(roomId);
    announceRoom(roomId, '开始答题！请按顺序作答');
  } else if (next === 'toRevealResult') {
    doRevealResult(roomId);
  } else if (next === 'toNextRound') {
    if (gs.roundNumber >= gs.totalRounds) {
      finishGame(roomId);
    } else {
      startNextRound(roomId);
    }
  }
}

function startNextRound(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.started || !room.gameState) return;

  const gs = room.gameState;
  gs.roundNumber++;

  // 按开局时洗好的顺序轮换猜词人，跳过离线玩家
  let idx = (gs.roundNumber - 1) % room.players.length;
  let attempts = 0;
  while (!room.players[idx].online && attempts < room.players.length) {
    idx = (idx + 1) % room.players.length;
    attempts++;
  }
  const guesser = room.players[idx];
  gs.guesserAccount = guesser.account;
  gs.guesserNickname = guesser.nickname;
  gs.phase = 'choosing';
  gs.wordOptions = pickRandomWords(roomId, 5);
  gs.wordName = null;
  gs.wordDescription = null;
  gs.categories = null;
  gs.correctCategory = null;
  gs.honestAccount = null;
  gs.honestNickname = null;
  gs.timer = null;
  gs.answerOrder = null;
  gs.judgmentResult = null;
  gs.revealResult = null;

  if (gs.wordOptions.length === 0) {
    gs.phase = 'no_words';
    broadcastRoomState(roomId);
    return;
  }

  broadcastRoomState(roomId);
  announceRoom(roomId, `第 ${gs.roundNumber} 轮开始！猜词人是：${guesser.nickname}`);
}

function addScore(room, account, pts) {
  const p = room.players.find(x => x.account === account);
  if (p) p.score += pts;
}

function doRevealResult(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.gameState) return;
  const gs = room.gameState;
  const jr = gs.judgmentResult;
  if (!jr) return;

  const correct = jr.honestAccount === gs.honestAccount;
  const scoreLines = [];

  if (correct) {
    addScore(room, gs.guesserAccount, 2);
    addScore(room, gs.honestAccount, 1);
    scoreLines.push(`✅ 猜对老实人：${gs.guesserNickname} +2，${gs.honestNickname} +1`);
  } else {
    addScore(room, jr.honestAccount, 3);
    scoreLines.push(`❌ 猜错了：${jr.honestNickname} 瞎掰成功 +3`);
  }

  if (jr.kingAccount === gs.honestAccount) {
    addScore(room, gs.honestAccount, 2);
    scoreLines.push(`😅 把老实人当成了瞎掰王：${gs.honestNickname} +2`);
  } else {
    addScore(room, gs.guesserAccount, 1);
    addScore(room, jr.kingAccount, -1);
    scoreLines.push(`🎯 瞎掰王指认正确：${gs.guesserNickname} +1，${jr.kingNickname} 被识破 -1`);
  }

  gs.revealResult = {
    correct,
    realHonestAccount: gs.honestAccount,
    realHonestNickname: gs.honestNickname,
    scoreLines
  };

  broadcastRoomState(roomId);
  announceRoom(roomId, correct
    ? `猜对了！真正的老实人就是 ${gs.honestNickname}！`
    : `猜错了！真正的老实人是 ${gs.honestNickname}！`);

  startPhaseTimer(roomId, 8, 'toNextRound');
}

async function recordStats(room) {
  if (room.statsRecorded || room.players.length === 0) return;
  room.statsRecorded = true;
  const maxScore = Math.max(...room.players.map(p => p.score));
  if (!dbConnected) return;
  for (const p of room.players) {
    User.updateOne(
      { account: p.account },
      { $inc: { gamesPlayed: 1, totalScore: p.score, wins: p.score === maxScore ? 1 : 0 } }
    ).catch(() => {});
  }
}

function finishGame(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.gameState) return;
  clearRoomTimer(roomId);
  room._timerNext = null;
  room.paused = false;
  room.gameState.phase = 'gameOver';
  room.gameState.timer = null;
  room.started = false;
  recordStats(room);
  broadcastRoomState(roomId);
  broadcastRoomList();
  announceRoom(roomId, '游戏结束！查看最终排名');
}

// 定期清理：全员离线超过 15 分钟的房间自动销毁
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [rid, room] of rooms) {
    const allOffline = room.players.every(p => !p.online);
    if (allOffline) {
      if (!room.emptySince) {
        room.emptySince = now;
      } else if (now - room.emptySince > 15 * 60 * 1000) {
        clearRoomTimer(rid);
        rooms.delete(rid);
        changed = true;
      }
    } else {
      room.emptySince = null;
    }
  }
  if (changed) broadcastRoomList();
}, 60000);

io.on('connection', (socket) => {

  socket.on('register', async ({ account, nickname }, cb) => {
    try {
      if (!account || !nickname) return cb({ ok: false, msg: '请填写账号和昵称' });
      if (!/^[a-zA-Z0-9]+$/.test(account)) return cb({ ok: false, msg: '账号只能包含字母和数字' });
      if (dbConnected) {
        const existing = await User.findOne({ account });
        if (existing) return cb({ ok: false, msg: '账号已被注册' });
        await User.create({ account, nickname });
      } else {
        if (memoryUsers.has(account)) return cb({ ok: false, msg: '账号已被注册' });
        memoryUsers.set(account, { account, nickname });
      }
      cb({ ok: true });
    } catch (e) {
      cb({ ok: false, msg: '注册失败，请重试' });
    }
  });

  socket.on('login', async ({ account }, cb) => {
    try {
      let user;
      if (dbConnected) {
        user = await User.findOne({ account });
      } else {
        user = memoryUsers.get(account);
      }
      if (!user) return cb({ ok: false, msg: '账号不存在，请先注册' });

      // 同一账号在别处登录时，踢掉旧连接
      const oldSocket = getSocketByAccount(account);
      if (oldSocket && oldSocket.id !== socket.id) {
        oldSocket.data.account = null;
        oldSocket.data.roomId = null;
        oldSocket.emit('forceLogout');
      }

      socket.data.account = account;
      socket.data.nickname = user.nickname;
      accountSockets.set(account, socket.id);

      if (!playedWordsByAccount.has(account)) {
        if (dbConnected) {
          const record = await PlayedWords.findOne({ account });
          playedWordsByAccount.set(account, new Set(record ? record.words : []));
        } else {
          playedWordsByAccount.set(account, new Set());
        }
      }

      // 如果该账号还在某个房间里，自动恢复（断线重连/刷新页面）
      const myRoomId = findRoomByAccount(account);
      if (myRoomId) {
        const room = rooms.get(myRoomId);
        const player = room.players.find(p => p.account === account);
        player.online = true;
        socket.data.roomId = myRoomId;
        cb({ ok: true, nickname: user.nickname, roomId: myRoomId });
        broadcastRoomState(myRoomId);
        broadcastRoomList();
      } else {
        cb({ ok: true, nickname: user.nickname });
        broadcastRoomList();
      }
    } catch (e) {
      cb({ ok: false, msg: '登录失败，请重试' });
    }
  });

  socket.on('getProfile', async (cb) => {
    const account = socket.data.account;
    if (!account) return cb({ ok: false });
    try {
      if (dbConnected) {
        const u = await User.findOne({ account });
        if (!u) return cb({ ok: false });
        return cb({
          ok: true,
          nickname: u.nickname,
          account: u.account,
          gamesPlayed: u.gamesPlayed || 0,
          totalScore: u.totalScore || 0,
          wins: u.wins || 0
        });
      }
      cb({ ok: true, nickname: socket.data.nickname, account, gamesPlayed: 0, totalScore: 0, wins: 0 });
    } catch (e) {
      cb({ ok: false });
    }
  });

  socket.on('getRooms', () => {
    broadcastRoomList();
  });

  socket.on('createRoom', ({ name, password }, cb) => {
    if (!socket.data.account) return cb({ ok: false, msg: '请先登录' });
    if (socket.data.roomId) return cb({ ok: false, msg: '你已在其他房间中' });
    const roomId = 'room_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    rooms.set(roomId, {
      name: name || '未命名房间',
      password: password || null,
      creatorAccount: socket.data.account,
      creatorNickname: socket.data.nickname,
      players: [{ account: socket.data.account, nickname: socket.data.nickname, score: 0, online: true }],
      started: false,
      paused: false,
      gameState: null,
      statsRecorded: false,
      emptySince: null,
      _timer: null,
      _timerNext: null
    });
    socket.data.roomId = roomId;
    cb({ ok: true, roomId });
    broadcastRoomList();
    broadcastRoomState(roomId);
  });

  socket.on('joinRoom', ({ roomId, password }, cb) => {
    if (!socket.data.account) return cb({ ok: false, msg: '请先登录' });
    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, msg: '房间不存在' });

    const existing = room.players.find(p => p.account === socket.data.account);
    if (existing) {
      // 房间原成员：随时可回，无视密码和游戏状态
      existing.online = true;
      socket.data.roomId = roomId;
      cb({ ok: true });
      broadcastRoomList();
      broadcastRoomState(roomId);
      return;
    }

    if (room.started) return cb({ ok: false, msg: '游戏已开始，无法加入' });
    if (room.password && room.password !== password) return cb({ ok: false, msg: '密码错误' });

    room.players.push({ account: socket.data.account, nickname: socket.data.nickname, score: 0, online: true });
    socket.data.roomId = roomId;
    cb({ ok: true });
    broadcastRoomList();
    broadcastRoomState(roomId);
  });

  socket.on('leaveRoom', (cb) => {
    const roomId = socket.data.roomId;
    if (!roomId) return cb && cb({ ok: true });
    const room = rooms.get(roomId);
    socket.data.roomId = null;
    if (!room) return cb && cb({ ok: true });

    room.players = room.players.filter(p => p.account !== socket.data.account);
    if (room.players.length === 0) {
      clearRoomTimer(roomId);
      rooms.delete(roomId);
    } else if (room.creatorAccount === socket.data.account) {
      room.creatorAccount = room.players[0].account;
      room.creatorNickname = room.players[0].nickname;
    }

    broadcastRoomList();
    if (rooms.has(roomId)) broadcastRoomState(roomId);
    cb && cb({ ok: true });
  });

  socket.on('startGame', (cb) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, msg: '房间不存在' });
    if (room.creatorAccount !== socket.data.account) return cb({ ok: false, msg: '只有房主可以开始游戏' });
    if (room.players.length < 3) return cb({ ok: false, msg: '至少需要3名玩家' });

    // 随机打乱座次：猜词人顺序每局都不同
    room.players = [...room.players].sort(() => Math.random() - 0.5);
    for (const p of room.players) p.score = 0;

    room.started = true;
    room.paused = false;
    room.statsRecorded = false;
    room.gameState = {
      phase: 'waiting',
      roundNumber: 0,
      totalRounds: room.players.length * 2,
      guesserAccount: null,
      guesserNickname: null,
      wordOptions: null,
      wordName: null,
      wordDescription: null,
      categories: null,
      correctCategory: null,
      honestAccount: null,
      honestNickname: null,
      timer: null,
      answerOrder: null,
      judgmentResult: null,
      revealResult: null
    };

    cb({ ok: true });
    broadcastRoomList();
    startNextRound(roomId);
  });

  socket.on('pauseGame', (cb) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.creatorAccount !== socket.data.account) return cb({ ok: false });
    if (!room.started || !room.gameState) return cb({ ok: false });
    room.paused = true;
    clearRoomTimer(roomId); // 保留 _timerNext 和剩余秒数，继续时恢复
    cb({ ok: true });
    broadcastRoomState(roomId);
    announceRoom(roomId, '⏸ 房主暂停了游戏');
  });

  socket.on('resumeGame', (cb) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.creatorAccount !== socket.data.account) return cb({ ok: false });
    if (!room.paused) return cb({ ok: false });
    room.paused = false;
    if (room._timerNext && room.gameState && room.gameState.timer > 0) {
      runRoomInterval(roomId);
    }
    cb({ ok: true });
    broadcastRoomState(roomId);
    announceRoom(roomId, '▶ 游戏继续！');
  });

  socket.on('endGame', (cb) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.creatorAccount !== socket.data.account) return cb({ ok: false });
    if (!room.started || !room.gameState) return cb({ ok: false });
    finishGame(roomId);
    cb({ ok: true });
  });

  socket.on('dissolveRoom', (cb) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.creatorAccount !== socket.data.account) return cb({ ok: false });
    clearRoomTimer(roomId);
    for (const p of room.players) {
      const s = getSocketByAccount(p.account);
      if (s) {
        s.data.roomId = null;
        s.emit('roomDissolved');
      }
    }
    rooms.delete(roomId);
    cb({ ok: true });
    broadcastRoomList();
  });

  socket.on('refreshWords', (cb) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.gameState || room.gameState.guesserAccount !== socket.data.account) return cb({ ok: false });
    if (room.paused) return cb({ ok: false, msg: '游戏已暂停' });
    room.gameState.wordOptions = pickRandomWords(roomId, 5);
    if (room.gameState.wordOptions.length === 0) {
      return cb({ ok: false, msg: '没有更多可用词条了' });
    }
    cb({ ok: true });
    broadcastRoomState(roomId);
  });

  socket.on('selectWord', ({ wordName }, cb) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.gameState || room.gameState.guesserAccount !== socket.data.account) return cb({ ok: false });
    if (room.paused) return cb({ ok: false, msg: '游戏已暂停' });
    if (room.gameState.phase !== 'choosing') return cb({ ok: false });
    const word = room.gameState.wordOptions.find(w => w.name === wordName);
    if (!word) return cb({ ok: false });

    const gs = room.gameState;
    gs.wordName = word.name;
    gs.wordDescription = word.description;
    gs.categories = word.categories ? [...word.categories].sort(() => Math.random() - 0.5) : null;
    gs.correctCategory = word.correct || null;

    // 在线的非猜词人中随机指定老实人
    const candidates = room.players.filter(p => p.account !== gs.guesserAccount && p.online);
    const pool = candidates.length > 0 ? candidates : room.players.filter(p => p.account !== gs.guesserAccount);
    const honest = pool[Math.floor(Math.random() * pool.length)];
    gs.honestAccount = honest.account;
    gs.honestNickname = honest.nickname;

    for (const p of room.players) {
      const played = playedWordsByAccount.get(p.account) || new Set();
      played.add(word.name);
      playedWordsByAccount.set(p.account, played);
      if (dbConnected) {
        PlayedWords.findOneAndUpdate(
          { account: p.account },
          { $addToSet: { words: word.name } },
          { upsert: true }
        ).catch(() => {});
      }
    }

    gs.phase = 'countdown_reveal';
    cb({ ok: true });
    announceRoom(roomId, '猜词人已选定词条！即将揭晓...');
    startPhaseTimer(roomId, 3, 'toViewing');
  });

  socket.on('startJudging', (cb) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.gameState || room.gameState.guesserAccount !== socket.data.account) return cb({ ok: false });
    if (room.paused) return cb({ ok: false, msg: '游戏已暂停' });
    if (room.gameState.phase !== 'answering') return cb({ ok: false });
    room.gameState.phase = 'judging';
    cb({ ok: true });
    broadcastRoomState(roomId);
  });

  socket.on('submitJudgment', ({ honestAccount, kingAccount }, cb) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.gameState || room.gameState.guesserAccount !== socket.data.account) return cb({ ok: false });
    if (room.paused) return cb({ ok: false, msg: '游戏已暂停' });
    if (room.gameState.phase !== 'judging') return cb({ ok: false });

    const honestPlayer = room.players.find(p => p.account === honestAccount);
    const kingPlayer = room.players.find(p => p.account === kingAccount);
    if (!honestPlayer || !kingPlayer) return cb({ ok: false });

    room.gameState.judgmentResult = {
      honestAccount,
      honestNickname: honestPlayer.nickname,
      kingAccount,
      kingNickname: kingPlayer.nickname
    };

    room.gameState.phase = 'reveal';
    cb({ ok: true });
    announceRoom(roomId, `猜词人认为：${honestPlayer.nickname} 是老实人，${kingPlayer.nickname} 是瞎掰王`);
    startPhaseTimer(roomId, 3, 'toRevealResult');
  });

  socket.on('disconnect', () => {
    const account = socket.data.account;
    if (account && accountSockets.get(account) === socket.id) {
      accountSockets.delete(account);
    }
    const roomId = socket.data.roomId;
    if (!roomId || !account) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.find(p => p.account === account);
    if (!player) return;

    player.online = false;

    // 游戏中的房间永不自动踢人；等待中的房间离线 60 秒后移出
    if (!room.started) {
      setTimeout(() => {
        const r = rooms.get(roomId);
        if (!r || r.started) return;
        const pl = r.players.find(p => p.account === account);
        if (pl && !pl.online) {
          r.players = r.players.filter(p => p.account !== account);
          if (r.players.length === 0) {
            clearRoomTimer(roomId);
            rooms.delete(roomId);
          } else if (r.creatorAccount === account) {
            r.creatorAccount = r.players[0].account;
            r.creatorNickname = r.players[0].nickname;
          }
          broadcastRoomList();
          if (rooms.has(roomId)) broadcastRoomState(roomId);
        }
      }, 60000);
    }

    broadcastRoomList();
    broadcastRoomState(roomId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});
