import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import db from './db.js';
import fs from 'fs';
import path from 'path';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const JWT_SECRET = 'teledrag-super-secret-key';

app.use(cors());
app.use(express.json());
app.use(express.static('.')); // раздаём index.html

// Синхронизация админов из admins.txt
function syncAdminsFromFile() {
  try {
    const adminsPath = path.join(process.cwd(), 'admins.txt');
    if (!fs.existsSync(adminsPath)) {
      console.log('admins.txt не найден, пропускаем синхронизацию админов');
      return;
    }
    const data = fs.readFileSync(adminsPath, 'utf-8');
    const adminUsernames = data.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    // Сбрасываем всем роль user, затем назначаем админов
    db.prepare("UPDATE users SET role = 'user'").run();
    const stmt = db.prepare("UPDATE users SET role = 'admin' WHERE username = ?");
    for (const name of adminUsernames) {
      stmt.run(name);
    }
    console.log(`Админы синхронизированы: ${adminUsernames.join(', ')}`);
  } catch (e) {
    console.error('Ошибка синхронизации админов:', e.message);
  }
}

syncAdminsFromFile();

// Middleware для проверки администратора
function adminOnly(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Нет токена' });
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    const user = db.prepare('SELECT role FROM users WHERE id = ?').get(decoded.id);
    if (user && user.role === 'admin') {
      req.user = decoded;
      next();
    } else {
      res.status(403).json({ error: 'Доступ запрещён' });
    }
  } catch (e) {
    res.status(401).json({ error: 'Токен недействителен' });
  }
}

// Регистрация
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });

  try {
    const stmt = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)');
    const result = stmt.run(username, password);
    const token = jwt.sign({ id: result.lastInsertRowid, username }, JWT_SECRET);
    const user = db.prepare('SELECT id, username, stars, role, verified FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.json({ token, user });
  } catch (e) {
    res.status(400).json({ error: 'Пользователь уже существует' });
  }
});

// Вход
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND password = ?').get(username, password);
  if (!user) return res.status(401).json({ error: 'Неверные данные' });

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
  res.json({ token, user: { id: user.id, username: user.username, stars: user.stars, role: user.role, verified: user.verified } });
});

// Получить свои данные
app.get('/api/me', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Нет токена' });
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    const user = db.prepare('SELECT id, username, stars, role, verified FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(user);
  } catch (e) {
    res.status(401).json({ error: 'Токен недействителен' });
  }
});

// Список пользователей (с поиском и verified)
app.get('/api/users', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Нет токена' });
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    const search = req.query.search || '';
    const users = db.prepare(`
      SELECT id, username, stars, verified FROM users
      WHERE id != ? AND username LIKE ?
      ORDER BY username ASC
    `).all(decoded.id, `%${search}%`);
    res.json(users);
  } catch (e) {
    res.status(401).json({ error: 'Токен недействителен' });
  }
});

// История сообщений
app.get('/api/messages/:userId', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Нет токена' });
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    const messages = db.prepare(`
      SELECT * FROM messages
      WHERE (sender_id = ? AND receiver_id = ?)
         OR (sender_id = ? AND receiver_id = ?)
      ORDER BY timestamp ASC
    `).all(decoded.id, req.params.userId, req.params.userId, decoded.id);
    res.json(messages);
  } catch (e) {
    res.status(401).json({ error: 'Токен недействителен' });
  }
});

// === Админ-маршруты ===

// Получить всех пользователей (для админки)
app.get('/api/admin/users', adminOnly, (req, res) => {
  const users = db.prepare('SELECT id, username, stars, role, verified FROM users ORDER BY username ASC').all();
  res.json(users);
});

// Выдать звёзды по username
app.post('/api/admin/give-stars', adminOnly, (req, res) => {
  const { username, stars } = req.body;
  if (!username || stars === undefined) return res.status(400).json({ error: 'Укажите username и количество звёзд' });
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  db.prepare('UPDATE users SET stars = stars + ? WHERE username = ?').run(stars, username);
  res.json({ success: true, message: `${username} получил ${stars} звёзд` });
});

// Установить звёзды конкретному пользователю (по ID)
app.post('/api/admin/set-stars', adminOnly, (req, res) => {
  const { userId, stars } = req.body;
  if (!userId || stars === undefined) return res.status(400).json({ error: 'Укажите userId и количество звёзд' });
  db.prepare('UPDATE users SET stars = ? WHERE id = ?').run(stars, userId);
  res.json({ success: true });
});

// Назначить администратора по username
app.post('/api/admin/make-admin', adminOnly, (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Укажите username' });
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  db.prepare("UPDATE users SET role = 'admin' WHERE username = ?").run(username);
  res.json({ success: true, message: `${username} теперь администратор` });
});

// Переключить верификацию (галочку) по username
app.post('/api/admin/toggle-verify', adminOnly, (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Укажите username' });
  const user = db.prepare('SELECT id, verified FROM users WHERE username = ?').get(username);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const newVerified = user.verified ? 0 : 1;
  db.prepare('UPDATE users SET verified = ? WHERE username = ?').run(newVerified, username);
  res.json({ success: true, verified: newVerified, message: `${username} ${newVerified ? 'получил' : 'лишился'} галочки` });
});

// Удалить пользователя
app.post('/api/admin/delete-user', adminOnly, (req, res) => {
  const { userId } = req.body;
  db.prepare('DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?').run(userId, userId);
  db.prepare('DELETE FROM purchases WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  res.json({ success: true });
});

// === WebSocket ===
io.on('connection', (socket) => {
  let currentUserId = null;
  socket.on('authenticate', (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      currentUserId = decoded.id;
      socket.join(`user_${decoded.id}`);
    } catch (e) {
      socket.emit('auth_error', 'Неверный токен');
    }
  });
  socket.on('private_message', ({ to, text }) => {
    if (!currentUserId) return;
    const stmt = db.prepare('INSERT INTO messages (sender_id, receiver_id, text) VALUES (?, ?, ?)');
    const result = stmt.run(currentUserId, to, text);
    const message = {
      id: result.lastInsertRowid,
      sender_id: currentUserId,
      receiver_id: to,
      text,
      timestamp: new Date().toISOString()
    };
    io.to(`user_${to}`).emit('private_message', message);
    socket.emit('private_message', message);
  });
  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`TeleDrag сервер запущен на порту ${PORT}`);
});
