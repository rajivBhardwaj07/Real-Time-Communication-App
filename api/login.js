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
  const u = users[username];
  if (!u) return res.status(401).json({ error: 'invalid credentials' });
  const ok = await bcrypt.compare(password, u.hash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, username });
};
