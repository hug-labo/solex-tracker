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
export default function App() {
  // Navigation principale de rôle
  const [viewRole, setViewRole] = useState<'stand' | 'solex' | 'circuit'>('stand');

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
  const [placementMode, setPlacementMode] = useState<'none' | 'startLine' | 'intermediate' | 'pitEntry' | 'pitExit'>('none');
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
              role: viewRole === 'solex' ? 'solex' : 'stand',
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
                const inPits = isDistanceInPits(newDist, currentCircuit.pitEntryDistance, currentCircuit.pitExitDistance);
                setInPitsState(inPits);
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

      // Balises entrée et sortie des stands
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
  }, [currentCircuit, sortedIntermediates, isEditingTrack, editTrackPoints]);

  // Clic sur la carte en mode édition ou placement
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handleClick = (e: L.LeafletMouseEvent) => {
      const clickPos: [number, number] = [e.latlng.lat, e.latlng.lng];

      // Cas 1 : Tracé direct d'un nouveau circuit
      if (isEditingTrack) {
        setEditTrackPoints((prev) => [...prev, clickPos]);
        return;
      }

      // Cas 2 : Repositionner la ligne de départ / arrivée
      if (placementMode === 'startLine') {
        const reanchored = reanchorTrackToStartPoint(currentCircuit.points, clickPos, trackMetrics.cumDistances);
        const updated = circuits.map((c) => (c.id === currentCircuit.id ? { ...c, points: reanchored } : c));
        setCircuits(updated);
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
        setPlacementMode('none');
        showToast(`📍 Balise intermédiaire ajoutée à ${Math.round(proj.distance)}m !`);
        return;
      }

      // Cas 4 : Positionner l'entrée des stands
      if (placementMode === 'pitEntry') {
        const proj = projectPointOnTrack(clickPos, currentCircuit.points, trackMetrics.cumDistances);
        const updated = circuits.map((c) =>
          c.id === currentCircuit.id
            ? { ...c, pitEntryDistance: proj.distance, pitEntryLatLng: proj.latLng }
            : c
        );
        setCircuits(updated);
        setPlacementMode('none');
        showToast(`⛽ Entrée des stands placée à ${Math.round(proj.distance)}m !`);
        return;
      }

      // Cas 5 : Positionner la sortie des stands
      if (placementMode === 'pitExit') {
        const proj = projectPointOnTrack(clickPos, currentCircuit.points, trackMetrics.cumDistances);
        const updated = circuits.map((c) =>
          c.id === currentCircuit.id
            ? { ...c, pitExitDistance: proj.distance, pitExitLatLng: proj.latLng }
            : c
        );
        setCircuits(updated);
        setPlacementMode('none');
        showToast(`🏁 Sortie des stands placée à ${Math.round(proj.distance)}m !`);
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
      const currentlyInPits = isDistanceInPits(
        distanceCoveredInLapRef.current,
        currentCircuit.pitEntryDistance,
        currentCircuit.pitExitDistance
      );
      setInPitsState(currentlyInPits);

      // 3. Arrêt aux stands
      if (simInPitStop) {
        setSpeed(0);
        pitDurationRef.current += dt;
        setPitTimerSeconds(Math.floor(pitDurationRef.current));
        setAlertStopped(false);
        stopDurationRef.current = 0;
        setStopElapsedSeconds(0);
        return;
      }

      // 4. Panne en piste simulée
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
    setViewRole('circuit');
    setNewCircuitName(`Circuit ${circuits.length + 1}`);
    setEditTrackPoints([]);
    setPlacementMode('none');
    showToast('✏️ Cliquez sur la carte pour déposer les points de votre nouveau circuit.');
  };

  const handleSaveCircuit = () => {
    if (editTrackPoints.length < 3) {
      alert('Veuillez cliquer au moins 3 points sur la carte pour délimiter le circuit.');
      return;
    }

    const finalName = newCircuitName.trim() || `Circuit ${circuits.length + 1}`;
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
    setEditTrackPoints([]);
    handleResetSimulation();
    showToast(`🎉 Circuit "${finalName}" enregistré ! Le 1er point cliqué est la ligne de départ.`);
  };

  const handleCancelCreateCircuit = () => {
    setIsEditingTrack(false);
    setEditTrackPoints([]);
    showToast('Création de circuit annulée.');
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
        ? { ...c, pitEntryDistance: undefined, pitExitDistance: undefined, pitEntryLatLng: undefined, pitExitLatLng: undefined }
        : c
    );
    setCircuits(updated);
    try {
      localStorage.setItem('solex_circuits_v8', JSON.stringify(updated));
    } catch (e) {
      console.error(e);
    }
    showToast("Repères d'entrée et sortie des stands réinitialisés.");
  };

  const handleStartPitStop = () => {
    setSimInPitStop(true);
    pitDurationRef.current = 0;
    setPitTimerSeconds(0);
    showToast('⛽ Entrée aux stands effectuée !');
  };

  const handleExitPitStop = () => {
    const record: PitStopRecord = {
      id: `pit-${Date.now()}`,
      lap: currentLap,
      driver: currentDriver,
      stint: currentStint,
      duration: Math.round(pitDurationRef.current),
      timestamp: new Date().toLocaleTimeString(),
    };
    setPitHistory((prev) => [record, ...prev]);
    setSimInPitStop(false);
    pitDurationRef.current = 0;
    setPitTimerSeconds(0);
    showToast(`🏁 Sortie des stands après ${record.duration}s d'arrêt !`);
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

        {/* ONGLETS DES RÔLES */}
        <div style={{ display: 'flex', gap: '4px', background: '#1e293b', padding: '3px', borderRadius: '6px' }}>
          <button
            onClick={() => setViewRole('stand')}
            style={{
              padding: '6px 12px',
              fontSize: '12px',
              fontWeight: 'bold',
              borderRadius: '5px',
              border: 'none',
              cursor: 'pointer',
              background: viewRole === 'stand' ? '#2563eb' : 'transparent',
              color: viewRole === 'stand' ? 'white' : '#94a3b8',
            }}
          >
            📊 Stands (Télémétrie)
          </button>
          <button
            onClick={() => setViewRole('solex')}
            style={{
              padding: '6px 12px',
              fontSize: '12px',
              fontWeight: 'bold',
              borderRadius: '5px',
              border: 'none',
              cursor: 'pointer',
              background: viewRole === 'solex' ? '#16a34a' : 'transparent',
              color: viewRole === 'solex' ? 'white' : '#94a3b8',
            }}
          >
            📱 Solex Embarqué (Guidon)
          </button>
          <button
            onClick={() => setViewRole('circuit')}
            style={{
              padding: '6px 12px',
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
      {/* VUE 1 : SOLEX EMBARQUÉ (SMARTPHONE AU GUIDON) */}
      {/* ==================================================================== */}
      {viewRole === 'solex' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px', background: '#020617', overflowY: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
            <div>
              <h2 style={{ margin: 0, fontSize: '18px', color: '#4ade80' }}>📱 Émetteur Télémétrie Embarqué</h2>
              <p style={{ margin: '2px 0 0 0', fontSize: '12px', color: '#94a3b8' }}>
                Fixez ce smartphone sur le guidon du Solex et lancez l'émission GPS live.
              </p>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '12px', color: '#94a3b8' }}>Équipe :</span>
              <input
                type="text"
                value={teamId}
                onChange={(e) => setTeamId(e.target.value)}
                style={{ padding: '6px 10px', background: '#1e293b', color: 'white', border: '1px solid #475569', borderRadius: '6px', fontSize: '12px', width: '120px' }}
              />
            </div>
          </div>

          {/* Vitesse géante lisible sur guidon */}
          <div style={{ background: '#0f172a', border: '2px solid #22c55e', borderRadius: '12px', padding: '24px', textAlign: 'center' }}>
            <div style={{ fontSize: '14px', color: '#94a3b8', letterSpacing: '1px' }}>VITESSE GPS INSTANTANÉE</div>
            <div style={{ fontSize: '72px', fontWeight: '900', color: gpsSpeed > 90 ? '#f87171' : '#4ade80', fontFamily: 'monospace' }}>
              {gpsSpeed}
            </div>
            <div style={{ fontSize: '16px', color: '#64748b' }}>km / h</div>
          </div>

          {/* Commandes d'émission GPS */}
          <div style={{ display: 'flex', gap: '10px' }}>
            {!isGpsTransmitting ? (
              <button
                onClick={startGpsTransmission}
                style={{ flex: 1, padding: '14px', background: '#16a34a', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', fontSize: '16px' }}
              >
                ▶️ Démarrer l'Émission GPS
              </button>
            ) : (
              <button
                onClick={stopGpsTransmission}
                style={{ flex: 1, padding: '14px', background: '#dc2626', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', fontSize: '16px' }}
              >
                ⏹️ Arrêter l'Émission GPS
              </button>
            )}

            <button
              onClick={() => setIsSimulatingPhoneGps((v) => !v)}
              style={{
                padding: '14px 18px',
                background: isSimulatingPhoneGps ? '#eab308' : '#334155',
                color: isSimulatingPhoneGps ? '#0f172a' : 'white',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                fontWeight: 'bold',
                fontSize: '13px',
              }}
            >
              {isSimulatingPhoneGps ? '🎮 Simu GPS Active' : '🎮 Test GPS Simulé'}
            </button>
          </div>

          {/* Cadrans d'état du téléphone */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px' }}>
            <div style={{ background: '#1e293b', padding: '12px', borderRadius: '8px', textAlign: 'center' }}>
              <div style={{ fontSize: '11px', color: '#94a3b8' }}>PRÉCISION GPS</div>
              <div style={{ fontSize: '20px', fontWeight: 'bold', marginTop: '4px', color: gpsAccuracy !== null && gpsAccuracy < 6 ? '#4ade80' : '#f59e0b' }}>
                {gpsAccuracy !== null ? `± ${gpsAccuracy} m` : '--'}
              </div>
            </div>

            <div style={{ background: '#1e293b', padding: '12px', borderRadius: '8px', textAlign: 'center' }}>
              <div style={{ fontSize: '11px', color: '#94a3b8' }}>CAP / DIRECTION</div>
              <div style={{ fontSize: '20px', fontWeight: 'bold', marginTop: '4px', color: '#38bdf8' }}>
                {gpsHeading !== null && gpsHeading !== undefined ? `${Math.round(gpsHeading)}°` : '--'}
              </div>
            </div>

            <div style={{ background: '#1e293b', padding: '12px', borderRadius: '8px', textAlign: 'center' }}>
              <div style={{ fontSize: '11px', color: '#94a3b8' }}>PAQUETS ÉMIS</div>
              <div style={{ fontSize: '20px', fontWeight: 'bold', marginTop: '4px', color: '#f8fafc' }}>
                {gpsPacketsSent}
              </div>
            </div>

            <div style={{ background: '#1e293b', padding: '12px', borderRadius: '8px', textAlign: 'center' }}>
              <div style={{ fontSize: '11px', color: '#94a3b8' }}>ÉCRAN ANTI-VEILLE</div>
              <div style={{ fontSize: '14px', fontWeight: 'bold', marginTop: '8px', color: wakeLockActive ? '#4ade80' : '#f87171' }}>
                {wakeLockActive ? '☀️ Actif' : '🌙 Standard'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* VUE 2 & 3 : STANDS ET ÉDITEUR CIRCUIT (CARTE COMMUNE TOUJOURS MONTÉE) */}
      {/* ==================================================================== */}
      <div style={{ flex: 1, display: viewRole === 'solex' ? 'none' : 'flex', flexDirection: 'column', gap: '8px', padding: '8px 16px', minHeight: 0 }}>

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
              title="Tracer un nouveau circuit au clic sur la carte"
            >
              ➕ Nouveau Circuit
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

            <button
              onClick={handleStartPitStop}
              disabled={simInPitStop}
              style={{
                padding: '5px 10px',
                background: '#2563eb',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '11px',
                fontWeight: 'bold',
              }}
            >
              ⛽ Simuler Entrée Stand
            </button>

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
              <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', background: '#f59e0b', color: '#0f172a', padding: '6px 14px', borderRadius: '6px', fontWeight: 'bold', fontSize: '12px', zIndex: 1000, boxShadow: '0 2px 8px rgba(0,0,0,0.5)' }}>
                👉 Cliquez sur le tracé de la piste pour positionner : {placementMode}
                <button
                  onClick={() => setPlacementMode('none')}
                  style={{ marginLeft: '10px', background: '#0f172a', color: 'white', border: 'none', borderRadius: '4px', padding: '2px 6px', cursor: 'pointer', fontSize: '10px' }}
                >
                  Annuler (Échap)
                </button>
              </div>
            )}
          </div>

          {/* ==================================================================== */}
          {/* PANNEAU LATÉRAL 1 : ÉDITEUR CIRCUIT (SI RÔLE ÉDITEUR) */}
          {/* ==================================================================== */}
          {viewRole === 'circuit' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '10px', background: '#1e293b', padding: '14px', borderRadius: '8px', border: '1px solid #f59e0b', minWidth: '320px', overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: '16px', color: '#f59e0b' }}>🛠️ Outils Éditeur Circuit</h3>
                <span style={{ fontSize: '11px', background: '#0f172a', padding: '3px 8px', borderRadius: '4px', color: '#38bdf8' }}>
                  {trackMetrics.totalDistanceMeters ? `${Math.round(trackMetrics.totalDistanceMeters)} m` : '0 m'}
                </span>
              </div>

              {/* FORMULAIRE DE CRÉATION DE TRACÉ */}
              {isEditingTrack ? (
                <div style={{ background: '#0f172a', padding: '12px', borderRadius: '8px', border: '2px solid #f59e0b', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#fbbf24' }}>
                    ✏️ Tracé du Nouveau Circuit
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
                    Points déposés : <strong>{editTrackPoints.length}</strong> (~{drawnDistanceMeters} m)
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
                      💾 Enregistrer le Circuit
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
                <button
                  onClick={handleStartCreateCircuit}
                  style={{
                    padding: '10px',
                    background: '#10b981',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    fontSize: '13px',
                    boxShadow: '0 2px 8px rgba(16,185,129,0.3)',
                  }}
                >
                  ➕ Tracer un Nouveau Circuit sur la carte
                </button>
              )}

              {/* OUTILS DE POSITIONNEMENT SUR LE TRACÉ EXISTANT */}
              <div style={{ background: '#0f172a', padding: '12px', borderRadius: '8px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ fontSize: '12px', fontWeight: 'bold', color: '#e2e8f0' }}>
                  Positionner au clic sur le circuit :
                </div>

                <button
                  onClick={() => {
                    setPlacementMode(placementMode === 'startLine' ? 'none' : 'startLine');
                    showToast('Cliquez sur la piste pour repositionner la ligne de départ / arrivée.');
                  }}
                  style={{
                    padding: '8px',
                    background: placementMode === 'startLine' ? '#16a34a' : '#1e293b',
                    color: 'white',
                    border: '1px solid #16a34a',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '12px',
                    textAlign: 'left',
                    fontWeight: 'bold',
                  }}
                >
                  🏁 {placementMode === 'startLine' ? '👉 Cliquez sur la piste...' : 'Ligne Départ / Arrivée'}
                </button>

                <button
                  onClick={() => {
                    setPlacementMode(placementMode === 'intermediate' ? 'none' : 'intermediate');
                    showToast('Cliquez sur la piste pour poser une balise secteur (S1, S2...).');
                  }}
                  style={{
                    padding: '8px',
                    background: placementMode === 'intermediate' ? '#f59e0b' : '#1e293b',
                    color: placementMode === 'intermediate' ? '#0f172a' : 'white',
                    border: '1px solid #f59e0b',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '12px',
                    textAlign: 'left',
                    fontWeight: 'bold',
                  }}
                >
                  📍 {placementMode === 'intermediate' ? '👉 Cliquez sur la piste...' : '+ Ajouter Balise Secteur (S)'}
                </button>

                <div style={{ display: 'flex', gap: '6px' }}>
                  <button
                    onClick={() => {
                      setPlacementMode(placementMode === 'pitEntry' ? 'none' : 'pitEntry');
                      showToast("Cliquez sur la piste pour positionner l'entrée des stands.");
                    }}
                    style={{
                      flex: 1,
                      padding: '8px',
                      background: placementMode === 'pitEntry' ? '#2563eb' : '#1e293b',
                      color: 'white',
                      border: '1px solid #2563eb',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontSize: '11px',
                      fontWeight: 'bold',
                    }}
                  >
                    ⛽ Entrée Stands
                  </button>

                  <button
                    onClick={() => {
                      setPlacementMode(placementMode === 'pitExit' ? 'none' : 'pitExit');
                      showToast('Cliquez sur la piste pour positionner la sortie des stands.');
                    }}
                    style={{
                      flex: 1,
                      padding: '8px',
                      background: placementMode === 'pitExit' ? '#0284c7' : '#1e293b',
                      color: 'white',
                      border: '1px solid #0284c7',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontSize: '11px',
                      fontWeight: 'bold',
                    }}
                  >
                    🏁 Sortie Stands
                  </button>
                </div>
              </div>

              {/* LISTE DES BALISES DU CIRCUIT */}
              <div style={{ background: '#0f172a', padding: '12px', borderRadius: '8px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ fontSize: '12px', fontWeight: 'bold', color: '#e2e8f0', display: 'flex', justifyContent: 'space-between' }}>
                  <span>Balises de chronométrage :</span>
                  <span style={{ fontSize: '11px', color: '#94a3b8' }}>{sortedIntermediates.length} balise(s)</span>
                </div>

                <div style={{ fontSize: '11px', color: '#10b981', display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #1e293b' }}>
                  <span>🏁 Départ / Arrivée</span>
                  <span>0 m</span>
                </div>

                {sortedIntermediates.length === 0 ? (
                  <div style={{ fontSize: '11px', color: '#64748b', fontStyle: 'italic', padding: '4px 0' }}>
                    Aucune balise intermédiaire. Cliquez sur "+ Ajouter Balise Secteur".
                  </div>
                ) : (
                  sortedIntermediates.map((inter) => (
                    <div key={inter.id} style={{ fontSize: '11px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid #1e293b' }}>
                      <span style={{ color: '#f59e0b', fontWeight: 'bold' }}>📍 {inter.name}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span>{Math.round(inter.distance)} m</span>
                        <button
                          onClick={() => handleDeleteIntermediate(inter.id)}
                          style={{ background: 'transparent', color: '#ef4444', border: 'none', cursor: 'pointer', fontSize: '12px' }}
                          title="Supprimer cette balise"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))
                )}

                {/* Statut stands */}
                <div style={{ marginTop: '6px', paddingTop: '6px', borderTop: '1px solid #334155', fontSize: '11px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: '#38bdf8' }}>
                    ⛽ Stands : {currentCircuit.pitEntryDistance !== undefined && currentCircuit.pitExitDistance !== undefined ? `${Math.round(currentCircuit.pitEntryDistance)}m ➔ ${Math.round(currentCircuit.pitExitDistance)}m` : 'Non configurés'}
                  </span>
                  {(currentCircuit.pitEntryDistance !== undefined || currentCircuit.pitExitDistance !== undefined) && (
                    <button
                      onClick={handleResetPits}
                      style={{ background: 'transparent', color: '#f87171', border: 'none', cursor: 'pointer', fontSize: '10px' }}
                      title="Effacer les repères stands"
                    >
                      Effacer
                    </button>
                  )}
                </div>
              </div>

              {/* Bouton de suppression du circuit & retour aux stands */}
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
                            {hasSplit ? `${split.toFixed(1)}s` : '--.-'}
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
                        <div key={item.id || item.lap} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#1e293b', padding: '6px 8px', borderRadius: '4px', fontSize: '11px', borderLeft: item.totalTime === bestLapTime ? '3px solid #fbbf24' : '3px solid #3b82f6' }}>
                          <div>
                            <span style={{ fontWeight: 'bold', color: '#38bdf8' }}>Tour #{item.lap}</span>
                            <span style={{ fontSize: '10px', color: '#94a3b8', marginLeft: '6px' }}>({item.driver})</span>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <span style={{ fontFamily: 'monospace', fontWeight: 'bold' }}>{formatSec(item.totalTime)}</span>
                            <span style={{ fontSize: '10px', color: '#94a3b8', marginLeft: '6px' }}>{item.avgSpeed} km/h</span>
                          </div>
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
