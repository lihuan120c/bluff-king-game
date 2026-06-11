const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  account: { type: String, required: true, unique: true },
  nickname: { type: String, required: true },
  gamesPlayed: { type: Number, default: 0 },
  totalScore: { type: Number, default: 0 },
  wins: { type: Number, default: 0 }
});

const playedWordsSchema = new mongoose.Schema({
  account: { type: String, required: true, unique: true },
  words: [String]
});

const User = mongoose.model('User', userSchema);
const PlayedWords = mongoose.model('PlayedWords', playedWordsSchema);

module.exports = { User, PlayedWords };
