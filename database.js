import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
  connectionLimit: 10,
  queueLimit: 0
});

// Exemple d'utilisation :
// const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);

// Fonction pour initialiser la base de données (créer les tables si elles n'existent pas)
const initDatabase = async () => {
  try {
    // Créer la table users
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(64) PRIMARY KEY,
        googleId VARCHAR(128) UNIQUE,
        name VARCHAR(255),
        email VARCHAR(255) UNIQUE,
        mysql_id VARCHAR(64),
        has_paid_bot BOOLEAN DEFAULT FALSE,
        chatbotMessagesUsed INT DEFAULT 0,
        chatbotMessagesQuota INT DEFAULT 1000
      )
    `);

    // Créer la table conversations
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS conversations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        userId VARCHAR(64),
        title VARCHAR(255),
        status INT DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Créer la table messages
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        userId VARCHAR(64),
        conversationId INT,
        sender VARCHAR(32) NOT NULL,
        text TEXT NOT NULL,
        context TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (conversationId) REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Créer les tables liées au Quran (progression, favoris, stats, objectifs, notifications, etc.)
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS quran_stats (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id VARCHAR(64) NOT NULL,
          date DATE NOT NULL,
          hasanat INT DEFAULT 0,
          verses INT DEFAULT 0,
          time_seconds INT DEFAULT 0,
          pages_read INT DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY unique_user_date (user_id, date),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS reading_progress (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id VARCHAR(64) NOT NULL,
          surah INT NOT NULL,
          ayah INT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE KEY unique_user_progress (user_id)
      )
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS reading_history (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id VARCHAR(64) NOT NULL,
          surah INT NOT NULL,
          ayah INT NOT NULL,
          action_type ENUM('read', 'listen', 'complete') NOT NULL,
          duration_seconds INT DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS favorites (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id VARCHAR(64) NOT NULL,
          type ENUM('surah', 'ayah', 'dua') NOT NULL,
          reference_id INT NOT NULL,
          reference_text TEXT,
          notes TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE KEY unique_user_favorite (user_id, type, reference_id)
      )
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS reading_sessions (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id VARCHAR(64) NOT NULL,
          start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          end_time TIMESTAMP NULL,
          duration_seconds INT DEFAULT 0,
          verses_read INT DEFAULT 0,
          hasanat_earned INT DEFAULT 0,
          device_info JSON,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS reading_goals (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id VARCHAR(64) NOT NULL,
          goal_type ENUM('daily_verses', 'daily_time', 'weekly_surahs', 'monthly_pages') NOT NULL,
          target_value INT NOT NULL,
          current_value INT DEFAULT 0,
          start_date DATE NOT NULL,
          end_date DATE NOT NULL,
          is_completed BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS notifications (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id VARCHAR(64) NOT NULL,
          type ENUM('goal_achieved', 'daily_reminder', 'weekly_report', 'system') NOT NULL,
          title VARCHAR(255) NOT NULL,
          message TEXT NOT NULL,
          is_read BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS global_stats (
          id INT AUTO_INCREMENT PRIMARY KEY,
          date DATE NOT NULL,
          total_users INT DEFAULT 0,
          total_verses_read INT DEFAULT 0,
          total_hasanat_earned BIGINT DEFAULT 0,
          total_reading_time BIGINT DEFAULT 0,
          active_users INT DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY unique_date (date)
      )
    `);

    console.log('✅ Base de données MySQL initialisée');
  } catch (error) {
    console.error('❌ Erreur lors de l\'initialisation de la base de données MySQL:', error);
    process.exit(1);
  }
};

// Fonction pour synchroniser un utilisateur vers la base MySQL (avec fetch)
const syncUserToMySQL = async (googleId, name, email) => {
  try {
    console.log('[SYNC] Tentative de synchro MySQL pour', email, 'via', process.env.SQL_API_URL);
    const response = await fetch(process.env.SQL_API_URL, {
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
      // Initialiser les stats à 0 pour ce nouvel utilisateur
      try {
        await fetch(process.env.SQL_API_URL.replace('/users', '/stats'), {
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

// Fonction pour trouver ou créer un utilisateur (async pour Passport)
const findOrCreateUser = async (googleId, name, email) => {
  console.log('[FIND_OR_CREATE] Appel avec', googleId, name, email);
  const [user] = await pool.execute('SELECT * FROM users WHERE googleId = ?', [googleId]);

  if (user) {
    // Initialiser les champs de quota si absents (migration douce)
    if (user.chatbotMessagesUsed === undefined) {
      await pool.execute('UPDATE users SET chatbotMessagesUsed = 0 WHERE id = ?', [googleId]);
    }
    if (user.chatbotMessagesQuota === undefined) {
      await pool.execute('UPDATE users SET chatbotMessagesQuota = 1000 WHERE id = ?', [googleId]);
    }
    // Recharger l'utilisateur après update éventuel
    const [updatedUser] = await pool.execute('SELECT * FROM users WHERE googleId = ?', [googleId]);
    // Vérifier si l'utilisateur a déjà un ID MySQL, sinon le synchroniser
    if (!updatedUser.mysql_id) {
      console.log('🔄 Utilisateur existant sans ID MySQL, synchronisation...');
      try {
        const mysqlUserId = await syncUserToMySQL(googleId, name, email);
        if (mysqlUserId) {
          await pool.execute('UPDATE users SET mysql_id = ? WHERE id = ?', [mysqlUserId, googleId]);
          console.log('✅ ID MySQL ajouté à l\'utilisateur existant:', mysqlUserId);
        }
      } catch (error) {
        console.error('❌ Erreur synchronisation MySQL pour utilisateur existant:', error);
      }
    }
    return updatedUser;
  } else {
    console.log('User not found, creating new user...');
    await pool.execute('INSERT INTO users (id, googleId, name, email, chatbotMessagesUsed, chatbotMessagesQuota) VALUES (?, ?, ?, ?, 0, 1000)',
      [googleId, googleId, name, email]
    );
    // Synchroniser vers MySQL (BLOQUANT)
    const mysqlUserId = await syncUserToMySQL(googleId, name, email);
    if (mysqlUserId) {
      await pool.execute('UPDATE users SET mysql_id = ? WHERE id = ?', [mysqlUserId, googleId]);
      console.log('✅ ID MySQL ajouté à l\'utilisateur SQLite:', mysqlUserId);
      return await pool.execute('SELECT * FROM users WHERE id = ?', [googleId]);
    } else {
      await pool.execute('DELETE FROM users WHERE id = ?', [googleId]);
      console.error('❌ Impossible de synchroniser l\'utilisateur avec MySQL, annulation de la création.');
      return null;
    }
  }
};

// Fonction pour trouver un utilisateur par son ID (pour la désérialisation Passport)
const findUserById = async (id) => {
  console.log('DB: findUserById - Attempting to find user with ID:', id);
  try {
    const [user] = await pool.execute('SELECT * FROM users WHERE id = ?', [id]);
    console.log('DB: findUserById - Result for ID', id, ':', user);
    return user;
  } catch (err) {
    console.error('DB: findUserById - Error finding user with ID', id, ':', err);
    throw err; // Rethrow the error so it can be caught by deserializeUser
  }
};

// Fonction pour récupérer tous les utilisateurs (maintenant non utilisée par le frontend public)
const getAllUsers = async () => {
  const [users] = await pool.execute('SELECT id, name, email FROM users');
  console.log('Fetching all users:', users);
  return users;
};

// === SUPPRESSION DE LA LOGIQUE MULTI-BOT ET CLÉS D'ACTIVATION ===
// Les fonctions suivantes sont supprimées :
// - getBots, getBotById, addBot, updateBot, deleteBot
// - countUserMessages, isBotActivatedForUser, checkMessageLimit, activateBotForUser, getActivatedBotsForUser, addActivationKey
// - getConversationsForUserBot, deleteConversation (version avec botId), updateConversationTitle (version avec botId), searchMessages (version avec botId), updateConversationStatus (version avec botId)
// - saveUserBotPreferences, getUserBotPreferences
//
// Les fonctions de messages/conversations sont simplifiées pour ne plus utiliser botId.

// Nouvelle fonction pour ajouter un message (sans botId)
export async function addMessage(userId, conversationId, sender, text, context = null) {
  try {
    const stmt = await pool.execute(`
      INSERT INTO messages (userId, conversationId, sender, text, context)
      VALUES (?, ?, ?, ?, ?)
    `, [userId, conversationId, sender, text, context]);
    return stmt[0].insertId;
  } catch (err) {
    console.error('Erreur lors de l\'ajout du message:', err);
    throw err;
  }
}

// Nouvelle fonction pour récupérer les messages d'une conversation
export async function getMessagesForConversation(userId, conversationId, limit = 10) {
  try {
    const stmt = await pool.execute(`
      SELECT sender, text, timestamp
      FROM messages
      WHERE userId = ? AND conversationId = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `, [userId, conversationId, limit]);
    return stmt[0].reverse();
  } catch (err) {
    console.error('Erreur lors de la récupération des messages:', err);
    throw err;
  }
}

// Nouvelle fonction pour ajouter une conversation
export async function addConversation(userId, title) {
  const stmt = await pool.execute(`
    INSERT INTO conversations (userId, title)
    VALUES (?, ?)
  `, [userId, title]);
  return stmt[0].insertId;
}

// Nouvelle fonction pour récupérer les conversations d'un utilisateur
export async function getConversationsForUser(userId) {
  const stmt = await pool.execute(`
    SELECT id, title, status, createdAt, updatedAt
    FROM conversations
    WHERE userId = ?
    ORDER BY createdAt DESC
  `, [userId]);
  return stmt[0];
}

// Nouvelle fonction pour supprimer une conversation
export async function deleteConversation(userId, conversationId) {
  const stmt = await pool.execute(`
    DELETE FROM conversations 
    WHERE id = ? AND userId = ?
  `, [conversationId, userId]);
  return stmt[0].affectedRows > 0;
}

// Nouvelle fonction pour mettre à jour le titre d'une conversation
export async function updateConversationTitle(userId, conversationId, title) {
  try {
    const stmt = await pool.execute(`
      UPDATE conversations
      SET title = ?, updatedAt = CURRENT_TIMESTAMP
      WHERE id = ? AND userId = ?
    `, [title, conversationId, userId]);
    return stmt[0].affectedRows > 0;
  } catch (err) {
    console.error('Erreur lors de la mise à jour du titre de la conversation dans la base de données:', err);
    throw err;
  }
}

// Nouvelle fonction pour rechercher des messages dans une conversation
export async function searchMessages(userId, conversationId, query) {
  try {
    const searchTerm = `%${query.replace(/[%_]/g, '$&')}%`;
    const stmt = await pool.execute(`
      SELECT sender, text, timestamp
      FROM messages
      WHERE userId = ? AND conversationId = ? AND text LIKE ? COLLATE NOCASE
      ORDER BY timestamp ASC
    `, [userId, conversationId, searchTerm]);
    return stmt[0];
  } catch (err) {
    console.error('Erreur lors de la recherche de messages:', err);
    throw err;
  }
}

// Nouvelle fonction pour mettre à jour le statut d'une conversation
export async function updateConversationStatus(userId, conversationId, status) {
  const stmt = await pool.execute(`
    UPDATE conversations
    SET status = ?, updatedAt = CURRENT_TIMESTAMP
    WHERE id = ? AND userId = ?
  `, [status, conversationId, userId]);
  return stmt[0].affectedRows > 0;
}

// Nouvelle fonction pour récupérer une conversation par son ID
export async function getConversationById(conversationId) {
  const stmt = await pool.execute('SELECT * FROM conversations WHERE id = ?', [conversationId]);
  return stmt[0];
}

// Fonction pour récupérer l'ID MySQL d'un utilisateur
const getMySQLUserId = async (googleId) => {
  const [user] = await pool.execute('SELECT id FROM users WHERE googleId = ?', [googleId]);
  return user.length > 0 ? user[0].mysql_id : null;
};

// Fonction pour mettre à jour l'ID MySQL d'un utilisateur
const updateUserMySQLId = async (googleId, mysqlId) => {
  const stmt = await pool.execute('UPDATE users SET mysql_id = ? WHERE googleId = ?', [mysqlId, googleId]);
  return stmt[0].affectedRows > 0;
};

// Fonction pour vérifier le quota global de messages chatbot
async function checkGlobalChatbotQuota(userId, email) {
  // Admin illimité
  if (email === 'mohammadharris200528@gmail.com') {
    return { canSend: true, remaining: Infinity };
  }
  const [user] = await pool.execute('SELECT chatbotMessagesUsed, chatbotMessagesQuota FROM users WHERE id = ?', [userId]);
  if (user.length === 0) return { canSend: false, remaining: 0 };
  const remaining = (user[0].chatbotMessagesQuota ?? 1000) - (user[0].chatbotMessagesUsed ?? 0);
  return {
    canSend: remaining > 0,
    remaining
  };
}

// Fonction pour incrémenter le compteur de messages chatbot
async function incrementChatbotMessagesUsed(userId) {
  await pool.execute('UPDATE users SET chatbotMessagesUsed = COALESCE(chatbotMessagesUsed,0) + 1 WHERE id = ?', [userId]);
}

// --- Fonctions utilitaires pour les tables du Quran ---

// quran_stats
export async function upsertQuranStats(userId, date, hasanat, verses, time_seconds, pages_read) {
  await pool.execute(`
    INSERT INTO quran_stats (user_id, date, hasanat, verses, time_seconds, pages_read)
    VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      hasanat = hasanat + VALUES(hasanat),
      verses = verses + VALUES(verses),
      time_seconds = time_seconds + VALUES(time_seconds),
      pages_read = pages_read + VALUES(pages_read)
  `, [userId, date, hasanat, verses, time_seconds, pages_read]);
}

export async function getQuranStats(userId, fromDate = null, toDate = null) {
  let query = 'SELECT * FROM quran_stats WHERE user_id = ?';
  const params = [userId];
  if (fromDate) {
    query += ' AND date >= ?';
    params.push(fromDate);
  }
  if (toDate) {
    query += ' AND date <= ?';
    params.push(toDate);
  }
  query += ' ORDER BY date DESC';
  const [rows] = await pool.execute(query, params);
  return rows;
}

// reading_progress
export async function upsertReadingProgress(userId, surah, ayah) {
  await pool.execute(`
    INSERT INTO reading_progress (user_id, surah, ayah)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE surah = VALUES(surah), ayah = VALUES(ayah)
  `, [userId, surah, ayah]);
}

export async function getReadingProgress(userId) {
  const [rows] = await pool.execute('SELECT * FROM reading_progress WHERE user_id = ?', [userId]);
  return rows.length > 0 ? rows[0] : null;
}

// favorites
export async function addFavorite(userId, type, referenceId, referenceText = null, notes = null) {
  await pool.execute(`
    INSERT INTO favorites (user_id, type, reference_id, reference_text, notes)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE reference_text = VALUES(reference_text), notes = VALUES(notes)
  `, [userId, type, referenceId, referenceText, notes]);
}

export async function removeFavorite(userId, type, referenceId) {
  await pool.execute('DELETE FROM favorites WHERE user_id = ? AND type = ? AND reference_id = ?', [userId, type, referenceId]);
}

export async function getFavorites(userId, type = null) {
  let query = 'SELECT * FROM favorites WHERE user_id = ?';
  const params = [userId];
  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }
  query += ' ORDER BY created_at DESC';
  const [rows] = await pool.execute(query, params);
  return rows;
}

// reading_goals
export async function addOrUpdateReadingGoal(userId, goalType, targetValue, currentValue, startDate, endDate, isCompleted = false) {
  await pool.execute(`
    INSERT INTO reading_goals (user_id, goal_type, target_value, current_value, start_date, end_date, is_completed)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      target_value = VALUES(target_value),
      current_value = VALUES(current_value),
      is_completed = VALUES(is_completed),
      updated_at = CURRENT_TIMESTAMP
  `, [userId, goalType, targetValue, currentValue, startDate, endDate, isCompleted]);
}

export async function getReadingGoals(userId, onlyActive = false) {
  let query = 'SELECT * FROM reading_goals WHERE user_id = ?';
  const params = [userId];
  if (onlyActive) {
    query += ' AND is_completed = FALSE';
  }
  query += ' ORDER BY end_date DESC';
  const [rows] = await pool.execute(query, params);
  return rows;
}

// notifications
export async function addNotification(userId, type, title, message) {
  await pool.execute(`
    INSERT INTO notifications (user_id, type, title, message)
    VALUES (?, ?, ?, ?)
  `, [userId, type, title, message]);
}

export async function getNotifications(userId, onlyUnread = false) {
  let query = 'SELECT * FROM notifications WHERE user_id = ?';
  const params = [userId];
  if (onlyUnread) {
    query += ' AND is_read = FALSE';
  }
  query += ' ORDER BY created_at DESC';
  const [rows] = await pool.execute(query, params);
  return rows;
}

export { 
  initDatabase, 
  findOrCreateUser, 
  findUserById, 
  getAllUsers, 
  getMySQLUserId,
  updateUserMySQLId,
  checkGlobalChatbotQuota,
  incrementChatbotMessagesUsed,
  syncUserToMySQL
}; 