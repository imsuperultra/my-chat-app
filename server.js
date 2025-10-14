const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Cloudinary 설정
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// 데이터베이스 연결
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

let globalMessages = []; 
const onlineUsers = new Map(); // userId -> { nickname, socketId }

async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY, nickname TEXT UNIQUE NOT NULL,
        change_timestamps TIMESTAMPTZ[] DEFAULT ARRAY[]::TIMESTAMPTZ[],
        last_seen TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS direct_messages (
        id SERIAL PRIMARY KEY, sender_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        receiver_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        message TEXT NOT NULL, type TEXT DEFAULT 'text', timestamp TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('Database tables checked/created successfully.');
  } catch (err) { console.error('Error initializing database:', err); }
}
initializeDatabase();

// API 라우트
app.get('/api/upload-signature', (req, res) => {
  const timestamp = Math.round((new Date).getTime() / 1000);
  const signature = cloudinary.utils.api_sign_request({ timestamp, folder: "chat_images" }, process.env.CLOUDINARY_API_SECRET);
  res.json({ timestamp, signature, cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY });
});

// React 앱 정적 파일 제공 (배포 환경용)
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'build')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
  });
}

// Socket.IO 로직
io.on('connection', (socket) => {
  let currentUserId = null;

  socket.on('user_connect', async ({ userId, nickname }, callback) => {
    try {
      let userResult = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
      let user = userResult.rows[0];
      if (user) {
        if (user.nickname !== nickname) {
          const nicknameCheck = await pool.query('SELECT 1 FROM users WHERE nickname = $1 AND user_id != $2', [nickname, userId]);
          if (nicknameCheck.rowCount > 0) {
            nickname = user.nickname;
            socket.emit('force_nickname_update', nickname);
          }
        }
        await pool.query('UPDATE users SET nickname = $1, last_seen = NOW() WHERE user_id = $2', [nickname, userId]);
        user.nickname = nickname;
      } else {
        const nicknameCheck = await pool.query('SELECT 1 FROM users WHERE nickname = $1', [nickname]);
        if (nicknameCheck.rowCount > 0) {
          return callback({ success: false, message: '닉네임이 이미 사용 중입니다.' });
        }
        const newUserResult = await pool.query('INSERT INTO users(user_id, nickname, last_seen) VALUES($1, $2, NOW()) RETURNING *', [userId, nickname]);
        user = newUserResult.rows[0];
      }
      currentUserId = userId;
      onlineUsers.set(userId, { nickname: user.nickname, socketId: socket.id });
      io.emit('online_users_update', Array.from(onlineUsers.keys()));
      callback({ success: true, user });
      socket.emit('load_global_messages', globalMessages);
    } catch (err) {
      console.error('User connect error:', err);
      callback({ success: false, message: '서버 연결 오류.' });
    }
  });

  socket.on('get_dm_partners', async (callback) => {
    if(!currentUserId) return callback([]);
    try {
      const result = await pool.query(`
          SELECT DISTINCT nickname FROM users WHERE user_id IN (
              SELECT receiver_id FROM direct_messages WHERE sender_id = $1
              UNION
              SELECT sender_id FROM direct_messages WHERE receiver_id = $1
          )
      `, [currentUserId]);
      callback(result.rows.map(r => r.nickname));
    } catch(err) {
      console.error('Error fetching DM partners', err);
      callback([]);
    }
  });

  socket.on('change_nickname', async (newNickname, callback) => {
      if (!currentUserId) return callback({ success: false, message: '인증되지 않은 사용자입니다.' });
      try {
          const userResult = await pool.query('SELECT nickname, change_timestamps FROM users WHERE user_id = $1', [currentUserId]);
          const oldNickname = userResult.rows[0].nickname;
          const timestamps = userResult.rows[0].change_timestamps || [];
          const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          const recentChanges = timestamps.filter(ts => new Date(ts) > oneWeekAgo);
          if (recentChanges.length >= 2) {
              return callback({ success: false, message: '일주일에 최대 2번만 변경할 수 있습니다.' });
          }
          const nicknameCheck = await pool.query('SELECT 1 FROM users WHERE nickname = $1 AND user_id != $2', [newNickname, currentUserId]);
          if (nicknameCheck.rowCount > 0) {
              return callback({ success: false, message: '이미 사용 중인 닉네임입니다.' });
          }
          const updateResult = await pool.query('UPDATE users SET nickname = $1, change_timestamps = array_append(change_timestamps, NOW()) WHERE user_id = $2 RETURNING *', [newNickname, currentUserId]);
          const updatedUser = updateResult.rows[0];
          onlineUsers.set(currentUserId, { nickname: updatedUser.nickname, socketId: socket.id });
          io.emit('nickname_changed', { oldNickname, newNickname });
          io.emit('online_users_update', Array.from(onlineUsers.keys()));
          callback({ success: true, user: updatedUser });
      } catch (err) {
          console.error('Change nickname error:', err);
          callback({ success: false, message: '닉네임 변경 중 오류가 발생했습니다.' });
      }
  });

  socket.on('global_message', async (data) => {
    if (!currentUserId) return;
    const senderInfo = onlineUsers.get(currentUserId);
    if (!senderInfo) return;
    const messageData = {
      id: Date.now(), senderId: currentUserId, senderNickname: senderInfo.nickname,
      message: data.message, type: data.type || 'text', timestamp: new Date().toISOString()
    };
    globalMessages.push(messageData);
    if(globalMessages.length > 100) globalMessages.shift();
    io.emit('new_global_message', messageData);
  });
  
  socket.on('delete_global_message', ({ messageId, senderId }) => {
    if (currentUserId === senderId) {
        const initialLength = globalMessages.length;
        globalMessages = globalMessages.filter(msg => msg.id !== messageId);
        if (globalMessages.length < initialLength) {
            io.emit('global_message_deleted', messageId);
        }
    }
  });

  socket.on('load_dms', async ({ targetNickname }) => {
      if (!currentUserId) return;
      try {
          const targetUserResult = await pool.query('SELECT user_id FROM users WHERE nickname = $1', [targetNickname]);
          if (targetUserResult.rowCount === 0) return socket.emit('loaded_dms', { targetNickname, messages: [] });
          const targetUserId = targetUserResult.rows[0].user_id;
          const result = await pool.query( `SELECT dm.id, dm.message, dm.type, dm.timestamp, sender.nickname as sender_nickname, receiver.nickname as receiver_nickname FROM direct_messages dm JOIN users sender ON dm.sender_id = sender.user_id JOIN users receiver ON dm.receiver_id = receiver.user_id WHERE (dm.sender_id = $1 AND dm.receiver_id = $2) OR (dm.sender_id = $2 AND dm.receiver_id = $1) ORDER BY timestamp`, [currentUserId, targetUserId]);
          socket.emit('loaded_dms', { targetNickname, messages: result.rows });
      } catch (err) { console.error('Error loading DMs:', err); }
  });

  socket.on('send_dm', async ({ receiverNickname, message, type }) => {
      if (!currentUserId) return;
      try {
          const receiverResult = await pool.query('SELECT user_id FROM users WHERE nickname = $1', [receiverNickname]);
          if (receiverResult.rowCount === 0) return socket.emit('dm_send_failed', { message: 'DM 상대방이 존재하지 않습니다.' });
          const receiverId = receiverResult.rows[0].user_id;
          const result = await pool.query('INSERT INTO direct_messages(sender_id, receiver_id, message, type) VALUES($1, $2, $3, $4) RETURNING id, timestamp', [currentUserId, receiverId, message, type || 'text']);
          const senderInfo = onlineUsers.get(currentUserId);
          const newDM = { id: result.rows[0].id, sender_id: currentUserId, receiver_id: receiverId, sender_nickname: senderInfo.nickname, receiver_nickname: receiverNickname, message, type: type || 'text', timestamp: result.rows[0].timestamp };
          socket.emit('new_dm', newDM);
          const receiverSocketInfo = Array.from(onlineUsers.entries()).find(([id, info]) => info.nickname === receiverNickname);
          if (receiverSocketInfo && receiverSocketInfo[1].socketId) {
              io.to(receiverSocketInfo[1].socketId).emit('new_dm', newDM);
          }
      } catch (err) {
          console.error('Error sending DM:', err);
          socket.emit('dm_send_failed', { message: 'DM 전송 중 서버 오류가 발생했습니다.' });
      }
  });

  socket.on('delete_dm', async (messageId) => {
      if (!currentUserId) return;
      try {
          const result = await pool.query('DELETE FROM direct_messages WHERE id = $1 AND (sender_id = $2 OR receiver_id = $2) RETURNING sender_id, receiver_id', [messageId, currentUserId]);
          if (result.rowCount > 0) {
              const { sender_id, receiver_id } = result.rows[0];
              const senderInfo = onlineUsers.get(sender_id);
              const receiverInfo = onlineUsers.get(receiver_id);
              if (senderInfo) io.to(senderInfo.socketId).emit('dm_deleted', messageId);
              if (receiverInfo && receiver_id !== sender_id) io.to(receiverInfo.socketId).emit('dm_deleted', messageId);
          }
      } catch (err) { console.error('Error deleting DM:', err); }
  });

  socket.on('disconnect', () => {
    if (currentUserId) {
      onlineUsers.delete(currentUserId);
      io.emit('online_users_update', Array.from(onlineUsers.keys()));
    }
    console.log(`User disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server is listening on port ${PORT}`));

