'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const path      = require('path');
const express   = require('express');
const mongoose  = require('mongoose');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { Provider } = require('ltijs');

const CLIENT = path.join(__dirname, '..', '..', 'client');

/* ════════════════════════════════════════════════════════════════
   LOGGER — préfixé avec timestamp
════════════════════════════════════════════════════════════════ */
const L = {
  info:  (...a) => console.log (`[${new Date().toISOString()}] ℹ️ `, ...a),
  ok:    (...a) => console.log (`[${new Date().toISOString()}] ✅ `, ...a),
  warn:  (...a) => console.warn(`[${new Date().toISOString()}] ⚠️ `, ...a),
  error: (...a) => console.error(`[${new Date().toISOString()}] ❌ `, ...a),
  req:   (req)  => console.log (`[${new Date().toISOString()}] 🌐 ${req.method} ${req.path}`, {
    ip:      req.ip,
    origin:  req.get('origin') || '—',
    ua:      (req.get('user-agent') || '').slice(0, 60),
    cookie:  req.headers.cookie ? '✓' : '✗',
    auth:    req.headers.authorization ? '✓ Bearer' : '✗',
  }),
};

L.info('=== DÉMARRAGE DU SERVEUR ===');
L.info('NODE_ENV      :', process.env.NODE_ENV);
L.info('PORT          :', process.env.PORT || 3000);
L.info('MONGODB_URI   :', process.env.MONGODB_URI ? process.env.MONGODB_URI.replace(/:([^@]+)@/, ':***@') : '❌ MANQUANT');
L.info('LTI_KEY       :', process.env.LTI_KEY   ? `✓ (${process.env.LTI_KEY.length} chars)` : '❌ MANQUANT');
L.info('ADMIN_KEY     :', process.env.ADMIN_KEY  ? '✓' : '⚠️  non défini');
L.info('CLIENT dir    :', CLIENT);

/* ════════════════════════════════════════════════════════════════
   AUTH — Modèle Teacher
════════════════════════════════════════════════════════════════ */
const teacherConn = mongoose.createConnection(process.env.MONGODB_URI);

teacherConn.on('connecting',   () => L.info('MongoDB: connexion en cours…'));
teacherConn.on('connected',    () => L.ok ('MongoDB: connecté ✓'));
teacherConn.on('disconnected', () => L.warn('MongoDB: déconnecté'));
teacherConn.on('error',        (e) => L.error('MongoDB erreur:', e.message));

const Teacher = teacherConn.model('Teacher', new mongoose.Schema({
  name:     { type: String, required: true },
  email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
}, { timestamps: true }));

const JWT_SECRET = process.env.JWT_SECRET || process.env.LTI_KEY;
if (!JWT_SECRET) L.error('JWT_SECRET / LTI_KEY manquant — les tokens seront invalides !');

const signToken = (teacher) => jwt.sign(
  { id: teacher._id.toString(), name: teacher.name, email: teacher.email, role: 'instructor' },
  JWT_SECRET,
  { expiresIn: '30d' }
);

/* ════════════════════════════════════════════════════════════════
   1.  LTIJS
════════════════════════════════════════════════════════════════ */
L.info('ltijs: setup…');
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
   2.  CALLBACK LTI launch
════════════════════════════════════════════════════════════════ */
Provider.onConnect(async (token, req, res) => {
  L.info('── LTI onConnect ──────────────────────');
  L.info('  user         :', token.user);
  L.info('  userInfo     :', JSON.stringify(token.userInfo));
  L.info('  roles        :', JSON.stringify(token.platformContext?.roles));
  L.info('  context      :', JSON.stringify(token.platformContext?.context));
  L.info('  platform     :', token.iss);

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

    L.ok(`LTI launch OK → ${name} (${isInstructor ? 'instructor' : 'learner'}) — cours: ${token.platformContext?.context?.title}`);
    return res.redirect('/?' + params.toString());
  } catch (err) {
    L.error('onConnect exception:', err.message, err.stack);
    return res.redirect('/');
  }
});

/* Accès direct (sans session LTI) → SPA */
Provider.onInvalidToken((req, res) => {
  L.warn('onInvalidToken — accès direct sans session LTI →', req.path);
  res.removeHeader('Cross-Origin-Embedder-Policy');
  res.removeHeader('Cross-Origin-Opener-Policy');
  res.sendFile(path.join(CLIENT, 'index.html'));
});

/* Headers COOP/COEP (bloquent parfois les iframes Moodle) */
Provider.app.use((_req, res, next) => {
  res.removeHeader('Cross-Origin-Embedder-Policy');
  res.removeHeader('Cross-Origin-Opener-Policy');
  next();
});
Provider.app.use(express.static(CLIENT));

/* ════════════════════════════════════════════════════════════════
   3.  API REST
════════════════════════════════════════════════════════════════ */
const api = express.Router();
api.use(express.json());

/* Middleware de log sur toutes les routes /api */
api.use((req, _res, next) => { L.req(req); next(); });

/* ── Health ───────────────────────────────────────────────────── */
api.get('/health', async (_req, res) => {
  const mongoState = ['disconnected','connected','connecting','disconnecting'][teacherConn.readyState] ?? 'unknown';
  const info = {
    status:      'ok',
    mongo:       mongoState,
    nodeVersion: process.version,
    env:         process.env.NODE_ENV,
    ltiKey:      process.env.LTI_KEY   ? `✓ (${process.env.LTI_KEY.length}c)` : '❌ MISSING',
    jwtSecret:   JWT_SECRET            ? '✓' : '❌ MISSING',
    clientDir:   CLIENT,
  };
  L.info('Health check:', JSON.stringify(info));
  return res.json(info);
});

/* ── Auth : register ──────────────────────────────────────────── */
api.post('/auth/register', async (req, res) => {
  L.info('POST /auth/register — body:', { name: req.body?.name, email: req.body?.email, pwLen: req.body?.password?.length });
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    L.warn('register: champs manquants');
    return res.status(400).json({ error: 'Nom, email et mot de passe obligatoires.' });
  }
  if (password.length < 8) {
    L.warn('register: mot de passe trop court');
    return res.status(400).json({ error: 'Mot de passe trop court (8 caractères minimum).' });
  }

  try {
    const exists = await Teacher.findOne({ email: email.toLowerCase() });
    if (exists) {
      L.warn('register: email déjà utilisé —', email);
      return res.status(409).json({ error: 'Cet email est déjà utilisé.' });
    }
    const hash    = await bcrypt.hash(password, 12);
    const teacher = await Teacher.create({ name, email, password: hash });
    L.ok('register: compte créé —', email);
    return res.json({
      token: signToken(teacher),
      user:  { id: teacher._id, name: teacher.name, email: teacher.email, role: 'instructor' },
    });
  } catch (err) {
    L.error('register exception:', err.message, err.stack);
    return res.status(500).json({ error: err.message });
  }
});

/* ── Auth : login ─────────────────────────────────────────────── */
api.post('/auth/login', async (req, res) => {
  L.info('POST /auth/login — email:', req.body?.email);
  const { email, password } = req.body;

  if (!email || !password) {
    L.warn('login: champs manquants');
    return res.status(400).json({ error: 'Email et mot de passe obligatoires.' });
  }

  try {
    L.info('login: recherche dans MongoDB…');
    const teacher = await Teacher.findOne({ email: email.toLowerCase() });
    if (!teacher) {
      L.warn('login: email non trouvé —', email);
      return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
    }
    L.info('login: compte trouvé, vérification du mot de passe…');
    const match = await bcrypt.compare(password, teacher.password);
    if (!match) {
      L.warn('login: mot de passe incorrect pour', email);
      return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
    }
    L.ok('login: connexion réussie —', email);
    return res.json({
      token: signToken(teacher),
      user:  { id: teacher._id, name: teacher.name, email: teacher.email, role: 'instructor' },
    });
  } catch (err) {
    L.error('login exception:', err.message, err.stack);
    return res.status(500).json({ error: err.message });
  }
});

/* ── Auth : me ────────────────────────────────────────────────── */
api.get('/auth/me', (req, res) => {
  L.info('GET /auth/me');
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    L.warn('/auth/me: header Authorization manquant ou mal formé —', auth?.slice(0,20));
    return res.status(401).json({ error: 'Token manquant.' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    L.ok('/auth/me: token valide —', payload.email);
    return res.json({ id: payload.id, name: payload.name, email: payload.email, role: 'instructor' });
  } catch (err) {
    L.warn('/auth/me: token invalide —', err.message);
    return res.status(401).json({ error: 'Token invalide ou expiré.' });
  }
});

/* ── Platform ─────────────────────────────────────────────────── */
api.post('/platform', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: 'Clé admin incorrecte' });
  const { url, clientId, name } = req.body;
  if (!url || !clientId)
    return res.status(400).json({ error: '"url" et "clientId" sont obligatoires' });
  try {
    await Provider.registerPlatform({
      url, name: name ?? url, clientId,
      authenticationEndpoint: `${url}/mod/lti/auth.php`,
      accesstokenEndpoint:    `${url}/mod/lti/token.php`,
      authConfig: { method: 'JWK_SET', key: `${url}/mod/lti/certs.php` },
    });
    L.ok('Platform registered:', url);
    return res.json({ success: true, message: `Plateforme ${url} enregistrée.` });
  } catch (err) {
    L.error('Platform register error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

api.get('/platforms', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: 'Clé admin incorrecte' });
  const platforms = await Provider.getAllPlatforms();
  return res.json(platforms.map(p => ({ name: p.platformName(), url: p.platformUrl() })));
});

/* ════════════════════════════════════════════════════════════════
   4.  DÉMARRAGE — Express principal devant ltijs
════════════════════════════════════════════════════════════════ */
const PORT = parseInt(process.env.PORT ?? '3000', 10);

L.info('ltijs: deploy(serverless)…');

Provider.deploy({ serverless: true })
  .then(() => {
    L.ok('ltijs: déployé en mode serverless');

    const app = express();

    /* Log toutes les requêtes entrantes */
    app.use((req, _res, next) => {
      console.log(`[${new Date().toISOString()}] → ${req.method} ${req.originalUrl}`);
      next();
    });

    /* /api/* → notre routeur (avant ltijs) */
    app.use('/api', api);

    /* Tout le reste → ltijs */
    app.use(Provider.app);

    app.listen(PORT, () => {
      L.ok('=== SERVEUR DÉMARRÉ ===');
      L.ok(`URL locale   : http://localhost:${PORT}`);
      L.ok(`Health check : http://localhost:${PORT}/api/health`);
      L.ok(`LTI endpoint : http://localhost:${PORT}/lti`);
    });
  })
  .catch(err => {
    L.error('Échec du démarrage:', err.message, err.stack);
    process.exit(1);
  });
