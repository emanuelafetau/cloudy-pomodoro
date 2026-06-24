require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');
const { pool, init } = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'cloudy-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

// ── Auth middleware ──────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

// ── Auth routes ──────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  if (password.length < 4) return res.status(400).json({ error: 'Password too short' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      [username.trim(), hash]
    );
    req.session.userId = result.insertId;
    req.session.username = username.trim();
    res.json({ username: username.trim() });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username taken' });
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username.trim()]);
    if (!rows.length) return res.status(401).json({ error: 'Wrong username or password' });
    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Wrong username or password' });
    req.session.userId = rows[0].id;
    req.session.username = rows[0].username;
    res.json({ username: rows[0].username });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  res.json({ username: req.session.username });
});

// ── Task routes ──────────────────────────────────────────────
app.get('/api/tasks', requireAuth, async (req, res) => {
  const [rows] = await pool.query(
    'SELECT * FROM tasks WHERE user_id = ? ORDER BY done ASC, created_at DESC',
    [req.session.userId]
  );
  res.json(rows);
});

app.post('/api/tasks', requireAuth, async (req, res) => {
  const { title } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title required' });
  const [result] = await pool.query(
    'INSERT INTO tasks (user_id, title) VALUES (?, ?)',
    [req.session.userId, title.trim()]
  );
  res.json({ id: result.insertId, title: title.trim(), done: false });
});

app.patch('/api/tasks/:id', requireAuth, async (req, res) => {
  const { done } = req.body;
  await pool.query(
    'UPDATE tasks SET done = ? WHERE id = ? AND user_id = ?',
    [done, req.params.id, req.session.userId]
  );
  res.json({ ok: true });
});

app.delete('/api/tasks/:id', requireAuth, async (req, res) => {
  await pool.query(
    'DELETE FROM tasks WHERE id = ? AND user_id = ?',
    [req.params.id, req.session.userId]
  );
  res.json({ ok: true });
});

// ── Session routes ───────────────────────────────────────────
app.post('/api/sessions', requireAuth, async (req, res) => {
  const { duration_minutes } = req.body;
  const today = new Date().toISOString().split('T')[0];
  await pool.query(
    'INSERT INTO sessions (user_id, duration_minutes, session_date) VALUES (?, ?, ?)',
    [req.session.userId, duration_minutes || 25, today]
  );
  res.json({ ok: true });
});

app.get('/api/sessions/stats', requireAuth, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];

  const [[totals]] = await pool.query(
    'SELECT COUNT(*) as total_sessions, SUM(duration_minutes) as total_minutes FROM sessions WHERE user_id = ?',
    [req.session.userId]
  );

  const [[todayRow]] = await pool.query(
    'SELECT COUNT(*) as today_sessions FROM sessions WHERE user_id = ? AND session_date = ?',
    [req.session.userId, today]
  );

  // Streak: fetch distinct dates desc, count consecutive from today
  const [dates] = await pool.query(
    'SELECT DISTINCT session_date FROM sessions WHERE user_id = ? ORDER BY session_date DESC',
    [req.session.userId]
  );
  let streak = 0;
  const check = new Date(today);
  for (const row of dates) {
    const d = new Date(row.session_date).toISOString().split('T')[0];
    if (d === check.toISOString().split('T')[0]) {
      streak++;
      check.setDate(check.getDate() - 1);
    } else break;
  }

  res.json({
    total_sessions: totals.total_sessions || 0,
    total_minutes: totals.total_minutes || 0,
    today_sessions: todayRow.today_sessions || 0,
    streak,
  });
});

app.get('/api/sessions/history', requireAuth, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT session_date as date, COUNT(*) as count
     FROM sessions
     WHERE user_id = ? AND session_date >= DATE_SUB(CURDATE(), INTERVAL 84 DAY)
     GROUP BY session_date
     ORDER BY session_date ASC`,
    [req.session.userId]
  );
  res.json(rows.map(r => ({ date: r.date.toISOString().split('T')[0], count: Number(r.count) })));
});

// ── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
init().then(() => {
  app.listen(PORT, () => console.log(`Cloudy running on http://localhost:${PORT}`));
});
