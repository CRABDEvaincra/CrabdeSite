// server.js - Backend Express avec PostgreSQL
const express = require('express');
const { Pool } = require('pg'); // On utilise 'pg' au lieu de 'sqlite3'
const cors = require('cors');
const helmet = require('helmet');
const app = express();

// ========== CONFIGURATION ==========
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

const allowedOrigins = [
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'https://crabde-site.netlify.app', // Mettez l'URL de votre frontend Netlify
  'https://votre-site.netlify.app'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Non autorisé par CORS'));
    }
  }
}));

app.use(express.json({ limit: '1mb' }));

// ========== CONNEXION POSTGRESQL ==========
// Render fournit l'URL via process.env.DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Nécessaire pour Render
  }
});

// Initialisation des tables
async function initDatabase() {
  try {
    // Table Resultats
    await pool.query(`
      CREATE TABLE IF NOT EXISTS resultats (
        id SERIAL PRIMARY KEY,
        score REAL NOT NULL,
        parti_proche TEXT,
        associations TEXT,
        formation TEXT,
        coloc TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Table Roue
    await pool.query(`
      CREATE TABLE IF NOT EXISTS roue_tentatives (
        id SERIAL PRIMARY KEY,
        user_identifier TEXT NOT NULL UNIQUE,
        last_spin_date DATE NOT NULL,
        total_spins INTEGER DEFAULT 1,
        total_wins INTEGER DEFAULT 0,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Tables PostgreSQL vérifiées/créées');
  } catch (err) {
    console.error('❌ Erreur initialisation DB:', err);
  }
}

initDatabase();

// ========== ROUTES ==========

// 1. Enregistrer un résultat
app.post('/api/resultats', async (req, res) => {
  const { score, parti_proche, associations, formation, coloc } = req.body;

  try {
    const query = `
      INSERT INTO resultats (score, parti_proche, associations, formation, coloc)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `;
    const values = [score, parti_proche, JSON.stringify(associations), formation, coloc];
    
    const result = await pool.query(query, values);
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// 2. Récupérer les stats
app.get('/api/stats', async (req, res) => {
  try {
    const stats = {};

    // Total & Moyenne
    const basicStats = await pool.query('SELECT COUNT(*) as count, AVG(score) as moyenne FROM resultats');
    stats.total = parseInt(basicStats.rows[0].count);
    stats.moyenne = parseFloat(basicStats.rows[0].moyenne) || 0;

    // Distribution (Syntaxe PostgreSQL CASE)
    const distQuery = `
      SELECT 
        CASE 
          WHEN score < 10 THEN '00-10'
          WHEN score < 20 THEN '10-20'
          WHEN score < 30 THEN '20-30'
          WHEN score < 40 THEN '30-40'
          WHEN score < 50 THEN '40-50'
          WHEN score < 60 THEN '50-60'
          WHEN score < 70 THEN '60-70'
          WHEN score < 80 THEN '70-80'
          WHEN score < 90 THEN '80-90'
          ELSE '90-100'
        END as tranche,
        COUNT(*) as count
      FROM resultats
      GROUP BY tranche
      ORDER BY tranche
    `;
    const distRes = await pool.query(distQuery);
    stats.distribution = distRes.rows;

    // Partis
    const partisRes = await pool.query(`
      SELECT parti_proche, COUNT(*) as count
      FROM resultats
      WHERE parti_proche IS NOT NULL
      GROUP BY parti_proche
      ORDER BY count DESC
    `);
    stats.partis = partisRes.rows;

    // Récents
    const recentRes = await pool.query(`
      SELECT score, parti_proche, timestamp
      FROM resultats
      ORDER BY timestamp DESC
      LIMIT 10
    `);
    stats.recent = recentRes.rows;

    res.json(stats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur récupération stats' });
  }
});

// 3. Route Roue : Check
app.post('/api/roue/check', async (req, res) => {
  const { userIdentifier } = req.body;
  const today = new Date().toISOString().split('T')[0];

  try {
    const resDb = await pool.query('SELECT * FROM roue_tentatives WHERE user_identifier = $1', [userIdentifier]);
    const row = resDb.rows[0];

    if (!row) {
      return res.json({ canSpin: true, nextSpinDate: null });
    }

    // Comparaison des dates (Postgres renvoie un objet Date)
    const lastDate = row.last_spin_date.toISOString().split('T')[0];
    
    if (lastDate !== today) {
      return res.json({ canSpin: true, nextSpinDate: null });
    }

    // Calcul date demain
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    res.json({ canSpin: false, nextSpinDate: tomorrow.toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// 4. Route Roue : Spin
app.post('/api/roue/spin', async (req, res) => {
  const { userIdentifier } = req.body;
  const today = new Date().toISOString().split('T')[0];

  try {
    const resDb = await pool.query('SELECT * FROM roue_tentatives WHERE user_identifier = $1', [userIdentifier]);
    const row = resDb.rows[0];

    // Vérification date si l'utilisateur existe
    if (row) {
      const lastDate = row.last_spin_date.toISOString().split('T')[0];
      if (lastDate === today) {
        return res.status(403).json({ error: 'Déjà joué aujourd\'hui' });
      }
    }

    const hasWon = Math.floor(Math.random() * 50) === 0;
    const winInc = hasWon ? 1 : 0;

    if (!row) {
      // Premier insert
      await pool.query(
        'INSERT INTO roue_tentatives (user_identifier, last_spin_date, total_spins, total_wins) VALUES ($1, $2, 1, $3)',
        [userIdentifier, today, winInc]
      );
    } else {
      // Update
      await pool.query(
        'UPDATE roue_tentatives SET last_spin_date = $1, total_spins = total_spins + 1, total_wins = total_wins + $2 WHERE user_identifier = $3',
        [today, winInc, userIdentifier]
      );
    }

    res.json({ hasWon, canSpin: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Démarrage
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
});