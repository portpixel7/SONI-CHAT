const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean));
function allowSocketRequest(req, callback) {
  const origin = req.headers.origin;
  if (!origin) return callback(null, true);
  if (allowedOrigins.size) return callback(null, allowedOrigins.has(origin));
  try {
    const forwardedHost = req.headers['x-forwarded-host'];
    callback(null, new URL(origin).host === (forwardedHost || req.headers.host));
  } catch {
    callback(null, false);
  }
}

const app = express();
const server = http.createServer(app);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Base64 adds roughly 33% to the original file size, so leave enough room for
// the encoded image and the surrounding Socket.IO payload.
const io = new Server(server, { maxHttpBufferSize: 8 * 1024 * 1024, allowRequest: allowSocketRequest });
const users = new Map();
const rooms = new Map();
const typing = new Map();
const messageWindows = new Map();
const joinWindows = new Map();
const recentMessages = new Map();
let reports = [];
const MAX_ROOM_MEMBERS = Number(process.env.MAX_ROOM_MEMBERS) || 50;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.static(__dirname));
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));
app.use('/api', express.json({ limit: '10kb' }));

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: 'Admin reporting is not configured.' });
  const token = req.get('authorization')?.replace(/^Bearer\s+/i, '');
  const valid = token && token.length === ADMIN_TOKEN.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN));
  if (!valid) return res.status(401).json({ error: 'Unauthorized.' });
  next();
}
app.get('/api/reports', requireAdmin, (_req, res) => res.json({ reports }));
app.delete('/api/reports', requireAdmin, (_req, res) => { reports = []; res.status(204).end(); });

const normalize = value => String(value || '').trim().replace(/\s+/g, ' ');
const passwordHash = password => crypto.createHash('sha256').update(password).digest('hex');

function roomMembers(room) {
  return [...users].filter(([, value]) => value.room === room).map(([id, value]) => ({ id, user: value.user }));
}
function updateRoom(room) {
  io.to(room).emit('room-state', { members: roomMembers(room) });
}
function updateTyping(room) {
  io.to(room).emit('typing', [...(typing.get(room) || new Map()).values()]);
}
function leaveCurrentRoom(socket, announce = true) {
  const current = users.get(socket.id);
  if (!current) return;
  users.delete(socket.id);
  socket.leave(current.room);
  typing.get(current.room)?.delete(socket.id);
  if (announce) socket.to(current.room).emit('room-event', `${current.user} left the room`);
  updateRoom(current.room);
  updateTyping(current.room);
  if (!roomMembers(current.room).length) {
    rooms.delete(current.room);
    typing.delete(current.room);
    reports = reports.filter(report => report.room !== current.room);
    for (const [id, message] of recentMessages) if (message.room === current.room) recentMessages.delete(id);
  }
}
function withinLimit(store, key, limit, duration) {
  const now = Date.now();
  const recent = (store.get(key) || []).filter(time => now - time < duration);
  if (recent.length >= limit) return false;
  recent.push(now);
  store.set(key, recent);
  return true;
}
const allowedToSend = socketId => withinLimit(messageWindows, socketId, 10, 5000);

io.on('connection', socket => {
  socket.on('join-room', (data, done = () => {}) => {
    const address = socket.handshake.address || socket.id;
    if (!withinLimit(joinWindows, address, 12, 60_000)) return done({ ok: false, error: 'Too many room attempts. Please wait one minute.' });
    const user = normalize(data?.user).slice(0, 24);
    const room = normalize(data?.room).toLowerCase().slice(0, 40);
    const password = String(data?.password || '').slice(0, 80);
    if (!user || !room) return done({ ok: false, error: 'Name and room code are required.' });
    if (!/^[a-z0-9 _-]+$/.test(room)) return done({ ok: false, error: 'Room code can use letters, numbers, spaces, - and _ only.' });
    const existingRoom = rooms.get(room);
    if (existingRoom?.passwordHash && passwordHash(password) !== existingRoom.passwordHash) return done({ ok: false, error: 'Incorrect room password.' });
    if (roomMembers(room).length >= MAX_ROOM_MEMBERS && users.get(socket.id)?.room !== room) return done({ ok: false, error: 'This room is full.' });
    if (roomMembers(room).some(member => member.id !== socket.id && member.user.toLowerCase() === user.toLowerCase())) return done({ ok: false, error: 'That name is already being used in this room.' });

    leaveCurrentRoom(socket, false);
    if (!existingRoom) rooms.set(room, { passwordHash: password ? passwordHash(password) : null });
    users.set(socket.id, { user, room });
    socket.join(room);
    done({ ok: true, protected: Boolean(rooms.get(room)?.passwordHash) });
    socket.to(room).emit('room-event', `${user} joined the room`);
    updateRoom(room);
  });

  socket.on('chat-message', (data, done = () => {}) => {
    const current = users.get(socket.id);
    const text = normalize(data?.text).slice(0, 1000);
    if (!current || !text) return done({ ok: false });
    if (!allowedToSend(socket.id)) return done({ ok: false, error: 'Slow down—please wait a few seconds.' });
    const message = { messageId: crypto.randomUUID(), id: socket.id, user: current.user, text, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
    recentMessages.set(message.messageId, { ...message, room: current.room, type: 'text' });
    if (recentMessages.size > 2000) recentMessages.delete(recentMessages.keys().next().value);
    io.to(current.room).emit('chat-message', message);
    done({ ok: true });
  });

  socket.on('image-message', (data, done = () => {}) => {
    const current = users.get(socket.id);
    const image = String(data?.image || '');
    const match = image.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
    if (!current || !match) return done({ ok: false, error: 'Unsupported image.' });
    if (Buffer.byteLength(match[2], 'base64') > MAX_IMAGE_BYTES) return done({ ok: false, error: 'Image must be 5 MB or smaller.' });
    if (!allowedToSend(socket.id)) return done({ ok: false, error: 'Slow down—please wait a few seconds.' });
    const message = { messageId: crypto.randomUUID(), id: socket.id, user: current.user, image, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
    recentMessages.set(message.messageId, { messageId: message.messageId, id: message.id, user: message.user, room: current.room, type: 'image', time: message.time });
    if (recentMessages.size > 2000) recentMessages.delete(recentMessages.keys().next().value);
    io.to(current.room).emit('image-message', message);
    done({ ok: true });
  });

  socket.on('report-message', (data, done = () => {}) => {
    const reporter = users.get(socket.id);
    if (!reporter) return done({ ok: false, error: 'Join a room before reporting.' });
    const messageId = String(data?.messageId || '');
    const message = recentMessages.get(messageId);
    if (!message || message.room !== reporter.room || message.id === socket.id) return done({ ok: false, error: 'Message is no longer available.' });
    reports.push({ room: reporter.room, reporter: reporter.user, messageId, reportedUser: message.user, type: message.type, text: message.text || null, time: Date.now() });
    if (reports.length > 200) reports.shift();
    done({ ok: true });
  });

  socket.on('message-seen', data => {
    const viewer = users.get(socket.id);
    const message = recentMessages.get(String(data?.messageId || ''));
    if (!viewer || !message || message.room !== viewer.room || message.id === socket.id) return;
    io.to(message.id).emit('message-seen', { messageId: message.messageId });
  });

  socket.on('typing', active => {
    const current = users.get(socket.id);
    if (!current) return;
    if (!typing.has(current.room)) typing.set(current.room, new Map());
    const roomTyping = typing.get(current.room);
    active ? roomTyping.set(socket.id, current.user) : roomTyping.delete(socket.id);
    updateTyping(current.room);
  });

  const relayToRoomMember = (event, data, done = () => {}) => {
    const current = users.get(socket.id);
    const target = String(data?.target || '');
    const recipient = users.get(target);
    if (!current || !recipient || recipient.room !== current.room || target === socket.id) return done({ ok: false, error: 'That member is no longer available.' });
    io.to(target).emit(event, { from: socket.id, user: current.user, ...(data?.signal ? { signal: data.signal } : {}), ...(typeof data?.accepted === 'boolean' ? { accepted: data.accepted } : {}) });
    done({ ok: true });
  };
  socket.on('call-user', (data, done) => relayToRoomMember('call-incoming', data, done));
  socket.on('call-response', (data, done) => relayToRoomMember('call-response', data, done));
  socket.on('webrtc-signal', (data, done) => relayToRoomMember('webrtc-signal', data, done));
  socket.on('call-end', (data, done) => relayToRoomMember('call-end', data, done));

  socket.on('leave-room', () => leaveCurrentRoom(socket));
  socket.on('disconnect', () => {
    leaveCurrentRoom(socket);
    messageWindows.delete(socket.id);
  });
});

const port = process.env.PORT || 3000;
if (require.main === module) server.listen(port, () => console.log(`SONI running on http://localhost:${port}`));
module.exports = { server };
