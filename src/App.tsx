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

  // Identifiant d'équipe et URL du serveur WebSocket
  const [teamId, setTeamId] = useState<string>(() => {
    return localStorage.getItem('solex_team_id') || 'equipe-1';
  });

  const [serverWsUrl, setServerWsUrl] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${window.location.host}`;
    }
    return 'ws://localhost:3000';
  });

  // Statut WebSocket
  const [isWsConnected, setIsWsConnected] = useState<boolean>(false);
  const [wsPacketsCount, setWsPacketsCount] = useState<number>(0);
  const wsRef = useRef<WebSocket | null>(null);

  // Vue carte (satellite, plan, nuit)
  const [mapLayerType, setMapLayerType] = useState<'satellite' | 'streets' | 'dark'>('satellite');

  // Recherche de lieu
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSearching, setIsSearching] = useState<boolean>(false);

  // Pilotes et Relais (Endurance)
  const [drivers, setDrivers] = useState<string[]>(['Pilote 1', 'Pilote 2', 'Pilote 3']);
  const [currentDriver, setCurrentDriver] = useState<string>('Pilote 1');
  const [currentStint, setCurrentStint] = useState<number>(1);
  const [showDriverModal, setShowDriverModal] = useState<boolean>(false);
  const [newDriverInput, setNewDriverInput] = useState<string>('');

  // Télémétrie en direct
  const [speed, setSpeed] = useState<number>(0);
  const [currentLap, setCurrentLap] = useState<number>(1);
  const [currentLapTime, setCurrentLapTime] = useState<number>(0);
  const [bestLapTime, setBestLapTime] = useState<number | null>(null);
  const [liveSplitTimes, setLiveSplitTimes] = useState<(number | null)[]>([]);
  const [lapHistory, setLapHistory] = useState<LapRecord[]>(() => {
    try {
      const saved = localStorage.getItem('solex_laps_v8');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // Gestion des alertes
  const [alertStopped, setAlertStopped] = useState<boolean>(false);
  const [stopElapsedSeconds, setStopElapsedSeconds] = useState<number>(0);
  const [alertSignalLost, setAlertSignalLost] = useState<boolean>(false);
  const [signalLostElapsedSeconds, setSignalLostElapsedSeconds] = useState<number>(0);

  // Stands et arrêts
  const [inPitsState, setInPitsState] = useState<boolean>(false);
  const [pitTimerSeconds, setPitTimerSeconds] = useState<number>(0);
  const [pitHistory, setPitHistory] = useState<PitStopRecord[]>(() => {
    try {
      const saved = localStorage.getItem('solex_pitstops_v8');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // Modal Export SQL / JSON
  const [showExportModal, setShowExportModal] = useState<boolean>(false);
  const [exportSqlText, setExportSqlText] = useState<string>('');

  // Mode Édition de circuit
  const [isEditingTrack, setIsEditingTrack] = useState<boolean>(false);
  const [newCircuitName, setNewCircuitName] = useState<string>('Mon Nouveau Circuit');
  const [editTrackPoints, setEditTrackPoints] = useState<[number, number][]>([]);
  const [isPlacingMenuOpen, setIsPlacingMenuOpen] = useState<boolean>(false);
  const [placementMode, setPlacementMode] = useState<'none' | 'startLine' | 'intermediate' | 'pitEntry' | 'pitExit'>('none');
  const [notificationMsg, setNotificationMsg] = useState<string | null>(null);

  // Contrôles de simulation
  const [targetSpeed, setTargetSpeed] = useState<number>(85);
  const [simStopped, setSimStopped] = useState<boolean>(false);
  const [simInPitStop, setSimInPitStop] = useState<boolean>(false);
  const [simSignalLost, setSimSignalLost] = useState<boolean>(false);

  // Onglet inférieur des stands
  const [activeTab, setActiveTab] = useState<'laps' | 'pitstops' | 'driverStats'>('laps');

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
  const solexMarkerRef = useRef<L.Marker | null>(null);
  const polylineRef = useRef<L.Polyline | null>(null);
  const pitPolylineRef = useRef<L.Polyline | null>(null);
  const markersGroupRef = useRef<L.LayerGroup | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);

  const lastKnownPosRef = useRef<[number, number]>(currentCircuit.points[0] || [47.95, 0.2]);
  const distanceCoveredInLapRef = useRef<number>(0);
  const lastTickTimeRef = useRef<number>(Date.now());
  const lapStartTimeRef = useRef<number>(Date.now());
  const recordedSplitsThisLapRef = useRef<(number | null)[]>([]);
  const stopDurationRef = useRef<number>(0);
  const signalLostDurationRef = useRef<number>(0);
  const pitDurationRef = useRef<number>(0);
  const lastTelemetryTimeRef = useRef<number>(Date.now());

  // Sauvegardes locales automatiques
  useEffect(() => {
    try {
      localStorage.setItem('solex_circuits_v8', JSON.stringify(circuits));
    } catch {}
  }, [circuits]);

  useEffect(() => {
    try {
      localStorage.setItem('solex_team_id', teamId);
    } catch {}
  }, [teamId]);

  useEffect(() => {
    try {
      localStorage.setItem('solex_laps_v8', JSON.stringify(lapHistory));
    } catch {}
  }, [lapHistory]);

  useEffect(() => {
    try {
      localStorage.setItem('solex_pitstops_v8', JSON.stringify(pitHistory));
    } catch {}
  }, [pitHistory]);

  const showToast = (msg: string) => {
    setNotificationMsg(msg);
    setTimeout(() => {
      setNotificationMsg(null);
    }, 4000);
  };

  const trackMetrics = useMemo(() => {
    const pts = currentCircuit.points;
    if (pts.length < 2) return { totalDistance: 1000, cumDistances: [0] };

    const cum: number[] = [0];
    let total = 0;
    for (let i = 0; i < pts.length; i++) {
      const nextIndex = (i + 1) % pts.length;
      const d = calculateDistanceMeters(pts[i], pts[nextIndex]);
      total += d;
      cum.push(total);
    }
    return {
      totalDistance: total,
      cumDistances: cum,
    };
  }, [currentCircuit]);

  const sortedIntermediates = useMemo(() => {
    const list = currentCircuit.intermediates ? [...currentCircuit.intermediates] : [];
    list.sort((a, b) => a.distance - b.distance);
    return list.map((item, idx) => ({
      ...item,
      name: `S${idx + 1}`,
    }));
  }, [currentCircuit.intermediates]);

  const getPositionFromDistance = (dist: number): [number, number] => {
    const pts = currentCircuit.points;
    if (pts.length < 2) return pts[0] || [47.95, 0.2];

    const total = trackMetrics.totalDistance;
    const normalizedDist = ((dist % total) + total) % total;

    for (let i = 0; i < pts.length; i++) {
      const nextIndex = (i + 1) % pts.length;
      const segDist = calculateDistanceMeters(pts[i], pts[nextIndex]);
      const segStart = trackMetrics.cumDistances[i];
      if (normalizedDist >= segStart && normalizedDist <= segStart + segDist) {
        const progress = segDist > 0 ? (normalizedDist - segStart) / segDist : 0;
        const lat = pts[i][0] + (pts[nextIndex][0] - pts[i][0]) * progress;
        const lng = pts[i][1] + (pts[nextIndex][1] - pts[i][1]) * progress;
        return [lat, lng];
      }
    }
    return pts[0];
  };

  // ============================================================================
  // CONNEXION WEBSOCKET CLIENT (RELAIS SERVEUR RENDER)
  // ============================================================================
  useEffect(() => {
    let active = true;
    let reconnectTimeout: any = null;

    const connectWs = () => {
      try {
        if (!serverWsUrl) return;
        const ws = new WebSocket(serverWsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (!active) return;
          setIsWsConnected(true);
          console.log('[WebSocket] Connecté au serveur relais');
          // Enregistrer notre rôle et notre équipe
          ws.send(
            JSON.stringify({
              type: 'register',
              role: viewRole === 'solex' ? 'solex' : 'stand',
              teamId,
            })
          );

          // Vider le tampon hors-ligne si des points étaient en attente
          if (offlineQueueRef.current.length > 0) {
            console.log(`[WebSocket] Envoi de ${offlineQueueRef.current.length} points hors-ligne...`);
            offlineQueueRef.current.forEach((pkt) => {
              ws.send(JSON.stringify({ type: 'telemetry', ...pkt }));
            });
            offlineQueueRef.current = [];
          }
        };

        ws.onmessage = (event) => {
          if (!active) return;
          try {
            const data = JSON.parse(event.data);
            setWsPacketsCount((c) => c + 1);

            // Réception de télémétrie en direct pour les Stands
            if (data.type === 'telemetry' && standDataSource === 'live') {
              lastTelemetryTimeRef.current = Date.now();
              setAlertSignalLost(false);
              setSignalLostElapsedSeconds(0);

              const lat = Number(data.lat);
              const lng = Number(data.lng);
              const spd = Number(data.speed || 0);
              const heading = data.heading;

              setSpeed(spd);
              lastKnownPosRef.current = [lat, lng];

              // Mise à jour marqueur Solex sur la carte
              if (solexMarkerRef.current) {
                solexMarkerRef.current.setLatLng([lat, lng]);
                solexMarkerRef.current.setIcon(createSolexIcon(heading));
              }

              // Projection sur le circuit pour les chronos
              if (currentCircuit.points.length >= 2) {
                const proj = projectPointOnTrack([lat, lng], currentCircuit.points, trackMetrics.cumDistances);
                const prevDist = distanceCoveredInLapRef.current;
                const newDist = proj.distance;
                const totalDist = trackMetrics.totalDistance;

                // Vérification zone des stands
                const inPits = isDistanceInPits(newDist, currentCircuit.pitEntryDistance, currentCircuit.pitExitDistance);
                setInPitsState(inPits);

                // Arrêt en piste si vitesse < 3 km/h hors stands
                if (spd < 3 && !inPits) {
                  stopDurationRef.current += 1;
                  setStopElapsedSeconds(stopDurationRef.current);
                  if (stopDurationRef.current >= 10) {
                    setAlertStopped(true);
                  }
                } else {
                  setAlertStopped(false);
                  stopDurationRef.current = 0;
                  setStopElapsedSeconds(0);
                }

                // Détection franchissement de la ligne d'arrivée
                // Si la distance passe de >85% à <15% du tour, le tour est bouclé
                if (prevDist > totalDist * 0.85 && newDist < totalDist * 0.15) {
                  const now = Date.now();
                  const lapTime = (now - lapStartTimeRef.current) / 1000;
                  if (lapTime > 15) { // Éviter faux déclenchement rebond
                    const avgSpd = Math.round((totalDist / lapTime) * 3.6);
                    const newRecord: LapRecord = {
                      id: `lap-${Date.now()}`,
                      teamId,
                      lap: currentLap,
                      intermediateTimes: [...recordedSplitsThisLapRef.current],
                      totalTime: lapTime,
                      avgSpeed: avgSpd,
                      driver: currentDriver,
                      stint: currentStint,
                      timestamp: new Date().toLocaleTimeString(),
                    };
                    setLapHistory((prev) => [newRecord, ...prev]);
                    setBestLapTime((prev) => (prev === null || lapTime < prev ? lapTime : prev));
                    setCurrentLap((l) => l + 1);
                    lapStartTimeRef.current = now;
                    recordedSplitsThisLapRef.current = new Array(sortedIntermediates.length).fill(null);
                    setLiveSplitTimes(new Array(sortedIntermediates.length).fill(null));
                    showToast(`🏁 Tour #${currentLap} bouclé en ${formatSec(lapTime)} (${avgSpd} km/h) !`);
                  }
                }

                // Détection des secteurs
                sortedIntermediates.forEach((inter, idx) => {
                  if (
                    prevDist < inter.distance &&
                    newDist >= inter.distance &&
                    recordedSplitsThisLapRef.current[idx] === null
                  ) {
                    const elapsed = (Date.now() - lapStartTimeRef.current) / 1000;
                    recordedSplitsThisLapRef.current[idx] = elapsed;
                    setLiveSplitTimes([...recordedSplitsThisLapRef.current]);
                  }
                });

                distanceCoveredInLapRef.current = newDist;
              }
            }
          } catch (e) {
            console.error('[WebSocket] Erreur décodage message :', e);
          }
        };

        ws.onclose = () => {
          if (!active) return;
          setIsWsConnected(false);
          console.warn('[WebSocket] Déconnecté, reconnexion dans 4s...');
          reconnectTimeout = setTimeout(connectWs, 4000);
        };

        ws.onerror = () => {
          ws.close();
        };
      } catch (err) {
        if (active) reconnectTimeout = setTimeout(connectWs, 4000);
      }
    };

    connectWs();

    return () => {
      active = false;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (wsRef.current) wsRef.current.close();
    };
  }, [serverWsUrl, teamId, viewRole, standDataSource, currentCircuit, trackMetrics, sortedIntermediates, currentLap, currentDriver, currentStint]);

  // Surveillance de perte de signal en mode direct (alerte orange)
  useEffect(() => {
    if (standDataSource !== 'live') return;

    const interval = setInterval(() => {
      const now = Date.now();
      const diffSec = Math.floor((now - lastTelemetryTimeRef.current) / 1000);
      if (diffSec >= 15) {
        setAlertSignalLost(true);
        setSignalLostElapsedSeconds(diffSec);
      } else {
        setAlertSignalLost(false);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [standDataSource]);

  // ============================================================================
  // ÉMETTEUR GPS EMBARQUÉ (POUR LE SMARTPHONE DU SOLEX)
  // ============================================================================
  const startGpsTransmission = async () => {
    // 1. Activer le Wake Lock pour empêcher l'écran de s'éteindre
    if ('wakeLock' in navigator) {
      try {
        wakeLockSentinelRef.current = await (navigator as any).wakeLock.request('screen');
        setWakeLockActive(true);
      } catch (err) {
        console.warn('Wake Lock non supporté ou refusé', err);
      }
    }

    if (!('geolocation' in navigator)) {
      alert("La géolocalisation GPS n'est pas supportée par ce navigateur.");
      return;
    }

    setIsGpsTransmitting(true);
    showToast('📡 Émission GPS démarrée ! Les données sont transmises au relais.');

    // 2. Démarrer la capture GPS haute fréquence (10 Hz ou max possible)
    gpsWatchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const spd = pos.coords.speed !== null && pos.coords.speed !== undefined ? Math.round(pos.coords.speed * 3.6) : 0;
        const heading = pos.coords.heading;
        const accuracy = Math.round(pos.coords.accuracy);
        const altitude = pos.coords.altitude !== null ? Math.round(pos.coords.altitude) : null;

        setGpsSpeed(spd);
        setGpsAccuracy(accuracy);
        setGpsHeading(heading);
        setGpsAltitude(altitude);
        setLastGpsFixTime(new Date().toLocaleTimeString());
        setGpsPacketsSent((c) => c + 1);

        const packet: TelemetryPacket = {
          teamId,
          lat,
          lng,
          speed: spd,
          heading,
          accuracy,
          timestamp: Date.now(),
        };

        // Envoi au WebSocket s'il est connecté, sinon mise en mémoire tampon locale
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'telemetry', ...packet }));
        } else {
          offlineQueueRef.current.push(packet);
          if (offlineQueueRef.current.length > 200) offlineQueueRef.current.shift();
        }
      },
      (err) => {
        console.error('Erreur GPS :', err);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 5000,
      }
    );
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
    showToast('🛑 Transmission GPS arrêtée.');
  };

  // Simulation GPS embarqué (pour tester le téléphone sur un bureau sans bouger)
  useEffect(() => {
    if (!isSimulatingPhoneGps) return;

    let simIndex = 0;
    const interval = setInterval(() => {
      const pos = getPositionFromDistance(simIndex);
      simIndex = (simIndex + 25) % trackMetrics.totalDistance;

      const spd = 75 + Math.round(Math.random() * 15);
      setGpsSpeed(spd);
      setGpsAccuracy(3);
      setGpsHeading(90);
      setLastGpsFixTime(new Date().toLocaleTimeString());
      setGpsPacketsSent((c) => c + 1);

      const packet: TelemetryPacket = {
        teamId,
        lat: pos[0],
        lng: pos[1],
        speed: spd,
        heading: 90,
        accuracy: 3,
        timestamp: Date.now(),
      };

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'telemetry', ...packet }));
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [isSimulatingPhoneGps, trackMetrics, teamId]);

  // ============================================================================
  // CARTE LEAFLET & COUCHES
  // ============================================================================
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const initialCenter = currentCircuit.points[0] || [47.95, 0.205];
    const map = L.map(mapContainerRef.current).setView(initialCenter, 16);

    const satLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: 'Tiles &copy; Esri' }
    );
    satLayer.addTo(map);
    tileLayerRef.current = satLayer;

    const polyline = L.polyline(currentCircuit.points, {
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
    if (!mapRef.current || isEditingTrack) return;

    if (polylineRef.current) {
      polylineRef.current.setLatLngs(currentCircuit.points);
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
  }, [currentCircuit, sortedIntermediates, isEditingTrack]);

  // Clic sur la carte en mode édition ou placement
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handleClick = (e: L.LeafletMouseEvent) => {
      const clickPos: [number, number] = [e.latlng.lat, e.latlng.lng];

      if (isEditingTrack) {
        setEditTrackPoints((prev) => [...prev, clickPos]);
        return;
      }

      if (placementMode === 'startLine') {
        const reanchored = reanchorTrackToStartPoint(currentCircuit.points, clickPos, trackMetrics.cumDistances);
        const updated = circuits.map((c) => (c.id === currentCircuit.id ? { ...c, points: reanchored } : c));
        setCircuits(updated);
        setPlacementMode('none');
        showToast('🏁 Ligne de départ repositionnée avec succès !');
        return;
      }

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

  // Synchronisation de la polyline pendant le tracé
  useEffect(() => {
    if (!isEditingTrack || !polylineRef.current) return;
    polylineRef.current.setLatLngs(editTrackPoints);
  }, [editTrackPoints, isEditingTrack]);

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

      // 4. Arrêt en piste
      if (simStopped) {
        setSpeed(0);
        if (!currentlyInPits) {
          stopDurationRef.current += dt;
          const totalStopSec = Math.floor(stopDurationRef.current);
          setStopElapsedSeconds(totalStopSec);
          if (stopDurationRef.current >= 5) setAlertStopped(true);
        }
        return;
      }

      // Course normale
      const currentSimSpeed = targetSpeed;
      setSpeed(currentSimSpeed);

      const distMoved = (currentSimSpeed / 3.6) * dt;
      const newLapDist = distanceCoveredInLapRef.current + distMoved;
      const totalTrackDist = trackMetrics.totalDistance;

      const lapTimeElapsed = (now - lapStartTimeRef.current) / 1000;
      setCurrentLapTime(lapTimeElapsed);

      // Balises intermédiaires
      sortedIntermediates.forEach((inter, idx) => {
        if (
          distanceCoveredInLapRef.current < inter.distance &&
          newLapDist >= inter.distance &&
          recordedSplitsThisLapRef.current[idx] === null
        ) {
          recordedSplitsThisLapRef.current[idx] = lapTimeElapsed;
          setLiveSplitTimes([...recordedSplitsThisLapRef.current]);
        }
      });

      // Tour complet
      if (newLapDist >= totalTrackDist) {
        const totalLapTime = lapTimeElapsed;
        const avgSpd = Math.round((totalTrackDist / totalLapTime) * 3.6);

        const newRecord: LapRecord = {
          id: `sim-lap-${Date.now()}`,
          teamId,
          lap: currentLap,
          intermediateTimes: [...recordedSplitsThisLapRef.current],
          totalTime: totalLapTime,
          avgSpeed: avgSpd,
          driver: currentDriver,
          stint: currentStint,
          timestamp: new Date().toLocaleTimeString(),
        };

        setLapHistory((prev) => [newRecord, ...prev]);
        setBestLapTime((prev) => (prev === null || totalLapTime < prev ? totalLapTime : prev));
        setCurrentLap((l) => l + 1);

        lapStartTimeRef.current = now;
        distanceCoveredInLapRef.current = newLapDist - totalTrackDist;
        recordedSplitsThisLapRef.current = new Array(sortedIntermediates.length).fill(null);
        setLiveSplitTimes(new Array(sortedIntermediates.length).fill(null));
      } else {
        distanceCoveredInLapRef.current = newLapDist;
      }

      const newPos = getPositionFromDistance(distanceCoveredInLapRef.current);
      lastKnownPosRef.current = newPos;
      if (solexMarkerRef.current) {
        solexMarkerRef.current.setLatLng(newPos);
      }
    }, 100);

    return () => clearInterval(interval);
  }, [standDataSource, isEditingTrack, currentCircuit, trackMetrics, sortedIntermediates, targetSpeed, simStopped, simInPitStop, simSignalLost, currentLap, currentDriver, currentStint, teamId]);

  // Actions stands et relais
  const handleStartPitStop = () => {
    if (currentCircuit.pitEntryDistance !== undefined) {
      distanceCoveredInLapRef.current = currentCircuit.pitEntryDistance;
      const pitPos = getPositionFromDistance(currentCircuit.pitEntryDistance);
      lastKnownPosRef.current = pitPos;
      if (solexMarkerRef.current) solexMarkerRef.current.setLatLng(pitPos);
    }
    setSimInPitStop(true);
    pitDurationRef.current = 0;
    setPitTimerSeconds(0);
    showToast('⛽ Entrée au stand : chronomètre de ravitaillement démarré !');
  };

  const handleExitPitStop = () => {
    const record: PitStopRecord = {
      id: `pit-${Date.now()}`,
      teamId,
      lap: currentLap,
      driver: currentDriver,
      stint: currentStint,
      duration: pitTimerSeconds,
      timestamp: new Date().toLocaleTimeString(),
    };
    setPitHistory((prev) => [record, ...prev]);

    if (currentCircuit.pitExitDistance !== undefined) {
      distanceCoveredInLapRef.current = currentCircuit.pitExitDistance;
      const exitPos = getPositionFromDistance(currentCircuit.pitExitDistance);
      lastKnownPosRef.current = exitPos;
      if (solexMarkerRef.current) solexMarkerRef.current.setLatLng(exitPos);
    }

    setSimInPitStop(false);
    lastTickTimeRef.current = Date.now();
    showToast(`🏁 Sortie des stands enregistrée : ${pitTimerSeconds}s d'arrêt.`);
    pitDurationRef.current = 0;
    setPitTimerSeconds(0);
  };

  const handleChangeDriver = (newDriver: string) => {
    if (newDriver === currentDriver) return;
    setCurrentDriver(newDriver);
    setCurrentStint((s) => s + 1);
    setShowDriverModal(false);
    showToast(`👤 Changement de pilote : ${newDriver} prend le guidon (Relais #${currentStint + 1}) !`);
  };

  const handleAddNewDriver = () => {
    const trimmed = newDriverInput.trim();
    if (!trimmed) return;
    if (drivers.includes(trimmed)) {
      alert('Ce pilote existe déjà.');
      return;
    }
    setDrivers([...drivers, trimmed]);
    setNewDriverInput('');
    handleChangeDriver(trimmed);
  };

  const handleSearchLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim() || !mapRef.current) return;
    setIsSearching(true);
    try {
      const resp = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}`
      );
      const data = await resp.json();
      if (data && data.length > 0) {
        const lat = parseFloat(data[0].lat);
        const lon = parseFloat(data[0].lon);
        mapRef.current.setView([lat, lon], 16);
        showToast(`📍 Carte centrée sur : ${data[0].display_name.split(',')[0]}`);
      } else {
        alert('Lieu non trouvé.');
      }
    } catch {
      alert('Erreur lors de la recherche.');
    } finally {
      setIsSearching(false);
    }
  };

  const handleRecenterSolex = () => {
    if (mapRef.current && lastKnownPosRef.current) {
      mapRef.current.setView(lastKnownPosRef.current, 17);
    }
  };

  // Gestion export SQL
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
    link.setAttribute('download', `solex_tracking_${teamId}.sql`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleDownloadJson = () => {
    const data = {
      teamId,
      circuit: currentCircuit,
      laps: lapHistory,
      pitStops: pitHistory,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `solex_tracking_${teamId}.json`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Statistiques pilotes
  const driverStats = useMemo(() => {
    return drivers.map((d) => {
      const laps = lapHistory.filter((l) => l.driver === d);
      const totalLaps = laps.length;
      const best = totalLaps > 0 ? Math.min(...laps.map((l) => l.totalTime)) : null;
      const avg = totalLaps > 0 ? laps.reduce((acc, l) => acc + l.totalTime, 0) / totalLaps : null;
      return { driver: d, totalLaps, bestTime: best, avgTime: avg };
    });
  }, [drivers, lapHistory]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', padding: '10px', gap: '8px', boxSizing: 'border-box', background: '#0f172a', color: '#f8fafc', fontFamily: 'sans-serif' }}>
      
      {/* ==================================================================== */}
      {/* BARRE DE NAVIGATION PRINCIPALE (SÉLECTION DU RÔLE) */}
      {/* ==================================================================== */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#1e293b', padding: '6px 12px', borderRadius: '8px', border: '1px solid #334155', flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '16px', fontWeight: 'bold', color: '#38bdf8' }}>🛵 SOLEX TRACKING</span>
          <span style={{ fontSize: '11px', background: '#334155', padding: '2px 6px', borderRadius: '4px', color: '#94a3b8' }}>v2.0 Finale</span>
        </div>

        {/* Sélecteur de rôle */}
        <div style={{ display: 'flex', gap: '4px', background: '#0f172a', padding: '3px', borderRadius: '6px' }}>
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
            🏁 Stands & Chronos
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

        {/* Statut de liaison serveur relais */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px' }}>
          <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: isWsConnected ? '#22c55e' : '#ef4444' }} />
          <span style={{ color: isWsConnected ? '#86efac' : '#fca5a5' }}>
            {isWsConnected ? 'Relais Connecté' : 'Relais Hors Ligne'}
          </span>
          <span style={{ color: '#64748b' }}>({teamId})</span>
        </div>
      </div>

      {/* Notifications Toast */}
      {notificationMsg && (
        <div style={{ backgroundColor: '#059669', color: 'white', padding: '8px 14px', borderRadius: '6px', textAlign: 'center', fontWeight: 'bold', fontSize: '13px', boxShadow: '0 4px 10px rgba(0,0,0,0.4)' }}>
          {notificationMsg}
        </div>
      )}

      {/* ==================================================================== */}
      {/* VUE 1 : SOLEX EMBARQUÉ (SMARTPHONE AU GUIDON) */}
      {/* ==================================================================== */}
      {viewRole === 'solex' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px', background: '#020617', borderRadius: '10px', border: '2px solid #16a34a', overflowY: 'auto' }}>
          
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
            <div>
              <h2 style={{ margin: 0, fontSize: '18px', color: '#4ade80' }}>📱 Émetteur Télémétrie Embarqué</h2>
              <p style={{ margin: '2px 0 0 0', fontSize: '12px', color: '#94a3b8' }}>
                Fixez ce téléphone sur le guidon du Solex et lancez l'émission.
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

          {/* GROS BOUTON DÉMARRER / ARRÊTER */}
          <div style={{ display: 'flex', gap: '10px', marginTop: '6px' }}>
            {!isGpsTransmitting ? (
              <button
                onClick={startGpsTransmission}
                style={{
                  flex: 1,
                  padding: '18px',
                  background: '#16a34a',
                  color: 'white',
                  border: 'none',
                  borderRadius: '10px',
                  fontSize: '18px',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  boxShadow: '0 0 20px rgba(22,163,74,0.6)',
                }}
              >
                🟢 DÉMARRER LA TRANSMISSION GPS
              </button>
            ) : (
              <button
                onClick={stopGpsTransmission}
                style={{
                  flex: 1,
                  padding: '18px',
                  background: '#dc2626',
                  color: 'white',
                  border: 'none',
                  borderRadius: '10px',
                  fontSize: '18px',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  boxShadow: '0 0 20px rgba(220,38,38,0.6)',
                }}
              >
                🔴 ARRÊTER L'ÉMISSION
              </button>
            )}

            <button
              onClick={() => setIsSimulatingPhoneGps((v) => !v)}
              style={{
                padding: '0 16px',
                background: isSimulatingPhoneGps ? '#eab308' : '#334155',
                color: isSimulatingPhoneGps ? '#0f172a' : 'white',
                border: 'none',
                borderRadius: '10px',
                fontSize: '12px',
                fontWeight: 'bold',
                cursor: 'pointer',
              }}
            >
              {isSimulatingPhoneGps ? '🎮 Simu GPS Active' : '🎮 Test GPS Simulé'}
            </button>
          </div>

          {/* AFFICHAGE GÉANT DE LA VITESSE (Lisible à 100 km/h) */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#0f172a', padding: '24px', borderRadius: '12px', border: '2px solid #334155' }}>
            <span style={{ fontSize: '13px', color: '#94a3b8', letterSpacing: '1px' }}>VITESSE INSTANTANÉE GPS</span>
            <div style={{ fontSize: '72px', fontWeight: '900', color: gpsSpeed > 90 ? '#f87171' : '#38bdf8', lineHeight: 1.1 }}>
              {gpsSpeed}
            </div>
            <span style={{ fontSize: '18px', fontWeight: 'bold', color: '#94a3b8' }}>KM / H</span>
          </div>

          {/* CADRANS D'ÉTAT DU TÉLÉPHONE */}
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

          <div style={{ background: '#0f172a', padding: '12px', borderRadius: '8px', border: '1px solid #1e293b', fontSize: '12px', color: '#94a3b8' }}>
            💡 <strong>Conseil Endurance :</strong> Branchez le smartphone à une batterie externe (powerbank) étanche fixée au cadre pour tenir les relais de 12h ou 24h sans coupure.
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* VUE 2 & 3 : STANDS OU ÉDITEUR CIRCUIT */}
      {/* ==================================================================== */}
      {viewRole !== 'solex' && (
        <>
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

          {/* BARRE D'OUTILS STANDS & CIRCUIT */}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', background: '#1e293b', padding: '8px 12px', borderRadius: '8px' }}>
            
            {/* Bascule Direct / Simulation pour les stands */}
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

            {/* Choix du circuit */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '12px', color: '#94a3b8' }}>Circuit :</span>
              <select
                value={selectedCircuitId}
                onChange={(e) => {
                  setSelectedCircuitId(e.target.value);
                  setLapHistory([]);
                  setCurrentLap(1);
                  setBestLapTime(null);
                  setPlacementMode('none');
                  setIsPlacingMenuOpen(false);
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
            </div>

            {/* Pilote en cours */}
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
            <form onSubmit={handleSearchLocation} style={{ display: 'flex', gap: '4px', flex: '1', minWidth: '140px' }}>
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

            {/* Bouton Export SQL */}
            <button
              onClick={handleOpenExportModal}
              style={{ padding: '5px 10px', background: '#7c3aed', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}
            >
              💾 Données SQL
            </button>
          </div>

          {/* ZONE PRINCIPALE : CARTE + PANNEAU CHRONOS */}
          <div style={{ display: 'flex', flex: 1, gap: '10px', minHeight: 0 }}>
            
            {/* CARTE LEAFLET */}
            <div style={{ flex: 2, position: 'relative', borderRadius: '8px', overflow: 'hidden', border: '1px solid #334155' }}>
              <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />

              {/* Instructions de placement en cours */}
              {placementMode !== 'none' && (
                <div style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', background: '#f59e0b', color: '#0f172a', padding: '6px 14px', borderRadius: '6px', fontWeight: 'bold', fontSize: '12px', zIndex: 1000, boxShadow: '0 2px 8px rgba(0,0,0,0.5)' }}>
                  👉 Cliquez sur la piste pour placer : {placementMode} (Échap pour annuler)
                </div>
              )}
            </div>

            {/* PANNEAU LATÉRAL STANDS */}
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
                      return (
                        <div key={inter.id} style={{ flex: 1, minWidth: '60px', background: '#1e293b', padding: '4px 6px', borderRadius: '4px', textAlign: 'center' }}>
                          <div style={{ fontSize: '10px', color: '#f59e0b', fontWeight: 'bold' }}>{inter.name}</div>
                          <div style={{ fontSize: '11px', fontFamily: 'monospace', color: split !== null ? '#4ade80' : '#64748b' }}>
                            {split !== null ? `${split.toFixed(1)}s` : '--.-'}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* BOUTONS D'ARRÊT & TESTS (SIMULATION) */}
              {standDataSource === 'simulation' && (
                <div style={{ display: 'flex', gap: '4px', background: '#0f172a', padding: '6px', borderRadius: '6px', border: '1px solid #334155', flexWrap: 'wrap' }}>
                  <button
                    onClick={() => setSimStopped((s) => !s)}
                    style={{
                      flex: 1,
                      padding: '5px',
                      background: simStopped ? '#10b981' : '#dc2626',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '11px',
                      fontWeight: 'bold',
                    }}
                  >
                    {simStopped ? '▶️ Reprendre' : '⚠️ Panne Piste'}
                  </button>

                  <button
                    onClick={handleStartPitStop}
                    disabled={simInPitStop}
                    style={{
                      flex: 1,
                      padding: '5px',
                      background: '#2563eb',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '11px',
                      fontWeight: 'bold',
                    }}
                  >
                    ⛽ Entrée Stand
                  </button>

                  <button
                    onClick={() => setSimSignalLost((v) => !v)}
                    style={{
                      flex: 1,
                      padding: '5px',
                      background: simSignalLost ? '#10b981' : '#ea580c',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '11px',
                      fontWeight: 'bold',
                    }}
                  >
                    {simSignalLost ? '📶 Signal OK' : '📡 Coupure 4G'}
                  </button>
                </div>
              )}

              {/* ONGLETS HISTORIQUE & STATS */}
              <div style={{ display: 'flex', borderBottom: '1px solid #334155', marginTop: '4px' }}>
                <button
                  onClick={() => setActiveTab('laps')}
                  style={{
                    flex: 1,
                    padding: '6px',
                    fontSize: '11px',
                    fontWeight: 'bold',
                    background: 'none',
                    border: 'none',
                    borderBottom: activeTab === 'laps' ? '2px solid #38bdf8' : 'none',
                    color: activeTab === 'laps' ? '#38bdf8' : '#94a3b8',
                    cursor: 'pointer',
                  }}
                >
                  🏁 Tours ({lapHistory.length})
                </button>
                <button
                  onClick={() => setActiveTab('pitstops')}
                  style={{
                    flex: 1,
                    padding: '6px',
                    fontSize: '11px',
                    fontWeight: 'bold',
                    background: 'none',
                    border: 'none',
                    borderBottom: activeTab === 'pitstops' ? '2px solid #38bdf8' : 'none',
                    color: activeTab === 'pitstops' ? '#38bdf8' : '#94a3b8',
                    cursor: 'pointer',
                  }}
                >
                  ⛽ Stands ({pitHistory.length})
                </button>
                <button
                  onClick={() => setActiveTab('driverStats')}
                  style={{
                    flex: 1,
                    padding: '6px',
                    fontSize: '11px',
                    fontWeight: 'bold',
                    background: 'none',
                    border: 'none',
                    borderBottom: activeTab === 'driverStats' ? '2px solid #38bdf8' : 'none',
                    color: activeTab === 'driverStats' ? '#38bdf8' : '#94a3b8',
                    cursor: 'pointer',
                  }}
                >
                  👤 Pilotes
                </button>
              </div>

              {/* TABLEAU DES TOURS */}
              {activeTab === 'laps' && (
                <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #334155', borderRadius: '6px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', textAlign: 'center' }}>
                    <thead>
                      <tr style={{ background: '#334155', color: '#94a3b8', position: 'sticky', top: 0 }}>
                        <th style={{ padding: '4px' }}>T</th>
                        <th style={{ padding: '4px' }}>Pilote</th>
                        <th style={{ padding: '4px' }}>Temps</th>
                        <th style={{ padding: '4px' }}>Moy</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lapHistory.length === 0 ? (
                        <tr>
                          <td colSpan={4} style={{ padding: '20px', color: '#64748b' }}>
                            Aucun tour enregistré.
                          </td>
                        </tr>
                      ) : (
                        lapHistory.map((item) => (
                          <tr key={item.id || item.lap} style={{ borderBottom: '1px solid #334155' }}>
                            <td style={{ padding: '4px', fontWeight: 'bold' }}>#{item.lap}</td>
                            <td style={{ padding: '4px', color: '#93c5fd' }}>{item.driver}</td>
                            <td style={{ padding: '4px', color: item.totalTime === bestLapTime ? '#4ade80' : '#fbbf24', fontWeight: 'bold' }}>
                              {formatSec(item.totalTime)}
                            </td>
                            <td style={{ padding: '4px', color: '#7dd3fc' }}>{item.avgSpeed} km/h</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {/* TABLEAU DES ARRÊTS AUX STANDS */}
              {activeTab === 'pitstops' && (
                <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #334155', borderRadius: '6px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', textAlign: 'center' }}>
                    <thead>
                      <tr style={{ background: '#334155', color: '#94a3b8', position: 'sticky', top: 0 }}>
                        <th style={{ padding: '4px' }}>Heure</th>
                        <th style={{ padding: '4px' }}>Pilote</th>
                        <th style={{ padding: '4px' }}>Durée</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pitHistory.length === 0 ? (
                        <tr>
                          <td colSpan={3} style={{ padding: '20px', color: '#64748b' }}>
                            Aucun arrêt enregistré.
                          </td>
                        </tr>
                      ) : (
                        pitHistory.map((p) => (
                          <tr key={p.id} style={{ borderBottom: '1px solid #334155' }}>
                            <td style={{ padding: '4px', color: '#94a3b8' }}>{p.timestamp}</td>
                            <td style={{ padding: '4px', color: '#93c5fd' }}>{p.driver}</td>
                            <td style={{ padding: '4px', fontWeight: 'bold', color: '#fbbf24' }}>{p.duration}s</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {/* STATISTIQUES PILOTES */}
              {activeTab === 'driverStats' && (
                <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {driverStats.map((s) => (
                    <div key={s.driver} style={{ background: '#0f172a', padding: '6px', borderRadius: '4px', border: s.driver === currentDriver ? '1px solid #3b82f6' : '1px solid #334155' }}>
                      <div style={{ fontSize: '11px', fontWeight: 'bold', color: s.driver === currentDriver ? '#60a5fa' : '#f8fafc' }}>
                        👤 {s.driver} {s.driver === currentDriver && '🟢'}
                      </div>
                      <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '2px' }}>
                        Tours: <strong>{s.totalLaps}</strong> | Best: <strong style={{ color: '#4ade80' }}>{formatSec(s.bestTime)}</strong>
                      </div>
                    </div>
                  ))}

                  <div style={{ marginTop: 'auto', background: '#0f172a', padding: '6px', borderRadius: '4px' }}>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <input
                        type="text"
                        placeholder="Nouveau pilote..."
                        value={newDriverInput}
                        onChange={(e) => setNewDriverInput(e.target.value)}
                        style={{ flex: 1, padding: '4px 6px', background: '#1e293b', color: 'white', border: '1px solid #475569', borderRadius: '4px', fontSize: '11px' }}
                      />
                      <button
                        onClick={handleAddNewDriver}
                        style={{ padding: '4px 8px', background: '#10b981', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}
                      >
                        +
                      </button>
                    </div>
                  </div>
                </div>
              )}

            </div>
          </div>
        </>
      )}

      {/* ==================================================================== */}
      {/* VUE 3 : ÉDITEUR DE CIRCUIT */}
      {/* ==================================================================== */}
      {viewRole === 'circuit' && (
        <div style={{ background: '#1e293b', padding: '10px', borderRadius: '8px', border: '1px solid #f59e0b', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#f59e0b' }}>🛠️ Outils Éditeur :</span>
          
          <button
            onClick={() => {
              setPlacementMode('startLine');
              showToast('Cliquez sur le tracé pour repositionner la ligne de départ / arrivée.');
            }}
            style={{ padding: '5px 10px', background: placementMode === 'startLine' ? '#16a34a' : '#334155', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
          >
            🏁 Ligne Départ/Arrivée
          </button>

          <button
            onClick={() => {
              setPlacementMode('intermediate');
              showToast('Cliquez sur le tracé pour ajouter une balise intermédiaire (S1, S2...).');
            }}
            style={{ padding: '5px 10px', background: placementMode === 'intermediate' ? '#f59e0b' : '#334155', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
          >
            📍 Ajouter Balise Secteur
          </button>

          <button
            onClick={() => {
              setPlacementMode('pitEntry');
              showToast("Cliquez sur le tracé pour positionner l'entrée des stands.");
            }}
            style={{ padding: '5px 10px', background: placementMode === 'pitEntry' ? '#2563eb' : '#334155', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
          >
            ⛽ Placer Entrée Stands
          </button>

          <button
            onClick={() => {
              setPlacementMode('pitExit');
              showToast('Cliquez sur le tracé pour positionner la sortie des stands.');
            }}
            style={{ padding: '5px 10px', background: placementMode === 'pitExit' ? '#0284c7' : '#334155', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
          >
            🏁 Placer Sortie Stands
          </button>

          <button
            onClick={() => setPlacementMode('none')}
            style={{ padding: '5px 10px', background: '#64748b', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
          >
            ✖️ Terminer
          </button>
        </div>
      )}

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
            <p style={{ margin: 0, fontSize: '12px', color: '#94a3b8' }}>
              Sélectionnez le pilote qui prend le guidon pour le <strong>Relais #{currentStint + 1}</strong> :
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {drivers.map((d) => (
                <button
                  key={d}
                  onClick={() => handleChangeDriver(d)}
                  style={{
                    padding: '8px 12px',
                    background: d === currentDriver ? '#1d4ed8' : '#334155',
                    color: 'white',
                    border: '1px solid #475569',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '12px',
                    fontWeight: 'bold',
                    textAlign: 'left',
                    display: 'flex',
                    justifyContent: 'space-between',
                  }}
                >
                  <span>👤 {d}</span>
                  {d === currentDriver && <span style={{ fontSize: '10px', color: '#93c5fd' }}>(Actuel)</span>}
                </button>
              ))}
            </div>

            <button
              onClick={() => setShowDriverModal(false)}
              style={{ padding: '6px', background: '#64748b', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '11px', marginTop: '6px' }}
            >
              Annuler
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
