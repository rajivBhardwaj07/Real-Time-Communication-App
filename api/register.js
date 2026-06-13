const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const users = require('./_users');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const { username, password } = req.body || {};
  if (!username || !password || username.length < 3 || password.length < 6) {
    return res.status(400).json({ error: 'username >=3 chars, password >=6 chars' });
  }
  if (users[username]) return res.status(409).json({ error: 'username taken' });
  const hash = await bcrypt.hash(password, 10);
  users[username] = { hash, createdAt: Date.now() };
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, username });
};
