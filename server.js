const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;
const SECRET = 'teledrag_secret_key_2024';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Подключение к базе Neon (строка подключения из переменной окружения)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // обязательно для Neon
});

// Создание таблиц при запуске
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        stars INTEGER DEFAULT 0,
        verified BOOLEAN DEFAULT FALSE,
        role TEXT DEFAULT 'user',
        avatar TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender_id INTEGER NOT NULL,
        receiver_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('Таблицы созданы/проверены');
  } catch (err) {
    console.error('Ошибка инициализации БД:', err);
  }
})();

// Аутентификация
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Токен не предоставлен' });
  jwt.verify(token, SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Неверный токен' });
    req.user = user;
    next();
  });
}

// Регистрация
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || password.length < 4) {
    return res.status(400).json({ error: 'Логин и пароль (мин. 4 символа) обязательны' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id, username, stars, verified, role',
      [username.trim(), hash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, SECRET);
    res.json({ token, user });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Имя уже занято' });
    res.status(500).json({ error: 'Ошибка базы данных' });
  }
});

// Вход
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username.trim()]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'Неверный логин или пароль' });
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'Неверный логин или пароль' });
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, SECRET);
    res.json({
      token,
      user: { id: user.id, username: user.username, stars: user.stars, verified: user.verified, role: user.role, avatar: user.avatar }
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Профиль
app.get('/api/me', authenticateToken, async (req, res) => {
  const result = await pool.query('SELECT id, username, stars, verified, role, avatar FROM users WHERE id = $1', [req.user.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json(result.rows[0]);
});

// Список пользователей
app.get('/api/users', authenticateToken, async (req, res) => {
  const search = req.query.search || '';
  const result = await pool.query(
    'SELECT id, username, stars, verified, role FROM users WHERE username ILIKE $1',
    [`%${search}%`]
  );
  res.json(result.rows);
});

// Аватарка
app.post('/api/upload-avatar', authenticateToken, async (req, res) => {
  const { avatar } = req.body;
  if (!avatar) return res.status(400).json({ error: 'Нет данных' });
  await pool.query('UPDATE users SET avatar = $1 WHERE id = $2', [avatar, req.user.id]);
  res.json({ message: 'Аватар обновлён' });
});

// Сообщения
app.get('/api/messages/:userId', authenticateToken, async (req, res) => {
  const { userId } = req.params;
  const result = await pool.query(
    `SELECT * FROM messages 
     WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1) 
     ORDER BY timestamp ASC`,
    [req.user.id, userId]
  );
  res.json(result.rows);
});

// ===== Магазин =====
app.post('/api/shop/buy-verification', authenticateToken, async (req, res) => {
  try {
    const user = await pool.query('SELECT stars, verified FROM users WHERE id = $1', [req.user.id]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });
    const { stars, verified } = user.rows[0];
    if (stars < 100) return res.status(400).json({ error: 'Недостаточно звёзд' });
    if (verified) return res.status(400).json({ error: 'Уже верифицирован' });
    await pool.query('UPDATE users SET stars = stars - 100, verified = TRUE WHERE id = $1', [req.user.id]);
    res.json({ message: 'Верификация куплена!', stars: stars - 100, verified: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/shop/buy-username-change', authenticateToken, async (req, res) => {
  const { newUsername } = req.body;
  if (!newUsername || newUsername.trim().length < 3) return res.status(400).json({ error: 'Ник не менее 3 символов' });
  try {
    // Проверка занятости
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [newUsername.trim()]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Ник уже занят' });
    const user = await pool.query('SELECT stars FROM users WHERE id = $1', [req.user.id]);
    if (user.rows[0].stars < 50) return res.status(400).json({ error: 'Недостаточно звёзд' });
    await pool.query('UPDATE users SET stars = stars - 50, username = $1 WHERE id = $2', [newUsername.trim(), req.user.id]);
    res.json({ message: 'Ник изменён!', stars: user.rows[0].stars - 50, username: newUsername.trim() });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ===== Админка =====
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Нет прав' });
  next();
}

app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT id, username, stars, verified, role FROM users');
  res.json(result.rows);
});

app.post('/api/admin/give-stars', authenticateToken, requireAdmin, async (req, res) => {
  const { username, stars } = req.body;
  await pool.query('UPDATE users SET stars = stars + $1 WHERE username = $2', [stars, username]);
  res.json({ message: `Выдано ${stars} звёзд пользователю ${username}` });
});

app.post('/api/admin/make-admin', authenticateToken, requireAdmin, async (req, res) => {
  const { username } = req.body;
  await pool.query('UPDATE users SET role = $1 WHERE username = $2', ['admin', username]);
  res.json({ message: `${username} теперь администратор` });
});

app.post('/api/admin/set-stars', authenticateToken, requireAdmin, async (req, res) => {
  const { userId, stars } = req.body;
  await pool.query('UPDATE users SET stars = $1 WHERE id = $2', [stars, userId]);
  res.json({ message: 'Звёзды обновлены' });
});

app.post('/api/admin/toggle-verify', authenticateToken, requireAdmin, async (req, res) => {
  const { username } = req.body;
  const user = await pool.query('SELECT verified FROM users WHERE username = $1', [username]);
  if (user.rows.length === 0) return res.status(400).json({ error: 'Пользователь не найден' });
  const newVerified = !user.rows[0].verified;
  await pool.query('UPDATE users SET verified = $1 WHERE username = $2', [newVerified, username]);
  res.json({ message: `Верификация ${newVerified ? 'включена' : 'отключена'}`, verified: newVerified });
});

app.post('/api/admin/delete-user', authenticateToken, requireAdmin, async (req, res) => {
  const { userId } = req.body;
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  res.json({ message: 'Пользователь удалён' });
});

// Socket.io (чат)
io.on('connection', (socket) => {
  socket.on('authenticate', (token) => {
    try {
      const user = jwt.verify(token, SECRET);
      socket.userId = user.id;
      socket.username = user.username;
      socket.join(`user_${user.id}`);
    } catch (e) {
      socket.disconnect();
    }
  });

  socket.on('private_message', async (data) => {
    if (!socket.userId) return;
    const { to, text } = data;
    const senderId = socket.userId;
    // Сохраняем в БД
    const result = await pool.query(
      'INSERT INTO messages (sender_id, receiver_id, text) VALUES ($1, $2, $3) RETURNING id, timestamp',
      [senderId, to, text]
    );
    const msg = { id: result.rows[0].id, sender_id: senderId, receiver_id: to, text, timestamp: result.rows[0].timestamp };
    // Рассылаем
    io.to(`user_${to}`).emit('private_message', msg);
    io.to(`user_${senderId}`).emit('private_message', msg);
  });
});

server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
