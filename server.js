require('dotenv').config(); // Charge les variables du fichier .env

// server.js - Backend Express avec PostgreSQL
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const helmet = require('helmet');
const fs = require('fs');
const path = require('path');
const app = express();

// ========== CONFIGURATION ==========
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

const allowedOrigins = [
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'https://crabde-site.netlify.app',
  'https://crabde.pages.dev',
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

// ========== CHARGEMENT DES LISTES DE VALIDATION ==========
let associationsValides = [];
let formationsValides = [];
let colocsValides = [];
let partisValides = [];

try {
  // Chargement des associations
  const assosData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'assos.json'), 'utf8'));
  associationsValides = assosData.associations ? assosData.associations.map(a => a.nom) : [];
  
  // Chargement des formations
  const formationsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'formations.json'), 'utf8'));
  formationsValides = formationsData.formations ? formationsData.formations : [];
  
  // Chargement des colocs
  const colocsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'colocs.json'), 'utf8'));
  colocsValides = colocsData.colocs ? colocsData.colocs : [];
  
  // Chargement des partis
  const partisData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'partis.json'), 'utf8'));
  partisValides = partisData.partis ? partisData.partis.map(p => p.nom) : [];
  
  console.log('✅ Listes de validation chargées:', {
    associations: associationsValides.length,
    formations: formationsValides.length,
    colocs: colocsValides.length,
    partis: partisValides.length
  });
} catch (err) {
  console.error('⚠️ Erreur chargement listes validation:', err);
  // Fallback sur des listes par défaut
  partisValides = ['Poutou', 'Mélenchon', 'Tondelier', 'Hidalgo', 'Hollande',
    'Valls', 'Macron', 'Sarkozy', 'Ciotti', 'Bardella', 'Zemmour', 'Ruffin', 'Darmanin'];
}

// ========== CONNEXION POSTGRESQL ==========
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
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

  // ✅ VALIDATION DU PARTI
  if (!parti_proche || !partisValides.includes(parti_proche)) {
    console.log('❌ Tentative bloquée - Parti invalide:', parti_proche);
    return res.status(400).json({ 
      success: false, 
      error: 'Parti invalide ou manquant' 
    });
  }

  // ✅ VALIDATION DU SCORE
  if (typeof score !== 'number' || score < 0 || score > 100 || isNaN(score)) {
    console.log('❌ Tentative bloquée - Score invalide:', score);
    return res.status(400).json({ 
      success: false, 
      error: 'Score invalide (doit être entre 0 et 100)' 
    });
  }

  // ✅ VALIDATION DES ASSOCIATIONS
  if (associations) {
    if (!Array.isArray(associations)) {
      console.log('❌ Tentative bloquée - Associations pas un tableau');
      return res.status(400).json({ 
        success: false, 
        error: 'Format associations invalide' 
      });
    }
    
    for (const asso of associations) {
      if (associationsValides.length > 0 && !associationsValides.includes(asso)) {
        console.log('❌ Tentative bloquée - Association invalide:', asso);
        return res.status(400).json({ 
          success: false, 
          error: 'Association invalide détectée' 
        });
      }
    }
  }

  // ✅ VALIDATION DE LA FORMATION
  if (formation && formationsValides.length > 0 && !formationsValides.includes(formation)) {
    console.log('❌ Tentative bloquée - Formation invalide:', formation);
    return res.status(400).json({ 
      success: false, 
      error: 'Formation invalide' 
    });
  }

  // ✅ VALIDATION DE LA COLOC
  if (coloc && colocsValides.length > 0 && !colocsValides.includes(coloc)) {
    console.log('❌ Tentative bloquée - Coloc invalide:', coloc);
    return res.status(400).json({ 
      success: false, 
      error: 'Coloc invalide' 
    });
  }

  try {
    const query = `
      INSERT INTO resultats (score, parti_proche, associations, formation, coloc)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `;
    const values = [score, parti_proche, JSON.stringify(associations), formation, coloc];
    
    const result = await pool.query(query, values);
    console.log('✅ Résultat enregistré - ID:', result.rows[0].id);
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error('❌ Erreur serveur:', err);
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

    // Distribution
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

    const lastDate = row.last_spin_date.toISOString().split('T')[0];
    
    if (lastDate !== today) {
      return res.json({ canSpin: true, nextSpinDate: null });
    }

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

    if (row) {
      const lastDate = row.last_spin_date.toISOString().split('T')[0];
      if (lastDate === today) {
        return res.status(403).json({ error: 'Déjà joué aujourd\'hui' });
      }
    }

    const hasWon = Math.floor(Math.random() * 50) === 0;
    const winInc = hasWon ? 1 : 0;

    if (!row) {
      await pool.query(
        'INSERT INTO roue_tentatives (user_identifier, last_spin_date, total_spins, total_wins) VALUES ($1, $2, 1, $3)',
        [userIdentifier, today, winInc]
      );
    } else {
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