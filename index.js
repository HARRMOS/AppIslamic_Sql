const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const morgan = require('morgan');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
app.set('trust proxy', 1);


// =====================================================
// CONFIGURATION BASE DE DONNÉES OVH
// =====================================================

const dbConfig = {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
  connectionLimit: 10,
  queueLimit: 0
};

// Pool de connexions
let pool;

// Configuration de la stratégie Google Passport AVANT les routes
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails[0].value;
    const username = profile.displayName;
    // Cherche l'utilisateur
    const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    let user;
    if (rows.length) {
      user = rows[0];
    } else {
      // Crée l'utilisateur
      const userId = require('crypto').randomUUID();
      await pool.execute(
        'INSERT INTO users (id, email, username) VALUES (?, ?, ?)',
        [userId, email, username]
      );
      user = { id: userId, email, username };
    }
    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

passport.serializeUser((user, done) => {
  done(null, user.id);
});
passport.deserializeUser(async (id, done) => {
  if (!pool) return done(null, false);
  const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [id]);
  if (rows.length) done(null, rows[0]);
  else done(null, false);
});

async function initializeDatabase() {
  try {
    pool = mysql.createPool(dbConfig);
    
    // Test de connexion
    const connection = await pool.getConnection();
    console.log('✅ Connexion à la base de données OVH réussie');
    connection.release();
  } catch (error) {
    console.error('❌ Erreur de connexion à la base de données:', error.message);
    process.exit(1);
  }
}

// =====================================================
// MIDDLEWARE
// =====================================================

// Sécurité
app.use(helmet());

// Correction du middleware CORS
const allowedOrigins = [
  'https://www.quran-pro.harrmos.com',
  'http://localhost:5173'
];
app.use(cors({
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// Compression
app.use(compression());

// Logs
app.use(morgan('combined'));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Session
app.use(session({
  secret: process.env.SESSION_SECRET || 'supersecret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // true si HTTPS
}));
app.use(passport.initialize());
app.use(passport.session());


app.get('/auth/status', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated() && req.user) {
    res.json({ authenticated: true, user: req.user });
  } else {
    res.json({ authenticated: false, user: null });
  }
});

// =====================================================
// ROUTES API
// =====================================================

// Route de santé
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    database: pool ? 'connected' : 'disconnected'
  });
});

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, res) => {
    res.redirect(process.env.FRONTEND_URL || 'http://localhost:5173');
  }
);
// === ROUTE D'INITIATION GOOGLE OAUTH ===
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

// === ROUTE DE LOGOUT ===
app.get('/auth/logout', (req, res) => {
  req.logout(() => {
    res.redirect(process.env.FRONTEND_URL || 'http://localhost:5173');
  });
});
// =====================================================
// ROUTES UTILISATEURS
// =====================================================

// Créer un utilisateur
app.post('/api/users', async (req, res) => {
  try {
    const { email, username, preferences } = req.body;
    
    // Vérifier si l'utilisateur existe déjà par email
    const [existingUsers] = await pool.execute(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );
    
    if (existingUsers.length > 0) {
      // Utilisateur déjà existant, retourner son ID
      const existingUser = existingUsers[0];
      console.log(`✅ Utilisateur existant trouvé: ${email} (ID: ${existingUser.id})`);
      return res.status(200).json({
        success: true,
        user: { 
          id: existingUser.id, 
          email, 
          username, 
          preferences: JSON.parse(existingUsers[0].preferences || '{}'),
          existing: true
        }
      });
    }
    
    // Créer un nouvel utilisateur
    const userId = require('crypto').randomUUID();
    const [result] = await pool.execute(
      'INSERT INTO users (id, email, username, preferences) VALUES (?, ?, ?, ?)',
      [userId, email, username, JSON.stringify(preferences || {})]
    );
    
    console.log(`✅ Nouvel utilisateur créé: ${email} (ID: ${userId})`);
    res.status(201).json({
      success: true,
      user: { id: userId, email, username, preferences, existing: false }
    });
  } catch (error) {
    console.error('Erreur création utilisateur:', error);
    res.status(500).json({ 
      error: 'Erreur lors de la création de l\'utilisateur',
      details: error.message 
    });
  }
});

// Obtenir un utilisateur
app.get('/api/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const [rows] = await pool.execute(
      'SELECT id, email, username, preferences, created_at, last_login FROM users WHERE id = ?',
      [userId]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }
    
    res.json({ success: true, user: rows[0] });
  } catch (error) {
    console.error('Erreur récupération utilisateur:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Non authentifié' });
}

app.get('/api/user/mysql-id', isAuthenticated, async (req, res) => {
  res.json({ mysqlUserId: req.user.id });
});

// Mettre à jour les préférences utilisateur
app.put('/api/users/:userId/preferences', async (req, res) => {
  try {
    const { userId } = req.params;
    const { preferences } = req.body;
    
    const [result] = await pool.execute(
      'UPDATE users SET preferences = ? WHERE id = ?',
      [JSON.stringify(preferences), userId]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }
    
    res.json({ success: true, message: 'Préférences mises à jour' });
  } catch (error) {
    console.error('Erreur mise à jour préférences:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// =====================================================
// ROUTES STATISTIQUES
// =====================================================

// Incrémenter les stats quotidiennes
app.post('/api/stats', async (req, res) => {
  try {
    const { userId, hasanat = 0, verses = 0, time = 0, pages = 0 } = req.body;
    // Si aucune stat à incrémenter, ignorer la requête
    if (hasanat === 0 && verses === 0 && time === 0 && pages === 0) {
      return res.json({ success: true, message: 'Aucune stat à incrémenter' });
    }
    // S'assurer qu'une ligne existe pour l'utilisateur et la date du jour
    await pool.execute(
      'INSERT IGNORE INTO quran_stats (user_id, date) VALUES (?, CURDATE())',
      [userId]
    );
    // Utiliser la procédure stockée
    await pool.execute(
      'CALL IncrementDailyStats(?, ?, ?, ?)',
      [userId, hasanat, verses, time]
    );
    // Mettre à jour les pages si fournies
    if (pages > 0) {
      await pool.execute(
        'UPDATE quran_stats SET pages_read = pages_read + ? WHERE user_id = ? AND date = CURDATE()',
        [pages, userId]
      );
    }
    res.json({ success: true, message: 'Stats mises à jour' });
  } catch (error) {
    console.error('Erreur mise à jour stats:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour des stats' });
  }
});

// Obtenir les stats d'une période ou d'une date précise
app.get('/api/stats/:userId/:period', async (req, res) => {
  try {
    const { userId, period } = req.params;
    // Si period est une date (YYYY-MM-DD)
    if (/^\d{4}-\d{2}-\d{2}$/.test(period)) {
      const [rows] = await pool.execute(
        'SELECT hasanat, verses, time_seconds, pages_read FROM quran_stats WHERE user_id = ? AND date = ?',
        [userId, period]
      );
      return res.json({
        success: true,
        stats: rows[0] || { hasanat: 0, verses: 0, time_seconds: 0, pages_read: 0 }
      });
    }
    // Sinon, utiliser la procédure stockée
    const [rows] = await pool.execute(
      'CALL GetUserStats(?, ?)',
      [userId, period]
    );
    res.json({ 
      success: true, 
      stats: rows[0] || { hasanat: 0, verses: 0, time_seconds: 0, pages_read: 0 }
    });
  } catch (error) {
    console.error('Erreur récupération stats:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des stats' });
  }
});

// Obtenir les stats détaillées par jour
app.get('/api/stats/:userId/daily/:days', async (req, res) => {
  try {
    const { userId, days } = req.params;
    const limit = Math.min(parseInt(days) || 30, 365); // Max 365 jours
    
    const [rows] = await pool.execute(
      `SELECT date, hasanat, verses, time_seconds, pages_read 
       FROM quran_stats 
       WHERE user_id = ? 
       ORDER BY date DESC 
       LIMIT ?`,
      [userId, limit]
    );
    
    res.json({ success: true, stats: rows });
  } catch (error) {
    console.error('Erreur récupération stats détaillées:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Route pour les stats du jour
app.get('/api/stats/today', isAuthenticated, async (req, res) => {
  const userId = req.user.id;
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM quran_stats WHERE user_id = ? AND date = CURDATE()',
      [userId]
    );
    res.json({ success: true, stats: rows });
  } catch (error) {
    console.error('Erreur récupération stats today:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Route pour les stats de la semaine
app.get('/api/stats/week', isAuthenticated, async (req, res) => {
  const userId = req.user.id;
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM quran_stats WHERE user_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY) ORDER BY date ASC',
      [userId]
    );
    res.json({ success: true, stats: rows });
  } catch (error) {
    console.error('Erreur récupération stats week:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Route pour toutes les stats
app.get('/api/stats/all', isAuthenticated, async (req, res) => {
  const userId = req.user.id;
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM quran_stats WHERE user_id = ? ORDER BY date ASC',
      [userId]
    );
    res.json({ success: true, stats: rows });
  } catch (error) {
    console.error('Erreur récupération stats all:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// =====================================================
// ROUTES PROGRESSION
// =====================================================

// Sauvegarder la progression de lecture
app.post('/api/progress', isAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { surah, ayah } = req.body;
  try {
    const [result] = await pool.execute(
      'INSERT INTO reading_progress (user_id, surah, ayah) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE surah = VALUES(surah), ayah = VALUES(ayah)',
      [userId, surah, ayah]
    );
    res.json({ success: true, message: 'Progression sauvegardée' });
  } catch (error) {
    console.error('Erreur sauvegarde progression:', error);
    res.status(500).json({ error: 'Erreur lors de la sauvegarde' });
  }
});

// Obtenir la progression de lecture
app.get('/api/progress', isAuthenticated, async (req, res) => {
  const userId = req.user.id;
  try {
    const [rows] = await pool.execute(
      'SELECT surah, ayah, updated_at FROM reading_progress WHERE user_id = ?',
      [userId]
    );
    res.json({ success: true, progress: rows[0] || { surah: 1, ayah: 1, updated_at: null } });
  } catch (error) {
    console.error('Erreur récupération progression:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// =====================================================
// ROUTES HISTORIQUE
// =====================================================

// Ajouter une entrée d'historique
app.post('/api/history', isAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { surah, ayah, actionType, duration = 0 } = req.body;
  try {
    const [result] = await pool.execute(
      'INSERT INTO reading_history (user_id, surah, ayah, action_type, duration_seconds) VALUES (?, ?, ?, ?, ?)',
      [userId, surah, ayah, actionType, duration]
    );
    res.json({ success: true, message: 'Historique ajouté' });
  } catch (error) {
    console.error('Erreur ajout historique:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Obtenir l'historique de lecture
app.get('/api/history/:limit', isAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const limitNum = Math.min(parseInt(req.params.limit) || 50, 100);
  try {
    const [rows] = await pool.execute(
      `SELECT surah, ayah, action_type, duration_seconds, created_at 
       FROM reading_history 
       WHERE user_id = ? 
       ORDER BY created_at DESC 
       LIMIT ?`,
      [userId, limitNum]
    );
    res.json({ success: true, history: rows });
  } catch (error) {
    console.error('Erreur récupération historique:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// =====================================================
// ROUTES FAVORIS
// =====================================================

// Ajouter un favori
app.post('/api/favorites', isAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { type, referenceId, referenceText, notes } = req.body;
  try {
    const [result] = await pool.execute(
      'INSERT INTO favorites (user_id, type, reference_id, reference_text, notes) VALUES (?, ?, ?, ?, ?)',
      [userId, type, referenceId, referenceText, notes]
    );
    res.json({ success: true, message: 'Favori ajouté' });
  } catch (error) {
    console.error('Erreur ajout favori:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Obtenir les favoris
app.get('/api/favorites', isAuthenticated, async (req, res) => {
  const userId = req.user.id;
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM favorites WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
    res.json({ success: true, favorites: rows });
  } catch (error) {
    console.error('Erreur récupération favoris:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Supprimer un favori
app.delete('/api/favorites/:favoriteId', async (req, res) => {
  try {
    const { favoriteId } = req.params;
    
    const [result] = await pool.execute(
      'DELETE FROM favorites WHERE id = ?',
      [favoriteId]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Favori non trouvé' });
    }
    
    res.json({ success: true, message: 'Favori supprimé' });
  } catch (error) {
    console.error('Erreur suppression favori:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// =====================================================
// ROUTES SESSIONS
// =====================================================

// Démarrer une session
app.post('/api/sessions/start', async (req, res) => {
  try {
    const { userId, deviceInfo } = req.body;
    
    const [result] = await pool.execute(
      'INSERT INTO reading_sessions (user_id, device_info) VALUES (?, ?)',
      [userId, JSON.stringify(deviceInfo || {})]
    );
    
    res.json({ 
      success: true, 
      sessionId: result.insertId,
      message: 'Session démarrée' 
    });
  } catch (error) {
    console.error('Erreur démarrage session:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Terminer une session
app.put('/api/sessions/:sessionId/end', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { versesRead, hasanatEarned } = req.body;
    
    const [result] = await pool.execute(
      `UPDATE reading_sessions 
       SET end_time = NOW(), 
           duration_seconds = TIMESTAMPDIFF(SECOND, start_time, NOW()),
           verses_read = ?, 
           hasanat_earned = ? 
       WHERE id = ?`,
      [versesRead || 0, hasanatEarned || 0, sessionId]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Session non trouvée' });
    }
    
    res.json({ success: true, message: 'Session terminée' });
  } catch (error) {
    console.error('Erreur fin session:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// =====================================================
// ROUTES OBJECTIFS
// =====================================================

// Créer un objectif
app.post('/api/goals', isAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { goalType, targetValue, startDate, endDate } = req.body;
  try {
    const [result] = await pool.execute(
      'INSERT INTO reading_goals (user_id, goal_type, target_value, start_date, end_date) VALUES (?, ?, ?, ?, ?)',
      [userId, goalType, targetValue, startDate, endDate]
    );
    res.json({ success: true, goalId: result.insertId, message: 'Objectif créé' });
  } catch (error) {
    console.error('Erreur création objectif:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Obtenir les objectifs
app.get('/api/goals', isAuthenticated, async (req, res) => {
  const userId = req.user.id;
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM reading_goals WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
    res.json({ success: true, goals: rows });
  } catch (error) {
    console.error('Erreur récupération objectifs:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Mettre à jour un objectif
app.put('/api/goals/:goalId', async (req, res) => {
  try {
    const { goalId } = req.params;
    const { currentValue, isCompleted } = req.body;
    
    const [result] = await pool.execute(
      'UPDATE reading_goals SET current_value = ?, is_completed = ? WHERE id = ?',
      [currentValue, isCompleted, goalId]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Objectif non trouvé' });
    }
    
    res.json({ success: true, message: 'Objectif mis à jour' });
  } catch (error) {
    console.error('Erreur mise à jour objectif:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// =====================================================
// ROUTES ANALYTICS (Admin)
// =====================================================

// Stats globales
app.get('/api/admin/stats/global', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM global_stats ORDER BY date DESC LIMIT 30'
    );
    
    res.json({ success: true, stats: rows });
  } catch (error) {
    console.error('Erreur récupération stats globales:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Stats utilisateurs
app.get('/api/admin/stats/users', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM user_stats_summary ORDER BY total_hasanat DESC LIMIT 100'
    );
    
    res.json({ success: true, users: rows });
  } catch (error) {
    console.error('Erreur récupération stats utilisateurs:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Middleware d'authentification simplifié (à adapter selon ton système)
function getUserIdFromRequest(req) {
  // À adapter selon ton auth (ici on prend userId dans le body ou query ou header)
  return req.body.userId || req.query.userId || req.headers['x-user-id'];
}

// Route pour récupérer le quota chatbot
app.get('/api/chatbot/quota', async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ message: 'Non authentifié' });
  const [rows] = await pool.execute('SELECT chatbotMessagesUsed, chatbotMessagesQuota FROM users WHERE id = ?', [userId]);
  if (!rows.length) return res.status(404).json({ message: 'Utilisateur non trouvé' });
  const used = rows[0].chatbotMessagesUsed ?? 0;
  const quota = rows[0].chatbotMessagesQuota ?? 1000;
  const remaining = quota - used;
  res.json({ remaining, quota });
});

// Route d'envoi de message au chatbot avec gestion du quota
app.post('/api/chat', async (req, res) => {
  const userId = getUserIdFromRequest(req);
  const { message } = req.body;
  if (!userId) return res.status(401).json({ message: 'Non authentifié' });
  if (!message) return res.status(400).json({ message: 'Message requis' });
  // Récupérer le quota
  const [rows] = await pool.execute('SELECT chatbotMessagesUsed, chatbotMessagesQuota FROM users WHERE id = ?', [userId]);
  if (!rows.length) return res.status(404).json({ message: 'Utilisateur non trouvé' });
  const used = rows[0].chatbotMessagesUsed ?? 0;
  const quota = rows[0].chatbotMessagesQuota ?? 1000;
  const remaining = quota - used;
  if (remaining <= 0) {
    return res.status(402).json({ message: 'Quota de messages gratuits dépassé. Veuillez acheter plus de messages.' });
  }
  // Incrémenter le compteur
  await pool.execute('UPDATE users SET chatbotMessagesUsed = chatbotMessagesUsed + 1 WHERE id = ?', [userId]);
  // Simuler la réponse du bot (à remplacer par OpenAI)
  res.json({ message: `Bot: tu as dit « ${message} » (il te reste ${remaining - 1} messages)` });
});

// =====================================================
// GESTION D'ERREURS
// =====================================================

// 404
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route non trouvée' });
});

// Gestionnaire d'erreurs global
app.use((error, req, res, next) => {
  console.error('Erreur non gérée:', error);
  res.status(500).json({ 
    error: 'Erreur interne du serveur',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Une erreur est survenue'
  });
});

// =====================================================
// DÉMARRAGE DU SERVEUR
// =====================================================

async function startServer() {
  await initializeDatabase();
  
  app.listen(PORT, () => {
    console.log(`🚀 Serveur API Quran démarré sur le port ${PORT}`);
    console.log(`📊 Base de données: ${process.env.DB_HOST}`);
    console.log(`🌍 Environnement: ${process.env.NODE_ENV || 'development'}`);
  });
}

// Gestion propre de l'arrêt
process.on('SIGINT', async () => {
  console.log('\n🛑 Arrêt du serveur...');
  if (pool) {
    await pool.end();
    console.log('✅ Connexions base de données fermées');
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Arrêt du serveur...');
  if (pool) {
    await pool.end();
    console.log('✅ Connexions base de données fermées');
  }
  process.exit(0);
});

startServer().catch(error => {
  console.error('❌ Erreur au démarrage:', error);
  process.exit(1);
});

app.get('/api/test-db', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT 1');
    res.json({ success: true, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}); 