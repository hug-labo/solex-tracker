import React, { useState, useEffect, useRef, useMemo } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// ============================================================================
// FIX ICÔNES LEAFLET
// ============================================================================
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

// Icône personnalisée Solex avec rotation de cap si disponible
const createSolexIcon = (heading?: number | null) => {
  const rotation = heading !== undefined && heading !== null ? heading : 0;
  return L.divIcon({
    className: 'custom-solex-marker',
    html: `<div style="background-color:#3b82f6;color:white;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;border:3px solid white;box-shadow:0 0 12px rgba(0,0,0,0.7);transform:translate(-2px,-2px) rotate(${rotation}deg);transition:transform 0.2s;">🛵</div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
};

// Icône pour les balises de secteurs, départ et stands
const createSectorIcon = (label: string, bg: string, distanceM?: number) =>
  L.divIcon({
    className: 'custom-sector-marker',
    html: `<div style="background-color:${bg};color:white;padding:3px 8px;border-radius:6px;font-weight:bold;font-size:11px;border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.5);white-space:nowrap;display:flex;flex-direction:column;align-items:center;line-height:1.2;">
      <span>${label}</span>
      ${distanceM !== undefined ? `<span style="font-size:9px;opacity:0.95;font-weight:normal;">${Math.round(distanceM)}m</span>` : ''}
    </div>`,
    iconSize: [60, 30],
    iconAnchor: [30, 15],
  });

// ============================================================================
// TYPES DE DONNÉES (SQL-READY POUR POSTGRESQL / SUPABASE)
// ============================================================================
export interface IntermediatePoint {
  id: string;
  name: string;
  distance: number; // en mètres depuis la ligne de départ
  latLng: [number, number];
}

export interface LapRecord {
  id?: string;
  teamId?: string;
  lap: number;
  intermediateTimes: (number | null)[];
  totalTime: number;
  avgSpeed: number;
  driver: string;
  stint: number;
  timestamp?: string;
}

export interface PitStopRecord {
  id: string;
  teamId?: string;
  lap: number;
  driver: string;
  stint: number;
  duration: number; // en secondes
  timestamp: string;
}

export interface SavedCircuit {
  id: string;
  name: string;
  points: [number, number][];
  intermediates?: IntermediatePoint[];
  pitPolygon?: [number, number][];
  pitEntryDistance?: number;
  pitExitDistance?: number;
  pitEntryLatLng?: [number, number];
  pitExitLatLng?: [number, number];
}

export interface TelemetryPacket {
  teamId: string;
  lat: number;
  lng: number;
  speed: number;
  heading?: number | null;
  accuracy?: number | null;
  timestamp: number;
}

// Circuits d'exemple par défaut
const DEFAULT_CIRCUITS: SavedCircuit[] = [
  {
    id: 'circuit-mans',
    name: 'Circuit Endurance Le Mans (~2.7 km)',
    points: [
      [47.9500, 0.2000],
      [47.9515, 0.2030],
      [47.9530, 0.2065],
      [47.9535, 0.2110],
      [47.9510, 0.2135],
      [47.9485, 0.2120],
      [47.9465, 0.2080],
      [47.9470, 0.2035],
      [47.9485, 0.2005],
    ],
    intermediates: [
      { id: 's1', name: 'S1', distance: 680, latLng: [47.9525, 0.2050] },
      { id: 's2', name: 'S2', distance: 1360, latLng: [47.9520, 0.2125] },
      { id: 's3', name: 'S3', distance: 2040, latLng: [47.9472, 0.2095] },
    ],
    pitEntryDistance: 2350,
    pitExitDistance: 2650,
    pitEntryLatLng: [47.9478, 0.2015],
    pitExitLatLng: [47.9495, 0.2001],
    pitPolygon: [
      [47.9472, 0.2008],
      [47.9482, 0.2005],
      [47.9492, 0.2012],
      [47.9482, 0.2025],
    ],
  },
  {
    id: 'circuit-nouziers',
    name: 'Circuit Type Nouziers (~3.6 km)',
    points: [
      [46.4250, 1.9400],
      [46.4280, 1.9480],
      [46.4310, 1.9560],
      [46.4270, 1.9600],
      [46.4220, 1.9550],
      [46.4180, 1.9480],
      [46.4200, 1.9410],
    ],
    intermediates: [
      { id: 's1', name: 'S1', distance: 1200, latLng: [46.4295, 1.9520] },
      { id: 's2', name: 'S2', distance: 2400, latLng: [46.4245, 1.9575] },
    ],
    pitEntryDistance: 3100,
    pitExitDistance: 3450,
    pitEntryLatLng: [46.4190, 1.9445],
    pitExitLatLng: [46.4230, 1.9405],
    pitPolygon: [
      [46.4185, 1.9430],
      [46.4200, 1.9422],
      [46.4215, 1.9440],
      [46.4200, 1.9455],
    ],
  },
];

// ============================================================================
// CALCULS GÉODÉSIQUES & PROJECTION SUR TRACÉ
// ============================================================================
function calculateDistanceMeters(p1: [number, number], p2: [number, number]): number {
  return L.latLng(p1[0], p1[1]).distanceTo(L.latLng(p2[0], p2[1]));
}

function projectPointOnTrack(
  clickLatLng: [number, number],
  trackPoints: [number, number][],
  cumDistances: number[]
): { distance: number; latLng: [number, number]; segmentIndex: number; t: number } {
  if (trackPoints.length < 2) {
    return { distance: 0, latLng: trackPoints[0] || clickLatLng, segmentIndex: 0, t: 0 };
  }

  let bestDistToSegment = Infinity;
  let bestTrackDist = 0;
  let bestLatLng: [number, number] = trackPoints[0];
  let bestSegIdx = 0;
  let bestT = 0;

  const cLat = clickLatLng[0];
  const cLng = clickLatLng[1];

  for (let i = 0; i < trackPoints.length; i++) {
    const nextIdx = (i + 1) % trackPoints.length;
    const p1 = trackPoints[i];
    const p2 = trackPoints[nextIdx];

    const segStartDist = cumDistances[i];
    const segLenMeters = calculateDistanceMeters(p1, p2);
    if (segLenMeters <= 0) continue;

    const midLatRad = ((p1[0] + p2[0]) / 2) * (Math.PI / 180);
    const mPerDegLat = 111132;
    const mPerDegLng = 111412 * Math.cos(midLatRad);

    const vx = (p2[1] - p1[1]) * mPerDegLng;
    const vy = (p2[0] - p1[0]) * mPerDegLat;
    const segLenSq = vx * vx + vy * vy;

    const ux = (cLng - p1[1]) * mPerDegLng;
    const uy = (cLat - p1[0]) * mPerDegLat;

    let t = (ux * vx + uy * vy) / segLenSq;
    t = Math.max(0, Math.min(1, t));

    const projLat = p1[0] + t * (p2[0] - p1[0]);
    const projLng = p1[1] + t * (p2[1] - p1[1]);
    const projLatLng: [number, number] = [projLat, projLng];

    const distToClick = calculateDistanceMeters(clickLatLng, projLatLng);
    if (distToClick < bestDistToSegment) {
      bestDistToSegment = distToClick;
      bestTrackDist = segStartDist + t * segLenMeters;
      bestLatLng = projLatLng;
      bestSegIdx = i;
      bestT = t;
    }
  }

  return { distance: bestTrackDist, latLng: bestLatLng, segmentIndex: bestSegIdx, t: bestT };
}

function reanchorTrackToStartPoint(
  trackPoints: [number, number][],
  clickPos: [number, number],
  cumDistances: number[]
): [number, number][] {
  if (trackPoints.length < 3) return trackPoints;

  const proj = projectPointOnTrack(clickPos, trackPoints, cumDistances);
  const bestProj = proj.latLng;
  const bestI = proj.segmentIndex;
  const n = trackPoints.length;

  const newPts: [number, number][] = [bestProj];
  for (let offset = 1; offset <= n; offset++) {
    const idx = (bestI + offset) % n;
    if (calculateDistanceMeters(newPts[newPts.length - 1], trackPoints[idx]) > 4) {
      newPts.push(trackPoints[idx]);
    }
  }
  return newPts;
}

export function isPointInPolygon(point: [number, number], polygon?: [number, number][]): boolean {
  if (!polygon || polygon.length < 3) return false;
  const [lat, lng] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = ((yi > lng) !== (yj > lng)) &&
      (lat < (xj - xi) * (lng - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function getPolygonCenter(polygon?: [number, number][]): [number, number] | null {
  if (!polygon || polygon.length === 0) return null;
  let sumLat = 0;
  let sumLng = 0;
  for (const p of polygon) {
    sumLat += p[0];
    sumLng += p[1];
  }
  return [sumLat / polygon.length, sumLng / polygon.length];
}

export function isDistanceInPits(dist: number, entry?: number, exit?: number): boolean {
  if (entry === undefined || exit === undefined) return false;
  if (entry <= exit) {
    return dist >= entry && dist <= exit;
  }
  return dist >= entry || dist <= exit;
}

function formatSec(seconds: number | null): string {
  if (seconds === null || seconds === undefined || isNaN(seconds)) return '--:--.-';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

// Générateur de script SQL exportable
function buildSqlExport(teamId: string, laps: LapRecord[], pitStops: PitStopRecord[], circuit: SavedCircuit): string {
  let sql = `-- ============================================================================\n`;
  sql += `-- EXPORT DONNÉES SOLEX TRACKING — PRÊT POUR BASE SQL (PostgreSQL / Supabase)\n`;
  sql += `-- Équipe : ${teamId} | Date : ${new Date().toISOString()}\n`;
  sql += `-- Circuit : ${circuit.name}\n`;
  sql += `-- ============================================================================\n\n`;

  sql += `-- 1. CRÉATION DES TABLES SI NÉCESSAIRE\n`;
  sql += `CREATE TABLE IF NOT EXISTS race_laps (\n`;
  sql += `  id SERIAL PRIMARY KEY,\n`;
  sql += `  team_id VARCHAR(50) NOT NULL,\n`;
  sql += `  lap_number INT NOT NULL,\n`;
  sql += `  total_time_seconds DOUBLE PRECISION NOT NULL,\n`;
  sql += `  avg_speed_kmh DOUBLE PRECISION,\n`;
  sql += `  intermediate_times JSONB,\n`;
  sql += `  driver_name VARCHAR(100),\n`;
  sql += `  stint_number INT,\n`;
  sql += `  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()\n`;
  sql += `);\n\n`;

  sql += `CREATE TABLE IF NOT EXISTS pit_stops (\n`;
  sql += `  id SERIAL PRIMARY KEY,\n`;
  sql += `  team_id VARCHAR(50) NOT NULL,\n`;
  sql += `  lap_number INT,\n`;
  sql += `  driver_name VARCHAR(100),\n`;
  sql += `  stint_number INT,\n`;
  sql += `  duration_seconds INT NOT NULL,\n`;
  sql += `  timestamp VARCHAR(50)\n`;
  sql += `);\n\n`;

  sql += `-- 2. INSERTION DES TOURS BOUCLÉS (${laps.length} tours)\n`;
  if (laps.length > 0) {
    laps.forEach((l) => {
      const splitsJson = JSON.stringify(l.intermediateTimes || []);
      const driverEscaped = (l.driver || 'Inconnu').replace(/'/g, "''");
      sql += `INSERT INTO race_laps (team_id, lap_number, total_time_seconds, avg_speed_kmh, intermediate_times, driver_name, stint_number) VALUES ('${teamId}', ${l.lap}, ${l.totalTime.toFixed(2)}, ${l.avgSpeed}, '${splitsJson}', '${driverEscaped}', ${l.stint});\n`;
    });
  } else {
    sql += `-- (Aucun tour complété pour le moment)\n`;
  }

  sql += `\n-- 3. INSERTION DES ARRÊTS AUX STANDS (${pitStops.length} arrêts)\n`;
  if (pitStops.length > 0) {
    pitStops.forEach((p) => {
      const driverEscaped = (p.driver || 'Inconnu').replace(/'/g, "''");
      sql += `INSERT INTO pit_stops (team_id, lap_number, driver_name, stint_number, duration_seconds, timestamp) VALUES ('${teamId}', ${p.lap}, '${driverEscaped}', ${p.stint}, ${p.duration}, '${p.timestamp}');\n`;
    });
  } else {
    sql += `-- (Aucun arrêt au stand pour le moment)\n`;
  }

  return sql;
}

// ============================================================================
// COMPOSANT PRINCIPAL APP
// ============================================================================
// ============================================================================
// COMPOSANT PRINCIPAL APP
// ============================================================================
// ============================================================================
// COMPOSANT PRINCIPAL APP
// ============================================================================

// ============================================================================
// COMPOSANT BALISE GPS SOLEX EMBARQUÉ (DÉDIÉ MOBILE / APK ANDROID)
// ============================================================================
interface SolexTransmitterViewProps {
  onSwitchToStand: () => void;
  defaultServerUrl: string;
}

function SolexTransmitterView({ onSwitchToStand, defaultServerUrl }: SolexTransmitterViewProps) {
  const [isTransmitting, setIsTransmitting] = useState<boolean>(false);
  const [teamId, setTeamId] = useState<string>('equipe-1');
  const [serverUrl, setServerUrl] = useState<string>(() => {
    if (typeof window !== 'undefined' && window.location.origin && window.location.origin.startsWith('http')) {
      return window.location.origin;
    }
    return defaultServerUrl || 'https://solex-tracker.onrender.com';
  });

  const [currentSpeed, setCurrentSpeed] = useState<number>(0);
  const [maxSpeed, setMaxSpeed] = useState<number>(0);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);
  const [pointsSent, setPointsSent] = useState<number>(0);
  const [lastTime, setLastTime] = useState<string>('--:--:--');
  const [wsState, setWsState] = useState<'connected' | 'connecting' | 'disconnected'>('disconnected');
  const [wakeLockActive, setWakeLockActive] = useState<boolean>(false);
  const [batteryLevel, setBatteryLevel] = useState<number | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const wakeLockRef = useRef<any>(null);

  // Détection batterie si API disponible
  useEffect(() => {
    if (typeof navigator !== 'undefined' && 'getBattery' in navigator) {
      (navigator as any).getBattery().then((battery: any) => {
        setBatteryLevel(Math.round(battery.level * 100));
        battery.addEventListener('levelchange', () => {
          setBatteryLevel(Math.round(battery.level * 100));
        });
      }).catch(() => {});
    }
  }, []);

  const startTracking = async () => {
    setIsTransmitting(true);
    setWsState('connecting');

    // 1. Maintien en éveil (WakeLock pour éviter la veille processeur)
    if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
      try {
        const wl = await (navigator as any).wakeLock.request('screen');
        wakeLockRef.current = wl;
        setWakeLockActive(true);
      } catch (err) {
        console.warn('WakeLock non disponible ou refusé', err);
      }
    }

    // 2. Connexion WebSocket vers Render
    try {
      const wsProto = serverUrl.startsWith('https') ? 'wss:' : 'ws:';
      const cleanHost = serverUrl.replace(/^https?:\/\//, '');
      const wsUrl = `${wsProto}//${cleanHost}`;
      
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsState('connected');
        ws.send(JSON.stringify({
          type: 'register',
          role: 'solex',
          teamId
        }));
      };

      ws.onclose = () => {
        setWsState('disconnected');
      };

      ws.onerror = () => {
        setWsState('disconnected');
      };
    } catch (e) {
      console.warn('Erreur init WebSocket', e);
      setWsState('disconnected');
    }

    // 3. Géolocalisation haute fréquence
    if (typeof navigator !== 'undefined' && 'geolocation' in navigator) {
      const id = navigator.geolocation.watchPosition(
        (pos) => {
          const latitude = pos.coords.latitude;
          const longitude = pos.coords.longitude;
          const speedKmh = pos.coords.speed !== null && pos.coords.speed !== undefined && pos.coords.speed >= 0
            ? Math.round(pos.coords.speed * 3.6)
            : 0;
          const acc = pos.coords.accuracy ? Math.round(pos.coords.accuracy * 10) / 10 : null;
          const heading = pos.coords.heading;

          setLat(latitude);
          setLng(longitude);
          setCurrentSpeed(speedKmh);
          setMaxSpeed(prev => Math.max(prev, speedKmh));
          setAccuracy(acc);

          const packet = {
            type: 'telemetry',
            teamId,
            lat: latitude,
            lng: longitude,
            speed: speedKmh,
            heading: heading || null,
            accuracy: acc,
            timestamp: pos.timestamp || Date.now()
          };

          // Envoi WebSocket prioritaire
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(packet));
          } else {
            // Secours HTTP si le socket est temporairement fermé
            fetch(`${serverUrl}/api/telemetry`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(packet)
            }).catch(() => {});
          }

          setPointsSent(p => p + 1);
          setLastTime(new Date().toLocaleTimeString());
        },
        (err) => console.warn('Erreur GPS', err),
        {
          enableHighAccuracy: true,
          maximumAge: 500,
          timeout: 10000
        }
      );
      watchIdRef.current = id;
    }
  };

  const stopTracking = () => {
    setIsTransmitting(false);
    if (watchIdRef.current !== null && typeof navigator !== 'undefined') {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
      setWakeLockActive(false);
    }
    setWsState('disconnected');
  };

  useEffect(() => {
    return () => {
      stopTracking();
    };
  }, []);

  return (
    <div style={{ minHeight: '100vh', background: '#090d16', color: '#f8fafc', padding: '16px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {/* Barre supérieure */}
      <div style={{ width: '100%', maxWidth: '480px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '24px' }}>🛵</span>
          <div>
            <div style={{ fontWeight: 'bold', fontSize: '16px' }}>Solex Tracking</div>
            <div style={{ fontSize: '11px', color: '#94a3b8' }}>Balise Embarquée (APK)</div>
          </div>
        </div>
        <button
          onClick={onSwitchToStand}
          style={{ background: '#1e293b', border: '1px solid #334155', color: '#cbd5e1', padding: '6px 12px', borderRadius: '6px', fontSize: '11px', cursor: 'pointer' }}
        >
          🏁 Vue Stands
        </button>
      </div>

      {/* Carte principale */}
      <div style={{ width: '100%', maxWidth: '480px', background: '#0f172a', border: '1px solid #1e293b', borderRadius: '16px', padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px', boxShadow: '0 10px 25px rgba(0,0,0,0.5)' }}>
        
        {/* Gros bouton Démarrer / Arrêter */}
        <button
          onClick={isTransmitting ? stopTracking : startTracking}
          style={{
            width: '100%',
            padding: '18px',
            borderRadius: '12px',
            border: 'none',
            fontWeight: 'bold',
            fontSize: '18px',
            cursor: 'pointer',
            background: isTransmitting ? '#ef4444' : '#10b981',
            color: 'white',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '10px',
            boxShadow: isTransmitting ? '0 0 25px rgba(239,68,68,0.5)' : '0 0 25px rgba(16,185,129,0.5)',
            transition: 'all 0.2s',
          }}
        >
          {isTransmitting ? '🔴 ARRÊTER L\'ÉMISSION' : '🟢 DÉMARRER LE SUIVI GPS'}
        </button>

        {/* Compteur de vitesse géant */}
        <div style={{ background: '#050811', border: '1px solid #1e293b', borderRadius: '14px', padding: '24px 16px', textAlign: 'center' }}>
          <div style={{ fontSize: '12px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '1px' }}>Vitesse Instantanée</div>
          <div style={{ fontSize: '76px', fontWeight: '900', lineHeight: '1', color: currentSpeed > 0 ? '#38bdf8' : '#64748b', margin: '8px 0' }}>
            {currentSpeed}
          </div>
          <div style={{ fontSize: '14px', color: '#94a3b8', fontWeight: 'bold' }}>KM / H</div>
          <div style={{ marginTop: '8px', fontSize: '12px', color: '#64748b' }}>
            Vitesse max atteinte : <strong style={{ color: '#cbd5e1' }}>{maxSpeed} km/h</strong>
          </div>
        </div>

        {/* Grille des statuts */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <div style={{ background: '#1e293b', padding: '12px', borderRadius: '10px' }}>
            <div style={{ fontSize: '11px', color: '#94a3b8' }}>Précision GPS</div>
            <div style={{ fontSize: '16px', fontWeight: 'bold', color: accuracy && accuracy <= 5 ? '#4ade80' : accuracy ? '#fbbf24' : '#94a3b8' }}>
              {accuracy !== null ? `± ${accuracy} m` : 'Recherche GPS...'}
            </div>
          </div>

          <div style={{ background: '#1e293b', padding: '12px', borderRadius: '10px' }}>
            <div style={{ fontSize: '11px', color: '#94a3b8' }}>Connexion Serveur</div>
            <div style={{ fontSize: '14px', fontWeight: 'bold', color: wsState === 'connected' ? '#4ade80' : wsState === 'connecting' ? '#fbbf24' : '#ef4444' }}>
              {wsState === 'connected' ? '🟢 Connecté' : wsState === 'connecting' ? '🟡 Connexion...' : '🔴 Déconnecté'}
            </div>
          </div>

          <div style={{ background: '#1e293b', padding: '12px', borderRadius: '10px' }}>
            <div style={{ fontSize: '11px', color: '#94a3b8' }}>Points transmis</div>
            <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#cbd5e1' }}>
              {pointsSent.toLocaleString('fr-FR')}
            </div>
          </div>

          <div style={{ background: '#1e293b', padding: '12px', borderRadius: '10px' }}>
            <div style={{ fontSize: '11px', color: '#94a3b8' }}>Dernier paquet</div>
            <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#cbd5e1' }}>
              {lastTime}
            </div>
          </div>
        </div>

        {/* Maintien écran et batterie */}
        <div style={{ display: 'flex', justifyContent: 'space-between', background: '#1e293b', padding: '10px 14px', borderRadius: '10px', fontSize: '12px', color: '#94a3b8' }}>
          <div>
            Éveil CPU : <strong style={{ color: wakeLockActive ? '#4ade80' : '#fbbf24' }}>{wakeLockActive ? 'Actif' : 'Standard'}</strong>
          </div>
          {batteryLevel !== null && (
            <div>
              Batterie : <strong style={{ color: batteryLevel > 20 ? '#cbd5e1' : '#ef4444' }}>{batteryLevel}%</strong>
            </div>
          )}
        </div>

        {/* Paramètres de l'équipe */}
        <div style={{ borderTop: '1px solid #1e293b', paddingTop: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div>
            <label style={{ fontSize: '11px', color: '#94a3b8', display: 'block', marginBottom: '3px' }}>Identifiant Équipe :</label>
            <input
              type="text"
              value={teamId}
              disabled={isTransmitting}
              onChange={(e) => setTeamId(e.target.value)}
              style={{ width: '100%', padding: '8px', background: '#090d16', border: '1px solid #334155', borderRadius: '6px', color: 'white', fontSize: '13px' }}
            />
          </div>

          <div>
            <label style={{ fontSize: '11px', color: '#94a3b8', display: 'block', marginBottom: '3px' }}>Serveur Relais Render :</label>
            <input
              type="text"
              value={serverUrl}
              disabled={isTransmitting}
              onChange={(e) => setServerUrl(e.target.value)}
              style={{ width: '100%', padding: '8px', background: '#090d16', border: '1px solid #334155', borderRadius: '6px', color: 'white', fontSize: '12px' }}
            />
          </div>
        </div>

        {/* Message d'instruction rassurant */}
        <div style={{ fontSize: '11px', color: '#64748b', textAlign: 'center', lineHeight: '1.4', background: '#050811', padding: '10px', borderRadius: '8px' }}>
          💡 Une fois le suivi démarré, le téléphone peut être glissé dans la sacoche du Solex. Les chronos, intermédiaires et alertes d'arrêt sont gérés directement par l'équipe aux stands.
        </div>
      </div>
    </div>
  );
}

export default function App() {
  // Navigation principale de rôle
  // Détection si l'application tourne dans l'APK Android (Capacitor) ou sur mobile dédié
  const isCapacitorNative = typeof window !== 'undefined' && Boolean((window as any).Capacitor?.isNativePlatform?.() || window.location.search.includes('mode=solex'));
  const [viewRole, setViewRole] = useState<'stand' | 'circuit' | 'transmitter'>(isCapacitorNative ? 'transmitter' : 'stand');

  // Circuits enregistrés
  const [circuits, setCircuits] = useState<SavedCircuit[]>(() => {
    try {
      const saved = localStorage.getItem('solex_circuits_v8');
      if (saved) return JSON.parse(saved);
      const savedV7 = localStorage.getItem('solex_circuits_v7');
      if (savedV7) return JSON.parse(savedV7);
    } catch (e) {
      console.error('Erreur lecture circuits', e);
    }
    return DEFAULT_CIRCUITS;
  });

  const [selectedCircuitId, setSelectedCircuitId] = useState<string>(circuits[0]?.id || 'circuit-mans');

  const currentCircuit = useMemo(() => {
    return circuits.find((c) => c.id === selectedCircuitId) || circuits[0] || DEFAULT_CIRCUITS[0];
  }, [circuits, selectedCircuitId]);

  // Mode de données pour les stands : 'live' (GPS réel via WebSocket) ou 'simulation' (virtuel)
  const [standDataSource, setStandDataSource] = useState<'live' | 'simulation'>('simulation');

  // État WebSocket Serveur Relais (pour communication réelle entre le Solex et les Stands)
  const [isWsConnected, setIsWsConnected] = useState<boolean>(false);
  const [wsPacketsCount, setWsPacketsCount] = useState<number>(0);
  const [serverWsUrl, setServerWsUrl] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${window.location.host}`;
    }
    return 'ws://localhost:3000';
  });
  const [teamId, setTeamId] = useState<string>('solex-7');

  // Télémétrie & Chronométrage
  const [speed, setSpeed] = useState<number>(0);
  const [currentLap, setCurrentLap] = useState<number>(1);
  const [currentLapTime, setCurrentLapTime] = useState<number>(0);
  const [bestLapTime, setBestLapTime] = useState<number | null>(null);
  const [lapHistory, setLapHistory] = useState<LapRecord[]>([]);
  const [pitHistory, setPitHistory] = useState<PitStopRecord[]>([]);

  // Pilotes & Relais
  const [currentDriver, setCurrentDriver] = useState<string>('Pilote 1');
  const [currentStint, setCurrentStint] = useState<number>(1);
  const [driversList, setDriversList] = useState<string[]>(['Pilote 1', 'Pilote 2', 'Pilote 3']);
  const [showDriverModal, setShowDriverModal] = useState<boolean>(false);
  const [filterDriver, setFilterDriver] = useState<string>('all');

  // Alertes de course
  const [alertStopped, setAlertStopped] = useState<boolean>(false);
  const [stopElapsedSeconds, setStopElapsedSeconds] = useState<number>(0);
  const [alertSignalLost, setAlertSignalLost] = useState<boolean>(false);
  const [signalLostElapsedSeconds, setSignalLostElapsedSeconds] = useState<number>(0);
  const [inPitsState, setInPitsState] = useState<boolean>(false);
  const [pitTimerSeconds, setPitTimerSeconds] = useState<number>(0);

  // Carte & Édition
  const [mapLayerType, setMapLayerType] = useState<'satellite' | 'streets' | 'dark'>('satellite');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSearching, setIsSearching] = useState<boolean>(false);

  // Édition & Création de circuit
  const [isEditingTrack, setIsEditingTrack] = useState<boolean>(false);
  const [newCircuitName, setNewCircuitName] = useState<string>('Mon Nouveau Circuit');
  const [editTrackPoints, setEditTrackPoints] = useState<[number, number][]>([]);
  const [placementMode, setPlacementMode] = useState<'none' | 'startLine' | 'intermediate' | 'move_intermediate' | 'pitPolygon'>('none');
  const [editingCircuitId, setEditingCircuitId] = useState<string | null>(null);
  const [movingIntermediateId, setMovingIntermediateId] = useState<string | null>(null);
  const [notificationMsg, setNotificationMsg] = useState<string | null>(null);

  // Contrôles de simulation
  const [isSimRunning, setIsSimRunning] = useState<boolean>(true);
  const [targetSpeed, setTargetSpeed] = useState<number>(85);
  const [simStopped, setSimStopped] = useState<boolean>(false);
  const [simInPitStop, setSimInPitStop] = useState<boolean>(false);
  const [simSignalLost, setSimSignalLost] = useState<boolean>(false);

  // Onglet inférieur des stands
  const [activeTab, setActiveTab] = useState<'laps' | 'pitstops' | 'driverStats'>('laps');

  // Export de données
  const [showExportModal, setShowExportModal] = useState<boolean>(false);
  const [exportSqlText, setExportSqlText] = useState<string>('');

  // ============================================================================
  // ÉTAT SPÉCIFIQUE AU MODE SOLEX EMBARQUÉ (SMARTPHONE AU GUIDON)
  // ============================================================================
  const [isGpsTransmitting, setIsGpsTransmitting] = useState<boolean>(false);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [gpsSpeed, setGpsSpeed] = useState<number>(0);
  const [gpsHeading, setGpsHeading] = useState<number | null>(null);
  const [gpsAltitude, setGpsAltitude] = useState<number | null>(null);
  const [gpsPacketsSent, setGpsPacketsSent] = useState<number>(0);
  const [lastGpsFixTime, setLastGpsFixTime] = useState<string>('--:--:--');
  const [wakeLockActive, setWakeLockActive] = useState<boolean>(false);
  const [isSimulatingPhoneGps, setIsSimulatingPhoneGps] = useState<boolean>(false);
  const wakeLockSentinelRef = useRef<any>(null);
  const gpsWatchIdRef = useRef<number | null>(null);
  const offlineQueueRef = useRef<TelemetryPacket[]>([]);

  // Refs pour Leaflet et boucle de calcul
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const polylineRef = useRef<L.Polyline | null>(null);
  const pitPolylineRef = useRef<L.Polyline | null>(null);
  const pitPolygonRef = useRef<L.Polygon | null>(null);
  const markersGroupRef = useRef<L.LayerGroup | null>(null);
  const solexMarkerRef = useRef<L.Marker | null>(null);

  // Progression & Chronométrage
  const lastKnownPosRef = useRef<[number, number]>(currentCircuit.points[0] || [47.95, 0.2]);
  const distanceCoveredInLapRef = useRef<number>(0);
  const lastTickTimeRef = useRef<number>(Date.now());
  const lapStartTimeRef = useRef<number>(Date.now());
  const currentLapRef = useRef<number>(1);
  const stopDurationRef = useRef<number>(0);
  const signalLostDurationRef = useRef<number>(0);
  const pitDurationRef = useRef<number>(0);

  // Sauvegarde persistante des circuits
  useEffect(() => {
    try {
      localStorage.setItem('solex_circuits_v8', JSON.stringify(circuits));
    } catch (e) {
      console.error(e);
    }
  }, [circuits]);

  // Toast temporaire
  const showToast = (msg: string) => {
    setNotificationMsg(msg);
    setTimeout(() => {
      setNotificationMsg((m) => (m === msg ? null : m));
    }, 4000);
  };

  // Métriques géométriques du circuit en cours
  const trackMetrics = useMemo(() => {
    const pts = currentCircuit.points;
    if (pts.length < 2) {
      return { totalDistanceMeters: 0, cumDistances: [0] };
    }
    const cum: number[] = [0];
    let total = 0;
    for (let i = 0; i < pts.length; i++) {
      const nextIdx = (i + 1) % pts.length;
      const d = calculateDistanceMeters(pts[i], pts[nextIdx]);
      total += d;
      cum.push(total);
    }
    return { totalDistanceMeters: total, cumDistances: cum };
  }, [currentCircuit]);

  // Balises intermédiaires triées par distance croissante
  const sortedIntermediates = useMemo(() => {
    const list = currentCircuit.intermediates ? [...currentCircuit.intermediates] : [];
    return list.sort((a, b) => a.distance - b.distance);
  }, [currentCircuit.intermediates]);

  // Calcul de la distance totale du tracé en cours de création
  const drawnDistanceMeters = useMemo(() => {
    if (editTrackPoints.length < 2) return 0;
    let total = 0;
    for (let i = 0; i < editTrackPoints.length - 1; i++) {
      total += calculateDistanceMeters(editTrackPoints[i], editTrackPoints[i + 1]);
    }
    return Math.round(total);
  }, [editTrackPoints]);

  const [liveSplitTimes, setLiveSplitTimes] = useState<(number | null)[]>(() =>
    new Array(sortedIntermediates.length).fill(null)
  );
  const recordedSplitsThisLapRef = useRef<(number | null)[]>(
    new Array(sortedIntermediates.length).fill(null)
  );

  useEffect(() => {
    setLiveSplitTimes(new Array(sortedIntermediates.length).fill(null));
    recordedSplitsThisLapRef.current = new Array(sortedIntermediates.length).fill(null);
  }, [sortedIntermediates.length, selectedCircuitId]);

  // Calcul de position à partir d'une distance sur le circuit
  const getPositionFromDistance = (dist: number): [number, number] => {
    const pts = currentCircuit.points;
    if (pts.length < 2) return pts[0] || [47.95, 0.2];
    const total = trackMetrics.totalDistanceMeters;
    if (total <= 0) return pts[0];

    const normalizedDist = ((dist % total) + total) % total;
    const cum = trackMetrics.cumDistances;

    for (let i = 0; i < pts.length; i++) {
      const segStart = cum[i];
      const segEnd = cum[i + 1];
      if (normalizedDist >= segStart && normalizedDist <= segEnd) {
        const segLen = segEnd - segStart;
        const t = segLen > 0 ? (normalizedDist - segStart) / segLen : 0;
        const nextIdx = (i + 1) % pts.length;
        const lat = pts[i][0] + (pts[nextIdx][0] - pts[i][0]) * t;
        const lng = pts[i][1] + (pts[nextIdx][1] - pts[i][1]) * t;
        return [lat, lng];
      }
    }
    return pts[0];
  };

  // ============================================================================
  // WEBSOCKET TEMPS RÉEL (RELAIS SERVEUR RENDER)
  // ============================================================================
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: any = null;
    let active = true;

    const connect = () => {
      try {
        ws = new WebSocket(serverWsUrl);

        ws.onopen = () => {
          if (!active) return;
          setIsWsConnected(true);
          console.log('[WebSocket] Connecté au serveur relais');
          ws?.send(
            JSON.stringify({
              type: 'register',
              role: 'stand',
              teamId,
            })
          );

          if (offlineQueueRef.current.length > 0) {
            offlineQueueRef.current.forEach((pkt) => {
              ws?.send(JSON.stringify({ type: 'telemetry', ...pkt }));
            });
            offlineQueueRef.current = [];
          }
        };

        ws.onmessage = (event) => {
          if (!active) return;
          try {
            const data = JSON.parse(event.data);
            setWsPacketsCount((c) => c + 1);

            if (data.type === 'telemetry' && standDataSource === 'live') {
              const { lat, lng, speed: spd, timestamp } = data;
              setSpeed(Math.round(spd || 0));
              lastKnownPosRef.current = [lat, lng];

              if (solexMarkerRef.current) {
                solexMarkerRef.current.setLatLng([lat, lng]);
              }

              if (currentCircuit.points.length >= 2) {
                const proj = projectPointOnTrack([lat, lng], currentCircuit.points, trackMetrics.cumDistances);
                const newDist = proj.distance;
                const inPits = (currentCircuit.pitPolygon && currentCircuit.pitPolygon.length >= 3)
                  ? isPointInPolygon([lat, lng], currentCircuit.pitPolygon)
                  : isDistanceInPits(newDist, currentCircuit.pitEntryDistance, currentCircuit.pitExitDistance);
                setInPitsState(inPits);
                if (inPits) setAlertStopped(false);
              }
            }
          } catch (e) {
            console.error('[WebSocket] Erreur décodage message', e);
          }
        };

        ws.onclose = () => {
          if (!active) return;
          setIsWsConnected(false);
          reconnectTimeout = setTimeout(connect, 3000);
        };

        ws.onerror = (err) => {
          console.warn('[WebSocket] Avertissement connexion', err);
        };
      } catch (e) {
        console.error('[WebSocket] Erreur init', e);
        reconnectTimeout = setTimeout(connect, 3000);
      }
    };

    connect();

    return () => {
      active = false;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) ws.close();
    };
  }, [serverWsUrl, teamId, viewRole, standDataSource, currentCircuit, trackMetrics, sortedIntermediates]);

  // ============================================================================
  // ÉMISSION TÉLÉMÉTRIE SOLEX EMBARQUÉ
  // ============================================================================
  const sendTelemetryPacket = (lat: number, lng: number, spd: number, heading?: number | null, acc?: number | null) => {
    const pkt: TelemetryPacket = {
      teamId,
      lat,
      lng,
      speed: spd,
      heading,
      accuracy: acc,
      timestamp: Date.now(),
    };

    setGpsPacketsSent((c) => c + 1);
    setLastGpsFixTime(new Date().toLocaleTimeString());
    setGpsSpeed(Math.round(spd));
    setGpsAccuracy(acc ? Math.round(acc) : null);
    setGpsHeading(heading || null);

    fetch('/api/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pkt),
    }).catch(() => {
      offlineQueueRef.current.push(pkt);
    });
  };

  const startGpsTransmission = async () => {
    if (!navigator.geolocation) {
      alert("La géolocalisation GPS n'est pas supportée par ce navigateur.");
      return;
    }

    try {
      if ('wakeLock' in navigator) {
        wakeLockSentinelRef.current = await (navigator as any).wakeLock.request('screen');
        setWakeLockActive(true);
      }
    } catch (e) {
      console.warn('WakeLock indisponible', e);
    }

    setIsGpsTransmitting(true);
    showToast('🚀 Transmission GPS lancée !');

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, speed: spd, heading, accuracy, altitude } = pos.coords;
        const kmh = spd !== null && spd !== undefined ? spd * 3.6 : 0;
        setGpsAltitude(altitude ? Math.round(altitude) : null);
        sendTelemetryPacket(latitude, longitude, kmh, heading, accuracy);
      },
      (err) => {
        console.error('Erreur GPS', err);
        showToast('⚠️ Erreur signal GPS : ' + err.message);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 5000,
      }
    );

    gpsWatchIdRef.current = watchId;
  };

  const stopGpsTransmission = () => {
    if (gpsWatchIdRef.current !== null) {
      navigator.geolocation.clearWatch(gpsWatchIdRef.current);
      gpsWatchIdRef.current = null;
    }
    if (wakeLockSentinelRef.current) {
      wakeLockSentinelRef.current.release().catch(() => {});
      wakeLockSentinelRef.current = null;
      setWakeLockActive(false);
    }
    setIsGpsTransmitting(false);
    setIsSimulatingPhoneGps(false);
    showToast('⏹️ Transmission GPS arrêtée.');
  };

  // Simulation GPS embarqué
  useEffect(() => {
    if (!isSimulatingPhoneGps) return;
    let curDist = 0;
    const pts = currentCircuit.points;
    if (pts.length < 2) return;

    const interval = setInterval(() => {
      curDist += (85 * 1000 / 3600) * 0.5;
      const total = trackMetrics.totalDistanceMeters;
      if (total <= 0) return;
      const norm = curDist % total;

      const pos = getPositionFromDistance(norm);
      sendTelemetryPacket(pos[0], pos[1], 85, 90, 3.5);
    }, 500);

    return () => clearInterval(interval);
  }, [isSimulatingPhoneGps, trackMetrics, teamId]);

  // ============================================================================
  // GESTION CARTE LEAFLET
  // ============================================================================
  useEffect(() => {
    if (!mapContainerRef.current) return;
    if (mapRef.current) return;

    const initialCenter = currentCircuit.points[0] || [47.95, 0.205];
    const map = L.map(mapContainerRef.current).setView(initialCenter, 16);

    const satLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: 'Tiles &copy; Esri' }
    );
    satLayer.addTo(map);
    tileLayerRef.current = satLayer;

    const closedPoints = currentCircuit.points.length > 2
      ? [...currentCircuit.points, currentCircuit.points[0]]
      : currentCircuit.points;

    const polyline = L.polyline(closedPoints, {
      color: '#ef4444',
      weight: 5,
      opacity: 0.9,
    }).addTo(map);
    polylineRef.current = polyline;

    const pitPoly = L.polyline([], {
      color: '#eab308',
      weight: 4,
      dashArray: '6, 8',
      opacity: 0.9,
    }).addTo(map);
    pitPolylineRef.current = pitPoly;

    const pitPolyZone = L.polygon([], {
      color: '#2563eb',
      fillColor: '#3b82f6',
      fillOpacity: 0.28,
      weight: 2,
      dashArray: '5, 5',
    }).addTo(map);
    pitPolygonRef.current = pitPolyZone;

    const markersGroup = L.layerGroup().addTo(map);
    markersGroupRef.current = markersGroup;

    const solexM = L.marker(initialCenter, { icon: createSolexIcon() }).addTo(map);
    solexMarkerRef.current = solexM;

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Invalider la taille de la carte lors du changement d'onglet
  useEffect(() => {
    if (mapRef.current) {
      setTimeout(() => {
        mapRef.current?.invalidateSize();
      }, 100);
    }
  }, [viewRole]);

  // Changement de fond de carte
  useEffect(() => {
    if (!mapRef.current || !tileLayerRef.current) return;
    mapRef.current.removeLayer(tileLayerRef.current);

    let newUrl = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
    let newAttr = 'Tiles &copy; Esri';

    if (mapLayerType === 'streets') {
      newUrl = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
      newAttr = '&copy; OpenStreetMap contributors';
    } else if (mapLayerType === 'dark') {
      newUrl = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
      newAttr = '&copy; CartoDB';
    }

    const newLayer = L.tileLayer(newUrl, { maxZoom: 19, attribution: newAttr });
    newLayer.addTo(mapRef.current);
    tileLayerRef.current = newLayer;
  }, [mapLayerType]);

  // Mise à jour visuelle du circuit et des balises
  useEffect(() => {
    if (!mapRef.current) return;

    if (isEditingTrack) {
      if (polylineRef.current) {
        polylineRef.current.setStyle({ color: '#f59e0b', weight: 4, dashArray: '4, 6' });
        polylineRef.current.setLatLngs(editTrackPoints);
      }
      if (pitPolylineRef.current) {
        pitPolylineRef.current.setLatLngs([]);
      }
      if (pitPolygonRef.current) {
        pitPolygonRef.current.setLatLngs([]);
      }
      if (markersGroupRef.current) {
        markersGroupRef.current.clearLayers();
        editTrackPoints.forEach((pt, idx) => {
          L.circleMarker(pt, {
            radius: idx === 0 ? 8 : 5,
            color: idx === 0 ? '#10b981' : '#f59e0b',
            fillColor: idx === 0 ? '#10b981' : '#fbbf24',
            fillOpacity: 0.9,
            weight: 2,
          }).addTo(markersGroupRef.current!);
        });
      }
      return;
    }

    // Hors mode tracé
    if (polylineRef.current) {
      polylineRef.current.setStyle({ color: '#ef4444', weight: 5, dashArray: undefined });
      const closedPoints = currentCircuit.points.length > 2
        ? [...currentCircuit.points, currentCircuit.points[0]]
        : currentCircuit.points;
      polylineRef.current.setLatLngs(closedPoints);
    }

    if (pitPolygonRef.current) {
      if (currentCircuit.pitPolygon && currentCircuit.pitPolygon.length >= 3) {
        pitPolygonRef.current.setLatLngs(currentCircuit.pitPolygon);
      } else {
        pitPolygonRef.current.setLatLngs([]);
      }
    }

    if (pitPolylineRef.current) {
      if (currentCircuit.pitEntryLatLng && currentCircuit.pitExitLatLng) {
        pitPolylineRef.current.setLatLngs([currentCircuit.pitEntryLatLng, currentCircuit.pitExitLatLng]);
      } else {
        pitPolylineRef.current.setLatLngs([]);
      }
    }

    if (markersGroupRef.current) {
      markersGroupRef.current.clearLayers();

      // Balise Ligne de départ / arrivée
      if (currentCircuit.points[0]) {
        L.marker(currentCircuit.points[0], {
          icon: createSectorIcon('🏁 DÉPART', '#16a34a', 0),
        }).addTo(markersGroupRef.current);
      }

      // Balises de secteurs S1, S2...
      sortedIntermediates.forEach((inter) => {
        L.marker(inter.latLng, {
          icon: createSectorIcon(inter.name, '#f59e0b', inter.distance),
        }).addTo(markersGroupRef.current!);
      });

      // Zone des stands (Polygone)
      if (currentCircuit.pitPolygon && currentCircuit.pitPolygon.length >= 3) {
        const center = getPolygonCenter(currentCircuit.pitPolygon);
        if (center) {
          L.marker(center, {
            icon: createSectorIcon('⛽ ZONE STANDS', '#2563eb', 0),
          }).addTo(markersGroupRef.current);
        }
      } else {
        if (currentCircuit.pitEntryLatLng && currentCircuit.pitEntryDistance !== undefined) {
          L.marker(currentCircuit.pitEntryLatLng, {
            icon: createSectorIcon('⛽ ENTRÉE STANDS', '#2563eb', currentCircuit.pitEntryDistance),
          }).addTo(markersGroupRef.current);
        }

        if (currentCircuit.pitExitLatLng && currentCircuit.pitExitDistance !== undefined) {
          L.marker(currentCircuit.pitExitLatLng, {
            icon: createSectorIcon('🏁 SORTIE STANDS', '#0284c7', currentCircuit.pitExitDistance),
          }).addTo(markersGroupRef.current);
        }
      }
    }
  }, [currentCircuit, sortedIntermediates, isEditingTrack, editTrackPoints]);

  // Clic sur la carte en mode édition ou placement
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handleClick = (e: L.LeafletMouseEvent) => {
      const clickPos: [number, number] = [e.latlng.lat, e.latlng.lng];

                    {editingCircuitId ? `✏️ Modification du Tracé de "${currentCircuit.name}"` : "✏️ Tracé d'un Nouveau Circuit"}
      if (isEditingTrack) {
        setEditTrackPoints((prev) => [...prev, clickPos]);
        return;
      }

      // Cas 2 : Repositionner la ligne de départ / arrivée
      if (placementMode === 'startLine') {
        const reanchored = reanchorTrackToStartPoint(currentCircuit.points, clickPos, trackMetrics.cumDistances);
        const updated = circuits.map((c) => (c.id === currentCircuit.id ? { ...c, points: reanchored } : c));
        setCircuits(updated);
        try { localStorage.setItem('solex_circuits_v8', JSON.stringify(updated)); } catch (e) { console.error(e); }
        setPlacementMode('none');
        showToast('🏁 Ligne de départ repositionnée avec succès !');
        return;
      }

      // Cas 3 : Ajouter une balise intermédiaire S1, S2...
      if (placementMode === 'intermediate') {
        const proj = projectPointOnTrack(clickPos, currentCircuit.points, trackMetrics.cumDistances);
        const newInter: IntermediatePoint = {
          id: `inter-${Date.now()}`,
          name: `S${(currentCircuit.intermediates?.length || 0) + 1}`,
          distance: proj.distance,
          latLng: proj.latLng,
        };
        const updatedIntermediates = [...(currentCircuit.intermediates || []), newInter];
        const updated = circuits.map((c) =>
          c.id === currentCircuit.id ? { ...c, intermediates: updatedIntermediates } : c
        );
        setCircuits(updated);
        try { localStorage.setItem('solex_circuits_v8', JSON.stringify(updated)); } catch (e) { console.error(e); }
        setPlacementMode('none');
        showToast(`📍 Balise intermédiaire ajoutée à ${Math.round(proj.distance)}m !`);
        return;
      }

      // Cas 3bis : Déplacer une balise intermédiaire existante
      if (placementMode === 'move_intermediate' && movingIntermediateId) {
        const proj = projectPointOnTrack(clickPos, currentCircuit.points, trackMetrics.cumDistances);
        const updatedIntermediates = (currentCircuit.intermediates || []).map((inter) =>
          inter.id === movingIntermediateId
            ? { ...inter, distance: proj.distance, latLng: proj.latLng }
            : inter
        );
        const updated = circuits.map((c) =>
          c.id === currentCircuit.id ? { ...c, intermediates: updatedIntermediates } : c
        );
        setCircuits(updated);
        try { localStorage.setItem('solex_circuits_v8', JSON.stringify(updated)); } catch (e) { console.error(e); }
        setPlacementMode('none');
        setMovingIntermediateId(null);
        showToast(`📍 Balise repositionnée à ${Math.round(proj.distance)}m !`);
        return;
      }

      // Cas 4 : Positionner les sommets du polygone des stands
      if (placementMode === 'pitPolygon') {
        const currentPoly = currentCircuit.pitPolygon || [];
        const newPoly = [...currentPoly, clickPos];
        const updated = circuits.map((c) =>
          c.id === currentCircuit.id ? { ...c, pitPolygon: newPoly } : c
        );
        setCircuits(updated);
        try { localStorage.setItem('solex_circuits_v8', JSON.stringify(updated)); } catch (e) { console.error(e); }
        showToast(`📐 Sommet #${newPoly.length} ajouté à la zone des stands.`);
        return;
      }
    };

    map.on('click', handleClick);
    return () => {
      map.off('click', handleClick);
    };
  }, [isEditingTrack, placementMode, currentCircuit, trackMetrics, circuits]);

  // ============================================================================
  // BOUCLE DE SIMULATION (QUAND LE MODE SIMULATION EST CHOISI AUX STANDS)
  // ============================================================================
  useEffect(() => {
    if (standDataSource !== 'simulation' || isEditingTrack || currentCircuit.points.length < 2) return;

    lastTickTimeRef.current = Date.now();
    lapStartTimeRef.current = Date.now();
    recordedSplitsThisLapRef.current = new Array(sortedIntermediates.length).fill(null);
    setLiveSplitTimes(new Array(sortedIntermediates.length).fill(null));

    const interval = setInterval(() => {
      // Si la simulation est mise en pause ou arrêtée par l'utilisateur
      if (!isSimRunning) {
        setSpeed(0);
        return;
      }

      const now = Date.now();
      const dt = (now - lastTickTimeRef.current) / 1000;
      lastTickTimeRef.current = now;

      // 1. Perte de signal
      if (simSignalLost) {
        signalLostDurationRef.current += dt;
        const lostSec = Math.floor(signalLostDurationRef.current);
        setSignalLostElapsedSeconds(lostSec);
        if (signalLostDurationRef.current >= 5) setAlertSignalLost(true);
        if (solexMarkerRef.current && lastKnownPosRef.current) {
          solexMarkerRef.current.setLatLng(lastKnownPosRef.current);
        }
        setSpeed(0);
        return;
      }

      // 2. Zone des stands
      const currentlyInPits = (currentCircuit.pitPolygon && currentCircuit.pitPolygon.length >= 3 && lastKnownPosRef.current)
        ? isPointInPolygon(lastKnownPosRef.current, currentCircuit.pitPolygon)
        : isDistanceInPits(
            distanceCoveredInLapRef.current,
            currentCircuit.pitEntryDistance,
            currentCircuit.pitExitDistance
          );
      setInPitsState(currentlyInPits || simInPitStop);

      // 3. Arrêt aux stands (le chrono total du tour continue de tourner)
      if (simInPitStop) {
        setSpeed(0);
        pitDurationRef.current += dt;
        setPitTimerSeconds(Math.floor(pitDurationRef.current));
        setAlertStopped(false);
        stopDurationRef.current = 0;
        setStopElapsedSeconds(0);

        const currentLapDuration = (now - lapStartTimeRef.current) / 1000;
        setCurrentLapTime(currentLapDuration);
        return;
      }

      // 4. Panne en piste simulée (le chrono du tour continue de tourner sans pause)
      if (simStopped) {
        setSpeed(0);
        if (!currentlyInPits) {
          stopDurationRef.current += dt;
          const stoppedSec = Math.floor(stopDurationRef.current);
          setStopElapsedSeconds(stoppedSec);
          if (stopDurationRef.current >= 10) {
            setAlertStopped(true);
          }
        }

        const currentLapDuration = (now - lapStartTimeRef.current) / 1000;
        setCurrentLapTime(currentLapDuration);
        return;
      } else {
        stopDurationRef.current = 0;
        setStopElapsedSeconds(0);
        setAlertStopped(false);
      }

      // 5. Progression normale en piste
      const currentSimSpeed = currentlyInPits ? 25 : targetSpeed;
      setSpeed(currentSimSpeed);

      const distanceCoveredInInterval = (currentSimSpeed * 1000 / 3600) * dt;
      distanceCoveredInLapRef.current += distanceCoveredInInterval;

      const totalTrackLen = trackMetrics.totalDistanceMeters;
      if (totalTrackLen <= 0) return;

      const currentLapDuration = (now - lapStartTimeRef.current) / 1000;
      setCurrentLapTime(currentLapDuration);

      // Franchissement des balises intermédiaires
      sortedIntermediates.forEach((inter, idx) => {
        if (
          recordedSplitsThisLapRef.current[idx] === null &&
          distanceCoveredInLapRef.current >= inter.distance
        ) {
          const splitSec = parseFloat(currentLapDuration.toFixed(2));
          recordedSplitsThisLapRef.current[idx] = splitSec;
          setLiveSplitTimes([...recordedSplitsThisLapRef.current]);
          showToast(`⚡ Balise ${inter.name} franchie : ${splitSec.toFixed(1)}s`);
        }
      });

      // Franchissement de la ligne d'arrivée
      if (distanceCoveredInLapRef.current >= totalTrackLen) {
        const lapDuration = (now - lapStartTimeRef.current) / 1000;
        const avgSpd = Math.round((totalTrackLen / 1000) / (lapDuration / 3600));

        const completedLap: LapRecord = {
          id: `lap-${Date.now()}`,
          lap: currentLapRef.current,
          intermediateTimes: [...recordedSplitsThisLapRef.current],
          totalTime: lapDuration,
          avgSpeed: avgSpd,
          driver: currentDriver,
          stint: currentStint,
          timestamp: new Date().toLocaleTimeString(),
        };

        setLapHistory((prev) => [completedLap, ...prev]);

        setBestLapTime((prevBest) =>
          prevBest === null || lapDuration < prevBest ? lapDuration : prevBest
        );

        currentLapRef.current += 1;
        setCurrentLap(currentLapRef.current);

        distanceCoveredInLapRef.current = distanceCoveredInLapRef.current % totalTrackLen;
        lapStartTimeRef.current = now;
        recordedSplitsThisLapRef.current = new Array(sortedIntermediates.length).fill(null);
        setLiveSplitTimes(new Array(sortedIntermediates.length).fill(null));

        showToast(`🏁 Tour #${completedLap.lap} bouclé en ${formatSec(lapDuration)} (Moy: ${avgSpd} km/h)`);
      }

      // Mise à jour de la position du Solex
      const pos = getPositionFromDistance(distanceCoveredInLapRef.current);
      lastKnownPosRef.current = pos;
      if (solexMarkerRef.current) {
        solexMarkerRef.current.setLatLng(pos);
      }
    }, 100);

    return () => clearInterval(interval);
  }, [
    standDataSource,
    isEditingTrack,
    isSimRunning,
    currentCircuit,
    trackMetrics,
    sortedIntermediates,
    targetSpeed,
    simStopped,
    simInPitStop,
    simSignalLost,
    currentDriver,
    currentStint,
  ]);

  // ============================================================================
  // CONTRÔLES SIMULATION & CIRCUITS
  // ============================================================================
  const handleToggleSimulation = () => {
    setIsSimRunning((prev) => {
      const next = !prev;
      if (next) {
        lastTickTimeRef.current = Date.now();
        showToast('▶️ Simulation démarrée');
      } else {
        setSpeed(0);
        showToast('⏸️ Simulation arrêtée / en pause');
      }
      return next;
    });
  };

  const handleResetSimulation = () => {
    distanceCoveredInLapRef.current = 0;
    lapStartTimeRef.current = Date.now();
    lastTickTimeRef.current = Date.now();
    currentLapRef.current = 1;
    setCurrentLap(1);
    setCurrentLapTime(0);
    setBestLapTime(null);
    setLapHistory([]);
    setPitHistory([]);
    setLiveSplitTimes(new Array(sortedIntermediates.length).fill(null));
    recordedSplitsThisLapRef.current = new Array(sortedIntermediates.length).fill(null);
    setSpeed(0);
    setSimStopped(false);
    setSimInPitStop(false);
    setSimSignalLost(false);
    setAlertStopped(false);
    setAlertSignalLost(false);
    setInPitsState(false);
    stopDurationRef.current = 0;
    signalLostDurationRef.current = 0;
    pitDurationRef.current = 0;
    if (currentCircuit.points[0]) {
      lastKnownPosRef.current = currentCircuit.points[0];
      if (solexMarkerRef.current) {
        solexMarkerRef.current.setLatLng(currentCircuit.points[0]);
      }
    }
    showToast('🔄 Course réinitialisée au départ du Tour 1 !');
  };

  const handleStartCreateCircuit = () => {
    setIsEditingTrack(true);
    setEditingCircuitId(null);
    setViewRole('circuit');
    setNewCircuitName(`Circuit ${circuits.length + 1}`);
    setEditTrackPoints([]);
    setPlacementMode('none');
    showToast('✏️ Cliquez sur la carte pour déposer les points de votre nouveau circuit.');
  };

  const handleStartEditCurrentCircuit = () => {
    setIsEditingTrack(true);
    setEditingCircuitId(currentCircuit.id);
    setViewRole('circuit');
    setNewCircuitName(currentCircuit.name);
    setEditTrackPoints([...currentCircuit.points]);
    setPlacementMode('none');
    showToast(`✏️ Modification du tracé de "${currentCircuit.name}" : cliquez sur la carte pour ajouter des points, ou ↩️ pour retirer.`);
  };

  const handleRenameCurrentCircuit = (newName: string) => {
    const updated = circuits.map((c) =>
      c.id === currentCircuit.id ? { ...c, name: newName } : c
    );
    setCircuits(updated);
    try {
      localStorage.setItem('solex_circuits_v8', JSON.stringify(updated));
    } catch (e) {
      console.error(e);
    }
  };

  const handleSaveCircuit = () => {
    if (editTrackPoints.length < 3) {
      alert('Veuillez cliquer au moins 3 points sur la carte pour délimiter le circuit.');
      return;
    }

    const finalName = newCircuitName.trim() || (editingCircuitId ? currentCircuit.name : `Circuit ${circuits.length + 1}`);

    if (editingCircuitId) {
      const updated = circuits.map((c) =>
        c.id === editingCircuitId
          ? { ...c, name: finalName, points: editTrackPoints }
          : c
      );
      setCircuits(updated);
      try {
        localStorage.setItem('solex_circuits_v8', JSON.stringify(updated));
      } catch (e) {
        console.error(e);
      }
      setIsEditingTrack(false);
      setEditingCircuitId(null);
      setEditTrackPoints([]);
      handleResetSimulation();
                    {editingCircuitId ? `✏️ Modification du Tracé de "${currentCircuit.name}"` : "✏️ Tracé d'un Nouveau Circuit"}
    } else {
      const newCircuit: SavedCircuit = {
        id: `circuit-${Date.now()}`,
        name: finalName,
        points: editTrackPoints,
        intermediates: [],
      };
      const updated = [...circuits, newCircuit];
      setCircuits(updated);
      try {
        localStorage.setItem('solex_circuits_v8', JSON.stringify(updated));
      } catch (e) {
        console.error(e);
      }
      setSelectedCircuitId(newCircuit.id);
      setIsEditingTrack(false);
      setEditingCircuitId(null);
      setEditTrackPoints([]);
      handleResetSimulation();
      showToast(`🎉 Circuit "${finalName}" enregistré !`);
    }
  };

  const handleCancelCreateCircuit = () => {
    setIsEditingTrack(false);
    setEditingCircuitId(null);
    setEditTrackPoints([]);
    showToast('Édition de circuit annulée.');
  };

  const handleUndoLastPoint = () => {
    setEditTrackPoints((prev) => prev.slice(0, -1));
  };

  const handleDeleteCircuit = (circuitId: string) => {
    if (circuits.length <= 1) {
      alert('Impossible de supprimer le seul circuit restant.');
      return;
    }
    const toDelete = circuits.find((c) => c.id === circuitId);
    if (!window.confirm(`Confirmez-vous la suppression du circuit "${toDelete?.name}" ?`)) {
      return;
    }
    const updated = circuits.filter((c) => c.id !== circuitId);
    setCircuits(updated);
    try {
      localStorage.setItem('solex_circuits_v8', JSON.stringify(updated));
    } catch (e) {
      console.error(e);
    }
    if (selectedCircuitId === circuitId) {
      setSelectedCircuitId(updated[0].id);
    }
    showToast('Circuit supprimé.');
  };

  const handleDeleteIntermediate = (interId: string) => {
    const updatedIntermediates = (currentCircuit.intermediates || []).filter((i) => i.id !== interId);
    const updated = circuits.map((c) =>
      c.id === currentCircuit.id ? { ...c, intermediates: updatedIntermediates } : c
    );
    setCircuits(updated);
    try {
      localStorage.setItem('solex_circuits_v8', JSON.stringify(updated));
    } catch (e) {
      console.error(e);
    }
    showToast('Balise intermédiaire supprimée.');
  };

  const handleResetPits = () => {
    const updated = circuits.map((c) =>
      c.id === currentCircuit.id
        ? { ...c, pitPolygon: undefined, pitEntryDistance: undefined, pitExitDistance: undefined, pitEntryLatLng: undefined, pitExitLatLng: undefined }
        : c
    );
    setCircuits(updated);
    try {
      localStorage.setItem('solex_circuits_v8', JSON.stringify(updated));
    } catch (e) {
      console.error(e);
    }
    showToast("Zone des stands réinitialisée.");
  };

  const handleStartPitStop = () => {
    setSimInPitStop(true);
    setInPitsState(true);
    setAlertStopped(false);
    pitDurationRef.current = 0;
    setPitTimerSeconds(0);
    
    // Déplacer visuellement le solex au centre de la zone des stands si définie
    const center = getPolygonCenter(currentCircuit.pitPolygon);
    if (center && solexMarkerRef.current) {
      solexMarkerRef.current.setLatLng(center);
      lastKnownPosRef.current = center;
    }
    showToast('⛽ Entrée aux stands simulée ! Chronomètre d\'arrêt lancé.');
  };

  const handleExitPitStop = () => {
    const duration = Math.round(pitDurationRef.current);
    const record: PitStopRecord = {
      id: `pit-${Date.now()}`,
      lap: currentLap,
      driver: currentDriver,
      stint: currentStint,
      duration,
      timestamp: new Date().toLocaleTimeString(),
    };
    setPitHistory((prev) => [record, ...prev]);
    setSimInPitStop(false);
    setInPitsState(false);
    pitDurationRef.current = 0;
    setPitTimerSeconds(0);
    
    // Replacer le solex sur le tracé de la piste
    if (currentCircuit.points.length > 0 && solexMarkerRef.current) {
      const pt = getPositionFromDistance(distanceCoveredInLapRef.current);
      solexMarkerRef.current.setLatLng(pt);
      lastKnownPosRef.current = pt;
    }
    showToast(`🏁 Sortie des stands après ${duration}s d\'arrêt ! Reprise de piste.`);
  };

  const handleSearchLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    try {
      const resp = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}`
      );
      const data = await resp.json();
      if (data && data.length > 0) {
        const lat = parseFloat(data[0].lat);
        const lon = parseFloat(data[0].lon);
        if (mapRef.current) {
          mapRef.current.flyTo([lat, lon], 16, { duration: 1.5 });
          showToast(`📍 Vue déplacée sur : ${data[0].display_name.split(',')[0]}`);
        }
      } else {
        alert('Lieu introuvable.');
      }
    } catch (err) {
      console.error('Erreur recherche', err);
    } finally {
      setIsSearching(false);
    }
  };

  const handleRecenterSolex = () => {
    if (mapRef.current) {
      mapRef.current.panTo(lastKnownPosRef.current, { animate: true });
    }
  };

  const handleOpenExportModal = () => {
    const sql = buildSqlExport(teamId, lapHistory, pitHistory, currentCircuit);
    setExportSqlText(sql);
    setShowExportModal(true);
  };

  const handleDownloadSql = () => {
    const blob = new Blob([exportSqlText], { type: 'text/sql;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `solex_export_${teamId}_${Date.now()}.sql`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadJson = () => {
    const data = {
      teamId,
      circuit: currentCircuit,
      laps: lapHistory,
      pitstops: pitHistory,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `solex_telemetry_${teamId}_${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const formatSec = (sec: number | null) => {
    if (sec === null || isNaN(sec)) return '--:--.-';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 10);
    return `${m}:${s < 10 ? '0' : ''}${s}.${ms}`;
  };

  const filteredLapHistory = useMemo(() => {
    if (filterDriver === 'all') return lapHistory;
    return lapHistory.filter((l) => l.driver === filterDriver);
  }, [lapHistory, filterDriver]);

  const driverStats = useMemo(() => {
    const stats: Record<string, { laps: number; bestLap: number | null; totalTime: number }> = {};
    lapHistory.forEach((l) => {
      if (!stats[l.driver]) {
        stats[l.driver] = { laps: 0, bestLap: null, totalTime: 0 };
      }
      stats[l.driver].laps += 1;
      stats[l.driver].totalTime += l.totalTime;
      if (stats[l.driver].bestLap === null || l.totalTime < stats[l.driver].bestLap!) {
        stats[l.driver].bestLap = l.totalTime;
      }
    });
    return Object.entries(stats).map(([driver, data]) => ({
      driver,
      ...data,
      avgLap: data.laps > 0 ? data.totalTime / data.laps : 0,
    }));
  }, [lapHistory]);

  // ============================================================================
  // RENDU INTERFACE UTILISATEUR
  // ============================================================================
  if (viewRole === 'transmitter') {
    return <SolexTransmitterView onSwitchToStand={() => setViewRole('stand')} defaultServerUrl={serverWsUrl.replace(/^ws/, 'http')} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', background: '#0f172a', color: '#f8fafc', fontFamily: 'sans-serif', overflow: 'hidden' }}>

      {/* EN-TÊTE SUPÉRIEUR & SÉLECTEUR DE RÔLE */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#020617', padding: '8px 16px', borderBottom: '1px solid #1e293b', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '20px' }}>🛵</span>
          <div>
            <h1 style={{ margin: 0, fontSize: '15px', fontWeight: 'bold', color: '#38bdf8' }}>
              SOLEX LIVE TRACKING
            </h1>
            <div style={{ fontSize: '10px', color: '#64748b' }}>Endurance & Chronos Temps Réel</div>
          </div>
        </div>

        {/* ONGLETS DES RÔLES (STANDS & ÉDITEUR) */}
        <div style={{ display: 'flex', gap: '4px', background: '#1e293b', padding: '3px', borderRadius: '6px' }}>
          <button
            onClick={() => setViewRole('stand')}
            style={{
              padding: '6px 14px',
              fontSize: '12px',
              fontWeight: 'bold',
              borderRadius: '5px',
              border: 'none',
              cursor: 'pointer',
              background: viewRole === 'stand' ? '#2563eb' : 'transparent',
              color: viewRole === 'stand' ? 'white' : '#94a3b8',
            }}
          >
            🏁 Écran Stands (Live)
          </button>
          <button
            onClick={() => setViewRole('circuit')}
            style={{
              padding: '6px 14px',
              fontSize: '12px',
              fontWeight: 'bold',
              borderRadius: '5px',
              border: 'none',
              cursor: 'pointer',
              background: viewRole === 'circuit' ? '#f59e0b' : 'transparent',
              color: viewRole === 'circuit' ? 'white' : '#94a3b8',
            }}
          >
            🛠️ Éditeur Circuit
          </button>
          <button
            onClick={() => setViewRole('transmitter')}
            style={{
              padding: '6px 14px',
              fontSize: '12px',
              fontWeight: 'bold',
              borderRadius: '5px',
              border: 'none',
              cursor: 'pointer',
              background: (viewRole as string) === 'transmitter' ? '#10b981' : 'transparent',
              color: (viewRole as string) === 'transmitter' ? 'white' : '#94a3b8',
            }}
          >
            🛵 Balise Solex (APK)
          </button>
        </div>

        {/* Statut serveur relais */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px' }}>
          <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: isWsConnected ? '#22c55e' : '#ef4444' }} />
          <span style={{ color: isWsConnected ? '#86efac' : '#fca5a5' }}>
            {isWsConnected ? 'Relais Connecté' : 'Relais Hors Ligne'}
          </span>
          <span style={{ color: '#64748b' }}>({teamId})</span>
        </div>
      </div>

      {/* Toast de notification */}
      {notificationMsg && (
        <div style={{ backgroundColor: '#059669', color: 'white', padding: '8px 14px', borderRadius: '6px', textAlign: 'center', fontWeight: 'bold', fontSize: '13px', boxShadow: '0 4px 10px rgba(0,0,0,0.4)', margin: '4px 16px 0 16px', zIndex: 1000 }}>
          {notificationMsg}
        </div>
      )}

      {/* ==================================================================== */}
      {/* CONTENU PRINCIPAL : STANDS & ÉDITEUR CIRCUIT */}
      {/* ==================================================================== */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px', padding: '8px 16px', minHeight: 0 }}>

        {/* ALERTES STANDS */}
        {alertStopped && (
          <div style={{ backgroundColor: '#dc2626', color: 'white', padding: '10px 14px', borderRadius: '8px', textAlign: 'center', fontWeight: 'bold', fontSize: '15px', border: '2px solid #fecaca', boxShadow: '0 0 15px rgba(220,38,38,0.7)' }}>
            🚨 ALERTE STANDS : SOLEX IMMOBILISÉ EN PISTE DEPUIS {stopElapsedSeconds}s ! (Hors zone de stands)
          </div>
        )}

        {alertSignalLost && (
          <div style={{ backgroundColor: '#ea580c', color: 'white', padding: '10px 14px', borderRadius: '8px', textAlign: 'center', fontWeight: 'bold', fontSize: '15px', border: '2px solid #fed7aa', boxShadow: '0 0 15px rgba(234,88,12,0.7)' }}>
            📡 ALERTE STANDS : PERTE DE SIGNAL TÉLÉMÉTRIE DEPUIS {signalLostElapsedSeconds}s !
          </div>
        )}

        {(inPitsState || simInPitStop) && (
          <div style={{ backgroundColor: '#1d4ed8', color: 'white', padding: '8px 12px', borderRadius: '6px', textAlign: 'center', fontWeight: 'bold', fontSize: '13px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '12px' }}>
            <span>⛽ SOLEX ACTUELLEMENT AUX STANDS</span>
            <span style={{ background: '#3b82f6', padding: '3px 8px', borderRadius: '4px' }}>
              ⏱️ Temps d'arrêt : <strong>{pitTimerSeconds}s</strong>
            </span>
            <span>👤 {currentDriver} (Relais #{currentStint})</span>
            {simInPitStop && (
              <button
                onClick={handleExitPitStop}
                style={{ background: '#10b981', color: 'white', border: 'none', padding: '4px 10px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px' }}
              >
                🏁 Sortir des stands & reprendre la piste
              </button>
            )}
          </div>
        )}

        {/* BARRE D'OUTILS PRINCIPALE */}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', background: '#1e293b', padding: '8px 12px', borderRadius: '8px' }}>

          {/* Sélecteur source de données (uniquement en vue Stands) */}
          {viewRole === 'stand' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', background: '#0f172a', padding: '3px 6px', borderRadius: '6px', border: '1px solid #334155' }}>
              <span style={{ fontSize: '11px', color: '#94a3b8' }}>Source :</span>
              <button
                onClick={() => setStandDataSource('live')}
                style={{
                  padding: '4px 8px',
                  fontSize: '11px',
                  fontWeight: 'bold',
                  borderRadius: '4px',
                  border: 'none',
                  cursor: 'pointer',
                  background: standDataSource === 'live' ? '#16a34a' : 'transparent',
                  color: standDataSource === 'live' ? 'white' : '#94a3b8',
                }}
              >
                📡 Direct (GPS Réel)
              </button>
              <button
                onClick={() => setStandDataSource('simulation')}
                style={{
                  padding: '4px 8px',
                  fontSize: '11px',
                  fontWeight: 'bold',
                  borderRadius: '4px',
                  border: 'none',
                  cursor: 'pointer',
                  background: standDataSource === 'simulation' ? '#2563eb' : 'transparent',
                  color: standDataSource === 'simulation' ? 'white' : '#94a3b8',
                }}
              >
                🎮 Démo (Simulation)
              </button>
            </div>
          )}

          {/* Choix du circuit + BOUTON NOUVEAU CIRCUIT */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '12px', color: '#94a3b8' }}>Circuit :</span>
            <select
              value={selectedCircuitId}
              onChange={(e) => {
                setSelectedCircuitId(e.target.value);
                handleResetSimulation();
                setPlacementMode('none');
              }}
              disabled={isEditingTrack}
              style={{ padding: '5px 8px', background: '#334155', color: 'white', border: '1px solid #475569', borderRadius: '6px', fontSize: '12px' }}
            >
              {circuits.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>

            {/* BOUTON CRÉER UN CIRCUIT */}
            <button
              onClick={handleStartCreateCircuit}
              style={{
                padding: '5px 10px',
                background: '#10b981',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '12px',
                fontWeight: 'bold',
              }}
              title="Tracer un tout nouveau circuit au clic sur la carte"
            >
              ➕ Nouveau Circuit
            </button>

            {/* BOUTON MODIFIER CE CIRCUIT */}
            <button
              onClick={() => {
                setViewRole('circuit');
                setPlacementMode('none');
                showToast(`🛠️ Éditeur ouvert pour "${currentCircuit.name}". Choisissez l'élément à modifier ci-dessous.`);
              }}
              style={{
                padding: '5px 10px',
                background: '#d97706',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '12px',
                fontWeight: 'bold',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
              }}
              title="Modifier les balises, la ligne de départ ou le tracé de ce circuit"
            >
              ✏️ Modifier ce Circuit
            </button>
          </div>

          {/* Pilote en cours */}
          {viewRole === 'stand' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: '#0f172a', padding: '4px 8px', borderRadius: '6px', border: '1px solid #334155' }}>
              <span style={{ fontSize: '11px', color: '#94a3b8' }}>Au guidon :</span>
              <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#38bdf8' }}>{currentDriver}</span>
              <span style={{ fontSize: '10px', background: '#334155', padding: '2px 5px', borderRadius: '4px', color: '#cbd5e1' }}>R#{currentStint}</span>
              <button
                onClick={() => setShowDriverModal(true)}
                style={{ padding: '3px 7px', background: '#2563eb', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}
              >
                🔄 Relais
              </button>
            </div>
          )}

          {/* Fond de carte */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', background: '#0f172a', padding: '3px 6px', borderRadius: '6px', border: '1px solid #334155' }}>
            <button
              onClick={() => setMapLayerType('satellite')}
              style={{ padding: '4px 6px', fontSize: '11px', fontWeight: 'bold', borderRadius: '4px', border: 'none', cursor: 'pointer', background: mapLayerType === 'satellite' ? '#2563eb' : 'transparent', color: mapLayerType === 'satellite' ? 'white' : '#94a3b8' }}
            >
              🛰️ Sat
            </button>
            <button
              onClick={() => setMapLayerType('streets')}
              style={{ padding: '4px 6px', fontSize: '11px', fontWeight: 'bold', borderRadius: '4px', border: 'none', cursor: 'pointer', background: mapLayerType === 'streets' ? '#2563eb' : 'transparent', color: mapLayerType === 'streets' ? 'white' : '#94a3b8' }}
            >
              🗺️ Plan
            </button>
            <button
              onClick={() => setMapLayerType('dark')}
              style={{ padding: '4px 6px', fontSize: '11px', fontWeight: 'bold', borderRadius: '4px', border: 'none', cursor: 'pointer', background: mapLayerType === 'dark' ? '#2563eb' : 'transparent', color: mapLayerType === 'dark' ? 'white' : '#94a3b8' }}
            >
              🌙 Nuit
            </button>
          </div>

          {/* Recherche de lieu */}
          <form onSubmit={handleSearchLocation} style={{ display: 'flex', gap: '4px', flex: '1', minWidth: '130px' }}>
            <input
              type="text"
              placeholder="Chercher un lieu..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ flex: 1, padding: '5px 8px', background: '#334155', color: 'white', border: '1px solid #475569', borderRadius: '6px', fontSize: '12px' }}
            />
            <button type="submit" disabled={isSearching} style={{ padding: '5px 8px', background: '#475569', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' }}>
              {isSearching ? '...' : '🔍'}
            </button>
          </form>

          <button onClick={handleRecenterSolex} style={{ padding: '5px 8px', background: '#334155', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' }}>
            🎯 Centrer
          </button>

          {/* Export SQL */}
          <button
            onClick={handleOpenExportModal}
            style={{ padding: '5px 10px', background: '#7c3aed', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}
          >
            💾 Données SQL
          </button>
        </div>

        {/* BANDEAU DE CONTRÔLE DE SIMULATION COMPLET (ARRÊT / MARCHE / RESET / TESTS) */}
        {viewRole === 'stand' && standDataSource === 'simulation' && (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', background: '#020617', padding: '8px 12px', borderRadius: '8px', border: '1px solid #1e293b', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#38bdf8' }}>🎮 Simulation :</span>

            {/* BOUTON ARRÊTER / DÉMARRER LA SIMULATION */}
            <button
              onClick={handleToggleSimulation}
              style={{
                padding: '6px 14px',
                background: isSimRunning ? '#eab308' : '#16a34a',
                color: isSimRunning ? '#0f172a' : 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '12px',
                fontWeight: 'bold',
                boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
              }}
            >
              {isSimRunning ? '⏸️ Mettre en Pause / Arrêter' : '▶️ Démarrer la Simulation'}
            </button>

            {/* BOUTON RÉINITIALISER */}
            <button
              onClick={handleResetSimulation}
              style={{
                padding: '6px 12px',
                background: '#475569',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '12px',
                fontWeight: 'bold',
              }}
              title="Remet le tour à 1, efface les chronos et replace le Solex sur la ligne de départ"
            >
              🔄 Remise à Zéro
            </button>

            {/* Vitesse cible */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: '#0f172a', padding: '3px 8px', borderRadius: '6px', border: '1px solid #334155' }}>
              <span style={{ fontSize: '11px', color: '#94a3b8' }}>Vitesse cible :</span>
              {[60, 85, 105].map((spd) => (
                <button
                  key={spd}
                  onClick={() => setTargetSpeed(spd)}
                  style={{
                    padding: '2px 6px',
                    fontSize: '11px',
                    borderRadius: '4px',
                    border: 'none',
                    cursor: 'pointer',
                    background: targetSpeed === spd ? '#2563eb' : '#334155',
                    color: targetSpeed === spd ? 'white' : '#94a3b8',
                    fontWeight: targetSpeed === spd ? 'bold' : 'normal',
                  }}
                >
                  {spd} km/h
                </button>
              ))}
            </div>

            <div style={{ height: '16px', width: '1px', background: '#334155' }} />

            {/* BOUTONS DE SCÉNARIOS D'INCIDENTS */}
            <button
              onClick={() => setSimStopped((s) => !s)}
              style={{
                padding: '5px 10px',
                background: simStopped ? '#10b981' : '#dc2626',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '11px',
                fontWeight: 'bold',
              }}
            >
              {simStopped ? '▶️ Reprendre Piste' : '⚠️ Simuler Panne Piste'}
            </button>

            {!simInPitStop ? (
              <button
                onClick={handleStartPitStop}
                style={{
                  padding: '5px 11px',
                  background: '#2563eb',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '11px',
                  fontWeight: 'bold',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                ⛽ Simuler Entrée Stand
              </button>
            ) : (
              <button
                onClick={handleExitPitStop}
                style={{
                  padding: '5px 11px',
                  background: '#16a34a',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '11px',
                  fontWeight: 'bold',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  boxShadow: '0 0 10px rgba(22, 163, 74, 0.6)',
                }}
              >
                🏁 Sortir Stand ({pitTimerSeconds}s)
              </button>
            )}

            <button
              onClick={() => setSimSignalLost((v) => !v)}
              style={{
                padding: '5px 10px',
                background: simSignalLost ? '#10b981' : '#ea580c',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '11px',
                fontWeight: 'bold',
              }}
            >
              {simSignalLost ? '▶️ Rétablir Signal 4G' : '📡 Simuler Coupure 4G'}
            </button>
          </div>
        )}

        {/* ZONE PRINCIPALE : CARTE + PANNEAU LATÉRAL (STANDS OU ÉDITEUR) */}
        <div style={{ display: 'flex', flex: 1, gap: '10px', minHeight: 0 }}>

          {/* CARTE LEAFLET COMMUNE */}
          <div style={{ flex: 2, position: 'relative', borderRadius: '8px', overflow: 'hidden', border: '1px solid #334155' }}>
            <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />

            {/* BANDEAU OVERLAY MODE TRACÉ EN COURS */}
            {isEditingTrack && (
              <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', background: '#0f172a', border: '2px solid #f59e0b', color: 'white', padding: '8px 16px', borderRadius: '8px', zIndex: 1000, boxShadow: '0 4px 15px rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#f59e0b' }}>
                  ✏️ Mode Tracé Actif :
                </span>
                <span style={{ fontSize: '12px', color: '#cbd5e1' }}>
                  Cliquez sur la carte pour tracer le circuit (<strong>{editTrackPoints.length}</strong> pts - <strong>~{drawnDistanceMeters}m</strong>)
                </span>
              </div>
            )}

            {/* Instructions de placement au clic (Balises, départ, stands) */}
            {placementMode !== 'none' && !isEditingTrack && (
              <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', background: '#f59e0b', color: '#0f172a', padding: '8px 16px', borderRadius: '8px', fontWeight: 'bold', fontSize: '13px', zIndex: 1000, boxShadow: '0 4px 15px rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span>
                  {placementMode === 'startLine' && '🏁 Cliquez sur la piste pour y déplacer le Départ / Arrivée (km 0)'}
                  {placementMode === 'intermediate' && '📍 Cliquez sur la piste pour poser une nouvelle balise secteur'}
                  {placementMode === 'move_intermediate' && '🔄 Cliquez sur la piste pour repositionner la balise sélectionnée'}
                  {placementMode === 'pitPolygon' && "📐 Cliquez sur la carte pour poser les sommets du polygone des stands (min 3 points, puis validez)"}
                  
                </span>
                <button
                  onClick={() => {
                    setPlacementMode('none');
                    setMovingIntermediateId(null);
                  }}
                  style={{ background: '#0f172a', color: 'white', border: 'none', borderRadius: '6px', padding: '4px 8px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}
                >
                  ✕ Annuler
                </button>
              </div>
            )}
          </div>

          {/* ==================================================================== */}
          {/* PANNEAU LATÉRAL 1 : ÉDITEUR CIRCUIT (SI RÔLE ÉDITEUR) */}
          {/* ==================================================================== */}
          {viewRole === 'circuit' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '10px', background: '#1e293b', padding: '14px', borderRadius: '8px', border: '1px solid #f59e0b', minWidth: '330px', overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #334155', paddingBottom: '8px' }}>
                <h3 style={{ margin: 0, fontSize: '16px', color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  🛠️ Éditeur de Circuit
                </h3>
                <span style={{ fontSize: '11px', background: '#0f172a', padding: '3px 8px', borderRadius: '4px', color: '#38bdf8', fontWeight: 'bold' }}>
                  {trackMetrics.totalDistanceMeters ? `${Math.round(trackMetrics.totalDistanceMeters)} m` : '0 m'}
                </span>
              </div>

              {/* CARTE 1 : INFORMATIONS & MODIFICATION DU TRACÉ */}
              {isEditingTrack ? (
                <div style={{ background: '#0f172a', padding: '12px', borderRadius: '8px', border: '2px solid #f59e0b', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#fbbf24' }}>
                    {editingCircuitId ? `✏️ Modification du Tracé de "${currentCircuit.name}"` : "✏️ Tracé d'un Nouveau Circuit"}
                  </div>
                  <div>
                    <label style={{ fontSize: '11px', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>Nom du circuit :</label>
                    <input
                      type="text"
                      value={newCircuitName}
                      onChange={(e) => setNewCircuitName(e.target.value)}
                      placeholder="Nom du circuit..."
                      style={{ width: '100%', padding: '6px 8px', background: '#1e293b', color: 'white', border: '1px solid #475569', borderRadius: '6px', fontSize: '12px', boxSizing: 'border-box' }}
                    />
                  </div>
                  <div style={{ fontSize: '12px', color: '#94a3b8' }}>
                    Points déposés : <strong style={{ color: '#38bdf8' }}>{editTrackPoints.length}</strong> (~{drawnDistanceMeters} m)
                  </div>

                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      onClick={handleSaveCircuit}
                      disabled={editTrackPoints.length < 3}
                      style={{
                        flex: 1,
                        padding: '8px',
                        background: editTrackPoints.length >= 3 ? '#10b981' : '#334155',
                        color: 'white',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: editTrackPoints.length >= 3 ? 'pointer' : 'not-allowed',
                        fontWeight: 'bold',
                        fontSize: '12px',
                      }}
                    >
                      💾 Enregistrer le Tracé
                    </button>
                    <button
                      onClick={handleUndoLastPoint}
                      disabled={editTrackPoints.length === 0}
                      style={{ padding: '8px 10px', background: '#334155', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' }}
                      title="Retirer le dernier point cliqué"
                    >
                      ↩️
                    </button>
                    <button
                      onClick={handleCancelCreateCircuit}
                      style={{ padding: '8px 10px', background: '#dc2626', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' }}
                      title="Annuler"
                    >
                      ❌
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ background: '#0f172a', padding: '10px 12px', borderRadius: '8px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '11px', color: '#94a3b8' }}>Nom du circuit :</span>
                    <span style={{ fontSize: '10px', color: '#64748b' }}>{currentCircuit.points.length} points</span>
                  </div>
                  <input
                    type="text"
                    value={currentCircuit.name}
                    onChange={(e) => handleRenameCurrentCircuit(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '6px 8px',
                      background: '#1e293b',
                      color: '#f59e0b',
                      border: '1px solid #475569',
                      borderRadius: '6px',
                      fontSize: '13px',
                      fontWeight: 'bold',
                      boxSizing: 'border-box',
                    }}
                    title="Cliquez pour renommer ce circuit"
                  />
                  <div style={{ display: 'flex', gap: '6px', marginTop: '2px' }}>
                    <button
                      onClick={handleStartEditCurrentCircuit}
                      style={{
                        flex: 1,
                        padding: '8px',
                        background: '#d97706',
                        color: 'white',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontWeight: 'bold',
                        fontSize: '11px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '4px',
                      }}
                      title="Modifier les points du tracé sur la carte"
                    >
                      ✏️ Modifier le Tracé
                    </button>
                    <button
                      onClick={handleStartCreateCircuit}
                      style={{
                        flex: 1,
                        padding: '8px',
                        background: '#10b981',
                        color: 'white',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontWeight: 'bold',
                        fontSize: '11px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '4px',
                      }}
                      title="Créer un tout nouveau circuit"
                    >
                      ➕ Nouveau Circuit
                    </button>
                  </div>
                </div>
              )}

              {/* CARTE 2 : LIGNE DE DÉPART / ARRIVÉE */}
              <div style={{ background: '#0f172a', padding: '12px', borderRadius: '8px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ fontSize: '12px', fontWeight: 'bold', color: '#10b981', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>🏁 Ligne Départ / Arrivée</span>
                  <span style={{ fontSize: '10px', color: '#94a3b8' }}>km 0</span>
                </div>
                <button
                  onClick={() => {
                    const nextMode = placementMode === 'startLine' ? 'none' : 'startLine';
                    setPlacementMode(nextMode);
                    if (nextMode === 'startLine') {
                      showToast('Cliquez sur la piste pour y déplacer la ligne de départ / arrivée.');
                    }
                  }}
                  style={{
                    padding: '8px 10px',
                    background: placementMode === 'startLine' ? '#16a34a' : '#1e293b',
                    color: 'white',
                    border: '1px solid #16a34a',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '12px',
                    fontWeight: 'bold',
                    textAlign: 'left',
                  }}
                >
                  {placementMode === 'startLine' ? '👉 Cliquez sur la piste...' : '🔄 Déplacer Ligne Départ / Arrivée'}
                </button>
              </div>

              {/* CARTE 3 : BALISES INTERMÉDIAIRES (SECTEURS S1, S2...) */}
              <div style={{ background: '#0f172a', padding: '12px', borderRadius: '8px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#f59e0b' }}>📍 Balises Intermédiaires (Secteurs)</span>
                  <span style={{ fontSize: '11px', color: '#94a3b8' }}>{sortedIntermediates.length} active(s)</span>
                </div>

                <button
                  onClick={() => {
                    const nextMode = placementMode === 'intermediate' ? 'none' : 'intermediate';
                    setPlacementMode(nextMode);
                    if (nextMode === 'intermediate') {
                      showToast('Cliquez sur la piste pour poser une nouvelle balise secteur.');
                    }
                  }}
                  style={{
                    padding: '8px 10px',
                    background: placementMode === 'intermediate' ? '#f59e0b' : '#1e293b',
                    color: placementMode === 'intermediate' ? '#0f172a' : 'white',
                    border: '1px solid #f59e0b',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '12px',
                    fontWeight: 'bold',
                    textAlign: 'left',
                  }}
                >
                  {placementMode === 'intermediate' ? '👉 Cliquez sur la piste pour poser S...' : '➕ Ajouter une Balise Secteur (S)'}
                </button>

                {/* Liste des balises existantes avec bouton Déplacer individuel */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '2px' }}>
                  {sortedIntermediates.length === 0 ? (
                    <div style={{ fontSize: '11px', color: '#64748b', fontStyle: 'italic', padding: '4px 0' }}>
                      Aucune balise intermédiaire. Cliquez sur le bouton ci-dessus pour en ajouter.
                    </div>
                  ) : (
                    sortedIntermediates.map((inter) => {
                      const isBeingMoved = placementMode === 'move_intermediate' && movingIntermediateId === inter.id;
                      return (
                        <div
                          key={inter.id}
                          style={{
                            fontSize: '11px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '6px 8px',
                            background: isBeingMoved ? '#451a03' : '#1e293b',
                            border: isBeingMoved ? '1px solid #f59e0b' : '1px solid #334155',
                            borderRadius: '6px',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ color: '#f59e0b', fontWeight: 'bold' }}>📍 {inter.name}</span>
                            <span style={{ color: '#94a3b8' }}>({Math.round(inter.distance)} m)</span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <button
                              onClick={() => {
                                if (isBeingMoved) {
                                  setPlacementMode('none');
                                  setMovingIntermediateId(null);
                                } else {
                                  setPlacementMode('move_intermediate');
                                  setMovingIntermediateId(inter.id);
                                  showToast(`Cliquez sur la piste pour repositionner la balise ${inter.name}.`);
                                }
                              }}
                              style={{
                                padding: '3px 6px',
                                background: isBeingMoved ? '#f59e0b' : '#334155',
                                color: isBeingMoved ? '#0f172a' : '#38bdf8',
                                border: 'none',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                fontSize: '10px',
                                fontWeight: 'bold',
                              }}
                              title={`Déplacer la balise ${inter.name}`}
                            >
                              {isBeingMoved ? '👉 Cliquez...' : '🔄 Déplacer'}
                            </button>
                            <button
                              onClick={() => handleDeleteIntermediate(inter.id)}
                              style={{
                                padding: '3px 6px',
                                background: '#ef444422',
                                color: '#ef4444',
                                border: '1px solid #ef4444',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                fontSize: '10px',
                              }}
                              title="Supprimer cette balise"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* CARTE 4 : ZONE DES STANDS (POLYGONE HORS TRACÉ) */}
              <div style={{ background: '#0f172a', padding: '12px', borderRadius: '8px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: '12px', fontWeight: 'bold', color: '#38bdf8' }}>
                    ⛽ Zone des Stands (Polygone Hors Tracé)
                  </div>
                  {currentCircuit.pitPolygon && currentCircuit.pitPolygon.length >= 3 && (
                    <span style={{ fontSize: '10px', background: '#1e3a8a', color: '#93c5fd', padding: '2px 6px', borderRadius: '4px' }}>
                      {currentCircuit.pitPolygon.length} sommets
                    </span>
                  )}
                </div>

                <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8', lineHeight: '1.4' }}>
                  Tracez une zone libre (rectangle ou polygone) englobant votre allée des stands en cliquant sur la carte.
                </p>

                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <button
                    onClick={() => {
                      const nextMode = placementMode === 'pitPolygon' ? 'none' : 'pitPolygon';
                      setPlacementMode(nextMode);
                      if (nextMode === 'pitPolygon') {
                        showToast("📐 Cliquez sur la carte pour poser les sommets du polygone des stands.");
                      }
                    }}
                    style={{
                      flex: 1,
                      padding: '8px',
                      background: placementMode === 'pitPolygon' ? '#2563eb' : '#1e293b',
                      color: 'white',
                      border: '1px solid #2563eb',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontSize: '11px',
                      fontWeight: 'bold',
                    }}
                  >
                    {placementMode === 'pitPolygon' ? '👉 Cliquez sur la carte...' : '📐 Définir / Redessiner Zone'}
                  </button>

                  {placementMode === 'pitPolygon' && (currentCircuit.pitPolygon?.length || 0) >= 3 && (
                    <button
                      onClick={() => {
                        setPlacementMode('none');
                        showToast(`✅ Zone stands validée avec ${currentCircuit.pitPolygon?.length} sommets !`);
                      }}
                      style={{
                        padding: '8px 12px',
                        background: '#16a34a',
                        color: 'white',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontSize: '11px',
                        fontWeight: 'bold',
                      }}
                    >
                      ✅ Valider
                    </button>
                  )}

                  {currentCircuit.pitPolygon && currentCircuit.pitPolygon.length > 0 && (
                    <button
                      onClick={handleResetPits}
                      style={{
                        padding: '8px 10px',
                        background: '#ef4444',
                        color: 'white',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontSize: '11px',
                        fontWeight: 'bold',
                      }}
                      title="Effacer le polygone des stands"
                    >
                      🗑️ Effacer
                    </button>
                  )}
                </div>

                <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>
                  {currentCircuit.pitPolygon && currentCircuit.pitPolygon.length >= 3
                    ? `Zone active (${currentCircuit.pitPolygon.length} sommets) - Neutralise les alertes d'arrêt en piste.`
                    : 'Aucun polygone défini. Cliquez sur Définir puis posez au moins 3 points sur la carte.'}
                </div>
              </div>

              {/* BOUTONS NAVIGATION & ACTIONS */}
              <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <button
                  onClick={() => setViewRole('stand')}
                  style={{
                    padding: '10px',
                    background: '#2563eb',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    fontSize: '12px',
                  }}
                >
                  🏁 Retourner au Tableau des Stands
                </button>

                {circuits.length > 1 && (
                  <button
                    onClick={() => handleDeleteCircuit(currentCircuit.id)}
                    style={{
                      padding: '6px',
                      background: 'transparent',
                      color: '#ef4444',
                      border: '1px solid #ef4444',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontSize: '11px',
                    }}
                  >
                    🗑️ Supprimer ce circuit
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ==================================================================== */}
          {/* PANNEAU LATÉRAL 2 : STANDS (TÉLÉMÉTRIE, CADRANS & CHRONOS) */}
          {/* ==================================================================== */}
          {viewRole === 'stand' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px', background: '#1e293b', padding: '10px', borderRadius: '8px', border: '1px solid #334155', minWidth: '310px' }}>

              {/* CADRANS VITESSE & TOUR */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <div style={{ background: '#0f172a', padding: '10px', borderRadius: '6px', textAlign: 'center', border: '1px solid #334155' }}>
                  <div style={{ fontSize: '11px', color: '#94a3b8' }}>VITESSE SOLEX</div>
                  <div style={{ fontSize: '28px', fontWeight: 'bold', color: speed > 90 ? '#f87171' : '#38bdf8' }}>
                    {speed} <span style={{ fontSize: '13px' }}>km/h</span>
                  </div>
                </div>

                <div style={{ background: '#0f172a', padding: '10px', borderRadius: '6px', textAlign: 'center', border: '1px solid #334155' }}>
                  <div style={{ fontSize: '11px', color: '#94a3b8' }}>TOUR EN COURS</div>
                  <div style={{ fontSize: '28px', fontWeight: 'bold', color: '#4ade80' }}>
                    #{currentLap}
                  </div>
                </div>
              </div>

              {/* CHRONOMÈTRE TOUR & MEILLEUR TOUR */}
              <div style={{ background: '#0f172a', padding: '10px', borderRadius: '6px', border: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: '10px', color: '#94a3b8' }}>CHRONO TOUR ACTUEL</div>
                  <div style={{ fontSize: '22px', fontWeight: 'bold', color: '#f8fafc', fontFamily: 'monospace' }}>
                    {formatSec(currentLapTime)}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '10px', color: '#94a3b8' }}>MEILLEUR TOUR</div>
                  <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#fbbf24', fontFamily: 'monospace' }}>
                    {formatSec(bestLapTime)}
                  </div>
                </div>
              </div>

              {/* SECTEURS INTERMÉDIAIRES */}
              {sortedIntermediates.length > 0 && (
                <div style={{ background: '#0f172a', padding: '8px', borderRadius: '6px', border: '1px solid #334155' }}>
                  <div style={{ fontSize: '10px', color: '#94a3b8', marginBottom: '4px' }}>SECTEURS INTERMÉDIAIRES (DEPUIS LE DÉPART)</div>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {sortedIntermediates.map((inter, idx) => {
                      const split = liveSplitTimes[idx];
                      const hasSplit = typeof split === 'number';
                      return (
                        <div key={inter.id} style={{ flex: 1, minWidth: '60px', background: '#1e293b', padding: '4px 6px', borderRadius: '4px', textAlign: 'center' }}>
                          <div style={{ fontSize: '10px', color: '#f59e0b', fontWeight: 'bold' }}>{inter.name}</div>
                          <div style={{ fontSize: '11px', fontFamily: 'monospace', color: hasSplit ? '#4ade80' : '#64748b' }}>
                            {hasSplit ? (split >= 60 ? formatSec(split) : `${split.toFixed(1)}s`) : '--.-'}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ONGLETS HISTORIQUE DES TOURS, STANDS ET STATS PILOTES */}
              <div style={{ display: 'flex', borderBottom: '1px solid #334155', marginTop: '4px' }}>
                <button
                  onClick={() => setActiveTab('laps')}
                  style={{
                    flex: 1,
                    padding: '6px',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: activeTab === 'laps' ? '2px solid #38bdf8' : 'none',
                    color: activeTab === 'laps' ? '#38bdf8' : '#94a3b8',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    fontSize: '11px',
                  }}
                >
                  🏁 Tours ({lapHistory.length})
                </button>
                <button
                  onClick={() => setActiveTab('pitstops')}
                  style={{
                    flex: 1,
                    padding: '6px',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: activeTab === 'pitstops' ? '2px solid #38bdf8' : 'none',
                    color: activeTab === 'pitstops' ? '#38bdf8' : '#94a3b8',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    fontSize: '11px',
                  }}
                >
                  ⛽ Stands ({pitHistory.length})
                </button>
                <button
                  onClick={() => setActiveTab('driverStats')}
                  style={{
                    flex: 1,
                    padding: '6px',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: activeTab === 'driverStats' ? '2px solid #38bdf8' : 'none',
                    color: activeTab === 'driverStats' ? '#38bdf8' : '#94a3b8',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    fontSize: '11px',
                  }}
                >
                  👤 Pilotes
                </button>
              </div>

              {/* CONTENU ONGLETS */}
              <div style={{ flex: 1, overflowY: 'auto', background: '#0f172a', padding: '6px', borderRadius: '6px', border: '1px solid #334155', minHeight: '130px' }}>
                {activeTab === 'laps' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                      <span style={{ fontSize: '10px', color: '#94a3b8' }}>Filtrer par pilote :</span>
                      <select
                        value={filterDriver}
                        onChange={(e) => setFilterDriver(e.target.value)}
                        style={{ padding: '2px 4px', background: '#1e293b', color: 'white', border: '1px solid #475569', borderRadius: '4px', fontSize: '10px' }}
                      >
                        <option value="all">Tous les pilotes</option>
                        {driversList.map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>
                    </div>

                    {filteredLapHistory.length === 0 ? (
                      <div style={{ textAlign: 'center', color: '#64748b', fontSize: '11px', padding: '20px 0' }}>
                        Aucun tour enregistré.
                      </div>
                    ) : (
                      filteredLapHistory.map((item) => (
                        <div key={item.id || item.lap} style={{ display: 'flex', flexDirection: 'column', gap: '4px', background: '#1e293b', padding: '6px 8px', borderRadius: '4px', fontSize: '11px', borderLeft: item.totalTime === bestLapTime ? '3px solid #fbbf24' : '3px solid #3b82f6' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                              <span style={{ fontWeight: 'bold', color: '#38bdf8' }}>Tour #{item.lap}</span>
                              <span style={{ fontSize: '10px', color: '#94a3b8', marginLeft: '6px' }}>({item.driver})</span>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                              <span style={{ fontFamily: 'monospace', fontWeight: 'bold' }}>{formatSec(item.totalTime)}</span>
                              <span style={{ fontSize: '10px', color: '#94a3b8', marginLeft: '6px' }}>{item.avgSpeed} km/h</span>
                            </div>
                          </div>
                          {item.intermediateTimes && item.intermediateTimes.length > 0 && item.intermediateTimes.some((t) => typeof t === 'number') && (
                            <div style={{ display: 'flex', gap: '8px', fontSize: '10px', color: '#94a3b8', borderTop: '1px solid #334155', paddingTop: '3px', flexWrap: 'wrap' }}>
                              {item.intermediateTimes.map((t, idx) => {
                                const interName = sortedIntermediates[idx]?.name || `S${idx + 1}`;
                                return (
                                  <span key={idx}>
                                    <strong style={{ color: '#f59e0b' }}>{interName} :</strong>{' '}
                                    <span style={{ fontFamily: 'monospace', color: typeof t === 'number' ? '#e2e8f0' : '#64748b' }}>
                                      {typeof t === 'number' ? (t >= 60 ? formatSec(t) : `${t.toFixed(1)}s`) : '--.-'}
                                    </span>
                                  </span>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}

                {activeTab === 'pitstops' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {pitHistory.length === 0 ? (
                      <div style={{ textAlign: 'center', color: '#64748b', fontSize: '11px', padding: '20px 0' }}>
                        Aucun arrêt aux stands.
                      </div>
                    ) : (
                      pitHistory.map((p) => (
                        <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#1e293b', padding: '6px 8px', borderRadius: '4px', fontSize: '11px' }}>
                          <div>
                            <span style={{ fontWeight: 'bold', color: '#eab308' }}>Arrêt Tour #{p.lap}</span>
                            <span style={{ fontSize: '10px', color: '#94a3b8', marginLeft: '6px' }}>({p.driver})</span>
                          </div>
                          <div style={{ fontWeight: 'bold', color: '#f8fafc' }}>
                            ⏱️ {p.duration}s
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {activeTab === 'driverStats' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {driverStats.map((s) => (
                      <div key={s.driver} style={{ background: '#1e293b', padding: '6px 8px', borderRadius: '4px', fontSize: '11px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold', color: '#38bdf8' }}>
                          <span>👤 {s.driver}</span>
                          <span>{s.laps} tour(s)</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8', marginTop: '2px', fontSize: '10px' }}>
                          <span>Meilleur : <strong style={{ color: '#fbbf24' }}>{formatSec(s.bestLap)}</strong></span>
                          <span>Moyenne : <strong>{formatSec(s.avgLap)}</strong></span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ==================================================================== */}
      {/* MODALE EXPORT DONNÉES SQL / JSON */}
      {/* ==================================================================== */}
      {showExportModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          <div style={{ background: '#1e293b', padding: '20px', borderRadius: '10px', border: '2px solid #7c3aed', width: '600px', maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '85vh' }}>
            <h3 style={{ margin: 0, fontSize: '16px', color: '#c084fc' }}>💾 Données Course & Schéma SQL Prêt à l'Emploi</h3>
            <p style={{ margin: 0, fontSize: '12px', color: '#94a3b8' }}>
              Les données sont formatées selon la structure SQL finale (PostgreSQL / Supabase). Vous pouvez télécharger le script SQL complet ou le fichier JSON.
            </p>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={handleDownloadSql}
                style={{ flex: 1, padding: '8px', background: '#7c3aed', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px' }}
              >
                📥 Télécharger Script .sql
              </button>
              <button
                onClick={handleDownloadJson}
                style={{ flex: 1, padding: '8px', background: '#2563eb', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px' }}
              >
                📥 Télécharger Fichier .json
              </button>
            </div>

            <textarea
              readOnly
              value={exportSqlText}
              style={{ flex: 1, minHeight: '220px', background: '#0f172a', color: '#4ade80', fontFamily: 'monospace', fontSize: '11px', padding: '10px', borderRadius: '6px', border: '1px solid #334155', resize: 'none' }}
            />

            <button
              onClick={() => setShowExportModal(false)}
              style={{ padding: '8px', background: '#64748b', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' }}
            >
              Fermer
            </button>
          </div>
        </div>
      )}

      {/* MODALE CHANGEMENT DE PILOTE (RELAIS) */}
      {showDriverModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#1e293b', padding: '20px', borderRadius: '10px', border: '2px solid #3b82f6', width: '320px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <h3 style={{ margin: 0, fontSize: '15px', color: '#f8fafc' }}>🔄 Changement de pilote / Nouveau relais</h3>
            <div>
              <label style={{ fontSize: '11px', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>Pilote prenant le guidon :</label>
              <select
                value={currentDriver}
                onChange={(e) => setCurrentDriver(e.target.value)}
                style={{ width: '100%', padding: '6px', background: '#0f172a', color: 'white', border: '1px solid #475569', borderRadius: '6px', fontSize: '12px' }}
              >
                {driversList.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ fontSize: '11px', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>Numéro de relais :</label>
              <input
                type="number"
                min="1"
                value={currentStint}
                onChange={(e) => setCurrentStint(parseInt(e.target.value) || 1)}
                style={{ width: '100%', padding: '6px', background: '#0f172a', color: 'white', border: '1px solid #475569', borderRadius: '6px', fontSize: '12px' }}
              />
            </div>

            <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
              <button
                onClick={() => {
                  setShowDriverModal(false);
                  showToast(`Relais #${currentStint} démarré avec ${currentDriver} !`);
                }}
                style={{ flex: 1, padding: '8px', background: '#10b981', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px' }}
              >
                Valider Relais
              </button>
              <button
                onClick={() => setShowDriverModal(false)}
                style={{ padding: '8px 12px', background: '#64748b', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' }}
              >
                Annuler
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
