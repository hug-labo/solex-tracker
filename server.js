/**
 * ============================================================================
 * SOLEX TRACKING — SERVEUR RELAIS TEMPS RÉEL (NODE.JS + WEBSOCKET + EXPRESS)
 * ============================================================================
 * 
 * Rôles :
 * 1. Sert l'application web compilée (fichiers dans dist/) sur Render
 * 2. Maintient le canal WebSocket temps réel entre le Solex et les stands
 * 3. Aiguille les positions GPS par équipe (multi-équipes)
 * 4. Conserve en mémoire les derniers points et tours
 * 5. Prêt pour le branchement immédiat d'une base de données SQL (PostgreSQL / Supabase)
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const app = express();
const server = createServer(app);

app.use(express.json());

// ============================================================================
// MODÈLE DE DONNÉES & ADAPTATEUR SQL (PRÊT POUR POSTGRESQL / SUPABASE)
// ============================================================================
/**
 * SCHÉMA SQL COMPLET POUR UNE COURSE D'ENDURANCE :
 * 
 * CREATE TABLE IF NOT EXISTS race_teams (
 *   id VARCHAR(50) PRIMARY KEY,
 *   name VARCHAR(100) NOT NULL,
 *   created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
 * );
 * 
 * CREATE TABLE IF NOT EXISTS circuits (
 *   id VARCHAR(50) PRIMARY KEY,
 *   name VARCHAR(150) NOT NULL,
 *   points JSONB NOT NULL,
 *   intermediates JSONB,
 *   pit_entry JSONB,
 *   pit_exit JSONB,
 *   updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
 * );
 * 
 * CREATE TABLE IF NOT EXISTS gps_telemetry (
 *   id BIGSERIAL PRIMARY KEY,
 *   team_id VARCHAR(50) NOT NULL,
 *   latitude DOUBLE PRECISION NOT NULL,
 *   longitude DOUBLE PRECISION NOT NULL,
 *   speed DOUBLE PRECISION,
 *   heading DOUBLE PRECISION,
 *   accuracy DOUBLE PRECISION,
 *   recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
 * );
 * CREATE INDEX IF NOT EXISTS idx_telemetry_team_time ON gps_telemetry (team_id, recorded_at DESC);
 * 
 * CREATE TABLE IF NOT EXISTS race_laps (
 *   id SERIAL PRIMARY KEY,
 *   team_id VARCHAR(50) NOT NULL,
 *   circuit_id VARCHAR(50),
 *   lap_number INT NOT NULL,
 *   total_time_seconds DOUBLE PRECISION NOT NULL,
 *   avg_speed_kmh DOUBLE PRECISION,
 *   intermediate_times JSONB,
 *   driver_name VARCHAR(100),
 *   stint_number INT,
 *   created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
 * );
 * 
 * CREATE TABLE IF NOT EXISTS pit_stops (
 *   id SERIAL PRIMARY KEY,
 *   team_id VARCHAR(50) NOT NULL,
 *   lap_number INT,
 *   driver_name VARCHAR(100),
 *   stint_number INT,
 *   duration_seconds INT NOT NULL,
 *   timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
 * );
 */

class StorageAdapter {
  constructor() {
    // Mémoire tampon (ring buffers) pour chaque équipe
    this.teams = new Map(); // teamId -> { lastTelemetry, telemetryHistory: [], laps: [], pitStops: [] }
    console.log('[StorageAdapter] Initialisé en mode mémoire locale avec structure SQL-ready.');
  }

  getTeam(teamId) {
    if (!this.teams.has(teamId)) {
      this.teams.set(teamId, {
        lastTelemetry: null,
        telemetryHistory: [], // Garde les 500 derniers points GPS
        laps: [],
        pitStops: []
      });
    }
    return this.teams.get(teamId);
  }

  saveTelemetry(packet) {
    const { teamId, lat, lng, speed, heading, accuracy, timestamp } = packet;
    if (!teamId) return;
    const team = this.getTeam(teamId);
    
    const record = {
      teamId,
      lat: Number(lat),
      lng: Number(lng),
      speed: Number(speed || 0),
      heading: heading !== undefined ? Number(heading) : null,
      accuracy: accuracy !== undefined ? Number(accuracy) : null,
      timestamp: timestamp || Date.now()
    };

    team.lastTelemetry = record;
    team.telemetryHistory.push(record);
    if (team.telemetryHistory.length > 500) {
      team.telemetryHistory.shift();
    }

    // NOTE D'EXTENSIBILITÉ SQL :
    // Quand une base PostgreSQL ou Supabase est branchée, exécuter ici :
    // await pool.query('INSERT INTO gps_telemetry (team_id, latitude, longitude, speed, heading, accuracy, recorded_at) VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7/1000))', [...])
    return record;
  }

  saveLap(packet) {
    const { teamId, lap, totalTime, avgSpeed, intermediateTimes, driver, stint } = packet;
    if (!teamId) return;
    const team = this.getTeam(teamId);

    const record = {
      teamId,
      lap: Number(lap),
      totalTime: Number(totalTime),
      avgSpeed: Number(avgSpeed || 0),
      intermediateTimes: intermediateTimes || [],
      driver: driver || 'Pilote inconnu',
      stint: Number(stint || 1),
      timestamp: Date.now()
    };

    team.laps.push(record);

    // NOTE D'EXTENSIBILITÉ SQL :
    // await pool.query('INSERT INTO race_laps (team_id, lap_number, total_time_seconds, avg_speed_kmh, intermediate_times, driver_name, stint_number) VALUES ($1,$2,$3,$4,$5,$6,$7)', [...])
    return record;
  }

  savePitStop(packet) {
    const { teamId, lap, driver, stint, duration } = packet;
    if (!teamId) return;
    const team = this.getTeam(teamId);

    const record = {
      teamId,
      lap: Number(lap || 0),
      driver: driver || 'Pilote',
      stint: Number(stint || 1),
      duration: Number(duration || 0),
      timestamp: Date.now()
    };

    team.pitStops.push(record);

    // NOTE D'EXTENSIBILITÉ SQL :
    // await pool.query('INSERT INTO pit_stops (team_id, lap_number, driver_name, stint_number, duration_seconds) VALUES ($1,$2,$3,$4,$5)', [...])
    return record;
  }

  getSnapshot(teamId) {
    const team = this.getTeam(teamId);
    return {
      teamId,
      lastTelemetry: team.lastTelemetry,
      recentPointsCount: team.telemetryHistory.length,
      laps: team.laps,
      pitStops: team.pitStops
    };
  }
}

const db = new StorageAdapter();

// ============================================================================
// ROUTES API REST
// ============================================================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    connectedClients: wss.clients.size
  });
});

// Récupération de l'état actuel d'une équipe
app.get('/api/teams/:teamId/state', (req, res) => {
  const { teamId } = req.params;
  res.json(db.getSnapshot(teamId));
});

// Schéma SQL téléchargeable pour préparer la base de données
app.get('/api/schema.sql', (req, res) => {
  res.type('text/plain').send(`-- Schéma SQL pour base de données de télémétrie Solex Tracking
CREATE TABLE IF NOT EXISTS race_teams (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS circuits (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  points JSONB NOT NULL,
  intermediates JSONB,
  pit_entry JSONB,
  pit_exit JSONB,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gps_telemetry (
  id BIGSERIAL PRIMARY KEY,
  team_id VARCHAR(50) NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  speed DOUBLE PRECISION,
  heading DOUBLE PRECISION,
  accuracy DOUBLE PRECISION,
  recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_telemetry_team_time ON gps_telemetry (team_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS race_laps (
  id SERIAL PRIMARY KEY,
  team_id VARCHAR(50) NOT NULL,
  circuit_id VARCHAR(50),
  lap_number INT NOT NULL,
  total_time_seconds DOUBLE PRECISION NOT NULL,
  avg_speed_kmh DOUBLE PRECISION,
  intermediate_times JSONB,
  driver_name VARCHAR(100),
  stint_number INT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pit_stops (
  id SERIAL PRIMARY KEY,
  team_id VARCHAR(50) NOT NULL,
  lap_number INT,
  driver_name VARCHAR(100),
  stint_number INT,
  duration_seconds INT NOT NULL,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
`);
});

// ============================================================================
// GESTION DU WEBSOCKET (RELAIS SOLEX <-> STANDS)
// ============================================================================
const wss = new WebSocketServer({ server });

// Map des clients connectés : ws -> { teamId, role: 'stand'|'solex', isAlive: boolean }
const clients = new Map();

// Ping régulier toutes les 30s pour maintenir les connexions ouvertes (Render & Proxies 4G)
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    const meta = clients.get(ws);
    if (!meta || meta.isAlive === false) {
      clients.delete(ws);
      return ws.terminate();
    }
    meta.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

wss.on('connection', (ws) => {
  clients.set(ws, { teamId: null, role: 'stand', isAlive: true });

  ws.on('pong', () => {
    const meta = clients.get(ws);
    if (meta) meta.isAlive = true;
  });

  ws.on('message', (rawData) => {
    try {
      const data = JSON.parse(rawData.toString());
      const meta = clients.get(ws);
      if (!meta) return;

      // 1. ENREGISTREMENT DU CLIENT (Stand ou Solex + ID Équipe)
      if (data.type === 'register') {
        meta.teamId = data.teamId || 'equipe-1';
        meta.role = data.role === 'solex' ? 'solex' : 'stand';
        console.log(`[WebSocket] Client enregistré : role=${meta.role}, teamId=${meta.teamId}`);

        // Renvoyer confirmation et dernier état connu au Stand
        if (meta.role === 'stand') {
          const snapshot = db.getSnapshot(meta.teamId);
          ws.send(JSON.stringify({
            type: 'init_state',
            teamId: meta.teamId,
            snapshot
          }));
        }
        return;
      }

      // 2. RÉCEPTION TÉLÉMÉTRIE GPS DEPUIS LE SOLEX
      if (data.type === 'telemetry') {
        const teamId = data.teamId || meta.teamId || 'equipe-1';
        meta.teamId = teamId;
        meta.role = 'solex';

        // Sauvegarde dans l'adaptateur de données
        const saved = db.saveTelemetry(data);

        // Retransmission immédiate à tous les stands abonnés à cette équipe
        const payload = JSON.stringify({
          type: 'telemetry',
          ...saved
        });

        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            const clientMeta = clients.get(client);
            if (clientMeta && clientMeta.role === 'stand' && clientMeta.teamId === teamId) {
              client.send(payload);
            }
          }
        });
        return;
      }

      // 3. RÉCEPTION TOUR BOUCLÉ DEPUIS LES STANDS
      if (data.type === 'lap_completed') {
        const teamId = data.teamId || meta.teamId || 'equipe-1';
        const savedLap = db.saveLap(data);
        
        // Broadcast aux autres stands
        const payload = JSON.stringify({ type: 'lap_completed', ...savedLap });
        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            const clientMeta = clients.get(client);
            if (clientMeta && clientMeta.teamId === teamId) {
              client.send(payload);
            }
          }
        });
        return;
      }

      // 4. RÉCEPTION ARRÊT AUX STANDS
      if (data.type === 'pit_stop') {
        const teamId = data.teamId || meta.teamId || 'equipe-1';
        const savedPit = db.savePitStop(data);
        
        const payload = JSON.stringify({ type: 'pit_stop', ...savedPit });
        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            const clientMeta = clients.get(client);
            if (clientMeta && clientMeta.teamId === teamId) {
              client.send(payload);
            }
          }
        });
        return;
      }

    } catch (err) {
      console.error('[WebSocket] Erreur traitement message :', err);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
  });
});

// ============================================================================
// FICHIERS STATIQUES (APPLICATION WEB VITE BUILD)
// ============================================================================
const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));

// Pour toute route non-API, renvoyer index.html (SPA)
app.use((req, res) => {
  res.sendFile(path.join(distPath, 'index.html'), (err) => {
    if (err) {
      res.status(200).send(`
        <html>
          <body style="font-family:sans-serif;padding:30px;background:#0f172a;color:#f8fafc;text-align:center;">
            <h1>🏁 Solex Tracking — Serveur Relais Actif</h1>
            <p>Le serveur WebSocket et API fonctionne parfaitement sur le port ${PORT}.</p>
            <p>Statut : <span style="color:#22c55e;">Opérationnel</span> | Clients connectés : ${wss.clients.size}</p>
            <p>Pour voir l'application complète, assurez-vous d'avoir exécuté <code>npm run build</code>.</p>
          </body>
        </html>
      `);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[Solex Tracking] Serveur démarré avec succès sur le port ${PORT}`);
  console.log(`[Solex Tracking] Prêt pour les connexions WebSocket et HTTP`);
});
