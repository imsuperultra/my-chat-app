const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Cloudinary 설정 (환경 변수에서 키를 안전하게 로드) ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// --- 데이터베이스 연결 설정 ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// --- 데이터 저장소 ---
let globalMessages = []; // 글로벌 메시지는 서버 메모리에만 저장

// --- 서버 시작 시 초기 작업 ---
async function initializeDatabase() {
  try {
    // direct_messages 테이블이 없으면 생성
    await pool.query(`
      CREATE TABLE IF NOT EXISTS direct_messages (
        id SERIAL PRIMARY KEY,
        sender TEXT NOT NULL,
        receiver TEXT NOT NULL,
        message TEXT NOT NULL,
        type TEXT DEFAULT 'text', -- 'text', 'image', 'youtube'
        timestamp TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('Database table "direct_messages" checked/created successfully.');
  } catch (err) {
    console.error('Error initializing database:', err);
  }
}
initializeDatabase();


// --- 기본 설정 ---
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));
app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

// --- API: 이미지 업로드를 위한 보안 서명 생성 ---
app.get('/api/upload-signature', (req, res) => {
  const timestamp = Math.round((new Date).getTime() / 1000);
  const signature = cloudinary.utils.api_sign_request({
    timestamp: timestamp,
    folder: "chat_images" // Cloudinary에 저장될 폴더명 (선택 사항)
  }, process.env.CLOUDINARY_API_SECRET);

  res.json({
    timestamp: timestamp,
    signature: signature,
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
  });
});


// --- Socket.IO 실시간 통신 로직 ---
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  
  let currentNickname; // 이 소켓에 연결된 사용자의 닉네임

  socket.on('set_nickname', (nickname) => {
    currentNickname = nickname;
    console.log(`${currentNickname} (${socket.id}) has joined.`);
    // 처음 접속한 사용자에게 기존 글로벌 메시지 전송
    socket.emit('load_global_messages', globalMessages);
  });

  // --- 글로벌 채팅 ---
  socket.on('global_message', (data) => {
    const messageData = {
      id: Date.now(), // 클라이언트 측에서 삭제를 위해 임시 ID 생성
      sender: data.sender,
      message: data.message,
      type: data.type || 'text', // text, image, youtube
      timestamp: new Date().toISOString()
    };
    globalMessages.push(messageData);
    io.emit('new_global_message', messageData); // 모든 사용자에게 전파
  });

  // 글로벌 메시지 삭제 요청 처리
  socket.on('delete_global_message', (messageId) => {
    const initialLength = globalMessages.length;
    globalMessages = globalMessages.filter(msg => msg.id !== messageId);
    if (globalMessages.length < initialLength) { // 실제로 삭제되었으면
      io.emit('global_message_deleted', messageId); // 모든 사용자에게 삭제 알림
    }
  });

  // --- DM (Direct Message) ---
  socket.on('load_dms', async (targetNickname) => {
    if (!currentNickname || !targetNickname) return;
    try {
      // 보낸 메시지
      const sentDMs = await pool.query(
        'SELECT * FROM direct_messages WHERE sender = $1 AND receiver = $2 ORDER BY timestamp',
        [currentNickname, targetNickname]
      );
      // 받은 메시지
      const receivedDMs = await pool.query(
        'SELECT * FROM direct_messages WHERE sender = $1 AND receiver = $2 ORDER BY timestamp',
        [targetNickname, currentNickname]
      );
      
      const allDMs = [...sentDMs.rows, ...receivedDMs.rows];
      allDMs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      socket.emit('loaded_dms', targetNickname, allDMs);
    } catch (err) {
      console.error('Error loading DMs:', err);
    }
  });

  socket.on('send_dm', async (data) => {
    if (!currentNickname || !data.receiver || !data.message) return;
    try {
      const result = await pool.query(
        'INSERT INTO direct_messages(sender, receiver, message, type) VALUES($1, $2, $3, $4) RETURNING *',
        [currentNickname, data.receiver, data.message, data.type || 'text']
      );
      const newDM = result.rows[0];
      // 보낸 사람, 받는 사람 모두에게 새로운 DM 전송
      io.to(socket.id).emit('new_dm', newDM); // 보낸 본인에게
      // 받는 사람이 접속해 있다면, 그 소켓에도 전송 (모든 소켓 순회 필요)
      for (const [id, connectedSocket] of io.of("/").sockets) {
        if (connectedSocket.currentNickname === data.receiver) {
          connectedSocket.emit('new_dm', newDM);
        }
      }
    } catch (err) {
      console.error('Error sending DM:', err);
    }
  });

  socket.on('delete_dm', async (messageId) => {
    try {
      const result = await pool.query(
        'DELETE FROM direct_messages WHERE id = $1 AND (sender = $2 OR receiver = $2) RETURNING id',
        [messageId, currentNickname]
      );
      if (result.rowCount > 0) { // 실제로 삭제되었으면
        io.emit('dm_deleted', messageId); // 모든 사용자에게 삭제 알림 (UI에서 필터링)
      }
    } catch (err) {
      console.error('Error deleting DM:', err);
    }
  });


  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});


// --- 서버 실행 ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
