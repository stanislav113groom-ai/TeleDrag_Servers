import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import db from './db.js';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const JWT_SECRET = 'teledrag-super-secret-key';

app.use(cors());
app.use(express.json());

const shopItems = [
  { id: 1, name: 'Стикер-пак "Драконы"', price: 50 },
  { id: 2, name: 'Премиум статус на 30 дней', price: 200 },
  { id: 3, name: 'Анимированный аватар', price: 150 },
  { id: 4, name: 'Дополнительные реакции', price: 75 }
];

app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
  try {
    const stmt = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)');
    const result = stmt.run(username, password);
    const token = jwt.sign({ id: result.lastInsertRowid, username }, JWT_SECRET);
    res.json({ token, user: { id: result.lastInsertRowid, username, stars: 100 } });
  } catch (e) {
    res.status(400).json({ error: 'Пользователь уже существует' });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND password = ?').get(username, password);
  if (!user) return res.status(401).json({ error: 'Неверные данные' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
  res.json({ token, user: { id: user.id, username: user.username, stars: user.stars } });
});

app.get('/api/me', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Нет токена' });
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    const user = db.prepare('SELECT id, username, stars FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(user);
  } catch (e) {
    res.status(401).json({ error: 'Токен недействителен' });
  }
});

app.get('/api/users', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Нет токена' });
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    const users = db.prepare('SELECT id, username, stars FROM users WHERE id != ?').all(decoded.id);
    res.json(users);
  } catch (e) {
    res.status(401).json({ error: 'Токен недействителен' });
  }
});

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

app.get('/api/shop/items', (req, res) => {
  res.json(shopItems);
});

app.post('/api/shop/buy', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Нет токена' });
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    const { itemId } = req.body;
    const item = shopItems.find(i => i.id === itemId);
    if (!item) return res.status(404).json({ error: 'Товар не найден' });
    const user = db.prepare('SELECT stars FROM users WHERE id = ?').get(decoded.id);
    if (user.stars < item.price) return res.status(400).json({ error: 'Недостаточно звёзд' });
    db.prepare('UPDATE users SET stars = stars - ? WHERE id = ?').run(item.price, decoded.id);
    db.prepare('INSERT INTO purchases (user_id, item_id, item_name, price) VALUES (?, ?, ?, ?)').run(decoded.id, item.id, item.name, item.price);
    const updatedUser = db.prepare('SELECT id, username, stars FROM users WHERE id = ?').get(decoded.id);
    res.json({ success: true, message: `Вы купили "${item.name}"`, stars: updatedUser.stars });
  } catch (e) {
    res.status(401).json({ error: 'Ошибка при покупке' });
  }
});

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
