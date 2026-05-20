'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const path      = require('path');
const express   = require('express');
const mongoose  = require('mongoose');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { Provider } = require('ltijs');

/* ════════════════════════════════════════════════════════════════
   AUTH — Modèle Teacher & connexion mongoose séparée
════════════════════════════════════════════════════════════════ */
const teacherConn = mongoose.createConnection(process.env.MONGODB_URI);
const Teacher = teacherConn.model('Teacher', new mongoose.Schema({
  name:      { type: String, required: true },
  email:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:  { type: String, required: true },
}, { timestamps: true }));

const JWT_SECRET = process.env.JWT_SECRET || process.env.LTI_KEY;
const signToken  = (teacher) => jwt.sign(
  { id: teacher._id.toString(), name: teacher.name, email: teacher.email, role: 'instructor' },
  JWT_SECRET,
  { expiresIn: '30d' }
);

/* ════════════════════════════════════════════════════════════════
   1.  LTIJS — configuration
════════════════════════════════════════════════════════════════ */
Provider.setup(
  process.env.LTI_KEY,
  { url: process.env.MONGODB_URI },
  {
    cookies: {
      secure:   process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'None' : 'Lax',
    },
    devMode:     process.env.NODE_ENV !== 'production',
    tokenMaxAge: false,
  }
);

/* ════════════════════════════════════════════════════════════════
   2.  CALLBACK après un launch LTI réussi
   On extrait les infos Moodle du JWT et on les passe au frontend
   via des paramètres d'URL — simple et sans Provider.protect().
════════════════════════════════════════════════════════════════ */
Provider.onConnect(async (token, _req, res) => {
  try {
    const roles = token.platformContext?.roles ?? [];
    const isInstructor = roles.some(r =>
      r.includes('Instructor') ||
      r.includes('TeachingAssistant') ||
      r.includes('Administrator') ||
      r.includes('ContentDeveloper')
    );

    const name =
      token.userInfo?.name ??
      [token.userInfo?.given_name, token.userInfo?.family_name]
        .filter(Boolean).join(' ') ??
      'Anonyme';

    const params = new URLSearchParams({
      lti:        '1',
      id:         token.user                               ?? '',
      name,
      email:      token.userInfo?.email                    ?? '',
      role:       isInstructor ? 'instructor' : 'learner',
      courseId:   token.platformContext?.context?.id       ?? '',
      courseName: token.platformContext?.context?.title    ?? 'Cours',
    });

    console.log(`[LTI Launch] ${name} (${isInstructor ? 'instructor' : 'learner'}) — cours: ${token.platformContext?.context?.title}`);
    return res.redirect('/?' + params.toString());
  } catch (err) {
    console.error('[onConnect error]', err.message);
    return res.redirect('/');
  }
});

/* ════════════════════════════════════════════════════════════════
   2b. Routes non protégées par LTI
   - /api/* → nos endpoints REST (auth, platform, health)
   - /static/* → assets du frontend
   Sans whitelist, ltijs intercepte tout et renvoie 401.
════════════════════════════════════════════════════════════════ */
Provider.whitelist(
  { route: new RegExp('^/api/'), method: 'all' },
);

/* Accès direct navigateur sans token → servir le SPA React.
   On supprime COEP ici car ltijs envoie la réponse avant que
   le middleware Express n'ait la chance de modifier les headers. */
const CLIENT = path.join(__dirname, '../../client');
Provider.onInvalidToken((_req, res) => {
  res.removeHeader('Cross-Origin-Embedder-Policy');
  res.removeHeader('Cross-Origin-Opener-Policy');
  res.sendFile(path.join(CLIENT, 'index.html'));
});

/* ════════════════════════════════════════════════════════════════
   3.  API REST
════════════════════════════════════════════════════════════════ */
const api = express.Router();
api.use(express.json());

/* ── POST /api/auth/register ───────────────────────────────────
   Inscription enseignant (accès web sans LTI).
────────────────────────────────────────────────────────────── */
api.post('/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Nom, email et mot de passe obligatoires.' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Mot de passe trop court (8 caractères minimum).' });
  try {
    if (await Teacher.findOne({ email: email.toLowerCase() }))
      return res.status(409).json({ error: 'Cet email est déjà utilisé.' });
    const hash    = await bcrypt.hash(password, 12);
    const teacher = await Teacher.create({ name, email, password: hash });
    return res.json({ token: signToken(teacher), user: { id: teacher._id, name: teacher.name, email: teacher.email, role: 'instructor' } });
  } catch (err) {
    console.error('[POST /api/auth/register]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/auth/login ──────────────────────────────────────
   Connexion enseignant.
────────────────────────────────────────────────────────────── */
api.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email et mot de passe obligatoires.' });
  try {
    const teacher = await Teacher.findOne({ email: email.toLowerCase() });
    if (!teacher || !(await bcrypt.compare(password, teacher.password)))
      return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
    return res.json({ token: signToken(teacher), user: { id: teacher._id, name: teacher.name, email: teacher.email, role: 'instructor' } });
  } catch (err) {
    console.error('[POST /api/auth/login]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/auth/me ──────────────────────────────────────────
   Vérifie le token JWT et retourne l'enseignant.
────────────────────────────────────────────────────────────── */
api.get('/auth/me', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer '))
    return res.status(401).json({ error: 'Token manquant.' });
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    return res.json({ id: payload.id, name: payload.name, email: payload.email, role: 'instructor' });
  } catch {
    return res.status(401).json({ error: 'Token invalide ou expiré.' });
  }
});

/* ── POST /api/platform ────────────────────────────────────────
   Enregistre une plateforme Moodle.
   À appeler UNE SEULE FOIS lors de la configuration initiale.
────────────────────────────────────────────────────────────── */
api.post('/platform', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Clé admin incorrecte' });
  }
  const { url, clientId, name } = req.body;
  if (!url || !clientId) {
    return res.status(400).json({ error: '"url" et "clientId" sont obligatoires' });
  }
  try {
    await Provider.registerPlatform({
      url,
      name:                    name ?? url,
      clientId,
      authenticationEndpoint:  `${url}/mod/lti/auth.php`,
      accesstokenEndpoint:     `${url}/mod/lti/token.php`,
      authConfig: {
        method: 'JWK_SET',
        key:    `${url}/mod/lti/certs.php`,
      },
    });
    console.log(`[Platform registered] ${url}`);
    return res.json({ success: true, message: `Plateforme ${url} enregistrée.` });
  } catch (err) {
    console.error('[POST /api/platform]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/platforms ────────────────────────────────────────
   Liste les plateformes enregistrées.
────────────────────────────────────────────────────────────── */
api.get('/platforms', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Clé admin incorrecte' });
  }
  const platforms = await Provider.getAllPlatforms();
  return res.json(
    platforms.map(p => ({ name: p.platformName(), url: p.platformUrl() }))
  );
});

/* ── GET /api/health ───────────────────────────────────────────
   Vérification de vie.
────────────────────────────────────────────────────────────── */
api.get('/health', (_req, res) => res.json({ status: 'ok' }));

Provider.app.use('/api', api);

/* ════════════════════════════════════════════════════════════════
   4.  FRONTEND STATIQUE (assets JS/CSS/images)
   Supprime le header COEP posé par helmet/ltijs qui bloque les
   ressources CDN (Tailwind, React, Firebase…).
════════════════════════════════════════════════════════════════ */
Provider.app.use((_req, res, next) => {
  res.removeHeader('Cross-Origin-Embedder-Policy');
  res.removeHeader('Cross-Origin-Opener-Policy');
  next();
});
Provider.app.use(express.static(CLIENT));

/* ════════════════════════════════════════════════════════════════
   5.  DÉMARRAGE
════════════════════════════════════════════════════════════════ */
const PORT = parseInt(process.env.PORT ?? '3000', 10);

Provider.deploy({ port: PORT })
  .then(() => {
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log(`║  ✅  PollApp LTI  →  port ${PORT}       ║`);
    console.log('╚══════════════════════════════════════╝');
    console.log('');
  })
  .catch(err => {
    console.error('❌ Erreur au démarrage :', err);
    process.exit(1);
  });
