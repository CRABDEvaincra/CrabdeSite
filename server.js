// server.js - Backend Express avec SQLite
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const helmet = require('helmet');
const app = express();

// ========== SÉCURITÉ : Headers de protection ==========
app.use(helmet({
  contentSecurityPolicy: false, // Désactiver pour permettre les ressources externes
  crossOriginEmbedderPolicy: false
}));

// ========== SÉCURITÉ : CORS restreint ==========
const allowedOrigins = [
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:8000',
  'https://crabde-site.netlify.app',

];

const corsOptions = {
  origin: function (origin, callback) {
    // Autoriser les requêtes sans origin (comme Postman) en développement
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Non autorisé par CORS'));
    }
  },
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// Middleware
app.use(express.json({ limit: '1mb' })); // Limiter la taille des requêtes

// Middleware de validation
function validateScore(req, res, next) {
  const { score, parti_proche, associations, formation, coloc } = req.body;
  
  // Validation du score
  if (score === undefined || score === null) {
    return res.status(400).json({ error: 'Score manquant' });
  }
  
  if (typeof score !== 'number' || isNaN(score)) {
    return res.status(400).json({ error: 'Score invalide (doit être un nombre)' });
  }
  
  if (score < 0 || score > 100) {
    return res.status(400).json({ error: 'Score hors limites (0-100)' });
  }
  
  // Validation du parti
  if (parti_proche && typeof parti_proche !== 'string') {
    return res.status(400).json({ error: 'Parti invalide' });
  }
  
  if (parti_proche && parti_proche.length > 100) {
    return res.status(400).json({ error: 'Nom de parti trop long' });
  }
  
  // ========== SÉCURITÉ : Validation des autres champs ==========
  if (formation && typeof formation !== 'string') {
    return res.status(400).json({ error: 'Formation invalide' });
  }
  
  if (formation && formation.length > 200) {
    return res.status(400).json({ error: 'Formation trop longue' });
  }
  
  if (coloc && typeof coloc !== 'string') {
    return res.status(400).json({ error: 'Coloc invalide' });
  }
  
  if (coloc && coloc.length > 200) {
    return res.status(400).json({ error: 'Coloc trop longue' });
  }
  
  // Validation des associations (doit être un array)
  if (associations && !Array.isArray(associations)) {
    return res.status(400).json({ error: 'Associations invalides' });
  }
  
  if (associations && associations.length > 50) {
    return res.status(400).json({ error: 'Trop d\'associations' });
  }
  
  next();
}

// Rate limiting simple (sans bibliothèque externe)
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS = 5; // ⚠️ RÉDUIT de 10 à 5 pour plus de sécurité

function rateLimiter(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!requestCounts.has(ip)) {
    requestCounts.set(ip, []);
  }
  
  const requests = requestCounts.get(ip).filter(time => now - time < RATE_LIMIT_WINDOW);
  
  if (requests.length >= MAX_REQUESTS) {
    return res.status(429).json({ 
      error: 'Trop de requêtes. Veuillez patienter.' 
    });
  }
  
  requests.push(now);
  requestCounts.set(ip, requests);
  
  next();
}

// Nettoyage périodique de la map de rate limiting
setInterval(() => {
  const now = Date.now();
  for (const [ip, requests] of requestCounts.entries()) {
    const validRequests = requests.filter(time => now - time < RATE_LIMIT_WINDOW);
    if (validRequests.length === 0) {
      requestCounts.delete(ip);
    } else {
      requestCounts.set(ip, validRequests);
    }
  }
}, RATE_LIMIT_WINDOW);

// Connexion à la base de données SQLite
const db = new sqlite3.Database('./crabde_stats.db', (err) => {
  if (err) {
    console.error('Erreur connexion DB:', err);
  } else {
    console.log('✅ Connecté à la base de données');
    initDatabase();
  }
});

// Création de la table si elle n'existe pas
function initDatabase() {
  db.run(`
    CREATE TABLE IF NOT EXISTS resultats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      score REAL NOT NULL,
      parti_proche TEXT,
      associations TEXT,
      formation TEXT,
      coloc TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) {
      console.error('Erreur création table:', err);
    } else {
      console.log('✅ Table "resultats" prête');
    }
  });
}

// Route POST : Enregistrer un résultat
app.post('/api/resultats', rateLimiter, validateScore, (req, res) => {
  const { score, parti_proche, associations, formation, coloc } = req.body;

  const query = `
    INSERT INTO resultats (score, parti_proche, associations, formation, coloc)
    VALUES (?, ?, ?, ?, ?)
  `;

  db.run(query, [score, parti_proche, JSON.stringify(associations), formation, coloc], function(err) {
    if (err) {
      console.error('Erreur insertion:', err);
      return res.status(500).json({ error: 'Erreur serveur' });
    }
    
    res.json({ 
      success: true, 
      id: this.lastID,
      message: 'Résultat enregistré avec succès' 
    });
  });
});

// Route GET : Récupérer les statistiques (avec rate limiting)
app.get('/api/stats', rateLimiter, (req, res) => {
  const queries = {
    total: 'SELECT COUNT(*) as count FROM resultats',
    moyenne: 'SELECT AVG(score) as moyenne FROM resultats',
    distribution: `
      SELECT 
        CASE 
          WHEN score < 20 THEN '0-20'
          WHEN score < 40 THEN '20-40'
          WHEN score < 60 THEN '40-60'
          WHEN score < 80 THEN '60-80'
          ELSE '80-100'
        END as tranche,
        COUNT(*) as count
      FROM resultats
      GROUP BY tranche
      ORDER BY tranche
    `,
    partis: `
      SELECT parti_proche, COUNT(*) as count
      FROM resultats
      WHERE parti_proche IS NOT NULL
      GROUP BY parti_proche
      ORDER BY count DESC
    `,
    recent: `
      SELECT score, parti_proche, timestamp
      FROM resultats
      ORDER BY timestamp DESC
      LIMIT 10
    `
  };

  const stats = {};

  // Exécution de toutes les requêtes
  Promise.all([
    new Promise((resolve) => {
      db.get(queries.total, (err, row) => {
        stats.total = row ? row.count : 0;
        resolve();
      });
    }),
    new Promise((resolve) => {
      db.get(queries.moyenne, (err, row) => {
        stats.moyenne = row ? row.moyenne : 0;
        resolve();
      });
    }),
    new Promise((resolve) => {
      db.all(queries.distribution, (err, rows) => {
        stats.distribution = rows || [];
        resolve();
      });
    }),
    new Promise((resolve) => {
      db.all(queries.partis, (err, rows) => {
        stats.partis = rows || [];
        resolve();
      });
    }),
    new Promise((resolve) => {
      db.all(queries.recent, (err, rows) => {
        stats.recent = rows || [];
        resolve();
      });
    })
  ]).then(() => {
    res.json(stats);
  });
});

// Route GET : Tous les résultats (pour export CSV) - PROTÉGÉ
app.get('/api/resultats/export', rateLimiter, (req, res) => {
  // ========== SÉCURITÉ : Authentification basique (optionnel) ==========
  // Pour activer : décommenter et définir un mot de passe
  // const authHeader = req.headers.authorization;
  // if (authHeader !== 'Bearer VOTRE_MOT_DE_PASSE_SECRET') {
  //   return res.status(401).json({ error: 'Non autorisé' });
  // }
  
  db.all('SELECT * FROM resultats ORDER BY timestamp DESC LIMIT 1000', (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Erreur serveur' });
    }
    res.json(rows);
  });
});

// Démarrage du serveur
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`);
  console.log(`📊 Stats disponibles sur http://localhost:${PORT}/api/stats`);
  console.log(`🛡️ Sécurité activée : Helmet + CORS + Rate Limiting`);
});

// Fermeture propre de la DB
process.on('SIGINT', () => {
  db.close((err) => {
    if (err) {
      console.error(err.message);
    }
    console.log('Base de données fermée');
    process.exit(0);
  });
});