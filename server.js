const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
const { WORD_LIBRARY } = require('./words');
const { User, PlayedWords } = require('./models');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/bluffking';
let dbConnected = false;
mongoose.connect(MONGODB_URI).then(() => {
  dbConnected = true;
  console.log('MongoDB 连接成功');
}).catch(err => {
  console.error('MongoDB 连接失败:', err.message);
  console.log('将使用内存模式运行（数据不会持久化）');
});
mongoose.connection.on('connected', () => { dbConnected = true; });
mongoose.connection.on('disconnected', () => { dbConnected = false; });

const rooms = new Map();
const socketPlayedWords = new Map();

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
    id: p.id,
    nickname: p.nickname,
    score: p.score,
    isCreator: p.id === room.creatorId
  }));
  const state = {
    id: roomId,
    name: room.name,
    started: room.started,
    creatorId: room.creatorId,
    players: playerList,
    gameState: room.gameState
  };
  for (const p of room.players) {
    const sock = io.sockets.sockets.get(p.id);
    if (sock) {
      const personalState = { ...state };
      if (room.gameState) {
        personalState.gameState = buildPersonalGameState(room, p.id);
      }
      sock.emit('roomState', personalState);
    }
  }
}

function buildPersonalGameState(room, playerId) {
  const gs = room.gameState;
  if (!gs) return null;
  const base = {
    phase: gs.phase,
    guesserId: gs.guesserId,
    guesserNickname: gs.guesserNickname,
    roundNumber: gs.roundNumber,
    totalRounds: gs.totalRounds,
    timer: gs.timer,
    wordName: gs.wordName,
    answerOrder: gs.answerOrder,
    judgmentResult: gs.judgmentResult,
    revealResult: gs.revealResult
  };

  if (gs.phase === 'choosing') {
    if (playerId === gs.guesserId) {
      base.wordOptions = gs.wordOptions;
    }
  } else if (gs.phase === 'countdown_reveal') {
    base.wordName = gs.wordName;
  } else if (gs.phase === 'viewing') {
    base.wordName = gs.wordName;
    if (playerId === gs.honestPlayerId) {
      base.wordDescription = gs.wordDescription;
      base.role = 'honest';
    } else if (playerId === gs.guesserId) {
      base.role = 'guesser';
    } else {
      base.role = 'bluffer';
    }
  } else if (gs.phase === 'preparing') {
    base.wordName = gs.wordName;
    if (playerId === gs.honestPlayerId) {
      base.role = 'honest';
    } else if (playerId === gs.guesserId) {
      base.role = 'guesser';
    } else {
      base.role = 'bluffer';
    }
  } else if (gs.phase === 'answering') {
    base.wordName = gs.wordName;
    if (playerId === gs.honestPlayerId) {
      base.role = 'honest';
    } else if (playerId === gs.guesserId) {
      base.role = 'guesser';
    } else {
      base.role = 'bluffer';
    }
  } else if (gs.phase === 'judging') {
    base.wordName = gs.wordName;
    if (playerId === gs.guesserId) {
      base.isJudging = true;
    }
    if (playerId === gs.honestPlayerId) {
      base.role = 'honest';
    } else if (playerId === gs.guesserId) {
      base.role = 'guesser';
    } else {
      base.role = 'bluffer';
    }
  } else if (gs.phase === 'reveal') {
    base.wordName = gs.wordName;
    base.honestPlayerId = gs.honestPlayerId;
    base.honestPlayerNickname = gs.honestPlayerNickname;
  }

  return base;
}

function getAvailableWords(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  const playerIds = room.players.map(p => p.id);
  const usedWords = new Set();
  for (const pid of playerIds) {
    const played = socketPlayedWords.get(pid) || new Set();
    for (const w of played) usedWords.add(w);
  }
  return WORD_LIBRARY.filter(w => !usedWords.has(w.name));
}

function pickRandomWords(roomId, count = 5) {
  const available = getAvailableWords(roomId);
  const shuffled = available.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function startNextRound(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.started) return;

  const gs = room.gameState;
  gs.roundNumber++;
  const guesserIndex = (gs.roundNumber - 1) % room.players.length;
  const guesser = room.players[guesserIndex];
  gs.guesserId = guesser.id;
  gs.guesserNickname = guesser.nickname;
  gs.phase = 'choosing';
  gs.wordOptions = pickRandomWords(roomId, 5);
  gs.wordName = null;
  gs.wordDescription = null;
  gs.honestPlayerId = null;
  gs.honestPlayerNickname = null;
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

  for (const p of room.players) {
    const sock = io.sockets.sockets.get(p.id);
    if (sock) {
      sock.emit('announcement', `第 ${gs.roundNumber} 轮开始！猜词人是：${guesser.nickname}`);
    }
  }
}

function clearRoomTimer(roomId) {
  const room = rooms.get(roomId);
  if (room && room._timer) {
    clearInterval(room._timer);
    room._timer = null;
  }
}

function startTimer(roomId, seconds, onTick, onEnd) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearRoomTimer(roomId);
  room.gameState.timer = seconds;
  broadcastRoomState(roomId);

  room._timer = setInterval(() => {
    if (!rooms.has(roomId)) { clearRoomTimer(roomId); return; }
    const r = rooms.get(roomId);
    if (!r.gameState) { clearRoomTimer(roomId); return; }
    r.gameState.timer--;
    if (onTick) onTick(r.gameState.timer);
    broadcastRoomState(roomId);
    if (r.gameState.timer <= 0) {
      clearInterval(r._timer);
      r._timer = null;
      if (onEnd) onEnd();
    }
  }, 1000);
}

const memoryUsers = new Map();

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
      socket.data.account = account;
      socket.data.nickname = user.nickname;
      if (dbConnected) {
        const record = await PlayedWords.findOne({ account });
        socketPlayedWords.set(socket.id, new Set(record ? record.words : []));
      } else {
        if (!socketPlayedWords.has(socket.id)) socketPlayedWords.set(socket.id, new Set());
      }
      cb({ ok: true, nickname: user.nickname });
      broadcastRoomList();
    } catch (e) {
      cb({ ok: false, msg: '登录失败，请重试' });
    }
  });

  socket.on('getRooms', () => {
    broadcastRoomList();
  });

  socket.on('createRoom', ({ name, password }, cb) => {
    if (!socket.data.account) return cb({ ok: false, msg: '请先登录' });
    const roomId = 'room_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    rooms.set(roomId, {
      name: name || '未命名房间',
      password: password || null,
      creatorId: socket.id,
      creatorNickname: socket.data.nickname,
      players: [{ id: socket.id, nickname: socket.data.nickname, score: 0 }],
      started: false,
      gameState: null,
      _timer: null
    });
    socket.join(roomId);
    socket.data.roomId = roomId;
    cb({ ok: true, roomId });
    broadcastRoomList();
    broadcastRoomState(roomId);
  });

  socket.on('joinRoom', ({ roomId, password }, cb) => {
    if (!socket.data.account) return cb({ ok: false, msg: '请先登录' });
    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, msg: '房间不存在' });
    if (room.started) return cb({ ok: false, msg: '游戏已开始，无法加入' });
    if (room.password && room.password !== password) return cb({ ok: false, msg: '密码错误' });
    if (room.players.find(p => p.id === socket.id)) return cb({ ok: false, msg: '你已在房间中' });

    room.players.push({ id: socket.id, nickname: socket.data.nickname, score: 0 });
    socket.join(roomId);
    socket.data.roomId = roomId;
    cb({ ok: true });
    broadcastRoomList();
    broadcastRoomState(roomId);
  });

  socket.on('leaveRoom', (cb) => {
    const roomId = socket.data.roomId;
    if (!roomId) return cb && cb({ ok: false });
    const room = rooms.get(roomId);
    if (!room) { socket.data.roomId = null; return cb && cb({ ok: true }); }

    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave(roomId);
    socket.data.roomId = null;

    if (room.players.length === 0) {
      clearRoomTimer(roomId);
      rooms.delete(roomId);
    } else if (room.creatorId === socket.id) {
      room.creatorId = room.players[0].id;
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
    if (room.creatorId !== socket.id) return cb({ ok: false, msg: '只有房主可以开始游戏' });
    if (room.players.length < 3) return cb({ ok: false, msg: '至少需要3名玩家' });

    room.started = true;
    room.gameState = {
      phase: 'waiting',
      roundNumber: 0,
      totalRounds: room.players.length * 2,
      guesserId: null,
      guesserNickname: null,
      wordOptions: null,
      wordName: null,
      wordDescription: null,
      honestPlayerId: null,
      honestPlayerNickname: null,
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
    if (!room || room.creatorId !== socket.id) return cb({ ok: false });
    room.started = false;
    clearRoomTimer(roomId);
    room.gameState = null;
    cb({ ok: true });
    broadcastRoomList();
    broadcastRoomState(roomId);
    for (const p of room.players) {
      const s = io.sockets.sockets.get(p.id);
      if (s) s.emit('announcement', '房主已暂停游戏，房间已解锁');
    }
  });

  socket.on('dissolveRoom', (cb) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.creatorId !== socket.id) return cb({ ok: false });
    clearRoomTimer(roomId);
    for (const p of room.players) {
      const s = io.sockets.sockets.get(p.id);
      if (s) {
        s.leave(roomId);
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
    if (!room || !room.gameState || room.gameState.guesserId !== socket.id) return cb({ ok: false });
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
    if (!room || !room.gameState || room.gameState.guesserId !== socket.id) return cb({ ok: false });
    const word = room.gameState.wordOptions.find(w => w.name === wordName);
    if (!word) return cb({ ok: false });

    room.gameState.wordName = word.name;
    room.gameState.wordDescription = word.description;

    const otherPlayers = room.players.filter(p => p.id !== room.gameState.guesserId);
    const honestIndex = Math.floor(Math.random() * otherPlayers.length);
    const honest = otherPlayers[honestIndex];
    room.gameState.honestPlayerId = honest.id;
    room.gameState.honestPlayerNickname = honest.nickname;

    for (const p of room.players) {
      const played = socketPlayedWords.get(p.id) || new Set();
      played.add(word.name);
      socketPlayedWords.set(p.id, played);
      const sock = io.sockets.sockets.get(p.id);
      if (sock && sock.data.account) {
        PlayedWords.findOneAndUpdate(
          { account: sock.data.account },
          { $addToSet: { words: word.name } },
          { upsert: true }
        ).catch(() => {});
      }
    }

    room.gameState.phase = 'countdown_reveal';
    cb({ ok: true });
    broadcastRoomState(roomId);

    for (const p of room.players) {
      const s = io.sockets.sockets.get(p.id);
      if (s) s.emit('announcement', `猜词人已选定词条！即将揭晓...`);
    }

    setTimeout(() => {
      if (!rooms.has(roomId) || !room.gameState) return;
      room.gameState.phase = 'viewing';
      broadcastRoomState(roomId);

      startTimer(roomId, 30, null, () => {
        if (!rooms.has(roomId) || !room.gameState) return;
        room.gameState.phase = 'preparing';
        broadcastRoomState(roomId);

        for (const p of room.players) {
          const s = io.sockets.sockets.get(p.id);
          if (s) s.emit('announcement', '准备环节开始！所有人只能看到词条名称');
        }

        startTimer(roomId, 10, null, () => {
          if (!rooms.has(roomId) || !room.gameState) return;
          room.gameState.phase = 'answering';

          const others = room.players.filter(p => p.id !== room.gameState.guesserId);
          const shuffled = others.sort(() => Math.random() - 0.5);
          room.gameState.answerOrder = shuffled.map(p => ({ id: p.id, nickname: p.nickname }));

          broadcastRoomState(roomId);
          for (const p of room.players) {
            const s = io.sockets.sockets.get(p.id);
            if (s) s.emit('announcement', '开始答题！请按顺序作答');
          }
        });
      });
    }, 3000);
  });

  socket.on('startJudging', (cb) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.gameState || room.gameState.guesserId !== socket.id) return cb({ ok: false });
    room.gameState.phase = 'judging';
    cb({ ok: true });
    broadcastRoomState(roomId);
  });

  socket.on('submitJudgment', ({ honestId, bluffKingId }, cb) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.gameState || room.gameState.guesserId !== socket.id) return cb({ ok: false });

    const honestPlayer = room.players.find(p => p.id === honestId);
    const bluffKingPlayer = room.players.find(p => p.id === bluffKingId);

    room.gameState.judgmentResult = {
      chosenHonestId: honestId,
      chosenHonestNickname: honestPlayer ? honestPlayer.nickname : '?',
      chosenBluffKingId: bluffKingId,
      chosenBluffKingNickname: bluffKingPlayer ? bluffKingPlayer.nickname : '?'
    };

    room.gameState.phase = 'reveal';
    broadcastRoomState(roomId);

    for (const p of room.players) {
      const s = io.sockets.sockets.get(p.id);
      if (s) {
        s.emit('announcement',
          `猜词人认为：${honestPlayer?.nickname} 是老实人，${bluffKingPlayer?.nickname} 是瞎掰王`);
      }
    }

    setTimeout(() => {
      if (!rooms.has(roomId) || !room.gameState) return;

      const correct = honestId === room.gameState.honestPlayerId;
      room.gameState.revealResult = {
        realHonestId: room.gameState.honestPlayerId,
        realHonestNickname: room.gameState.honestPlayerNickname,
        correct
      };

      if (correct) {
        const guesser = room.players.find(p => p.id === room.gameState.guesserId);
        const honest = room.players.find(p => p.id === room.gameState.honestPlayerId);
        if (guesser) guesser.score += 1;
        if (honest) honest.score += 1;
      } else {
        const fakeHonest = room.players.find(p => p.id === honestId);
        if (fakeHonest) fakeHonest.score += 2;
      }

      broadcastRoomState(roomId);

      for (const p of room.players) {
        const s = io.sockets.sockets.get(p.id);
        if (s) {
          if (correct) {
            s.emit('announcement', `猜对了！真正的老实人就是 ${room.gameState.honestPlayerNickname}！猜词人和老实人各+1分`);
          } else {
            s.emit('announcement', `猜错了！真正的老实人是 ${room.gameState.honestPlayerNickname}！${honestPlayer?.nickname} 成功骗过猜词人，+2分`);
          }
        }
      }

      setTimeout(() => {
        if (!rooms.has(roomId) || !room.gameState) return;
        if (room.gameState.roundNumber >= room.gameState.totalRounds) {
          room.gameState.phase = 'gameOver';
          broadcastRoomState(roomId);
          for (const p of room.players) {
            const s = io.sockets.sockets.get(p.id);
            if (s) s.emit('announcement', '游戏结束！查看最终排名');
          }
        } else {
          startNextRound(roomId);
        }
      }, 5000);
    }, 3000);
  });

  socket.on('nextRound', (cb) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.creatorId !== socket.id) return cb({ ok: false });
    startNextRound(roomId);
    cb({ ok: true });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (roomId) {
      const room = rooms.get(roomId);
      if (room) {
        room.players = room.players.filter(p => p.id !== socket.id);
        if (room.players.length === 0) {
          clearRoomTimer(roomId);
          rooms.delete(roomId);
        } else if (room.creatorId === socket.id) {
          room.creatorId = room.players[0].id;
          room.creatorNickname = room.players[0].nickname;
        }
        broadcastRoomList();
        if (rooms.has(roomId)) broadcastRoomState(roomId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});
