import express from 'express';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import dotenv from 'dotenv';
import session from 'express-session';
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
  getBotById,
  getMessagesForUserBot
} from './database.js';
import cors from 'cors';
import openai from './openai.js';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();

app.set('trust proxy', 1);

// Middleware pour vérifier l'authentification
function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ message: 'Non authentifié' });
}

// Configurer CORS pour autoriser les requêtes depuis le frontend
app.use(cors({
  origin: ['http://localhost:5173', 'http://www.quran-pro.harrmos.com', 'https://www.quran-pro.harrmos.com'],
  credentials: true
}));

// Ajouter le middleware pour parser le JSON
app.use(express.json());

// Debug de l'environnement
console.log('=== ENVIRONMENT DEBUG ===');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('RENDER:', process.env.RENDER);
console.log('PORT:', process.env.PORT);
console.log('========================');

// Configurer le middleware de session
app.use(session({
  secret: process.env.SESSION_SECRET || 'supersecretpar défaut',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    sameSite: 'Lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 heures
  }
}));

// Ajout de logs pour la configuration de session
console.log('Configuration de session:', {
  secret: process.env.SESSION_SECRET || 'supersecretpar défaut',
  secure: true,
  sameSite: 'None',
  maxAge: 24 * 60 * 60 * 1000
});

// Configure Google OAuth strategy
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || "http://localhost:3000/auth/google/callback"
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      const user = await findOrCreateUser(profile.id, profile.displayName, profile.emails[0].value);
      if (!user) {
        // Si la synchro MySQL a échoué, refuser la connexion
        return done(null, false);
      }
      done(null, user);
    } catch (err) {
      console.error('Erreur dans la stratégie Google:', err);
      done(err);
    }
  }
));

// Initialiser Passport et la gestion de session
app.use(passport.initialize());
app.use(passport.session());

// Sérialisation et désérialisation de l'utilisateur (déplacées depuis database.js)
passport.serializeUser((user, done) => {
  console.log('Passport: server.js - serializeUser - User ID:', user.id);
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await findUserById(id);
    if (user) {
      console.log('Passport: server.js - deserializeUser - User found, calling done(null, user)');
      done(null, user);
    } else {
      console.log('Passport: server.js - deserializeUser - User not found for ID', id, ', calling done(null, false)');
      done(null, false);
    }
  } catch (err) {
    console.error('Passport: server.js - deserializeUser - Error during deserialization:', err);
    done(err);
  }
});

// Initialiser la base de données au démarrage du serveur

// Fonction utilitaire pour ajouter un message dans MySQL
async function addMessageMySQL(userId, botId, conversationId, sender, text, context = null) {
  await mysqlPool.query(
    'INSERT INTO messages (userId, botId, conversationId, sender, text, context) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, botId, conversationId, sender, text, context]
  );
}

// Route pour vérifier l'état de l'authentification (pour le frontend)
app.get('/auth/status', async (req, res) => {
  console.log('=== Début de la requête /auth/status ===');
  console.log('Headers:', req.headers);
  console.log('Raw Cookie Header:', req.headers.cookie);
  console.log('Cookies:', req.cookies);
  console.log('Session:', req.session);
  console.log('isAuthenticated:', req.isAuthenticated());
  console.log('User:', req.user);

  if (req.isAuthenticated()) {
    console.log('Utilisateur authentifié, ID:', req.user.id);
    const responseUser = { 
      id: req.user.id, 
      name: req.user.name, 
      email: req.user.email, 
      mysql_id: req.user.mysql_id
    };
    console.log('/auth/status - Envoi de la réponse user (authentifié): ', responseUser);
    res.status(200).json({ user: responseUser });
  } else {
    console.log('Utilisateur non authentifié');
    console.log('/auth/status - Envoi de la réponse user (non authentifié): ', null);
    res.status(200).json({ user: null });
  }
  console.log('=== Fin de la requête /auth/status ===');
});

// Route pour initier l'authentification Google
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);
// Route de callback après l'authentification Google
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => {
    // Répondre en 200 avec un HTML qui redirige côté client (pour que le cookie soit bien set)
    const frontendUrl = 'http://localhost:5173/';
    res.send(`
      <html>
        <head>
          <meta http-equiv="refresh" content="0;url=${frontendUrl}" />
          <script>window.location.href = "${frontendUrl}";</script>
        </head>
        <body>
          Redirection...
        </body>
      </html>
    `);
  }
);

// Route de déconnexion
app.get('/logout', (req, res, next) => {
  console.log('Received logout request');
  req.logout((err) => {
    if (err) {
      console.error('Erreur lors de la déconnexion:', err);
      return next(err);
    }
    // Au lieu de rediriger, envoyer une réponse JSON pour le frontend
    res.status(200).json({ message: 'Déconnexion réussie' });
  });
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
app.put('/api/users/:userId/preferences', isAuthenticated, async (req, res) => {
  try {
    const { userId } = req.params;
    const { preferences } = req.body;
    const [result] = await mysqlPool.execute(
      'UPDATE users SET preferences = ? WHERE id = ?',
      [JSON.stringify(preferences), userId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }
    res.json({ success: true, message: 'Préférences mises à jour' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
// ===================== ROUTES STATISTIQUES =====================
app.post('/api/stats', isAuthenticated, async (req, res) => {
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
app.post('/api/progress', isAuthenticated, async (req, res) => {
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
app.get('/api/progress/:userId', isAuthenticated, async (req, res) => {
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
app.post('/api/history', isAuthenticated, async (req, res) => {
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
app.get('/api/history/:userId/:limit', isAuthenticated, async (req, res) => {
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
app.post('/api/favorites', isAuthenticated, async (req, res) => {
  try {
    const { userId, type, referenceId, referenceText, notes } = req.body;
    const [result] = await mysqlPool.execute(
      'INSERT INTO favorites (user_id, type, reference_id, reference_text, notes) VALUES (?, ?, ?, ?, ?)',
      [userId, type, referenceId, referenceText, notes]
    );
    res.json({ success: true, message: 'Favori ajouté' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
app.get('/api/favorites/:userId', isAuthenticated, async (req, res) => {
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
app.delete('/api/favorites/:favoriteId', isAuthenticated, async (req, res) => {
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
app.post('/api/sessions/start', isAuthenticated, async (req, res) => {
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
app.put('/api/sessions/:sessionId/end', isAuthenticated, async (req, res) => {
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
app.post('/api/goals', isAuthenticated, async (req, res) => {
  try {
    const { userId, goalType, targetValue, startDate, endDate } = req.body;
    const [result] = await mysqlPool.execute(
      'INSERT INTO reading_goals (user_id, goal_type, target_value, start_date, end_date) VALUES (?, ?, ?, ?, ?)',
      [userId, goalType, targetValue, startDate, endDate]
    );
    res.json({ success: true, goalId: result.insertId, message: 'Objectif créé' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
app.get('/api/goals/:userId', isAuthenticated, async (req, res) => {
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
app.put('/api/goals/:goalId', isAuthenticated, async (req, res) => {
  try {
    const { goalId } = req.params;
    const { currentValue, isCompleted } = req.body;
    const [result] = await mysqlPool.execute(
      'UPDATE reading_goals SET current_value = ?, is_completed = ? WHERE id = ?',
      [currentValue, isCompleted, goalId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Objectif non trouvé' });
    }
    res.json({ success: true, message: 'Objectif mis à jour' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Nouvelle route pour récupérer tous les bots
app.get('/api/bots', (req, res) => {
  try {
    const bots = getBots();
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
// Route pour créer un nouveau bot
app.post('/api/bots', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ message: 'Non authentifié' });
  }
  const { name, description, price, category, image, prompt } = req.body;
  
  try {
    const botId = addBot(name, description, price, category, image, prompt);
    res.status(201).json({ message: 'Bot créé avec succès', botId });
  } catch (error) {
    console.error('Erreur lors de la création du bot:', error);
    res.status(500).json({ message: 'Erreur lors de la création du bot' });
  }
});

// Route pour mettre à jour un bot
app.put('/api/bots/:id', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ message: 'Non authentifié' });
  }
  const botId = Number(req.params.id); // Convertir l'ID en nombre
  console.log('PUT /api/bots/:id - Received ID:', botId); // Log the received ID
  const { name, description, price, category, image, prompt } = req.body;
  console.log('PUT /api/bots/:id - Received body:', req.body); // Log the received body
  
  try {
    updateBot(botId, name, description, price, category, image, prompt);
    res.status(200).json({ message: 'Bot mis à jour avec succès' });
  } catch (error) {
    console.error('Erreur lors de la mise à jour du bot:', error);
    res.status(500).json({ message: 'Erreur lors de la mise à jour du bot' });
  }
});

// Route pour supprimer un bot
app.delete('/api/bots/:id', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ message: 'Non authentifié' });
  }
  const botId = req.params.id;
  
  try {
    deleteBot(botId);
    res.status(200).json({ message: 'Bot supprimé avec succès' });
  } catch (error) {
    console.error('Erreur lors de la suppression du bot:', error);
    res.status(500).json({ message: 'Erreur lors de la suppression du bot' });
  }
});

// Nouvelle route pour activer un bot pour un utilisateur


// Nouvelle route pour récupérer les messages pour un utilisateur et un bot spécifiques
app.get('/api/messages', async (req, res) => {
  console.log('=== Début de la requête /api/messages ===');
  console.log('Headers:', req.headers);
  console.log('Cookies:', req.cookies);
  console.log('Session (avant Passport): ', req.session);
  console.log('isAuthenticated (après Passport): ', req.isAuthenticated());
  console.log('User (après Passport): ', req.user);

  // Commenter temporairement la vérification d'authentification
  // if (!req.isAuthenticated()) {
  //   console.log('/api/messages - Non authentifié après Passport');
  //   return res.status(401).json({ message: 'Non authentifié' });
  // }

  console.log('/api/messages - Authentifié (vérification temporairement désactivée) ou non authentifié');
  const userId = req.query.userId;
  const botId = Number(req.query.botId);

  // Récupérer l'identifiant de conversation, utiliser 0 par défaut si non spécifié
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
app.post('/api/chat', async (req, res) => {
  console.log('=== Début de la requête /api/chat ===');
  console.log('Headers:', req.headers);
  console.log('Cookies:', req.cookies);
  console.log('Session (avant Passport): ', req.session);
  console.log('isAuthenticated (après Passport): ', req.isAuthenticated());
  console.log('User (après Passport): ', req.user);

  if (!req.isAuthenticated()) {
    console.log('/api/chat - Non authentifié après Passport');
    return res.status(401).json({ message: 'Non authentifié' });
  }

  // Vérification du quota global de messages chatbot
  const quota = await checkGlobalChatbotQuota(req.user.id, req.user.email);
  if (!quota.canSend) {
    return res.status(402).json({ message: `Quota de messages gratuits dépassé. Veuillez acheter plus de messages pour continuer à utiliser le chatbot.` });
  }

  console.log('/api/chat - Utilisateur authentifié, ID:', req.user.id);
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
        [req.user.id, usedBotId, newConvTitle]
      );
      currentConversationId = result.insertId;
      console.log('Nouvelle conversation créée avec ID (MySQL):', currentConversationId);
    } catch (convError) {
      console.error('Erreur lors de la création de la conversation (MySQL):', convError);
      return res.status(500).json({ message: 'Erreur lors de la création de la conversation.' });
    }
  } else if (title && currentConversationId > 0) {
    try {
      await updateConversationTitle(req.user.id, usedBotId, Number(conversationId), title);
      console.log(`Titre de la conversation ${currentConversationId} mis à jour.`);
    } catch (titleUpdateError) {
      console.error(`Erreur lors de la mise à jour du titre de la conversation ${currentConversationId}:`, titleUpdateError);
    }
  }

  try {
    // Récupérer le bot pour obtenir le prompt
    const bot = getBotById(usedBotId);

    if (!bot) {
      return res.status(404).json({ message: 'Bot non trouvé' });
    }

    const prompt = bot.prompt || 'You are a helpful assistant.';

    // Récupérer les 10 derniers messages pour le contexte de cette conversation
    const conversationHistory = await getMessagesForUserBot(req.user.id, usedBotId, currentConversationId, 10);

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

    await addMessageMySQL(req.user.id, usedBotId, currentConversationId, 'user', message);
    await addMessageMySQL(req.user.id, usedBotId, currentConversationId, 'bot', reply);

    // Incrémenter le compteur de messages chatbot
    incrementChatbotMessagesUsed(req.user.id);

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
app.get('/api/chatbot/quota', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ message: 'Non authentifié' });
  }
  // Aller chercher l'utilisateur dans MySQL
  const [rows] = await mysqlPool.query('SELECT chatbotMessagesUsed, chatbotMessagesQuota FROM users WHERE id = ?', [req.user.id]);
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
app.post('/api/generate-keys', (req, res) => {
  if (!req.isAuthenticated() || req.user.email !== 'mohammadharris200528@gmail.com') { // Vérifier si l'utilisateur est admin
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

// Nouvelle route pour sauvegarder les préférences utilisateur par bot
app.post('/api/bot-preferences', isAuthenticated, (req, res) => {
  const userId = req.user.id;
  const { botId, preferences } = req.body;

  if (!botId || !preferences) {
    return res.status(400).json({ message: 'Bot ID et préférences sont requis.' });
  }

  try {
    saveUserBotPreferences(userId, botId, preferences);
    res.status(200).json({ message: 'Préférences sauvegardées avec succès.' });
  } catch (error) {
    console.error('Erreur lors de la sauvegarde des préférences:', error);
    res.status(500).json({ message: 'Erreur lors de la sauvegarde des préférences.' });
  }
});

// Modifier la route pour récupérer les conversations afin d'inclure les préférences
app.get('/api/conversations/:botId', isAuthenticated, (req, res) => {
  const userId = req.user.id;
  const botId = Number(req.params.botId);

  try {
    const conversations = getConversationsForUserBot(userId, botId);
    const preferences = getUserBotPreferences(userId, botId);
    
    res.status(200).json({ conversations, preferences });
  } catch (error) {
    console.error('Erreur lors de la récupération des conversations et préférences:', error);
    res.status(500).json({ message: 'Erreur lors de la récupération des conversations et préférences.' });
  }
});

// Route pour supprimer une conversation
app.delete('/api/conversations/:botId/:conversationId', isAuthenticated, async (req, res) => {
  try {
    const { botId, conversationId } = req.params;
    const userId = req.user.id;

    const success = await deleteConversationMySQL(userId, botId, conversationId);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Conversation non trouvée' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la suppression de la conversation' });
  }
});

// Route pour mettre à jour le titre d'une conversation
app.put('/api/conversations/:botId/:conversationId/title', isAuthenticated, async (req, res) => {
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
app.get('/api/messages/:botId/:conversationId/search', isAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const botId = parseInt(req.params.botId);
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
app.get('/api/user/mysql-id', isAuthenticated, async (req, res) => {
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
app.get('/api/user/stats', isAuthenticated, async (req, res) => {
  try {
    const stats = await getUserStats(req.user.id);
    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Route pour récupérer les stats journalières des 30 derniers jours pour l’utilisateur connecté


// Route de test pour forcer la synchronisation d'un utilisateur vers MySQL
app.get('/api/test/sync-user', isAuthenticated, async (req, res) => {
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
app.post('/api/conversations', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    const { botId, title } = req.body;
    const usedBotId = botId ? Number(botId) : 1;
    if (!usedBotId || isNaN(usedBotId)) {
      return res.status(400).json({ message: 'botId requis et doit être un nombre' });
    }
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
app.post('/api/test/generate-stats', isAuthenticated, async (req, res) => {
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
    // Insertion en une seule requête
    await mysqlPool.query(
      'INSERT INTO quran_stats (user_id, date, hasanat, verses, time_seconds, pages_read) VALUES ?',
      [values]
    );
    res.json({ success: true, message: 'Stats de test générées pour 30 jours.' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur lors de la génération des stats.', error: error.message });
  }
});

// Stats du jour
app.get('/api/user/stats/today', isAuthenticated, async (req, res) => {
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
app.get('/api/user/stats/week', isAuthenticated, async (req, res) => {
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
app.get('/api/user/stats/all', isAuthenticated, async (req, res) => {
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
app.get('/api/user/stats/daily', isAuthenticated, async (req, res) => {
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
app.get('/api/user/preferences', isAuthenticated, async (req, res) => {
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
app.put('/api/user/preferences', isAuthenticated, async (req, res) => {
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
app.get('/api/conversations/:conversationId/messages', isAuthenticated, async (req, res) => {
  const { conversationId } = req.params;
  try {
    const [rows] = await mysqlPool.execute(
      'SELECT * FROM messages WHERE conversationId = ? ORDER BY timestamp ASC',
      [conversationId]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Erreur lors de la récupération des messages.' });
  }
});

// Route pour récupérer tous les messages d'un utilisateur, groupés par conversationId
app.get('/api/user/:userId/messages', isAuthenticated, async (req, res) => {
  const { userId } = req.params;
  try {
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
app.get('/api/user/:userId/conversations', isAuthenticated, async (req, res) => {
  const { userId } = req.params;
  try {
    const [rows] = await mysqlPool.execute(
      'SELECT * FROM conversations WHERE userId = ? ORDER BY createdAt DESC',
      [userId]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Erreur lors de la récupération des conversations.' });
  }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Servir les fichiers statiques du build React

// Fallback SPA : toutes les autres routes renvoient index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur backend démarré sur le port ${PORT}`);
}); 