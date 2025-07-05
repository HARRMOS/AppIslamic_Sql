// =========================
// ROUTES DISPONIBLES (BACKEND FUSIONNÉ)
// =========================
//
// 1. AUTHENTIFICATION
//   - GET    /auth/status                → Vérifie l'état d'authentification
//   - GET    /auth/google                → Démarre l'auth Google
//   - GET    /auth/google/callback       → Callback OAuth Google
//   - GET    /logout                     → Déconnexion
//
// 2. UTILISATEUR
//   - GET    /api/user/mysql-id          → Récupère l'ID MySQL de l'utilisateur connecté
//
// 3. CHATBOT & CONVERSATIONS
//   - POST   /api/chat                   → Envoie un message au chatbot (création/conversation)
//   - GET    /api/conversations          → Liste toutes les conversations de l'utilisateur
//   - POST   /api/conversations          → Crée une nouvelle conversation
//   - DELETE /api/conversations/:conversationId      → Supprime une conversation
//   - PUT    /api/conversations/:conversationId/title → Met à jour le titre d'une conversation
//   - GET    /api/messages?conversationId=...        → Récupère les messages d'une conversation
//   - GET    /api/messages/:conversationId/search?query=... → Recherche des messages dans une conversation
//
// 4. QUOTA CHATBOT
//   - GET    /api/chatbot/quota           → Retourne le quota et le nombre de messages restants
//
// 5. (Optionnel) FONCTIONS QURAN (non exposées en API REST)
//
// Toutes les routes (hors /auth/* et /logout) nécessitent l'authentification.
// =========================

import express from 'express';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import dotenv from 'dotenv';
import session from 'express-session';
import { initDatabase, findOrCreateUser, findUserById, addMessage, getMessagesForConversation, addConversation, getConversationsForUser, deleteConversation, updateConversationTitle, getConversationById, searchMessages, updateConversationStatus, getMySQLUserId, syncUserToMySQL, updateUserMySQLId, checkGlobalChatbotQuota, incrementChatbotMessagesUsed, upsertQuranStats } from './database.js';
import cors from 'cors';
import openai from './openai.js';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';

const app = express();

// Middlewares de sécurité
app.use(helmet());
app.use(compression());
app.use(morgan('combined'));

// CORS
const allowedOrigins = [
  'https://www.quran-pro.harrmos.com',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000'
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

// Body parsing
app.use(express.json());

// Session et Passport (doivent être AVANT les routes)
app.use(session({
  secret: process.env.SESSION_SECRET || 'supersecretpar défaut',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, sameSite: 'Lax', maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());

function isAuthenticated(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  res.status(401).json({ message: 'Non authentifié' });
}

// =========================
// CONFIGURATION BASE DE DONNÉES
// =========================
import mysql from 'mysql2/promise';
let pool;
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

async function initializeDatabase() {
  try {
    pool = mysql.createPool(dbConfig);
    const connection = await pool.getConnection();
    console.log('✅ Connexion à la base de données MySQL réussie');
    connection.release();
  } catch (error) {
    console.error('❌ Erreur de connexion à la base de données:', error.message);
    process.exit(1);
  }
}

// =========================
// STRATÉGIE GOOGLE PASSPORT
// =========================
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL || "http://localhost:3000/auth/google/callback"
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
      const userId = (await import('crypto')).randomUUID();
      await pool.execute(
        'INSERT INTO users (id, email, name) VALUES (?, ?, ?)',
        [userId, email, username]
      );
      user = { id: userId, email, name: username };
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

// AUTH
app.get('/auth/status', async (req, res) => {
  if (req.isAuthenticated()) {
    res.status(200).json({ user: { id: req.user.id, name: req.user.name, email: req.user.email, mysql_id: req.user.mysql_id } });
  } else {
    res.status(200).json({ user: null });
  }
});
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login' }), (req, res) => {
  const frontendUrl = 'http://localhost:5173/';
  res.send(`<html><head><meta http-equiv="refresh" content="0;url=${frontendUrl}" /><script>window.location.href = "${frontendUrl}";</script></head><body>Redirection...</body></html>`);
});
app.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.status(200).json({ message: 'Déconnexion réussie' });
  });
});

// UTILISATEUR
app.get('/api/user/mysql-id', isAuthenticated, (req, res) => {
  if (req.user && req.user.id) {
    res.json({ success: true, mysqlUserId: req.user.id });
  } else {
    res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
  }
});

// CHATBOT & CONVERSATIONS
app.post('/api/chat', isAuthenticated, async (req, res) => {
  const quota = await checkGlobalChatbotQuota(req.user.id, req.user.email);
  if (!quota.canSend) return res.status(402).json({ message: `Quota de messages gratuits dépassé. Veuillez acheter plus de messages pour continuer à utiliser le chatbot.` });
  const { message, conversationId, title } = req.body;
  if (!message) return res.status(400).json({ message: 'Message requis' });
  let currentConversationId = Number(conversationId);
  let conversationTitle = title;
  if (!currentConversationId || !(await getConversationById(currentConversationId))) {
    const newConvTitle = conversationTitle || 'Nouvelle conversation';
    currentConversationId = await addConversation(req.user.id, newConvTitle);
  } else if (title && currentConversationId > 0) {
    await updateConversationTitle(req.user.id, currentConversationId, title);
  }
  try {
    const prompt = `Tu es un assistant islamique bienveillant. Tu expliques l'islam avec douceur, sagesse et respect. Tu cites toujours tes sources : versets du Coran (avec numéro de sourate et verset), hadiths authentiques (avec référence), ou avis de savants connus. Si tu ne connais pas la réponse, dis-le avec bienveillance. Tu t'exprimes comme un ami proche, rassurant et sincère. Et tu ne reponds a aucune question qui n'est pas islamique.`;
    const conversationHistory = await getMessagesForConversation(req.user.id, currentConversationId, 10);
    const messagesForGpt = [ { role: "system", content: prompt } ];
    conversationHistory.forEach(msg => {
      messagesForGpt.push({ role: msg.sender === 'user' ? 'user' : 'assistant', content: msg.text });
    });
    messagesForGpt.push({ role: "user", content: message });
    const completion = await openai.chat.completions.create({ model: "gpt-3.5-turbo", messages: messagesForGpt, temperature: 0.7, max_tokens: 500 });
    const reply = completion.choices[0].message.content;
    await addMessage(req.user.id, currentConversationId, 'user', message);
    await addMessage(req.user.id, currentConversationId, 'bot', reply);
    await incrementChatbotMessagesUsed(req.user.id);
    res.status(200).json({ message: reply, conversationId: currentConversationId });
  } catch (error) {
    res.status(500).json({ message: 'Une erreur est survenue lors de l\'interaction avec le bot' });
  }
});
app.get('/api/conversations', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    const conversations = await getConversationsForUser(userId);
    res.status(200).json(conversations);
  } catch (error) {
    res.status(500).json({ message: 'Erreur lors de la récupération des conversations.' });
  }
});
app.post('/api/conversations', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    const { title } = req.body;
    const convTitle = title || 'Nouvelle conversation';
    const conversationId = await addConversation(userId, convTitle);
    const conversation = await getConversationById(conversationId);
    res.status(201).json(conversation);
  } catch (error) {
    res.status(500).json({ message: 'Erreur lors de la création de la conversation.' });
  }
});
app.delete('/api/conversations/:conversationId', isAuthenticated, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;
    const success = await deleteConversation(userId, conversationId);
    if (success) res.json({ success: true });
    else res.status(404).json({ error: 'Conversation non trouvée' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la suppression de la conversation' });
  }
});
app.put('/api/conversations/:conversationId/title', isAuthenticated, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: 'Le titre est requis' });
    const success = await updateConversationTitle(userId, Number(conversationId), title);
    if (success) res.json({ success: true });
    else res.status(404).json({ error: 'Conversation non trouvée ou aucun message à mettre à jour' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la mise à jour du titre de la conversation' });
  }
});
app.get('/api/messages', isAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const conversationId = Number(req.query.conversationId);
  if (!userId || isNaN(conversationId)) return res.status(400).json({ message: 'userId et conversationId sont requis' });
  try {
    const messages = await getMessagesForConversation(userId, conversationId);
    res.status(200).json(messages);
  } catch (error) {
    res.status(500).json({ message: 'Erreur lors de la récupération des messages' });
  }
});
app.get('/api/messages/:conversationId/search', isAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const conversationId = parseInt(req.params.conversationId);
  const query = req.query.query;
  if (!userId || isNaN(conversationId) || !query || typeof query !== 'string') return res.status(400).send('Paramètres manquants ou invalides.');
  try {
    const messages = await searchMessages(userId, conversationId, query);
    res.json(messages);
  } catch (error) {
    res.status(500).send('Erreur interne du serveur.');
  }
});

// QUOTA CHATBOT
app.get('/api/chatbot/quota', isAuthenticated, async (req, res) => {
  const user = await findUserById(req.user.id);
  if (!user) return res.status(404).json({ message: 'Utilisateur non trouvé' });
  if (req.user.email === 'mohammadharris200528@gmail.com') return res.json({ remaining: Infinity, quota: Infinity });
  const used = user.chatbotMessagesUsed ?? 0;
  const quota = user.chatbotMessagesQuota ?? 1000;
  const remaining = quota - used;
  res.json({ remaining, quota });
});

// Incrémentation des stats de lecture du Quran
app.post('/api/quran/stats/increment', isAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { hasanat = 0, verses = 0, time_seconds = 0, pages_read = 0 } = req.body;
  try {
    const today = new Date().toISOString().slice(0, 10); // format YYYY-MM-DD
    await upsertQuranStats(userId, today, hasanat, verses, time_seconds, pages_read);
    res.json({ success: true, message: 'Stats mises à jour' });
  } catch (error) {
    console.error('Erreur incrémentation stats:', error);
    res.status(500).json({ success: false, message: 'Erreur lors de la mise à jour des stats' });
  }
});

// Fallback SPA
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist', 'index.html'));
});

// =========================
// DÉMARRAGE DU SERVEUR
// =========================
async function startServer() {
  await initializeDatabase();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Serveur backend démarré sur le port ${PORT}`);
  });
}

startServer().catch(error => {
  console.error('❌ Erreur au démarrage:', error);
  process.exit(1);
}); 