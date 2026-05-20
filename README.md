# PollApp LTI — Guide de déploiement complet

Application de sondages interactifs type Wooclap, intégrée à Moodle via **LTI 1.3** avec **SSO** automatique.

---

## Architecture

```
Moodle ──LTI 1.3──► Railway (Node.js + ltijs) ──► Firebase (temps réel)
                           │                              │
                    Cookie de session              Stockage events
                    (OIDC validé)                  Questions/Réponses
```

---

## Étape 1 — Firebase (base de données temps réel)

1. Va sur **https://console.firebase.google.com**
2. **Créer un projet** → nom : `pollapp-ecole`
3. Dans le menu gauche : **Realtime Database** → Créer une base de données
   - Choisir la région **Europe (europe-west1)**
   - Démarrer en **mode test** (règles ouvertes)
4. Dans **Règles**, coller :
   ```json
   {
     "rules": {
       ".read": true,
       ".write": true
     }
   }
   ```
5. Aller dans **Paramètres du projet** (⚙️) → **Vos applications** → Ajouter une app **Web**
6. Copier la `firebaseConfig` et la coller dans `client/index.html` (champ `FIREBASE_CONFIG`)

---

## Étape 2 — MongoDB Atlas (stockage des clés LTI)

1. Va sur **https://cloud.mongodb.com**
2. **Sign up** gratuit → Créer un cluster **Free (M0)**
3. **Database Access** → Ajouter un utilisateur (login + mot de passe)
4. **Network Access** → Ajouter `0.0.0.0/0` (accès depuis Railway)
5. **Connect** → Driver → copier l'URL :
   ```
   mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/pollapp
   ```

---

## Étape 3 — Déploiement sur Railway

1. Créer un compte sur **https://railway.app** (gratuit, 500h/mois)
2. **New Project** → **Deploy from GitHub repo**
3. Connecter ce repo GitHub (pousser le code d'abord)
4. Dans **Variables** (onglet de ton service), ajouter :

   | Variable | Valeur |
   |----------|--------|
   | `NODE_ENV` | `production` |
   | `LTI_KEY` | Chaîne aléatoire 32 chars ([générer ici](https://1password.com/password-generator/)) |
   | `MONGODB_URI` | URL MongoDB Atlas |
   | `ADMIN_KEY` | Clé secrète de ton choix |

5. Railway détecte `railway.toml` et démarre automatiquement.
6. Copier l'URL publique de ton service (ex: `https://pollapp-xxx.railway.app`)

---

## Étape 4 — Configurer Moodle (côté admin)

### 4a. Activer LTI 1.3 dans Moodle

1. **Administration du site** → **Plugins** → **Activités** → **External Tool**
2. **Manage tools** → **Configure a tool manually**

### 4b. Enregistrer PollApp comme outil externe

Remplir le formulaire avec :

| Champ | Valeur |
|-------|--------|
| **Tool name** | PollApp |
| **Tool URL** | `https://pollapp-xxx.railway.app/lti` |
| **LTI version** | LTI 1.3 |
| **Public key type** | Keyset URL |
| **Public keyset** | `https://pollapp-xxx.railway.app/lti/keys` |
| **Initiate login URL** | `https://pollapp-xxx.railway.app/lti/login` |
| **Redirection URI** | `https://pollapp-xxx.railway.app/lti` |
| **Default launch container** | New window OU Embed |
| **Supports Deep Linking** | Non |

3. Sauvegarder → Moodle génère un **Client ID**

### 4c. Enregistrer Moodle dans PollApp

Faire une requête POST (avec Postman, Insomnia, ou `curl`) :

```bash
curl -X POST https://pollapp-xxx.railway.app/api/platform \
  -H "Content-Type: application/json" \
  -H "x-admin-key: VOTRE_ADMIN_KEY" \
  -d '{
    "url":      "https://moodle.tonecole.fr",
    "clientId": "CLIENT_ID_COPIE_DEPUIS_MOODLE",
    "name":     "Moodle École de Commerce"
  }'
```

Réponse attendue : `{ "success": true }`

---

## Étape 5 — Ajouter PollApp dans un cours Moodle

1. Dans un cours → **Activer le mode édition**
2. **Ajouter une activité** → **External Tool**
3. Sélectionner **PollApp** dans la liste
4. Sauvegarder

**L'enseignant** clique → vue présentateur automatique  
**Les étudiants** cliquent → vue participant automatique, identifiés par leur compte Moodle

---

## Flux SSO complet

```
Étudiant clique sur l'activité Moodle
        │
        ▼
Moodle envoie un JWT signé (LTI 1.3)
        │
        ▼
ltijs valide le JWT (signature + claims)
        │
        ▼
Serveur extrait : nom, email, rôle, courseId
        │
        ▼
Redirect vers / avec cookie de session
        │
        ▼
Frontend détecte le rôle :
  ├─ instructor → Vue présentateur du cours
  └─ learner    → Attend le sondage actif du cours
```

---

## Structure du projet

```
pollapp-lti/
├── server/
│   ├── src/
│   │   └── server.js      ← Express + ltijs
│   ├── package.json
│   └── .env.example       ← Copier en .env
├── client/
│   └── index.html         ← React + Firebase + LTI
├── railway.toml            ← Config déploiement
└── README.md
```

---

## Questions fréquentes

**Le LTI ne fonctionne pas en HTTP local**  
LTI 1.3 exige HTTPS en production. En développement, utiliser `devMode: true` (déjà configuré quand `NODE_ENV=development`).

**Erreur "Platform not found"**  
L'étape 4c (enregistrement Moodle dans PollApp) n'a pas été effectuée ou le `clientId` est incorrect.

**Les étudiants voient "En attente du professeur"**  
Normal — l'enseignant doit d'abord créer un sondage depuis son accès Moodle.
