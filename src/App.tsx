import React, { useState, useEffect, useRef, useMemo } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix icônes Leaflet par défaut
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

// Icône personnalisée Solex
const solexIcon = L.divIcon({
  className: 'custom-solex-marker',
  html: '<div style="background-color:#3b82f6;color:white;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;border:3px solid white;box-shadow:0 0 10px rgba(0,0,0,0.5);">🛵</div>',
  iconSize: [32, 32],
  iconAnchor: [16, 16],
});

// Icône pour les balises de secteurs
const createSectorIcon = (label: string, bg: string) =>
  L.divIcon({
    className: 'custom-sector-marker',
    html: `<div style="background-color:${bg};color:white;padding:2px 6px;border-radius:4px;font-weight:bold;font-size:12px;border:2px solid white;box-shadow:0 0 6px rgba(0,0,0,0.4);white-space:nowrap;">${label}</div>`,
    iconSize: [40, 24],
    iconAnchor: [20, 12],
  });

interface LapRecord {
  lap: number;
  s1: number;
  s2: number;
  s3: number;
  s4: number;
  s5: number;
  totalTime: number;
  avgSpeed: number;
}

interface SavedCircuit {
  id: string;
  name: string;
  points: [number, number][];
}

// Circuit par défaut réaliste (Le Mans Karting / Circuit d'endurance ~1.4 km)
const DEFAULT_CIRCUITS: SavedCircuit[] = [
  {
    id: 'circuit-mans',
    name: 'Circuit Endurance Le Mans (1.4 km)',
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
  },
  {
    id: 'circuit-nouziers',
    name: 'Circuit Type Nouziers (3.2 km)',
    points: [
      [46.4250, 1.9400],
      [46.4280, 1.9480],
      [46.4310, 1.9560],
      [46.4270, 1.9600],
      [46.4220, 1.9550],
      [46.4180, 1.9480],
      [46.4200, 1.9410],
    ],
  },
];

// Calcul géodésique de distance en mètres
function calculateDistanceMeters(p1: [number, number], p2: [number, number]): number {
  return L.latLng(p1[0], p1[1]).distanceTo(L.latLng(p2[0], p2[1]));
}

export default function App() {
  // Liste des circuits
  const [circuits, setCircuits] = useState<SavedCircuit[]>(() => {
    const saved = localStorage.getItem('solex_circuits_v2');
    return saved ? JSON.parse(saved) : DEFAULT_CIRCUITS;
  });
  const [selectedCircuitId, setSelectedCircuitId] = useState<string>(circuits[0]?.id || 'circuit-mans');

  const currentCircuit = useMemo(() => {
    return circuits.find((c) => c.id === selectedCircuitId) || circuits[0] || DEFAULT_CIRCUITS[0];
  }, [circuits, selectedCircuitId]);

  // Mode édition de circuit
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [newCircuitName, setNewCircuitName] = useState<string>('Mon Nouveau Circuit');
  const [editPoints, setEditPoints] = useState<[number, number][]>([]);

  // Recherche de lieu
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSearching, setIsSearching] = useState<boolean>(false);

  // Données de télémétrie en direct
  const [speed, setSpeed] = useState<number>(0);
  const [targetSpeed, setTargetSpeed] = useState<number>(80);
  const [currentLap, setCurrentLap] = useState<number>(1);
  const [currentLapTime, setCurrentLapTime] = useState<number>(0);
  const [lapHistory, setLapHistory] = useState<LapRecord[]>([]);
  const [bestLapTime, setBestLapTime] = useState<number | null>(null);

  // Temps en direct du tour en cours pour les secteurs
  const [liveS1, setLiveS1] = useState<number | null>(null);
  const [liveS2, setLiveS2] = useState<number | null>(null);
  const [liveS3, setLiveS3] = useState<number | null>(null);
  const [liveS4, setLiveS4] = useState<number | null>(null);

  // Arrêt d'urgence et alerte
  const [simStopped, setSimStopped] = useState<boolean>(false);
  const [alertStopped, setAlertStopped] = useState<boolean>(false);

  // Références carte et objets Leaflet
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const polylineRef = useRef<L.Polyline | null>(null);
  const solexMarkerRef = useRef<L.Marker | null>(null);
  const sectorMarkersRef = useRef<L.Marker[]>([]);

  // Références physiques pour la simulation précise
  const distanceCoveredInLapRef = useRef<number>(0);
  const lapStartTimeRef = useRef<number>(Date.now());
  const lastTickTimeRef = useRef<number>(Date.now());
  const currentSpeedRef = useRef<number>(80);
  const stopDurationRef = useRef<number>(0);
  const sectorSplitsRef = useRef<{ s1: number; s2: number; s3: number; s4: number }>({ s1: 0, s2: 0, s3: 0, s4: 0 });

  // Calcul des métriques du circuit sélectionné
  const trackMetrics = useMemo(() => {
    const pts = currentCircuit.points;
    if (pts.length < 2) return { totalDistance: 1000, cumDistances: [0], s1Dist: 200, s2Dist: 400, s3Dist: 600, s4Dist: 800 };

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
      s1Dist: total * 0.20,
      s2Dist: total * 0.40,
      s3Dist: total * 0.60,
      s4Dist: total * 0.80,
    };
  }, [currentCircuit]);

  // Positionner le Solex sur le tracé en fonction de la distance parcourue
  const getPositionFromDistance = (dist: number): [number, number] => {
    const pts = currentCircuit.points;
    if (pts.length < 2) return pts[0] || [47.95, 0.2];

    const total = trackMetrics.totalDistance;
    const normalizedDist = ((dist % total) + total) % total;

    let segmentIndex = 0;
    for (let i = 0; i < pts.length; i++) {
      const nextIndex = (i + 1) % pts.length;
      const segDist = calculateDistanceMeters(pts[i], pts[nextIndex]);
      const segStart = trackMetrics.cumDistances[i];
      if (normalizedDist >= segStart && normalizedDist <= segStart + segDist) {
        segmentIndex = i;
        const progress = segDist > 0 ? (normalizedDist - segStart) / segDist : 0;
        const lat = pts[i][0] + (pts[nextIndex][0] - pts[i][0]) * progress;
        const lng = pts[i][1] + (pts[nextIndex][1] - pts[i][1]) * progress;
        return [lat, lng];
      }
    }
    return pts[0];
  };

  // Initialisation de la carte Leaflet
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const initialCenter = currentCircuit.points[0] || [47.95, 0.205];
    const map = L.map(mapContainerRef.current).setView(initialCenter, 16);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    polylineRef.current = L.polyline(currentCircuit.points, { color: '#3b82f6', weight: 5 }).addTo(map);
    solexMarkerRef.current = L.marker(initialCenter, { icon: solexIcon }).addTo(map);

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Affichage des balises Départ/Arrivée, S1, S2, S3, S4
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Supprimer les anciens marqueurs de secteurs
    sectorMarkersRef.current.forEach((m) => m.remove());
    sectorMarkersRef.current = [];

    if (isEditing) return;

    const pts = currentCircuit.points;
    if (pts.length < 2) return;

    const markers: L.Marker[] = [];

    // Ligne Départ / Arrivée
    const startPos = pts[0];
    const startMarker = L.marker(startPos, { icon: createSectorIcon('🏁 DÉPART / ARRIVÉE', '#10b981') }).addTo(map);
    markers.push(startMarker);

    // S1, S2, S3, S4
    const s1Pos = getPositionFromDistance(trackMetrics.s1Dist);
    const s2Pos = getPositionFromDistance(trackMetrics.s2Dist);
    const s3Pos = getPositionFromDistance(trackMetrics.s3Dist);
    const s4Pos = getPositionFromDistance(trackMetrics.s4Dist);

    markers.push(L.marker(s1Pos, { icon: createSectorIcon('S1', '#f59e0b') }).addTo(map));
    markers.push(L.marker(s2Pos, { icon: createSectorIcon('S2', '#f59e0b') }).addTo(map));
    markers.push(L.marker(s3Pos, { icon: createSectorIcon('S3', '#f59e0b') }).addTo(map));
    markers.push(L.marker(s4Pos, { icon: createSectorIcon('S4', '#f59e0b') }).addTo(map));

    sectorMarkersRef.current = markers;

    // Ajuster le tracé du circuit
    if (polylineRef.current) {
      polylineRef.current.setLatLngs([...pts, pts[0]]);
    }
  }, [currentCircuit, isEditing, trackMetrics]);

  // Écoute des clics en mode création de circuit
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handleClick = (e: L.LeafletMouseEvent) => {
      if (!isEditing) return;
      setEditPoints((prev) => [...prev, [e.latlng.lat, e.latlng.lng]]);
    };

    map.on('click', handleClick);
    return () => {
      map.off('click', handleClick);
    };
  }, [isEditing]);

  // Synchronisation du tracé pendant l'édition
  useEffect(() => {
    if (!isEditing || !polylineRef.current) return;
    polylineRef.current.setLatLngs(editPoints);
  }, [editPoints, isEditing]);

  // Alerte sonore Bip
  const playBeep = () => {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(850, ctx.currentTime);
      osc.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    } catch (e) {
      console.log('Audio notification bloquée');
    }
  };

  // BOUCLE DE SIMULATION HAUTE PRÉCISION (10 Hz = 100ms)
  // Distance et temps cohérents : distance = vitesse * temps
  useEffect(() => {
    if (isEditing || currentCircuit.points.length < 2) return;

    lastTickTimeRef.current = Date.now();
    lapStartTimeRef.current = Date.now();
    distanceCoveredInLapRef.current = 0;

    const interval = setInterval(() => {
      const now = Date.now();
      const dt = (now - lastTickTimeRef.current) / 1000; // dt en secondes
      lastTickTimeRef.current = now;

      if (simStopped) {
        setSpeed(0);
        stopDurationRef.current += dt;
        if (stopDurationRef.current >= 10) {
          setAlertStopped(true);
          playBeep();
        }
        return;
      }

      stopDurationRef.current = 0;
      setAlertStopped(false);

      // Fluctuation réaliste de vitesse (virages / lignes droites)
      const currentDist = distanceCoveredInLapRef.current;
      const variation = Math.sin(currentDist / 40) * 12;
      const instSpeed = Math.max(55, Math.min(105, targetSpeed + variation));
      currentSpeedRef.current = instSpeed;
      setSpeed(Math.round(instSpeed));

      // Distance parcourue lors de ce tick (mètres = (km/h / 3.6) * s)
      const deltaMeters = (instSpeed / 3.6) * dt;
      const newLapDist = distanceCoveredInLapRef.current + deltaMeters;
      const totalTrackDist = trackMetrics.totalDistance;

      // Détection des passages de secteurs
      const prevDist = distanceCoveredInLapRef.current;
      const lapTimeElapsed = (now - lapStartTimeRef.current) / 1000;
      setCurrentLapTime(lapTimeElapsed);

      if (prevDist < trackMetrics.s1Dist && newLapDist >= trackMetrics.s1Dist) {
        sectorSplitsRef.current.s1 = lapTimeElapsed;
        setLiveS1(lapTimeElapsed);
      }
      if (prevDist < trackMetrics.s2Dist && newLapDist >= trackMetrics.s2Dist) {
        const s2Duration = lapTimeElapsed - sectorSplitsRef.current.s1;
        sectorSplitsRef.current.s2 = s2Duration;
        setLiveS2(s2Duration);
      }
      if (prevDist < trackMetrics.s3Dist && newLapDist >= trackMetrics.s3Dist) {
        const s3Duration = lapTimeElapsed - (sectorSplitsRef.current.s1 + sectorSplitsRef.current.s2);
        sectorSplitsRef.current.s3 = s3Duration;
        setLiveS3(s3Duration);
      }
      if (prevDist < trackMetrics.s4Dist && newLapDist >= trackMetrics.s4Dist) {
        const s4Duration = lapTimeElapsed - (sectorSplitsRef.current.s1 + sectorSplitsRef.current.s2 + sectorSplitsRef.current.s3);
        sectorSplitsRef.current.s4 = s4Duration;
        setLiveS4(s4Duration);
      }

      // Franchissement de la ligne d'arrivée
      if (newLapDist >= totalTrackDist) {
        const totalLapTime = lapTimeElapsed;
        const s5Duration = totalLapTime - (sectorSplitsRef.current.s1 + sectorSplitsRef.current.s2 + sectorSplitsRef.current.s3 + sectorSplitsRef.current.s4);
        const avgSpd = Math.round((totalTrackDist / totalLapTime) * 3.6);

        const newRecord: LapRecord = {
          lap: currentLap,
          s1: sectorSplitsRef.current.s1,
          s2: sectorSplitsRef.current.s2,
          s3: sectorSplitsRef.current.s3,
          s4: sectorSplitsRef.current.s4,
          s5: s5Duration,
          totalTime: totalLapTime,
          avgSpeed: avgSpd,
        };

        setLapHistory((prev) => [newRecord, ...prev]);
        setBestLapTime((prev) => (!prev || totalLapTime < prev ? totalLapTime : prev));

        // Réinitialisation pour le tour suivant
        setCurrentLap((l) => l + 1);
        lapStartTimeRef.current = now;
        distanceCoveredInLapRef.current = newLapDist - totalTrackDist;
        sectorSplitsRef.current = { s1: 0, s2: 0, s3: 0, s4: 0 };
        setLiveS1(null);
        setLiveS2(null);
        setLiveS3(null);
        setLiveS4(null);
      } else {
        distanceCoveredInLapRef.current = newLapDist;
      }

      // Mise à jour de la position du marqueur
      const newPos = getPositionFromDistance(distanceCoveredInLapRef.current);
      if (solexMarkerRef.current) {
        solexMarkerRef.current.setLatLng(newPos);
      }
    }, 100);

    return () => clearInterval(interval);
  }, [isEditing, currentCircuit, trackMetrics, simStopped, targetSpeed, currentLap]);

  // Recherche de lieu OpenStreetMap Nominatim
  const handleSearchLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    setIsSearching(true);
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=1`);
      const data = await res.json();
      if (data && data.length > 0) {
        const lat = parseFloat(data[0].lat);
        const lon = parseFloat(data[0].lon);
        if (mapRef.current) {
          mapRef.current.flyTo([lat, lon], 16, { duration: 1.5 });
        }
      } else {
        alert('Lieu introuvable, essayez avec un nom de commune plus précis.');
      }
    } catch (err) {
      alert('Erreur lors de la recherche du lieu.');
    } finally {
      setIsSearching(false);
    }
  };

  // Recentrer la carte
  const handleRecenterSolex = () => {
    if (!mapRef.current) return;
    const pos = getPositionFromDistance(distanceCoveredInLapRef.current);
    mapRef.current.panTo(pos, { animate: true });
  };

  const handleFitCircuit = () => {
    if (!mapRef.current || !polylineRef.current) return;
    mapRef.current.fitBounds(polylineRef.current.getBounds(), { padding: [40, 40] });
  };

  // Enregistrer le nouveau circuit
  const handleSaveCircuit = () => {
    if (editPoints.length < 3) {
      alert('Veuillez cliquer au moins 3 points sur la carte pour former une piste.');
      return;
    }
    const newCircuit: SavedCircuit = {
      id: `circuit-${Date.now()}`,
      name: newCircuitName.trim() || `Circuit ${circuits.length + 1}`,
      points: editPoints,
    };

    const updated = [...circuits, newCircuit];
    setCircuits(updated);
    localStorage.setItem('solex_circuits_v2', JSON.stringify(updated));
    setSelectedCircuitId(newCircuit.id);
    setIsEditing(false);
    setEditPoints([]);
    setLapHistory([]);
    setCurrentLap(1);
    setBestLapTime(null);
  };

  const formatSec = (sec: number | null) => {
    if (sec === null || isNaN(sec)) return '--:--.-';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 10);
    return `${m}:${s < 10 ? '0' : ''}${s}.${ms}`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', padding: '12px', gap: '12px', boxSizing: 'border-box' }}>
      {/* Alerte Arrêt Piste */}
      {alertStopped && (
        <div style={{ backgroundColor: '#dc2626', color: 'white', padding: '12px', borderRadius: '8px', textAlign: 'center', fontWeight: 'bold', fontSize: '17px', animation: 'pulse 1s infinite' }}>
          ⚠️ ALERTE STANDS : SOLEX IMMOBILISÉ EN PISTE DEPUIS PLUS DE 10 SECONDES !
        </div>
      )}

      {/* Barre supérieure : Sélecteur de circuit, Recherche de lieu et Actions */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', background: '#1f2937', padding: '10px', borderRadius: '8px' }}>
        {/* Choix du circuit */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '13px', color: '#9ca3af' }}>Circuit :</span>
          <select
            value={selectedCircuitId}
            onChange={(e) => {
              setSelectedCircuitId(e.target.value);
              setLapHistory([]);
              setCurrentLap(1);
              setBestLapTime(null);
            }}
            disabled={isEditing}
            style={{ padding: '6px 10px', background: '#374151', color: 'white', border: '1px solid #4b5563', borderRadius: '6px' }}
          >
            {circuits.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {/* Longueur du circuit calculée */}
        <div style={{ background: '#374151', padding: '6px 10px', borderRadius: '6px', fontSize: '13px', color: '#93c5fd' }}>
          Longueur : <strong>{Math.round(trackMetrics.totalDistance)} m</strong>
        </div>

        {/* Recherche de lieu */}
        <form onSubmit={handleSearchLocation} style={{ display: 'flex', gap: '6px', flex: '1', minWidth: '220px' }}>
          <input
            type="text"
            placeholder="Chercher un lieu, ville ou circuit..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ flex: 1, padding: '6px 10px', background: '#374151', color: 'white', border: '1px solid #4b5563', borderRadius: '6px', fontSize: '13px' }}
          />
          <button type="submit" disabled={isSearching} style={{ padding: '6px 12px', background: '#4b5563', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>
            {isSearching ? '...' : '🔍'}
          </button>
        </form>

        {/* Boutons Recentrage */}
        <button onClick={handleRecenterSolex} style={{ padding: '6px 10px', background: '#374151', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' }}>
          🎯 Recentrer Solex
        </button>
        <button onClick={handleFitCircuit} style={{ padding: '6px 10px', background: '#374151', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' }}>
          🗺️ Vue Circuit
        </button>

        {/* Bouton Créer circuit */}
        {!isEditing ? (
          <button
            onClick={() => {
              setIsEditing(true);
              setEditPoints([]);
            }}
            style={{ padding: '6px 12px', background: '#2563eb', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '13px' }}
          >
            ✏️ Tracer un circuit
          </button>
        ) : (
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <input
              type="text"
              placeholder="Nom du circuit"
              value={newCircuitName}
              onChange={(e) => setNewCircuitName(e.target.value)}
              style={{ padding: '6px 10px', background: '#374151', color: 'white', border: '1px solid #f59e0b', borderRadius: '6px', fontSize: '13px' }}
            />
            <button onClick={handleSaveCircuit} style={{ padding: '6px 12px', background: '#10b981', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>
              💾 Enregistrer ({editPoints.length} pts)
            </button>
            <button onClick={() => setIsEditing(false)} style={{ padding: '6px 10px', background: '#6b7280', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>
              Annuler
            </button>
          </div>
        )}
      </div>

      {/* Bandeau Télémétrie en direct */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '8px' }}>
        <div style={{ background: '#1f2937', padding: '8px', borderRadius: '8px', textAlign: 'center' }}>
          <div style={{ fontSize: '11px', color: '#9ca3af' }}>VITESSE GPS</div>
          <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#60a5fa' }}>{speed} <span style={{ fontSize: '12px' }}>km/h</span></div>
        </div>
        <div style={{ background: '#1f2937', padding: '8px', borderRadius: '8px', textAlign: 'center' }}>
          <div style={{ fontSize: '11px', color: '#9ca3af' }}>TOUR EN COURS</div>
          <div style={{ fontSize: '24px', fontWeight: 'bold' }}>#{currentLap}</div>
        </div>
        <div style={{ background: '#1f2937', padding: '8px', borderRadius: '8px', textAlign: 'center' }}>
          <div style={{ fontSize: '11px', color: '#9ca3af' }}>CHRONO TOUR</div>
          <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#fef08a' }}>{formatSec(currentLapTime)}</div>
        </div>
        <div style={{ background: '#1f2937', padding: '8px', borderRadius: '8px', textAlign: 'center' }}>
          <div style={{ fontSize: '11px', color: '#9ca3af' }}>MEILLEUR TOUR</div>
          <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#34d399' }}>{formatSec(bestLapTime)}</div>
        </div>
        <div style={{ background: '#1f2937', padding: '8px', borderRadius: '8px', textAlign: 'center' }}>
          <div style={{ fontSize: '11px', color: '#9ca3af' }}>SECTEURS S1 / S2</div>
          <div style={{ fontSize: '13px', fontWeight: 'bold', marginTop: '4px' }}>
            S1: <span style={{ color: '#f59e0b' }}>{formatSec(liveS1)}</span> | S2: <span style={{ color: '#f59e0b' }}>{formatSec(liveS2)}</span>
          </div>
        </div>
        <div style={{ background: '#1f2937', padding: '8px', borderRadius: '8px', textAlign: 'center' }}>
          <div style={{ fontSize: '11px', color: '#9ca3af' }}>SECTEURS S3 / S4</div>
          <div style={{ fontSize: '13px', fontWeight: 'bold', marginTop: '4px' }}>
            S3: <span style={{ color: '#f59e0b' }}>{formatSec(liveS3)}</span> | S4: <span style={{ color: '#f59e0b' }}>{formatSec(liveS4)}</span>
          </div>
        </div>
      </div>

      {/* Zone centrale : Carte Leaflet & Tableau des Tours */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(350px, 1fr) 380px', gap: '12px', flex: 1, minHeight: '380px' }}>
        {/* Carte */}
        <div style={{ borderRadius: '8px', overflow: 'hidden', border: '1px solid #374151', position: 'relative' }}>
          <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />

          {/* Bouton simulation arrêt piste */}
          <div style={{ position: 'absolute', bottom: '12px', left: '12px', zIndex: 1000 }}>
            <button
              onClick={() => setSimStopped(!simStopped)}
              style={{
                padding: '8px 14px',
                backgroundColor: simStopped ? '#10b981' : '#dc2626',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: 'bold',
                boxShadow: '0 4px 6px rgba(0,0,0,0.3)',
              }}
            >
              {simStopped ? '▶️ Reprendre la course' : '🛑 Simuler arrêt piste (>10s)'}
            </button>
          </div>
        </div>

        {/* Tableau d'affichage complet de tous les tours */}
        <div style={{ background: '#1f2937', borderRadius: '8px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px', overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: '15px', color: '#f3f4f6' }}>📋 Tableau de tous les tours</h3>
            <span style={{ fontSize: '12px', color: '#9ca3af' }}>{lapHistory.length} tours bouclés</span>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #374151', borderRadius: '6px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', textAlign: 'center' }}>
              <thead>
                <tr style={{ background: '#374151', color: '#9ca3af', position: 'sticky', top: 0 }}>
                  <th style={{ padding: '6px 4px' }}>Tour</th>
                  <th style={{ padding: '6px 4px' }}>S1</th>
                  <th style={{ padding: '6px 4px' }}>S2</th>
                  <th style={{ padding: '6px 4px' }}>S3</th>
                  <th style={{ padding: '6px 4px' }}>S4</th>
                  <th style={{ padding: '6px 4px' }}>S5</th>
                  <th style={{ padding: '6px 4px' }}>Total</th>
                  <th style={{ padding: '6px 4px' }}>Moy.</th>
                </tr>
              </thead>
              <tbody>
                {lapHistory.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ padding: '20px', color: '#6b7280' }}>
                      En attente du premier tour bouclé...
                    </td>
                  </tr>
                ) : (
                  lapHistory.map((item) => {
                    const isBest = bestLapTime !== null && Math.abs(item.totalTime - bestLapTime) < 0.05;
                    return (
                      <tr
                        key={item.lap}
                        style={{
                          borderBottom: '1px solid #2d3748',
                          background: isBest ? 'rgba(16, 185, 129, 0.15)' : 'transparent',
                          color: isBest ? '#34d399' : '#f3f4f6',
                          fontWeight: isBest ? 'bold' : 'normal',
                        }}
                      >
                        <td style={{ padding: '6px 4px' }}>#{item.lap}</td>
                        <td style={{ padding: '6px 4px' }}>{item.s1.toFixed(1)}s</td>
                        <td style={{ padding: '6px 4px' }}>{item.s2.toFixed(1)}s</td>
                        <td style={{ padding: '6px 4px' }}>{item.s3.toFixed(1)}s</td>
                        <td style={{ padding: '6px 4px' }}>{item.s4.toFixed(1)}s</td>
                        <td style={{ padding: '6px 4px' }}>{item.s5.toFixed(1)}s</td>
                        <td style={{ padding: '6px 4px', color: isBest ? '#34d399' : '#fbbf24' }}>{formatSec(item.totalTime)}</td>
                        <td style={{ padding: '6px 4px', color: '#93c5fd' }}>{item.avgSpeed} km/h</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
