'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const path    = require('path');
const express = require('express');
const { Provider } = require('ltijs');

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
   3.  API REST
════════════════════════════════════════════════════════════════ */
const api = express.Router();
api.use(express.json());

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
   4.  FRONTEND STATIQUE
════════════════════════════════════════════════════════════════ */
const CLIENT = path.join(__dirname, '../../client');
Provider.app.use(express.static(CLIENT));
Provider.app.get('*', (_req, res) => res.sendFile(path.join(CLIENT, 'index.html')));

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
