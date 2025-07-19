import mysql from 'mysql2/promise';

// Connexion MySQL OVH
const mysqlPool = mysql.createPool({
  host: 'mh285989-001.eu.clouddb.ovh.net',
  port: 35693,
  user: 'bts',
  password: 'Harris91270',
  database: 'islamicApp',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 10000, // 10s
  acquireTimeout: 10000  // 10s
});

// Ping automatique toutes les 5 minutes pour garder la connexion vivante
setInterval(async () => {
  try {
    await mysqlPool.query('SELECT 1');
    // console.log('MySQL keep-alive ping');
  } catch (err) {
    console.error('Erreur MySQL keep-alive ping:', err);
  }
}, 5 * 60 * 1000);

// Fonction pour synchroniser un utilisateur vers la base MySQL (avec fetch)
const SQL_API_URL = process.env.SQL_API_URL || (process.env.NODE_ENV === 'production'
  ? 'https://appislamic-sql.onrender.com/api/users'
  : 'http://localhost:3000/api/users');

const syncUserToMySQL = async (googleId, name, email) => {
  try {
    console.log('[SYNC] Tentative de synchro MySQL pour', email, 'via', SQL_API_URL);
    const response = await fetch(SQL_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: email,
        username: name,
        preferences: {
          theme: 'default',
          arabicFont: 'Amiri',
          arabicFontSize: '2.5rem',
          reciter: 'mishary_rashid_alafasy'
        }
      })
    });
    const result = await response.json();
    console.log('[SYNC] Réponse MySQL:', result);
    if (response.ok && result.user && result.user.id) {
      try {
        await fetch(SQL_API_URL.replace('/users', '/stats'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: result.user.id,
            hasanat: 0,
            verses: 0,
            time: 0,
            pages: 0
          })
        });
        console.log('✅ Stats initialisées à 0 pour l\'utilisateur MySQL:', result.user.id);
      } catch (err) {
        console.error('❌ Erreur lors de l\'initialisation des stats:', err);
      }
      return result.user.id;
    } else {
      console.error('[SYNC] Erreur MySQL:', result);
      return null;
    }
  } catch (error) {
    console.error('[SYNC] Erreur réseau:', error);
    return null;
  }
};

export async function findOrCreateUser(googleId, username, email) {
  let [rows] = await mysqlPool.query('SELECT * FROM users WHERE id = ?', [googleId]);
  if (rows.length > 0) {
    const user = rows[0];
    if (user.chatbotMessagesUsed === null || user.chatbotMessagesUsed === undefined) {
      await mysqlPool.query('UPDATE users SET chatbotMessagesUsed = 0 WHERE id = ?', [googleId]);
    }
    if (user.chatbotMessagesQuota === null || user.chatbotMessagesQuota === undefined) {
      await mysqlPool.query('UPDATE users SET chatbotMessagesQuota = 1000 WHERE id = ?', [googleId]);
    }
    [rows] = await mysqlPool.query('SELECT * FROM users WHERE id = ?', [googleId]);
    const userFinal = rows[0];
    // On utilise la colonne isAdmin de la base
    userFinal.isAdmin = !!userFinal.isAdmin;
    return userFinal;
  }
  await mysqlPool.query(
    'INSERT INTO users (id, email, username, chatbotMessagesUsed, chatbotMessagesQuota) VALUES (?, ?, ?, 0, 1000)',
    [googleId, email, username]
  );
  [rows] = await mysqlPool.query('SELECT * FROM users WHERE id = ?', [googleId]);
  const userFinal = rows[0];
  userFinal.isAdmin = (userFinal.email === 'mohammadharris200528@gmail.com');
  return userFinal;
}

export async function findUserById(id) {
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM users WHERE id = ?', [id]);
    if (!rows[0]) return null;
    const user = rows[0];
    user.isAdmin = (user.email === 'mohammadharris200528@gmail.com');
    return user;
  } catch (err) {
    console.error('Erreur MySQL dans findUserById:', err);
    return null;
  }
}

export async function checkGlobalChatbotQuota(userId, email) {
  if (email === 'mohammadharris200528@gmail.com') {
    return { canSend: true, remaining: Infinity };
  }
  const [rows] = await mysqlPool.query('SELECT chatbotMessagesUsed, chatbotMessagesQuota FROM users WHERE id = ?', [userId]);
  if (!rows[0]) return { canSend: false, remaining: 0 };
  const user = rows[0];
  const remaining = (user.chatbotMessagesQuota ?? 1000) - (user.chatbotMessagesUsed ?? 0);
  return {
    canSend: remaining > 0,
    remaining
  };
}

export async function incrementChatbotMessagesUsed(userId) {
  await mysqlPool.query('UPDATE users SET chatbotMessagesUsed = COALESCE(chatbotMessagesUsed,0) + 1 WHERE id = ?', [userId]);
}

export async function getUserStats(userId) {
  const [rows] = await mysqlPool.query(
    `SELECT 
      COALESCE(SUM(hasanat), 0) as hasanat,
      COALESCE(SUM(verses), 0) as verses,
      COALESCE(SUM(time_seconds), 0) as time_seconds,
      COALESCE(SUM(pages_read), 0) as pages_read
    FROM quran_stats
    WHERE user_id = ?`, [userId]
  );
  return rows[0];
}

export async function updateConversationTitleMySQL(userId, botId, conversationId, title) {
    try {
    const [result] = await mysqlPool.execute(
      'UPDATE conversations SET title = ?, updatedAt = NOW() WHERE id = ? AND userId = ? AND botId = ?',
      [title, conversationId, userId, botId]
    );
    return result.affectedRows > 0;
    } catch (err) {
    console.error('Erreur SQL MySQL lors du renommage:', err);
    throw err;
    }
}

export async function deleteConversationMySQL(userId, botId, conversationId) {
  const [result] = await mysqlPool.execute(
    'DELETE FROM conversations WHERE id = ? AND userId = ? AND botId = ?',
    [conversationId, userId, botId]
  );
  return result.affectedRows > 0;
}

export async function getConversationsForUserBot(userId, botId) {
  const [rows] = await mysqlPool.query(
    'SELECT * FROM conversations WHERE userId = ? AND botId = ?',
    [userId, botId]
  );
  return rows;
}

export async function getBotById(botId) {
  const [rows] = await mysqlPool.query(
    'SELECT * FROM bots WHERE id = ?',
    [botId]
  );
  return rows[0];
}

export async function getMessagesForUserBot(userId, botId, conversationId = 0, limit = 10) {
  // Si conversationId est fourni (>0), filtre dessus, sinon prend tous les messages du user/bot
  let query = 'SELECT * FROM messages WHERE userId = ? AND botId = ?';
  const params = [userId, botId];
  if (conversationId > 0) {
    query += ' AND conversationId = ?';
    params.push(conversationId);
  }
  query += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);
  const [rows] = await mysqlPool.query(query, params);
  return rows.reverse(); // Pour avoir du plus ancien au plus récent
}

export async function getUserBotPreferences(userId, botId) {
  const [rows] = await mysqlPool.query(
    'SELECT * FROM user_bot_preferences WHERE userId = ? AND botId = ?',
    [userId, botId]
  );
  return rows[0] || null;
}

// Enregistrer un résultat de quiz
export async function saveQuizResult(userId, theme, level, score, total, details = null, quiz_id) {
  const date = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await mysqlPool.query(
    'INSERT INTO quiz_results (user_id, quiz_id, theme, level, score, total, date, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, quiz_id, theme, level, score, total, date, details ? JSON.stringify(details) : null]
  );
}

// Récupérer l’historique des quiz d’un utilisateur
export async function getQuizResultsForUser(userId) {
  const [rows] = await mysqlPool.query(
    'SELECT * FROM quiz_results WHERE user_id = ? ORDER BY date DESC',
    [userId]
  );
  return rows;
}

export async function setMaintenance(enabled, id = '', pwd = '') {
  await mysqlPool.query(
    'UPDATE maintenance SET enabled = ?, admin_id = ?, admin_pwd = ? WHERE id = 1',
    [!!enabled, id, pwd]
  );
}

export async function getMaintenance() {
  const [rows] = await mysqlPool.query('SELECT enabled, admin_id, admin_pwd FROM maintenance WHERE id = 1');
  if (!rows[0]) return { enabled: false, id: '', pwd: '' };
  return { enabled: !!rows[0].enabled, id: rows[0].admin_id || '', pwd: rows[0].admin_pwd || '' };
}

export { 
  mysqlPool,
  syncUserToMySQL
  
}; 