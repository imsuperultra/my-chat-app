const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const { Pool } = require('pg'); // PostgreSQL 라이브러리 추가

const io = new Server(server);

// --- 데이터베이스 연결 설정 ---
// Render 환경 변수에서 Supabase 연결 URI 가져오기
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Render 환경 변수에 설정해야 함
  ssl: {
    rejectUnauthorized: false // Render와 Supabase 연결 시 필요
  }
});

// --- DB 테이블 자동 생성 ---
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,       -- 고유 사용자 ID (LocalStorage UUID)
        nickname TEXT UNIQUE NOT NULL, -- 현재 닉네임 (중복 불가)
        previous_nickname TEXT,         -- 이전 닉네임 (표시용)
        change_timestamps TIMESTAMPTZ[] DEFAULT ARRAY[]::TIMESTAMPTZ[] -- 변경 시간 기록
      );
    `);
    console.log('User table checked/created successfully.');
  } catch (err) {
    console.error('Error initializing user table:', err);
  }
}
initializeDatabase(); // 서버 시작 시 테이블 확인/생성

app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

io.on('connection', (socket) => {
  console.log('a user connected:', socket.id);
  let currentUserId = null; // 이 소켓 연결에 해당하는 사용자 ID

  // --- 사용자 정보 요청 처리 ---
  socket.on('request_user_data', async (userId, callback) => {
    try {
      if (!userId) {
          console.error("request_user_data called without userId from socket:", socket.id);
          return callback({ success: false, message: '사용자 ID가 없습니다.' });
      }

      let userResult = await pool.query('SELECT user_id, nickname, previous_nickname, change_timestamps FROM users WHERE user_id = $1', [userId]);
      let user = userResult.rows[0];

      if (user) { // 기존 사용자
        currentUserId = userId; // 소켓에 사용자 ID 연결
        console.log(`User reconnected: ${user.nickname} (${userId})`);
        callback({ success: true, user }); // DB 정보 반환
      } else { // 신규 사용자 또는 로컬스토리지 초기화된 경우
        console.log(`New connection, waiting for nickname setup for potential user: ${userId}`);
        callback({ success: false, needsSetup: true }); // 닉네임 설정 필요
      }
    } catch (err) {
      console.error(`Error fetching user data for ${userId}:`, err);
      callback({ success: false, message: '사용자 정보 로드 중 오류가 발생했습니다.' });
    }
  });

  // --- 신규 사용자 닉네임 설정 처리 ---
  socket.on('setup_nickname', async ({ userId, nickname }, callback) => {
      try {
          if (!userId || !nickname) {
              console.error("setup_nickname called with missing userId or nickname:", userId, nickname);
              return callback({ success: false, message: 'ID 또는 닉네임이 필요합니다.' });
          }
          // 혹시 모를 중복 ID 체크 (정상적으론 없어야 함)
          const existingUser = await pool.query('SELECT 1 FROM users WHERE user_id = $1', [userId]);
          if(existingUser.rowCount > 0) {
              console.warn(`Attempted to setup nickname for existing userId: ${userId}`);
              const userResult = await pool.query('SELECT user_id, nickname, previous_nickname, change_timestamps FROM users WHERE user_id = $1', [userId]);
              currentUserId = userId; // 재연결 처리
              return callback({ success: true, user: userResult.rows[0] });
          }

          // 닉네임 중복 체크
          const nicknameCheck = await pool.query('SELECT 1 FROM users WHERE nickname = $1', [nickname]);
          if (nicknameCheck.rowCount > 0) {
              console.log(`Nickname setup failed: ${nickname} already exists.`);
              return callback({ success: false, message: `닉네임 '${nickname}'은(는) 이미 사용 중입니다. 다른 닉네임을 입력해주세요.` });
          }

          // DB에 새 사용자 추가
          const newUserResult = await pool.query(
              'INSERT INTO users (user_id, nickname) VALUES ($1, $2) RETURNING user_id, nickname, previous_nickname, change_timestamps',
              [userId, nickname]
          );
          const newUser = newUserResult.rows[0];
          currentUserId = userId; // 소켓에 사용자 ID 연결
          console.log(`New user created: ${newUser.nickname} (${userId})`);
          callback({ success: true, user: newUser }); // 새로 생성된 정보 반환
      } catch (err) {
          console.error(`Error setting up nickname for ${userId}:`, err);
          callback({ success: false, message: '닉네임 설정 중 오류가 발생했습니다.' });
      }
  });

  // --- 닉네임 변경 요청 처리 ---
  socket.on('change_nickname', async ({ userId, newNickname }, callback) => {
    try {
        if (!userId || !newNickname) {
            console.error("change_nickname called with missing userId or newNickname:", userId, newNickname);
            return callback({ success: false, message: 'ID 또는 새 닉네임이 필요합니다.' });
        }
        if (userId !== currentUserId) { // 보안 체크
            console.warn(`Unauthorized nickname change attempt: socket ${socket.id} tried to change userId ${userId}`);
            return callback({ success: false, message: '잘못된 요청입니다.' });
        }

        // 1. 사용자 정보 및 변경 기록 조회
        const userResult = await pool.query('SELECT nickname, previous_nickname, change_timestamps FROM users WHERE user_id = $1', [userId]);
        if (userResult.rowCount === 0) {
            console.error(`User not found for nickname change: ${userId}`);
            return callback({ success: false, message: '사용자를 찾을 수 없습니다.' });
        }
        const currentUserData = userResult.rows[0];
        const currentNickname = currentUserData.nickname;
        const timestamps = currentUserData.change_timestamps || [];

        if (currentNickname === newNickname) {
            console.log(`Nickname change aborted: new nickname is same as current for ${userId}`);
            return callback({ success: false, message: '현재 닉네임과 동일합니다.'});
        }

        // 2. 변경 횟수 제한 체크 (2주 = 14일)
        const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
        const recentChanges = timestamps.filter(ts => new Date(ts).getTime() > twoWeeksAgo);
        if (recentChanges.length >= 2) {
            console.log(`Nickname change limit reached for ${userId}`);
            return callback({ success: false, message: '닉네임은 2주에 최대 2번만 변경할 수 있습니다.' });
        }

        // 3. 새 닉네임 중복 체크
        const nicknameCheck = await pool.query('SELECT 1 FROM users WHERE nickname = $1 AND user_id != $2', [newNickname, userId]);
        if (nicknameCheck.rowCount > 0) {
            console.log(`Nickname change failed: ${newNickname} already exists.`);
            return callback({ success: false, message: `닉네임 '${newNickname}'은(는) 이미 사용 중입니다.` });
        }

        // 4. DB 업데이트 (현재 닉네임을 previous로, 새 닉네임을 현재로, 타임스탬프 추가)
        const updateResult = await pool.query(
            'UPDATE users SET nickname = $1, previous_nickname = $2, change_timestamps = array_append(change_timestamps, NOW()) WHERE user_id = $3 RETURNING user_id, nickname, previous_nickname, change_timestamps',
            [newNickname, currentNickname, userId]
        );
        const updatedUser = updateResult.rows[0];
        console.log(`User ${currentNickname} (ID: ${userId}) changed nickname to ${newNickname}`);
        callback({ success: true, user: updatedUser }); // 업데이트된 정보 반환

        // 다른 사용자들에게 알림
        io.emit('user_renamed', { oldNick: currentNickname, newNick: newNickname });

    } catch (err) {
        console.error(`Error changing nickname for ${userId}:`, err);
        callback({ success: false, message: '닉네임 변경 중 오류가 발생했습니다.' });
    }
  });

  // --- 채팅 메시지 처리 ---
  socket.on('chat message', async (msg) => {
    // 메시지 유효성 검사 강화
    if (msg && msg.nick && msg.text && msg.timestamp && currentUserId) {
        // DB에서 보낸 사람의 현재 닉네임을 확인하는 것이 가장 정확하지만,
        // 여기서는 클라이언트가 보낸 닉네임(currentUser.nickname)을 신뢰한다고 가정
        io.emit('chat message', msg); // 모든 클라이언트에게 메시지 전달
    } else {
        console.warn("Invalid chat message received:", msg, "from socket:", socket.id);
    }
  });

  socket.on('disconnect', () => {
    console.log('user disconnected:', socket.id, currentUserId ? `(User ID: ${currentUserId})` : '');
    currentUserId = null; // 연결 해제 시 ID 초기화
  });
});

const listener = server.listen(process.env.PORT || 3000, () => {
  const port = listener.address()?.port;
  console.log(`Your app is listening on port ${port || process.env.PORT || 3000}`);
});
