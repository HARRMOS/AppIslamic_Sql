import express from 'express';
import dotenv from 'dotenv';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import bodyParser from 'body-parser';
import { 
  syncUserToMySQL,
  findOrCreateUser,
  findUserById,
  checkGlobalChatbotQuota,
  incrementChatbotMessagesUsed,
  getUserStats,
  mysqlPool, // <-- Ajouté ici
  updateConversationTitleMySQL,
  deleteConversationMySQL,
  getConversationsForUserBot, // Ajouté
  getBotById,
  getMessagesForUserBot, // Ajouté
  getUserBotPreferences, // Ajouté
  saveQuizResult,
  getQuizResultsForUser,
  setMaintenance,
  getMaintenance
} from './database.js';
import cors from 'cors';
import openai from './openai.js';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import fs from 'fs';
import { OAuth2Client } from 'google-auth-library';
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);


dotenv.config();

const app = express();

// Augmente la limite de taille du body parser à 2mb
app.use(bodyParser.json({ limit: '2mb' }));
app.use(bodyParser.urlencoded({ limit: '2mb', extended: true }));

// Désactive l'ETag globalement pour éviter les 304 (important pour Safari/cookies)
app.disable('etag');

app.set('trust proxy', 1);

// Middleware pour vérifier le JWT dans l'en-tête Authorization
function authenticateJWT(req, res, next) {
  if (req.method === 'OPTIONS') {
    return next();
  }
  const authHeader = req.headers['authorization'];
  console.log('--- [AUTH] ---');
  console.log('Authorization header reçu:', authHeader);
  if (!authHeader) {
    console.log('Aucun header Authorization reçu');
    return res.status(401).json({ message: 'Token manquant' });
  }
  const token = authHeader.split(' ')[1];
  console.log('Token extrait:', token);
  if (!token) {
    console.log('Header Authorization mal formé');
    return res.status(401).json({ message: 'Token manquant' });
  }
  const JWT_SECRET = process.env.JWT_SECRET || 'une_clé_ultra_secrète';
  jwt.verify(token, JWT_SECRET, async (err, decoded) => {
    if (err) {
      console.log('Erreur de vérification JWT:', err.message);
      return res.status(401).json({ message: 'Token invalide ou expiré', error: err.message });
    }
    console.log('Payload décodé:', decoded);
    // On peut aller chercher l'utilisateur en base si besoin
    const user = await findUserById(decoded.id);
    if (!user) {
      console.log('Utilisateur non trouvé pour l’ID:', decoded.id);
      return res.status(404).json({ message: 'Utilisateur non trouvé' });
    }
    console.log('Utilisateur trouvé:', user.id, user.email);
    req.user = user;
    next();
  });
}

// Middleware pour vérifier l'admin
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ message: 'Accès réservé à l’admin' });
  }
  next();
}

const allowedOrigins = [
  'https://www.quran-pro.harrmos.com',
  'https://www.ummati.pro',
  'https://quran-pro.harrmos.com',
  'https://ummati.pro',
  'https://appislamic.onrender.com',
  
  // Ajoute ici d'autres domaines si besoin (Vercel, Netlify, etc.)
];

const corsOptions = {
  origin: function (origin, callback) {
    console.log('CORS origin:', origin);
    // Autorise les requêtes sans origin (ex: mobile, redirection OAuth)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
};
app.use(cors(corsOptions));

// Ajouter le middleware pour parser le JSON
app.use(express.json());

// Debug de l'environnement
console.log('=== ENVIRONMENT DEBUG ===');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('RENDER:', process.env.RENDER);
console.log('PORT:', process.env.PORT);
console.log('========================');


// Configurer le middleware de session


// Ajout de logs pour la configuration de session


// Configure Google OAuth strategy

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const JWT_SECRET = process.env.JWT_SECRET || 'une_clé_ultra_secrète';

passport.use(new GoogleStrategy({
  clientID: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  callbackURL: 'https://appislamic-sql.onrender.com/auth/google/callback',
}, async (accessToken, refreshToken, profile, done) => {
  try {
    // On crée ou récupère l'utilisateur dans la base
    const user = await findOrCreateUser(profile.id, profile.displayName, profile.emails[0].value);
    return done(null, user);
  } catch (err) {
    return done(err, null);
  }
}));

app.use(passport.initialize());

// Initialiser Passport et la gestion de session


// Sérialisation et désérialisation de l'utilisateur (déplacées depuis database.js)


// Initialiser la base de données au démarrage du serveur

// Fonction utilitaire pour ajouter un message dans MySQL
async function addMessageMySQL(userId, botId, conversationId, sender, text, context = null) {
  await mysqlPool.query(
    'INSERT INTO messages (userId, botId, conversationId, sender, text, context) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, botId, conversationId, sender, text, context]
  );
}

// Désactive le cache pour la route /auth/status (important pour Safari/cookies)
app.use('/auth/status', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  next();
});
// Route pour vérifier l'état de l'authentification (pour le frontend)
app.get('/auth/status', authenticateJWT, async (req, res) => {
  const responseUser = {
    id: req.user.id,
    name: req.user.name || req.user.username,
    email: req.user.email,
    username: req.user.username, // Ajouté
    profile_picture: req.user.profile_picture, // Ajouté
    mysql_id: req.user.mysql_id
  };
  res.status(200).json({ user: responseUser });
});

// Route pour initier l'authentification Google
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);
// Route de callback après l'authentification Google
app.get('/auth/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/login' }),
  (req, res) => {
    // Générer un JWT pour l'utilisateur connecté
    const token = jwt.sign(
      { id: req.user.id, email: req.user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    // Rediriger vers le frontend avec le token en query (à adapter selon ton frontend)
    res.redirect(`https://www.ummati.pro/auth/callback?token=${token}`);
  }
);

// Route de déconnexion
app.get('/logout', (req, res) => {
  res.status(200).json({ message: 'Déconnexion réussie (stateless JWT)' });
});

// ===================== ROUTES UTILISATEURS =====================
app.post('/api/users', async (req, res) => {
  try {
    const { email, username, preferences } = req.body;
    const [existingUsers] = await mysqlPool.execute(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );
    if (existingUsers.length > 0) {
      const existingUser = existingUsers[0];
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
    const userId = require('crypto').randomUUID();
    const [result] = await mysqlPool.execute(
      'INSERT INTO users (id, email, username, preferences) VALUES (?, ?, ?, ?)',
      [userId, email, username, JSON.stringify(preferences || {})]
    );
    res.status(201).json({
      success: true,
      user: { id: userId, email, username, preferences, existing: false }
    });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la création de l\'utilisateur', details: error.message });
  }
});
app.get('/api/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const [rows] = await mysqlPool.execute(
      'SELECT id, email, username, preferences, created_at, last_login FROM users WHERE id = ?',
      [userId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }
    res.json({ success: true, user: rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
app.put('/api/users/:userId/preferences', authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const { preferences } = req.body;
    console.log('userId:', userId, typeof userId, 'params:', req.params.userId, typeof req.params.userId);
    if (!preferences) {
      return res.status(400).json({ success: false, message: 'Préférences manquantes' });
    }
    // Vérifier que l'utilisateur modifie bien ses propres préférences (comparaison en string)
    if (String(userId) !== String(req.params.userId)) {
      return res.status(403).json({ success: false, message: 'Accès interdit' });
    }
    console.log('UPDATE preferences for user', userId, preferences);
    await mysqlPool.execute(
      'UPDATE users SET preferences = ? WHERE id = ?',
      [JSON.stringify(preferences), userId]
    );
    res.json({ success: true, message: 'Préférences mises à jour.' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur lors de la mise à jour des préférences.' });
  }
});
// ===================== ROUTES STATISTIQUES =====================
app.post('/api/stats', authenticateJWT, async (req, res) => {
  console.log('POST /api/stats', req.body);
  try {
    const { userId, hasanat = 0, verses = 0, time = 0, pages = 0 } = req.body;
    if (hasanat === 0 && verses === 0 && time === 0 && pages === 0) {
      return res.json({ success: true, message: 'Aucune stat à incrémenter' });
    }
    
    // Utiliser la date locale au lieu de CURDATE() (UTC)
    const today = new Date();
    today.setHours(0,0,0,0); // Forcer à minuit
    const dateStr = today.toISOString().slice(0, 10); // 'YYYY-MM-DD'
    
    await mysqlPool.execute(
      'INSERT IGNORE INTO quran_stats (user_id, date) VALUES (?, ?)',
      [userId, dateStr]
    );
    await mysqlPool.execute(
      'CALL IncrementDailyStats(?, ?, ?, ?)',
      [userId, hasanat, verses, time]
    );
    if (pages > 0) {
      await mysqlPool.execute(
        'UPDATE quran_stats SET pages_read = pages_read + ? WHERE user_id = ? AND date = ?',
        [pages, userId, dateStr]
      );
    }
    res.json({ success: true, message: 'Stats mises à jour' });
  } catch (error) {
    console.error('Erreur SQL stats:', error); // Log détaillé
    res.status(500).json({ error: 'Erreur lors de la mise à jour des stats', details: error.message });
  }
});
// ===================== ROUTES PROGRESSION =====================
app.post('/api/progress', authenticateJWT, async (req, res) => {
  try {
    const { userId, surah, ayah } = req.body;
    const [result] = await mysqlPool.execute(
      'INSERT INTO reading_progress (user_id, surah, ayah) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE surah = VALUES(surah), ayah = VALUES(ayah)',
      [userId, surah, ayah]
    );
    res.json({ success: true, message: 'Progression sauvegardée' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la sauvegarde' });
  }
});
app.get('/api/progress/:userId', authenticateJWT, async (req, res) => {
  if (req.user.id !== req.params.userId) {
    return res.status(403).json({ message: 'Accès interdit' });
  }
  try {
    const { userId } = req.params;
    const [rows] = await mysqlPool.execute(
      'SELECT surah, ayah, updated_at FROM reading_progress WHERE user_id = ?',
      [userId]
    );
    res.json({ success: true, progress: rows[0] || { surah: 1, ayah: 1, updated_at: null } });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
// ===================== ROUTES HISTORIQUE =====================
app.post('/api/history', authenticateJWT, async (req, res) => {
  try {
    const { userId, surah, ayah, actionType, duration = 0 } = req.body;
    const [result] = await mysqlPool.execute(
      'INSERT INTO reading_history (user_id, surah, ayah, action_type, duration_seconds) VALUES (?, ?, ?, ?, ?)',
      [userId, surah, ayah, actionType, duration]
    );
    res.json({ success: true, message: 'Historique ajouté' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
app.get('/api/history/:userId/:limit', authenticateJWT, async (req, res) => {
  if (req.user.id !== req.params.userId) {
    return res.status(403).json({ message: 'Accès interdit' });
  }
  try {
    const { userId, limit } = req.params;
    const limitNum = Math.min(parseInt(limit) || 50, 100);
    const [rows] = await mysqlPool.execute(
      `SELECT surah, ayah, action_type, duration_seconds, created_at 
       FROM reading_history 
       WHERE user_id = ? 
       ORDER BY created_at DESC 
       LIMIT ?`,
      [userId, limitNum]
    );
    res.json({ success: true, history: rows });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
// ===================== ROUTES FAVORIS =====================
app.post('/api/favorites', authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const { type, referenceId, referenceText, notes } = req.body;
    const [result] = await mysqlPool.execute(
      'INSERT INTO favorites (user_id, type, reference_id, reference_text, notes) VALUES (?, ?, ?, ?, ?)',
      [userId, type, referenceId, referenceText, notes]
    );
    res.json({ success: true, message: 'Favori ajouté' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
app.get('/api/favorites/:userId', authenticateJWT, async (req, res) => {
  if (req.user.id !== req.params.userId) {
    return res.status(403).json({ message: 'Accès interdit' });
  }
  try {
    const { userId } = req.params;
    const [rows] = await mysqlPool.execute(
      'SELECT * FROM favorites WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
    res.json({ success: true, favorites: rows });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
app.delete('/api/favorites/:favoriteId', authenticateJWT, async (req, res) => {
  try {
    const { favoriteId } = req.params;
    const [result] = await mysqlPool.execute(
      'DELETE FROM favorites WHERE id = ?',
      [favoriteId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Favori non trouvé' });
    }
    res.json({ success: true, message: 'Favori supprimé' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
// ===================== ROUTES SESSIONS =====================
app.post('/api/sessions/start', authenticateJWT, async (req, res) => {
  try {
    const { userId, deviceInfo } = req.body;
    const [result] = await mysqlPool.execute(
      'INSERT INTO reading_sessions (user_id, device_info) VALUES (?, ?)',
      [userId, JSON.stringify(deviceInfo || {})]
    );
    res.json({ success: true, sessionId: result.insertId, message: 'Session démarrée' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
app.put('/api/sessions/:sessionId/end', authenticateJWT, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { versesRead, hasanatEarned } = req.body;
    const [result] = await mysqlPool.execute(
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
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
// ===================== ROUTES OBJECTIFS =====================
app.post('/api/goals', authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const { goalType, targetValue, startDate, endDate } = req.body;
    const [result] = await mysqlPool.execute(
      'INSERT INTO reading_goals (user_id, goal_type, target_value, start_date, end_date) VALUES (?, ?, ?, ?, ?)',
      [userId, goalType, targetValue, startDate, endDate]
    );
    res.json({ success: true, goalId: result.insertId, message: 'Objectif créé' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
app.get('/api/goals/:userId', authenticateJWT, async (req, res) => {
  if (req.user.id !== req.params.userId) {
    return res.status(403).json({ message: 'Accès interdit' });
  }
  try {
    const { userId } = req.params;
    const [rows] = await mysqlPool.execute(
      'SELECT * FROM reading_goals WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
    res.json({ success: true, goals: rows });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
app.put('/api/goals/:goalId', authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const { goalId } = req.params;
    const { currentValue, isCompleted } = req.body;
    // Vérifier que l'objectif appartient à l'utilisateur
    const [rows] = await mysqlPool.execute('SELECT * FROM reading_goals WHERE id = ? AND user_id = ?', [goalId, userId]);
    if (!rows.length) {
      return res.status(404).json({ error: 'Objectif non trouvé' });
    }
    const [result] = await mysqlPool.execute(
      'UPDATE reading_goals SET current_value = ?, is_completed = ? WHERE id = ?',
      [currentValue, isCompleted, goalId]
    );
    res.json({ success: true, message: 'Objectif mis à jour' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Correction de la route GET /api/bots si getBots est async
app.get('/api/bots', async (req, res) => {
  try {
    const bots = await getBots();
    res.status(200).json(bots);
  } catch (error) {
    console.error('Erreur lors de la récupération des bots:', error);
    res.status(500).json({ message: 'Erreur lors de la récupération des bots' });
  }
});

// Incrémenter les stats quotidiennes
// app.post('/api/stats', async (req, res) => {
//   try {
//     const { userId, hasanat = 0, verses = 0, time = 0, pages = 0 } = req.body;
//     // Si aucune stat à incrémenter, ignorer la requête
//     if (hasanat === 0 && verses === 0 && time === 0 && pages === 0) {
//       return res.json({ success: true, message: 'Aucune stat à incrémenter' });
//     }
//     // S'assurer qu'une ligne existe pour l'utilisateur et la date du jour
//     await pool.execute(
//       'INSERT IGNORE INTO quran_stats (user_id, date) VALUES (?, CURDATE())',
//       [userId]
//     );
//     // Utiliser la procédure stockée
//     await pool.execute(
//       'CALL IncrementDailyStats(?, ?, ?, ?)',
//       [userId, hasanat, verses, time]
//     );
//     // Mettre à jour les pages si fournies
//     if (pages > 0) {
//       await pool.execute(
//         'UPDATE quran_stats SET pages_read = pages_read + ? WHERE user_id = ? AND date = CURDATE()',
//         [pages, userId]
//       );
//     }
//     res.json({ success: true, message: 'Stats mises à jour' });
//   } catch (error) {
//     console.error('Erreur mise à jour stats:', error);
//     res.status(500).json({ error: 'Erreur lors de la mise à jour des stats' });
//   }
// });



// ===================== ROUTES EVENEMENTS CALENDRIER =====================
// Liste tous les événements (publique)
app.get('/api/events', async (req, res) => {
  try {
    const [rows] = await mysqlPool.execute('SELECT * FROM islamic_events ORDER BY date ASC');
    res.json({ events: rows });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la récupération des événements', details: error.message });
  }
});
// Ajout d'un événement (admin)
app.post('/api/events', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { date, name, icon, description } = req.body;
    if (!date || !name) {
      return res.status(400).json({ error: 'Date et nom obligatoires' });
    }
    await mysqlPool.execute(
      'INSERT INTO islamic_events (date, name, icon, description) VALUES (?, ?, ?, ?)',
      [date, name, icon || '', description || '']
    );
    res.status(201).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de l\'ajout de l\'événement', details: error.message });
  }
});
// Suppression d'un événement (admin)
app.delete('/api/events/:id', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await mysqlPool.execute('DELETE FROM islamic_events WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la suppression de l\'événement', details: error.message });
  }
}); 



// ===================== CRUD DUA =====================

// Récupérer toutes les duas
app.get('/api/duas', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const [rows] = await mysqlPool.execute('SELECT * FROM duas ORDER BY created_at DESC');
    res.json({ duas: rows });
  } catch (error) {
    res.status(500).json({ message: 'Erreur lors de la récupération des duas.' });
  }
});

// Ajouter une dua
app.post('/api/duas', authenticateJWT, requireAdmin, async (req, res) => {
  const { title, arabic, translit, translation, category, audio } = req.body;
  if (!title || !arabic || !translation) {
    return res.status(400).json({ message: 'Champs obligatoires manquants.' });
  }
  try {
    const [result] = await mysqlPool.execute(
      'INSERT INTO duas (title, arabic, translit, translation, category, audio) VALUES (?, ?, ?, ?, ?, ?)',
      [title, arabic, translit || '', translation, category || 'other', audio || '']
    );
    res.status(201).json({ success: true, id: result.insertId });
  } catch (error) {
    res.status(500).json({ message: 'Erreur lors de l’ajout de la dua.' });
  }
});

// Supprimer une dua
app.delete('/api/duas/:id', authenticateJWT, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await mysqlPool.execute('DELETE FROM duas WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: 'Erreur lors de la suppression.' });
  }
});
// Route pour activer/désactiver la maintenance (admin uniquement)
app.post('/api/maintenance', authenticateJWT, requireAdmin, async (req, res) => {
  const { enabled, id, pwd } = req.body;
  try {
    await setMaintenance(enabled, id, pwd);
    res.json({ success: true, maintenance: { enabled, id, pwd } });
  } catch (e) {
    console.error('Erreur SQL maintenance:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Route pour lire l'état maintenance
app.get('/api/maintenance-status', async (req, res) => {
  try {
    const data = await getMaintenance();
    res.json(data);
  } catch (e) {
    res.json({ enabled: false, id: '', pwd: '' });
  }
}); 

// ===================== ROUTES QUIZZES =====================
// Liste tous les quiz
app.get('/api/quizzes', authenticateJWT, async (req, res) => {
  try {
    const [rows] = await mysqlPool.execute('SELECT * FROM quizzes ORDER BY created_at DESC');
    res.json({ success: true, quizzes: rows });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la récupération des quiz', details: error.message });
  }
});
// Détail d'un quiz
app.get('/api/quizzes/:id', authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await mysqlPool.execute('SELECT * FROM quizzes WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Quiz non trouvé' });
    res.json({ success: true, quiz: rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la récupération du quiz', details: error.message });
  }
});
// Création d'un quiz (admin)
app.post('/api/quizzes', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { theme, difficulty, title, description, questions } = req.body;
    if (!theme || !difficulty || !title || !questions) {
      return res.status(400).json({ error: 'Paramètres manquants' });
    }
    const [result] = await mysqlPool.execute(
      'INSERT INTO quizzes (theme, difficulty, title, description, questions) VALUES (?, ?, ?, ?, ?)',
      [theme, difficulty, title, description || '', JSON.stringify(questions)]
    );
    res.status(201).json({ success: true, quizId: result.insertId });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la création du quiz', details: error.message });
  }
});
// Edition d'un quiz (admin)
app.put('/api/quizzes/:id', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { theme, difficulty, title, description, questions } = req.body;
    const [result] = await mysqlPool.execute(
      'UPDATE quizzes SET theme=?, difficulty=?, title=?, description=?, questions=?, updated_at=NOW() WHERE id=?',
      [theme, difficulty, title, description || '', JSON.stringify(questions), id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Quiz non trouvé' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la modification du quiz', details: error.message });
  }
});
// Suppression d'un quiz (admin)
app.delete('/api/quizzes/:id', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await mysqlPool.execute('DELETE FROM quizzes WHERE id = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Quiz non trouvé' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la suppression du quiz', details: error.message });
  }
}); 

// ===================== ROUTES QUIZ =====================
app.get('/api/quiz/history', authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const results = await getQuizResultsForUser(userId);
    res.json({ success: true, history: results });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la récupération de l’historique', details: error.message });
  }
});
app.post('/api/quiz/result', authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const { theme, level, score, total, details, quiz_id } = req.body;
    if (!theme || !level || score === undefined || total === undefined || !quiz_id) {
      return res.status(400).json({ error: 'Paramètres manquants' });
    }
    await saveQuizResult(userId, theme, level, score, total, details, quiz_id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de l’enregistrement du résultat', details: error.message });
  }
});
//Route pour les stats du jour
 app.get('/api/stats/:userId/today', async (req, res) => {
   try {
     const { userId } = req.params;
     const [rows] = await mysqlPool.execute(
       'SELECT * FROM quran_stats WHERE user_id = ? AND date = CURDATE()',
       [userId]
     );
     res.json({ success: true, stats: rows });
   } catch (error) {
     console.error('Erreur récupération stats today:', error);
     res.status(500).json({ error: 'Erreur serveur' });
   }
});
// Route pour créer un nouveau bot (admin uniquement)
app.post('/api/bots', authenticateJWT, requireAdmin, async (req, res) => {
  const { name, description, price, category, image, prompt } = req.body;
  
  try {
    const botId = await addBot(name, description, price, category, image, prompt);
    res.status(201).json({ message: 'Bot créé avec succès', botId });
  } catch (error) {
    console.error('Erreur lors de la création du bot:', error);
    res.status(500).json({ message: 'Erreur lors de la création du bot' });
  }
});

// Correction de la route PUT /api/bots/:id pour requireAdmin
app.put('/api/bots/:id', authenticateJWT, requireAdmin, async (req, res) => {
  const botId = Number(req.params.id);
  const { name, description, price, category, image, prompt } = req.body;
  try {
    await updateBot(botId, name, description, price, category, image, prompt);
    res.status(200).json({ message: 'Bot mis à jour avec succès' });
  } catch (error) {
    console.error('Erreur lors de la mise à jour du bot:', error);
    res.status(500).json({ message: 'Erreur lors de la mise à jour du bot' });
  }
});

// Correction de la route DELETE /api/bots/:id pour requireAdmin
app.delete('/api/bots/:id', authenticateJWT, requireAdmin, async (req, res) => {
  const botId = req.params.id;
  
  try {
    await deleteBot(botId);
    res.status(200).json({ message: 'Bot supprimé avec succès' });
  } catch (error) {
    console.error('Erreur lors de la suppression du bot:', error);
    res.status(500).json({ message: 'Erreur lors de la suppression du bot' });
  }
});

// Nouvelle route pour activer un bot pour un utilisateur


// Nouvelle route pour récupérer les messages pour un utilisateur et un bot spécifiques
app.get('/api/messages', authenticateJWT, async (req, res) => {
  console.log('=== Début de la requête /api/messages ===');
  console.log('Headers:', req.headers);
  console.log('Cookies:', req.cookies);
  console.log('Session (avant Passport): ', req.session);
  // Utilisateur authentifié via JWT
  const userId = req.user.id;
  const botId = Number(req.query.botId);
  const conversationId = Number(req.query.conversationId) || 0;

  if (!userId || isNaN(botId)) {
    console.error('/api/messages - Missing userId or invalid botId', { userId, botId });
    return res.status(400).json({ message: 'userId et botId sont requis' });
  }

  try {
    const messages = await getMessagesForUserBot(userId, botId, conversationId);
    console.log('/api/messages - Messages récupérés:', messages.length);
    res.status(200).json(messages);
  } catch (error) {
    console.error('Erreur lors de la récupération des messages:', error);
    res.status(500).json({ message: 'Erreur lors de la récupération des messages' });
  }
  console.log('=== Fin de la requête /api/messages ===');
});

// Route pour interagir avec l'API OpenAI (renommée en /api/chat)
app.post('/api/chat', authenticateJWT, async (req, res) => {
  console.log('=== Début de la requête /api/chat ===');
  console.log('Headers:', req.headers);
  console.log('Cookies:', req.cookies);
  console.log('Session (avant Passport): ', req.session);
  // On n'utilise plus Passport ici
  // console.log('isAuthenticated (après Passport): ', req.isAuthenticated());
  // console.log('User (après Passport): ', req.user);

  // Utilisateur authentifié via JWT
  const userId = req.user.id;
  console.log('/api/chat - Utilisateur authentifié, ID:', userId);

  // Vérification du quota global de messages chatbot
  const quota = await checkGlobalChatbotQuota(userId, req.user.email);
  if (!quota.canSend) {
    return res.status(402).json({ message: `Quota de messages gratuits dépassé. Veuillez acheter plus de messages pour continuer à utiliser le chatbot.` });
  }

  const { message, botId, conversationId, title } = req.body;
  const usedBotId = botId ? Number(botId) : 1;

  if (!message || usedBotId === undefined) {
    return res.status(400).json({ message: 'Message et botId sont requis' });
  }

  let currentConversationId = Number(conversationId);
  let conversationTitle = title;

  if (currentConversationId <= 0) {
    try {
      const newConvTitle = conversationTitle || 'Nouvelle conversation';
      // Création de la conversation dans MySQL
      const [result] = await mysqlPool.execute(
        'INSERT INTO conversations (userId, botId, title) VALUES (?, ?, ?)',
        [userId, usedBotId, newConvTitle]
      );
      currentConversationId = result.insertId;
      console.log('Nouvelle conversation créée avec ID (MySQL):', currentConversationId);
    } catch (convError) {
      console.error('Erreur lors de la création de la conversation (MySQL):', convError);
      return res.status(500).json({ message: 'Erreur lors de la création de la conversation.' });
    }
  } else if (title && currentConversationId > 0) {
    try {
      await updateConversationTitle(userId, usedBotId, Number(conversationId), title);
      console.log(`Titre de la conversation ${currentConversationId} mis à jour.`);
    } catch (titleUpdateError) {
      console.error(`Erreur lors de la mise à jour du titre de la conversation ${currentConversationId}:`, titleUpdateError);
    }
  }

  try {
    // const bot = getBotById(usedBotId);
    // const prompt = bot.prompt || 'You are a helpful assistant.';
    const prompt = `Tu es un assistant islamique bienveillant. Tu expliques l'islam avec douceur, sagesse et respect. Tu cites toujours tes sources : versets du Coran (avec numéro de sourate et verset), hadiths authentiques (avec référence), ou avis de savants connus. Si tu ne connais pas la réponse, dis-le avec bienveillance. Tu t'exprimes comme un ami proche, rassurant et sincère. Et tu ne réponds à aucune question qui n'est pas islamique.`;

    // Récupérer les 10 derniers messages pour le contexte de cette conversation
    const conversationHistory = await getMessagesForUserBot(userId, usedBotId, currentConversationId, 10);

    const messagesForGpt = [
      { role: "system", content: prompt }
    ];

    // Ajouter l'historique de la conversation au format attendu par l'API OpenAI
    conversationHistory.forEach(msg => {
      messagesForGpt.push({
        role: msg.sender === 'user' ? 'user' : 'assistant',
        content: msg.text
      });
    });

    // Ajouter le message actuel de l'utilisateur
    messagesForGpt.push({ role: "user", content: message });

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo", // Utilisation d'un modèle plus récent
      messages: messagesForGpt,
      temperature: 0.7,
      max_tokens: 500
    });

    const reply = completion.choices[0].message.content;

    await addMessageMySQL(userId, usedBotId, currentConversationId, 'user', message);
    await addMessageMySQL(userId, usedBotId, currentConversationId, 'bot', reply);

    // Incrémenter le compteur de messages chatbot
    incrementChatbotMessagesUsed(userId);

    res.status(200).json({ message: reply });

  } catch (error) {
    console.error('Erreur lors de l\'interaction avec OpenAI:', error);
    // Gérer spécifiquement les erreurs de limite de message si nécessaire
    if (error.message && error.message.includes('Message limit reached')) {
       res.status(403).json({ message: error.message });
    } else {
       res.status(500).json({ message: 'Une erreur est survenue lors de l\'interaction avec le bot' });
    }
  }
});

// Route pour récupérer le quota de messages chatbot restant
app.get('/api/chatbot/quota', authenticateJWT, async (req, res) => {
  // Utilisateur authentifié via JWT
  const userId = req.user.id;
  // Aller chercher l'utilisateur dans MySQL
  const [rows] = await mysqlPool.query('SELECT chatbotMessagesUsed, chatbotMessagesQuota FROM users WHERE id = ?', [userId]);
  if (!rows[0]) return res.status(404).json({ message: 'Utilisateur non trouvé' });
  const used = rows[0].chatbotMessagesUsed ?? 0;
  const quota = rows[0].chatbotMessagesQuota ?? 1000;
  res.json({
    remaining: Math.max(0, quota - used),
    total: quota,
    used
  });
});

// Middleware de gestion des erreurs global
app.use((err, req, res, next) => {
  console.error('Erreur serveur:', err);
  
  // Déterminer le type d'erreur et envoyer une réponse appropriée
  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({ message: 'Non authentifié' });
  }
  
  if (err.name === 'ValidationError') {
    return res.status(400).json({ message: err.message });
  }
  
  // Erreur par défaut
  res.status(500).json({ 
    message: 'Une erreur interne est survenue',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Nouvelle route pour générer des clés d'activation (pour l'administrateur)
app.post('/api/generate-keys', authenticateJWT, async (req, res) => {
  if (req.user.email !== 'mohammadharris200528@gmail.com') { // Vérifier si l'utilisateur est admin
    return res.status(403).json({ message: 'Accès refusé. Réservé à l\'administrateur.' });
  }

  const { botId, numberOfKeys } = req.body;

  if (!botId || !numberOfKeys || numberOfKeys <= 0) {
    return res.status(400).json({ message: 'botId et numberOfKeys (nombre > 0) sont requis' });
  }

  try {
    const generatedKeys = [];
    for (let i = 0; i < numberOfKeys; i++) {
        // Générer une clé unique (simple UUID pour l'exemple)
        const key = `${botId}-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`; // Génération simple, à améliorer pour la production si nécessaire
        addActivationKey(key, botId);
        generatedKeys.push(key);
    }
    res.status(201).json({ message: 'Clés générées avec succès', keys: generatedKeys });
  } catch (error) {
    console.error('Erreur détaillée lors de la génération des clés:', error); // Log détaillé de l'erreur
    res.status(500).json({ message: 'Erreur lors de la génération des clés', error: error.message }); // Inclure le message d'erreur dans la réponse
  }
});

// Harmonisation des préférences utilisateur :
// Supprimer PUT /api/users/:userId/preferences (doublon)
// Nouvelle route pour sauvegarder les préférences utilisateur par bot
app.post('/api/bot-preferences', authenticateJWT, async (req, res) => {
  const userId = req.user.id;
  const botId = Number(req.query.botId) || 1; // On force le bot islamique
  const { preferences } = req.body;

  if (!preferences) {
    return res.status(400).json({ message: 'Préférences sont requises.' });
  }

  try {
    await saveUserBotPreferences(userId, botId, preferences);
    res.status(200).json({ message: 'Préférences sauvegardées avec succès.' });
  } catch (error) {
    console.error('Erreur lors de la sauvegarde des préférences:', error);
    res.status(500).json({ message: 'Erreur lors de la sauvegarde des préférences.' });
  }
});

// Modifier la route pour récupérer les conversations afin d'inclure les préférences
app.get('/api/conversations/:botId', authenticateJWT, async (req, res) => {
  const userId = req.user.id;
  const botId = Number(req.params.botId) || 1; // On force le bot islamique

  try {
    const conversations = await getConversationsForUserBot(userId, botId);
    const preferences = await getUserBotPreferences(userId, botId);
    
    res.status(200).json({ conversations, preferences });
  } catch (error) {
    console.error('Erreur lors de la récupération des conversations et préférences:', error);
    res.status(500).json({ message: 'Erreur lors de la récupération des conversations et préférences.' });
  }
});

// Route pour supprimer une conversation
app.delete('/api/conversations/:botId/:conversationId', authenticateJWT, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;
    const botId = Number(req.params.botId) || 1; // On force le bot islamique

    const success = await deleteConversationMySQL(userId, botId, conversationId);
    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, message: 'Conversation non trouvée ou non supprimée.' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Erreur lors de la suppression de la conversation.' });
  }
});

// Route pour mettre à jour le titre d'une conversation
app.put('/api/conversations/:botId/:conversationId/title', authenticateJWT, async (req, res) => {
  try {
    const { botId, conversationId } = req.params;
    const userId = req.user.id;
    const { title } = req.body;

    console.log(`Received PUT request to update title for conversation ${conversationId}, bot ${botId}, user ${userId} with new title: ${title}`);

    if (!title) {
      console.log('Title is missing from request body.');
      return res.status(400).json({ error: 'Le titre est requis' });
    }

    // Utiliser la version MySQL
    const success = await updateConversationTitleMySQL(userId, Number(botId), Number(conversationId), title);

    if (success) {
      console.log(`Title updated successfully for conversation ${conversationId}.`);
      res.json({ success: true });
    } else {
      console.warn(`Conversation ${conversationId} not found or title not updated.`);
      res.status(404).json({ error: 'Conversation non trouvée ou aucun message à mettre à jour' });
    }

  } catch (error) {
    console.error('Erreur lors de la mise à jour du titre de la conversation:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour du titre de la conversation' });
  }
});

// Route pour rechercher des messages dans une conversation spécifique
app.get('/api/messages/:botId/:conversationId/search', authenticateJWT, async (req, res) => {
  const userId = req.user.id;
  const botId = Number(req.params.botId) || 1; // On force le bot islamique
  const conversationId = parseInt(req.params.conversationId);
  const query = req.query.query;

  if (!userId || isNaN(botId) || isNaN(conversationId) || !query || typeof query !== 'string') {
    return res.status(400).send('Paramètres manquants ou invalides.');
  }

  try {
    const messages = await searchMessages(userId, botId, conversationId, query);
    res.json(messages);
  } catch (error) {
    console.error('Erreur lors de la recherche de messages:', error);
    res.status(500).send('Erreur interne du serveur.');
  }
});

// Route pour récupérer l'ID MySQL d'un utilisateur connecté (désormais l'id utilisateur)
app.get('/api/user/mysql-id', authenticateJWT, async (req, res) => {
  try {
    // Si req.user est un id (string), on le renvoie directement. Sinon, on va le chercher en base.
    let userId = req.user && typeof req.user === 'object' ? req.user.id : req.user;
    if (!userId) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }
    res.json({ success: true, mysqlUserId: userId });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Route pour récupérer les stats utilisateur depuis MySQL
app.get('/api/user/stats', authenticateJWT, async (req, res) => {
  try {
    const stats = await getUserStats(req.user.id);
    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Route pour récupérer les stats journalières des 30 derniers jours pour l’utilisateur connecté


// Route de test pour forcer la synchronisation d'un utilisateur vers MySQL
app.get('/api/test/sync-user', authenticateJWT, async (req, res) => {
  try {
    console.log('🔄 Test de synchronisation forcée pour:', req.user.name);
    
    // Forcer la synchronisation
    const mysqlUserId = await syncUserToMySQL(req.user.id, req.user.name, req.user.email);
    
    if (mysqlUserId) {
      // Mettre à jour l'utilisateur SQLite avec l'ID MySQL
      updateUserMySQLId(req.user.id, mysqlUserId);
      console.log('✅ Synchronisation forcée réussie:', mysqlUserId);
      
      res.json({ 
        success: true, 
        message: 'Synchronisation réussie',
        mysqlUserId,
        user: req.user
      });
    } else {
      res.status(500).json({ 
        success: false, 
        message: 'Échec de la synchronisation'
      });
    }
  } catch (error) {
    console.error('❌ Erreur synchronisation forcée:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erreur serveur',
      error: error.message
    });
  }
});

// Route pour créer une nouvelle conversation
app.post('/api/conversations', authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const { title } = req.body;
    const usedBotId = 1; // On force le bot islamique
    // Vérifier que le bot existe dans MySQL
    const [bots] = await mysqlPool.execute('SELECT * FROM bots WHERE id = ?', [usedBotId]);
    if (!bots || bots.length === 0) {
      return res.status(404).json({ message: 'Bot inexistant' });
    }
    // Vérifier que l'utilisateur existe dans MySQL
    const [users] = await mysqlPool.execute('SELECT * FROM users WHERE id = ?', [userId]);
    if (!users || users.length === 0) {
      return res.status(404).json({ message: 'Utilisateur inexistant' });
    }
    const convTitle = title || 'Nouvelle conversation';
    // Insérer la conversation dans MySQL
    const [result] = await mysqlPool.execute(
      'INSERT INTO conversations (userId, botId, title) VALUES (?, ?, ?)',
      [userId, usedBotId, convTitle]
    );
    // Récupérer la conversation créée
    const [convs] = await mysqlPool.execute('SELECT * FROM conversations WHERE id = ?', [result.insertId]);
    res.status(201).json(convs[0]);
  } catch (error) {
    console.error('Erreur lors de la création de la conversation (MySQL):', error);
    res.status(500).json({ message: 'Erreur lors de la création de la conversation.' });
  }
});

// Route de test pour générer des stats sur 30 jours
app.post('/api/test/generate-stats', authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    await mysqlPool.execute('DELETE FROM quran_stats WHERE user_id = ?', [userId]);
    // Générer les valeurs à insérer
    const values = [];
    for (let i = 0; i < 30; i++) {
      // Date au format YYYY-MM-DD
      const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      values.push([userId, date, 100 + i * 10, 2 + i, 0, 0]);
    }
    await mysqlPool.query(
      'INSERT INTO quran_stats (user_id, date, hasanat, verses, time_seconds, pages_read) VALUES ?',
      [values]
    );
    res.json({ success: true, message: 'Stats générées pour 30 jours.' });
  } catch (error) {
    res.status(500).json({ message: 'Erreur lors de la génération des stats.' });
  }
});

// Stats du jour
app.get('/api/user/stats/today', authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const [rows] = await mysqlPool.execute(
      `SELECT 
        COALESCE(SUM(hasanat), 0) as hasanat,
        COALESCE(SUM(verses), 0) as verses,
        COALESCE(SUM(time_seconds), 0) as time_seconds,
        COALESCE(SUM(pages_read), 0) as pages_read
      FROM quran_stats
      WHERE user_id = ? AND DATE(date) = CURDATE()`, [userId]
    );
    res.json({ success: true, stats: rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Stats de la semaine
app.get('/api/user/stats/week', authenticateJWT, async (req, res) => {
  console.log('Route /api/user/stats/week - req.user:', req.user);
  try {
    const userId = req.user.id;
    const [rows] = await mysqlPool.execute(
      `SELECT 
        COALESCE(SUM(hasanat), 0) as hasanat,
        COALESCE(SUM(verses), 0) as verses,
        COALESCE(SUM(time_seconds), 0) as time_seconds,
        COALESCE(SUM(pages_read), 0) as pages_read
      FROM quran_stats
      WHERE user_id = ? AND DATE(date) >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)`, [userId]
    );
    res.json({ success: true, stats: rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Stats totales
app.get('/api/user/stats/all', authenticateJWT, async (req, res) => {
  console.log('Route /api/user/stats/all - req.user:', req.user);
  try {
    const userId = req.user.id;
    const [rows] = await mysqlPool.execute(
      `SELECT 
        COALESCE(SUM(hasanat), 0) as hasanat,
        COALESCE(SUM(verses), 0) as verses,
        COALESCE(SUM(time_seconds), 0) as time_seconds,
        COALESCE(SUM(pages_read), 0) as pages_read
      FROM quran_stats
      WHERE user_id = ?`, [userId]
    );
    res.json({ success: true, stats: rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Route pour récupérer les stats journalières des 30 derniers jours pour l'utilisateur connecté
app.get('/api/user/stats/daily', authenticateJWT, async (req, res) => {
  console.log('Route /api/user/stats/daily - req.user:', req.user);
  try {
    const userId = req.user.id;
    const [rows] = await mysqlPool.execute(
      `SELECT 
        DATE(date) as date,
        SUM(hasanat) as hasanat,
        SUM(verses) as verses,
        SUM(time_seconds) as time_seconds,
        SUM(pages_read) as pages_read
      FROM quran_stats
      WHERE user_id = ? AND DATE(date) >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
      GROUP BY DATE(date)
      ORDER BY DATE(date) DESC
      LIMIT 30`,
      [userId]
    );
    res.json({ success: true, stats: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur serveur', error: error.message });
  }
});

// ===================== ROUTES PREFERENCES UTILISATEUR =====================
// Récupérer les préférences de l'utilisateur connecté
app.get('/api/user/preferences', authenticateJWT, async (req, res) => {
  console.log('Route /api/user/preferences - req.user:', req.user);
  try {
    const userId = req.user.id;
    const [rows] = await mysqlPool.execute(
      'SELECT preferences FROM users WHERE id = ?',
      [userId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }
    res.json({ success: true, preferences: JSON.parse(rows[0].preferences || '{}') });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur serveur', error: error.message });
  }
});
// Mettre à jour les préférences de l'utilisateur connecté
app.put('/api/user/preferences', authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const { preferences } = req.body;
    if (!preferences) {
      return res.status(400).json({ success: false, message: 'Préférences manquantes' });
    }
    await mysqlPool.execute(
      'UPDATE users SET preferences = ? WHERE id = ?',
      [JSON.stringify(preferences), userId]
    );
    res.json({ success: true, message: 'Préférences mises à jour' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur serveur', error: error.message });
  }
});

// Route pour récupérer l'historique des messages d'une conversation (MySQL)
app.get('/api/conversations/:conversationId/messages', authenticateJWT, async (req, res) => {
  const { conversationId } = req.params;
  try {
    // Optionnel : vérifier que la conversation appartient à l'utilisateur
    const [convs] = await mysqlPool.execute('SELECT * FROM conversations WHERE id = ? AND userId = ?', [conversationId, req.user.id]);
    if (!convs.length) {
      return res.status(403).json({ message: 'Accès interdit à cette conversation.' });
    }
    const [rows] = await mysqlPool.execute(
      'SELECT * FROM messages WHERE conversationId = ? ORDER BY timestamp ASC',
      [conversationId]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Erreur lors de la récupération des messages' });
  }
});

// Route pour récupérer tous les messages d'un utilisateur, groupés par conversationId
app.get('/api/user/:userId/messages', authenticateJWT, async (req, res) => {
  if (req.user.id !== req.params.userId) {
    return res.status(403).json({ message: 'Accès interdit' });
  }
  try {
    const { userId } = req.params;
    const [rows] = await mysqlPool.execute(
      'SELECT * FROM messages WHERE userId = ? OR (sender = "bot" AND conversationId IN (SELECT id FROM conversations WHERE userId = ?)) ORDER BY conversationId, timestamp ASC',
      [userId, userId]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Erreur lors de la récupération des messages.' });
  }
});

// Route pour récupérer toutes les conversations d'un utilisateur
app.get('/api/user/:userId/conversations', authenticateJWT, async (req, res) => {
  if (req.user.id !== req.params.userId) {
    return res.status(403).json({ message: 'Accès interdit' });
  }
  try {
    const [rows] = await mysqlPool.execute(
      'SELECT * FROM conversations WHERE userId = ? ORDER BY createdAt DESC',
      [req.params.userId]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Erreur lors de la récupération des conversations.' });
  }
});

// ===================== ROUTE MISE À JOUR PROFIL UTILISATEUR =====================
app.put('/api/user/profile', authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const { username, profile_picture } = req.body;
    console.log('--- [UPDATE PROFILE] ---');
    console.log('userId:', userId);
    console.log('username:', username);
    console.log('profile_picture:', profile_picture ? '[image]' : null);
    if (!username && !profile_picture) {
      return res.status(400).json({ success: false, message: 'Aucune donnée à mettre à jour.' });
    }
    const fields = [];
    const values = [];
    if (username) {
      fields.push('username = ?');
      values.push(username);
    }
    if (profile_picture) {
      fields.push('profile_picture = ?');
      values.push(profile_picture);
    }
    if (fields.length === 0) {
      return res.status(400).json({ success: false, message: 'Aucune donnée à mettre à jour.' });
    }
    values.push(userId);
    const [result] = await mysqlPool.execute(
      `UPDATE users SET ${fields.join(', ')} WHERE id = ?`,
      values
    );
    console.log('Résultat SQL:', result);
    res.json({ success: true, message: 'Profil mis à jour.' });
  } catch (error) {
    console.error('Erreur update profile:', error);
    res.status(500).json({ success: false, message: 'Erreur lors de la mise à jour du profil.', error: error.message });
  }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Servir les fichiers statiques du build React

// ================== ADMIN ENDPOINTS ==================
// Liste des utilisateurs
app.get('/admin/users', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const [rows] = await mysqlPool.query('SELECT id, email, username, chatbotMessagesUsed, is_active FROM users');
    res.json({ users: rows });
  } catch (e) {
    res.status(500).json({ error: 'Erreur SQL users' });
  }
});
// Reset quota utilisateur
app.post('/admin/users/:userId/reset-quota', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const DEFAULT_QUOTA = 0; // Remettre à zéro
    await mysqlPool.query('UPDATE users SET chatbotMessagesUsed = ? WHERE id = ?', [DEFAULT_QUOTA, req.params.userId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur SQL reset quota' });
  }
});
// Voir achats d'un utilisateur
app.get('/admin/users/:userId/purchases', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM purchases WHERE user_id = ?', [req.params.userId]);
    res.json({ purchases: rows });
  } catch (e) {
    res.status(500).json({ error: 'Erreur SQL purchases user' });
  }
});
// Liste des achats
app.get('/admin/purchases', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM purchases');
    res.json({ purchases: rows });
  } catch (e) {
    res.status(500).json({ error: 'Erreur SQL purchases' });
  }
});
// Liste des bots
app.get('/admin/bots', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const [rows] = await mysqlPool.query('SELECT id, name, is_active, (SELECT COUNT(*) FROM user_bots WHERE bot_id = bots.id) AS usersCount FROM bots');
    res.json({ bots: rows });
  } catch (e) {
    res.status(500).json({ error: 'Erreur SQL bots' });
  }
});
// Activer/désactiver un bot
app.post('/admin/bots/:botId/toggle', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    await mysqlPool.query('UPDATE bots SET is_active = NOT is_active WHERE id = ?', [req.params.botId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur SQL toggle bot' });
  }
});
// Statistiques globales
app.get('/admin/stats', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const [[{ users }]] = await mysqlPool.query('SELECT COUNT(*) AS users FROM users');
    const [[{ bots }]] = await mysqlPool.query('SELECT COUNT(*) AS bots FROM bots');
    const [[{ purchases }]] = await mysqlPool.query('SELECT COUNT(*) AS purchases FROM purchases');
    const [[{ hasanat }]] = await mysqlPool.query('SELECT SUM(hasanat) AS hasanat FROM quran_stats');
    res.json({ users, bots, purchases, hasanat: hasanat || 0 });
  } catch (e) {
    res.status(500).json({ error: 'Erreur SQL stats' });
  }
}); 

// Fallback SPA : toutes les autres routes renvoient index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur backend démarré sur le port ${PORT}`);
}); 

// Route temporaire pour générer un JWT admin (à supprimer après usage)
app.get('/admin/generate-token', (req, res) => {
  const { secret } = req.query;
  // Change la valeur ci-dessous pour plus de sécurité
  if (secret !== 'GEN_TOKEN_2025') {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  const payload = {
    id: 'admin-id', // Remplace par l'id réel si besoin
    email: 'mohammadharris200528@gmail.com'
  };
  const JWT_SECRET = process.env.JWT_SECRET || 'une_clé_ultra_secrète';
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
}); 

// Route permanente pour login admin sécurisé
app.post('/admin/login', async (req, res) => {
  const { email, password } = req.body;
  if (
    email === 'mohammadharris200528@gmail.com' &&
    password === process.env.ADMIN_PASSWORD
  ) {
    const payload = {
      id: 'admin-id', // Mets l'id réel si tu veux
      email
    };
    const JWT_SECRET = process.env.JWT_SECRET || 'une_clé_ultra_secrète';
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token });
  }
  return res.status(403).json({ error: 'Identifiants invalides' });
}); 

app.post('/auth/mobile', async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ message: 'Token manquant' });
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    // payload.sub = Google user ID
    // payload.email, payload.name, payload.picture
    const user = await findOrCreateUser(payload.sub, payload.name, payload.email, payload.picture);
    // Générer un JWT maison
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user });
  } catch (err) {
    res.status(401).json({ message: 'Token Google invalide', error: err.message });
  }
}); 
