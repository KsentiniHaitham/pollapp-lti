'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const path    = require('path');
const express = require('express');
const { Provider } = require('ltijs');

/* ════════════════════════════════════════════════════════════════
   1.  LTIJS — configuration
   Ltijs gère automatiquement :
     - La réception du launch Moodle (POST /lti)
     - La validation du JWT signé par Moodle (OIDC / LTI 1.3)
     - Le cookie de session (ltik)
     - Le stockage des clés dans MongoDB
════════════════════════════════════════════════════════════════ */
Provider.setup(
  process.env.LTI_KEY,          // clé de chiffrement des cookies (min. 32 chars)
  { url: process.env.MONGODB_URI },
  {
    cookies: {
      // En production sur HTTPS : secure=true, sameSite='None' (requis pour iframe Moodle)
      secure:   process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'None' : 'Lax',
    },
    devMode:     process.env.NODE_ENV !== 'production',
    tokenMaxAge: false,           // pas d'expiration automatique du token
  }
);

/* ════════════════════════════════════════════════════════════════
   2.  CALLBACK après un launch LTI réussi
   Ltijs valide le JWT et appelle cette fonction.
   On redirige simplement vers le frontend — le cookie ltik
   est déjà posé par ltijs.
════════════════════════════════════════════════════════════════ */
Provider.onConnect(async (_token, _req, res) => {
  return res.redirect('/');
});

/* ════════════════════════════════════════════════════════════════
   3.  API REST
════════════════════════════════════════════════════════════════ */
const api = express.Router();
api.use(express.json());

/* ── GET /api/user ─────────────────────────────────────────────
   Retourne les infos de l'utilisateur LTI courant.
   Nécessite le cookie ltik (posé après un launch Moodle).
   Retourne 401 si aucune session LTI active → mode standalone.
────────────────────────────────────────────────────────────── */
api.get('/user', Provider.protect(), (req, res) => {
  try {
    const token = res.locals.token;
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

    return res.json({
      id:         token.user,
      name,
      email:      token.userInfo?.email            ?? '',
      role:       isInstructor ? 'instructor' : 'learner',
      courseId:   token.platformContext?.context?.id    ?? null,
      courseName: token.platformContext?.context?.title ?? 'Cours',
    });
  } catch (err) {
    console.error('[/api/user]', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* ── POST /api/platform ────────────────────────────────────────
   Enregistre une plateforme Moodle dans ltijs.
   À appeler UNE SEULE FOIS lors de la configuration initiale.
   Protégé par x-admin-key.

   Body JSON :
   {
     "url":      "https://moodle.monecole.fr",
     "clientId": "CLIENT_ID_COPIE_DEPUIS_MOODLE",
     "name":     "Moodle École de Commerce"   (optionnel)
   }
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
    console.log(`[Platform registered] ${url} — clientId: ${clientId}`);
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
   Vérification de vie (Railway, Moodle...).
────────────────────────────────────────────────────────────── */
api.get('/health', (_req, res) => res.json({ status: 'ok' }));

Provider.app.use('/api', api);

/* ════════════════════════════════════════════════════════════════
   4.  FRONTEND STATIQUE
   Express sert les fichiers du dossier client/.
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
    console.log('║                                      ║');
    console.log('║  Pour enregistrer Moodle :           ║');
    console.log('║  POST /api/platform                  ║');
    console.log('║  Header: x-admin-key: <ADMIN_KEY>    ║');
    console.log('╚══════════════════════════════════════╝');
    console.log('');
  })
  .catch(err => {
    console.error('❌ Erreur au démarrage :', err);
    process.exit(1);
  });
