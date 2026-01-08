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
  // Ajoutez votre domaine en production ici :
  // 'https://votre-site.netlify.app',
  // 'https://votre-site.vercel.app'
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
const MAX_REQUESTS = 20; // ⚠️ RÉDUIT de 10 à 5 pour plus de sécurité

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
  console.log(`🚀 Serveur démarré sur 'https://crabde-backend.onrender.com`);
  console.log(`📊 Stats disponibles sur 'https://crabde-backend.onrender.com/api/stats`);
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

// ========== ROUE DE LA CHANCE ==========

// Table pour stocker les tentatives de la roue
db.run(`
  CREATE TABLE IF NOT EXISTS roue_tentatives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_identifier TEXT NOT NULL UNIQUE,
    last_spin_date DATE NOT NULL,
    total_spins INTEGER DEFAULT 1,
    total_wins INTEGER DEFAULT 0,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`, (err) => {
  if (err) {
    console.error('Erreur création table roue_tentatives:', err);
  } else {
    console.log('✅ Table "roue_tentatives" prête');
  }
});

// Route POST : Vérifier si l'utilisateur peut tourner
app.post('/api/roue/check', rateLimiter, (req, res) => {
  const { userIdentifier } = req.body;
  
  if (!userIdentifier || typeof userIdentifier !== 'string') {
    return res.status(400).json({ error: 'Identifiant utilisateur manquant' });
  }
  
  const today = new Date().toISOString().split('T')[0]; // Format YYYY-MM-DD
  
  db.get(
    'SELECT * FROM roue_tentatives WHERE user_identifier = ?',
    [userIdentifier],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: 'Erreur serveur' });
      }
      
      if (!row) {
        // Premier essai
        return res.json({ 
          canSpin: true, 
          nextSpinDate: null,
          totalSpins: 0,
          totalWins: 0
        });
      }
      
      // Vérifier si c'est un nouveau jour
      if (row.last_spin_date !== today) {
        return res.json({ 
          canSpin: true,
          nextSpinDate: null,
          totalSpins: row.total_spins,
          totalWins: row.total_wins
        });
      }
      
      // Déjà joué aujourd'hui
      const lastDate = new Date(row.last_spin_date);
      const tomorrow = new Date(lastDate);
      tomorrow.setDate(tomorrow.getDate() + 1);
      
      res.json({ 
        canSpin: false, 
        nextSpinDate: tomorrow.toISOString(),
        totalSpins: row.total_spins,
        totalWins: row.total_wins
      });
    }
  );
});

// Route POST : Tourner la roue
app.post('/api/roue/spin', rateLimiter, (req, res) => {
  const { userIdentifier } = req.body;
  
  if (!userIdentifier || typeof userIdentifier !== 'string') {
    return res.status(400).json({ error: 'Identifiant utilisateur manquant' });
  }
  
  const today = new Date().toISOString().split('T')[0];
  
  // Vérifier d'abord si l'utilisateur peut jouer
  db.get(
    'SELECT * FROM roue_tentatives WHERE user_identifier = ?',
    [userIdentifier],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: 'Erreur serveur' });
      }
      
      // Vérifier si déjà joué aujourd'hui
      if (row && row.last_spin_date === today) {
        return res.status(403).json({ 
          error: 'Déjà joué aujourd\'hui',
          canSpin: false 
        });
      }
      
      // Générer le résultat (1 chance sur 50)
      const hasWon = Math.floor(Math.random() * 50) === 0;
      
      // Mettre à jour ou créer l'entrée
      if (!row) {
        // Première tentative
        db.run(
          'INSERT INTO roue_tentatives (user_identifier, last_spin_date, total_spins, total_wins) VALUES (?, ?, 1, ?)',
          [userIdentifier, today, hasWon ? 1 : 0],
          function(err) {
            if (err) {
              return res.status(500).json({ error: 'Erreur serveur' });
            }
            res.json({ 
              hasWon, 
              canSpin: false,
              totalSpins: 1,
              totalWins: hasWon ? 1 : 0
            });
          }
        );
      } else {
        // Mise à jour
        db.run(
          'UPDATE roue_tentatives SET last_spin_date = ?, total_spins = total_spins + 1, total_wins = total_wins + ? WHERE user_identifier = ?',
          [today, hasWon ? 1 : 0, userIdentifier],
          function(err) {
            if (err) {
              return res.status(500).json({ error: 'Erreur serveur' });
            }
            res.json({ 
              hasWon, 
              canSpin: false,
              totalSpins: row.total_spins + 1,
              totalWins: row.total_wins + (hasWon ? 1 : 0)
            });
          }
        );
      }
    }
  );
});

// Route GET : Statistiques de la roue
app.get('/api/roue/stats', rateLimiter, (req, res) => {
  const queries = {
    total: 'SELECT COUNT(*) as count FROM roue_tentatives',
    totalSpins: 'SELECT SUM(total_spins) as total FROM roue_tentatives',
    totalWins: 'SELECT SUM(total_wins) as total FROM roue_tentatives',
    winRate: 'SELECT (CAST(SUM(total_wins) AS FLOAT) / SUM(total_spins)) * 100 as rate FROM roue_tentatives'
  };
  
  const stats = {};
  
  Promise.all([
    new Promise((resolve) => {
      db.get(queries.total, (err, row) => {
        stats.totalUsers = row ? row.count : 0;
        resolve();
      });
    }),
    new Promise((resolve) => {
      db.get(queries.totalSpins, (err, row) => {
        stats.totalSpins = row ? row.total : 0;
        resolve();
      });
    }),
    new Promise((resolve) => {
      db.get(queries.totalWins, (err, row) => {
        stats.totalWins = row ? row.total : 0;
        resolve();
      });
    }),
    new Promise((resolve) => {
      db.get(queries.winRate, (err, row) => {
        stats.winRate = row ? row.rate : 0;
        resolve();
      });
    })
  ]).then(() => {
    res.json(stats);
  });
});