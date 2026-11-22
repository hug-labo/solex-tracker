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
  html: '<div style="background-color:#3b82f6;color:white;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;border:3px solid white;box-shadow:0 0 10px rgba(0,0,0,0.5);transform:translate(-2px,-2px);">🛵</div>',
  iconSize: [34, 34],
  iconAnchor: [17, 17],
});

// Icône pour les balises de secteurs et départ
const createSectorIcon = (label: string, bg: string, distanceM?: number) =>
  L.divIcon({
    className: 'custom-sector-marker',
    html: `<div style="background-color:${bg};color:white;padding:3px 8px;border-radius:6px;font-weight:bold;font-size:11px;border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.4);white-space:nowrap;display:flex;flex-direction:column;align-items:center;line-height:1.2;">
      <span>${label}</span>
      ${distanceM !== undefined ? `<span style="font-size:9px;opacity:0.9;font-weight:normal;">${Math.round(distanceM)}m</span>` : ''}
    </div>`,
    iconSize: [60, 30],
    iconAnchor: [30, 15],
  });

export interface IntermediatePoint {
  id: string;
  name: string; // Ex: "S1", "S2", etc.
  distance: number; // Distance en mètres depuis la ligne de départ le long de la piste
  latLng: [number, number];
}

export interface LapRecord {
  lap: number;
  intermediateTimes: (number | null)[]; // Temps de passage par rapport au départ (secondes)
  totalTime: number;
  avgSpeed: number;
}

export interface SavedCircuit {
  id: string;
  name: string;
  points: [number, number][];
  intermediates?: IntermediatePoint[];
}

// Circuits par défaut avec points intermédiaires préconfigurés
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
    // 3 intermédiaires par défaut (libre d'en ajouter ou retirer)
    intermediates: [
      { id: 's1', name: 'S1', distance: 680, latLng: [47.9525, 0.2050] },
      { id: 's2', name: 'S2', distance: 1360, latLng: [47.9520, 0.2125] },
      { id: 's3', name: 'S3', distance: 2040, latLng: [47.9472, 0.2095] },
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
  },
];

// Calcul géodésique de distance en mètres
function calculateDistanceMeters(p1: [number, number], p2: [number, number]): number {
  return L.latLng(p1[0], p1[1]).distanceTo(L.latLng(p2[0], p2[1]));
}

// Projeter un clic sur la piste pour trouver la position exacte et la distance depuis le départ
function projectPointOnTrack(
  clickLatLng: [number, number],
  trackPoints: [number, number][],
  cumDistances: number[]
): { distance: number; latLng: [number, number] } {
  if (trackPoints.length < 2) {
    return { distance: 0, latLng: trackPoints[0] || clickLatLng };
  }

  let bestDistToSegment = Infinity;
  let bestTrackDist = 0;
  let bestLatLng: [number, number] = trackPoints[0];

  const cLat = clickLatLng[0];
  const cLng = clickLatLng[1];

  for (let i = 0; i < trackPoints.length; i++) {
    const nextIdx = (i + 1) % trackPoints.length;
    const p1 = trackPoints[i];
    const p2 = trackPoints[nextIdx];

    const segStartDist = cumDistances[i];
    const segLenMeters = calculateDistanceMeters(p1, p2);
    if (segLenMeters <= 0) continue;

    // Projection planaire locale métrique
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
    }
  }

  return { distance: bestTrackDist, latLng: bestLatLng };
}

export default function App() {
  // Liste des circuits avec support de localStorage
  const [circuits, setCircuits] = useState<SavedCircuit[]>(() => {
    try {
      const saved = localStorage.getItem('solex_circuits_v3');
      if (saved) return JSON.parse(saved);
      // Migration v2 si présente
      const savedV2 = localStorage.getItem('solex_circuits_v2');
      if (savedV2) {
        const parsed = JSON.parse(savedV2);
        return parsed.map((c: any) => ({
          ...c,
          intermediates: c.intermediates || [
            { id: 's1', name: 'S1', distance: 500, latLng: c.points[1] || c.points[0] },
            { id: 's2', name: 'S2', distance: 1000, latLng: c.points[2] || c.points[0] },
          ],
        }));
      }
    } catch (e) {
      console.error('Erreur lecture circuits', e);
    }
    return DEFAULT_CIRCUITS;
  });

  const [selectedCircuitId, setSelectedCircuitId] = useState<string>(circuits[0]?.id || 'circuit-mans');

  const currentCircuit = useMemo(() => {
    return circuits.find((c) => c.id === selectedCircuitId) || circuits[0] || DEFAULT_CIRCUITS[0];
  }, [circuits, selectedCircuitId]);

  // Mode création de nouveau circuit
  const [isEditingTrack, setIsEditingTrack] = useState<boolean>(false);
  const [newCircuitName, setNewCircuitName] = useState<string>('Mon Nouveau Circuit');
  const [editTrackPoints, setEditTrackPoints] = useState<[number, number][]>([]);

  // Mode placement des balises intermédiaires
  const [isPlacingIntermediates, setIsPlacingIntermediates] = useState<boolean>(false);

  // Recherche de lieu
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSearching, setIsSearching] = useState<boolean>(false);

  // Données de télémétrie en direct
  const [speed, setSpeed] = useState<number>(0);
  const [targetSpeed, setTargetSpeed] = useState<number>(85);
  const [currentLap, setCurrentLap] = useState<number>(1);
  const [currentLapTime, setCurrentLapTime] = useState<number>(0);
  const [lapHistory, setLapHistory] = useState<LapRecord[]>([]);
  const [bestLapTime, setBestLapTime] = useState<number | null>(null);

  // Temps intermédiaires EN COURS (par rapport à la ligne de départ)
  const [liveSplitTimes, setLiveSplitTimes] = useState<(number | null)[]>([]);

  // Arrêt d'urgence et alerte
  const [simStopped, setSimStopped] = useState<boolean>(false);
  const [alertStopped, setAlertStopped] = useState<boolean>(false);

  // Références carte et objets Leaflet
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const polylineRef = useRef<L.Polyline | null>(null);
  const solexMarkerRef = useRef<L.Marker | null>(null);
  const sectorMarkersRef = useRef<L.Marker[]>([]);

  // Références physiques pour la simulation
  const distanceCoveredInLapRef = useRef<number>(0);
  const lapStartTimeRef = useRef<number>(Date.now());
  const lastTickTimeRef = useRef<number>(Date.now());
  const stopDurationRef = useRef<number>(0);
  const recordedSplitsThisLapRef = useRef<(number | null)[]>([]);

  // Calcul des métriques du circuit sélectionné
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

  // Points intermédiaires triés par distance depuis le départ
  const sortedIntermediates = useMemo(() => {
    const list = currentCircuit.intermediates ? [...currentCircuit.intermediates] : [];
    list.sort((a, b) => a.distance - b.distance);
    // Renommer dynamiquement S1, S2, S3... dans l'ordre de la piste
    return list.map((item, idx) => ({
      ...item,
      name: `S${idx + 1}`,
    }));
  }, [currentCircuit.intermediates]);

  // Positionner le Solex sur le tracé en fonction de la distance parcourue
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

  // Initialisation de la carte Leaflet
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const initialCenter = currentCircuit.points[0] || [47.95, 0.205];
    const map = L.map(mapContainerRef.current).setView(initialCenter, 16);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    polylineRef.current = L.polyline([...currentCircuit.points, currentCircuit.points[0]], {
      color: '#3b82f6',
      weight: 5,
    }).addTo(map);

    solexMarkerRef.current = L.marker(initialCenter, { icon: solexIcon }).addTo(map);
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Affichage dynamique des balises : Départ / Arrivée et tous les Intermédiaires Sn
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Supprimer les anciens marqueurs de secteurs
    sectorMarkersRef.current.forEach((m) => m.remove());
    sectorMarkersRef.current = [];

    if (isEditingTrack) return;

    const pts = currentCircuit.points;
    if (pts.length < 2) return;

    const markers: L.Marker[] = [];

    // Ligne Départ / Arrivée (Point 0)
    const startPos = pts[0];
    const startMarker = L.marker(startPos, {
      icon: createSectorIcon('🏁 DÉPART / ARRIVÉE', '#10b981', 0),
    }).addTo(map);
    startMarker.bindPopup('<b>🏁 Ligne de Départ / Arrivée</b><br>Chronométrage à 00:00.0');
    markers.push(startMarker);

    // Balises intermédiaires dynamiques S1, S2, ..., Sn
    sortedIntermediates.forEach((inter) => {
      const pos = inter.latLng || getPositionFromDistance(inter.distance);
      const marker = L.marker(pos, {
        icon: createSectorIcon(`🚩 ${inter.name}`, '#f59e0b', inter.distance),
      }).addTo(map);
      marker.bindPopup(`<b>Balise ${inter.name}</b><br>Distance départ : ${Math.round(inter.distance)} m<br><small>Temps mesuré par rapport au départ</small>`);
      markers.push(marker);
    });

    sectorMarkersRef.current = markers;

    // Ajuster le tracé du circuit
    if (polylineRef.current) {
      polylineRef.current.setLatLngs([...pts, pts[0]]);
    }
  }, [currentCircuit, isEditingTrack, sortedIntermediates]);

  // Clic sur la carte : gestion soit du tracé de circuit, soit du placement des balises
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handleClick = (e: L.LeafletMouseEvent) => {
      const clickPos: [number, number] = [e.latlng.lat, e.latlng.lng];

      // Cas 1 : En train de tracer un circuit
      if (isEditingTrack) {
        setEditTrackPoints((prev) => [...prev, clickPos]);
        return;
      }

      // Cas 2 : En mode placement d'un point intermédiaire
      if (isPlacingIntermediates) {
        const { distance, latLng } = projectPointOnTrack(clickPos, currentCircuit.points, trackMetrics.cumDistances);
        
        // Empêcher d'ajouter un point trop proche du départ (ex < 20m ou > total - 20m)
        if (distance < 20 || distance > trackMetrics.totalDistance - 20) {
          alert('Le point intermédiaire est trop proche de la ligne de départ/arrivée.');
          return;
        }

        const newInter: IntermediatePoint = {
          id: `inter-${Date.now()}`,
          name: `S${sortedIntermediates.length + 1}`,
          distance: distance,
          latLng: latLng,
        };

        const updatedList = [...(currentCircuit.intermediates || []), newInter];
        const updatedCircuit = { ...currentCircuit, intermediates: updatedList };

        const updatedCircuits = circuits.map((c) => (c.id === currentCircuit.id ? updatedCircuit : c));
        setCircuits(updatedCircuits);
        localStorage.setItem('solex_circuits_v3', JSON.stringify(updatedCircuits));
      }
    };

    map.on('click', handleClick);
    return () => {
      map.off('click', handleClick);
    };
  }, [isEditingTrack, isPlacingIntermediates, currentCircuit, trackMetrics, sortedIntermediates, circuits]);

  // Synchronisation visuelle du tracé pendant l'édition
  useEffect(() => {
    if (!isEditingTrack || !polylineRef.current) return;
    polylineRef.current.setLatLngs(editTrackPoints);
  }, [editTrackPoints, isEditingTrack]);

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
  // Calcul temps au tour & temps intermédiaires par rapport au départ
  useEffect(() => {
    if (isEditingTrack || currentCircuit.points.length < 2) return;

    lastTickTimeRef.current = Date.now();
    lapStartTimeRef.current = Date.now();
    distanceCoveredInLapRef.current = 0;
    recordedSplitsThisLapRef.current = new Array(sortedIntermediates.length).fill(null);
    setLiveSplitTimes(new Array(sortedIntermediates.length).fill(null));

    const interval = setInterval(() => {
      const now = Date.now();
      const dt = (now - lastTickTimeRef.current) / 1000;
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
      const variation = Math.sin(currentDist / 45) * 12;
      const instSpeed = Math.max(55, Math.min(105, targetSpeed + variation));
      setSpeed(Math.round(instSpeed));

      // Distance parcourue lors de ce tick
      const deltaMeters = (instSpeed / 3.6) * dt;
      const newLapDist = distanceCoveredInLapRef.current + deltaMeters;
      const totalTrackDist = trackMetrics.totalDistance;

      // Temps écoulé depuis le départ du tour actuel
      const lapTimeElapsed = (now - lapStartTimeRef.current) / 1000;
      setCurrentLapTime(lapTimeElapsed);

      // Détection du passage de chaque balise intermédiaire Sn
      sortedIntermediates.forEach((inter, idx) => {
        if (
          distanceCoveredInLapRef.current < inter.distance &&
          newLapDist >= inter.distance &&
          recordedSplitsThisLapRef.current[idx] === null
        ) {
          // Temps intermédiaire mesuré par rapport à la ligne de départ !
          recordedSplitsThisLapRef.current[idx] = lapTimeElapsed;
          setLiveSplitTimes([...recordedSplitsThisLapRef.current]);
        }
      });

      // Franchissement de la ligne d'arrivée
      if (newLapDist >= totalTrackDist) {
        const totalLapTime = lapTimeElapsed;
        const avgSpd = Math.round((totalTrackDist / totalLapTime) * 3.6);

        const newRecord: LapRecord = {
          lap: currentLap,
          intermediateTimes: [...recordedSplitsThisLapRef.current],
          totalTime: totalLapTime,
          avgSpeed: avgSpd,
        };

        setLapHistory((prev) => [newRecord, ...prev]);
        setBestLapTime((prev) => (!prev || totalLapTime < prev ? totalLapTime : prev));

        // Réinitialisation pour le tour suivant
        setCurrentLap((l) => l + 1);
        lapStartTimeRef.current = now;
        distanceCoveredInLapRef.current = newLapDist - totalTrackDist;
        recordedSplitsThisLapRef.current = new Array(sortedIntermediates.length).fill(null);
        setLiveSplitTimes(new Array(sortedIntermediates.length).fill(null));
      } else {
        distanceCoveredInLapRef.current = newLapDist;
      }

      // Mise à jour de la position du marqueur sur la carte
      const newPos = getPositionFromDistance(distanceCoveredInLapRef.current);
      if (solexMarkerRef.current) {
        solexMarkerRef.current.setLatLng(newPos);
      }
    }, 100);

    return () => clearInterval(interval);
  }, [isEditingTrack, currentCircuit, trackMetrics, sortedIntermediates, simStopped, targetSpeed, currentLap]);

  // Actions sur les balises intermédiaires
  const handleRemoveLastIntermediate = () => {
    if (!currentCircuit.intermediates || currentCircuit.intermediates.length === 0) return;
    const updated = [...currentCircuit.intermediates];
    updated.pop();
    saveIntermediates(updated);
  };

  const handleClearAllIntermediates = () => {
    if (window.confirm('Voulez-vous supprimer toutes les balises intermédiaires de ce circuit ?')) {
      saveIntermediates([]);
    }
  };

  // Répartition automatique équidistante
  const handleAutoDistribute = (count: number) => {
    const total = trackMetrics.totalDistance;
    const step = total / (count + 1);
    const newInters: IntermediatePoint[] = [];

    for (let i = 1; i <= count; i++) {
      const dist = step * i;
      const latLng = getPositionFromDistance(dist);
      newInters.push({
        id: `auto-s${i}-${Date.now()}`,
        name: `S${i}`,
        distance: dist,
        latLng: latLng,
      });
    }

    saveIntermediates(newInters);
  };

  const saveIntermediates = (newList: IntermediatePoint[]) => {
    const updatedCircuit = { ...currentCircuit, intermediates: newList };
    const updatedCircuits = circuits.map((c) => (c.id === currentCircuit.id ? updatedCircuit : c));
    setCircuits(updatedCircuits);
    localStorage.setItem('solex_circuits_v3', JSON.stringify(updatedCircuits));
    setLapHistory([]);
    setCurrentLap(1);
    setBestLapTime(null);
  };

  // Recherche de lieu OpenStreetMap Nominatim
  const handleSearchLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    setIsSearching(true);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=1`
      );
      const data = await res.json();
      if (data && data.length > 0) {
        const lat = parseFloat(data[0].lat);
        const lon = parseFloat(data[0].lon);
        if (mapRef.current) {
          mapRef.current.flyTo([lat, lon], 16, { duration: 1.5 });
        }
      } else {
        alert('Lieu introuvable. Précisez la ville ou la région.');
      }
    } catch (err) {
      alert('Erreur lors de la recherche.');
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

  // Enregistrer le nouveau circuit tracé
  const handleSaveCircuit = () => {
    if (editTrackPoints.length < 3) {
      alert('Veuillez cliquer au moins 3 points sur la carte pour former une piste.');
      return;
    }

    // Répartir 2 intermédiaires par défaut sur le nouveau circuit
    const newCircuit: SavedCircuit = {
      id: `circuit-${Date.now()}`,
      name: newCircuitName.trim() || `Circuit ${circuits.length + 1}`,
      points: editTrackPoints,
      intermediates: [],
    };

    const updated = [...circuits, newCircuit];
    setCircuits(updated);
    localStorage.setItem('solex_circuits_v3', JSON.stringify(updated));
    setSelectedCircuitId(newCircuit.id);
    setIsEditingTrack(false);
    setEditTrackPoints([]);
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', padding: '12px', gap: '10px', boxSizing: 'border-box', background: '#111827', color: '#f3f4f6', fontFamily: 'sans-serif' }}>
      {/* Alerte Arrêt Piste */}
      {alertStopped && (
        <div style={{ backgroundColor: '#dc2626', color: 'white', padding: '12px', borderRadius: '8px', textAlign: 'center', fontWeight: 'bold', fontSize: '16px', animation: 'pulse 1s infinite' }}>
          ⚠️ ALERTE STANDS : SOLEX IMMOBILISÉ EN PISTE DEPUIS PLUS DE 10 SECONDES !
        </div>
      )}

      {/* Barre supérieure : Sélecteur de circuit, Recherche, Actions */}
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
              setIsPlacingIntermediates(false);
            }}
            disabled={isEditingTrack}
            style={{ padding: '6px 10px', background: '#374151', color: 'white', border: '1px solid #4b5563', borderRadius: '6px', fontSize: '13px' }}
          >
            {circuits.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {/* Longueur du circuit & nombre de balises */}
        <div style={{ background: '#374151', padding: '6px 10px', borderRadius: '6px', fontSize: '12px', color: '#93c5fd' }}>
          📏 <strong>{Math.round(trackMetrics.totalDistance)} m</strong> | 🚩 <strong>{sortedIntermediates.length} balise{sortedIntermediates.length > 1 ? 's' : ''}</strong>
        </div>

        {/* Recherche de lieu */}
        <form onSubmit={handleSearchLocation} style={{ display: 'flex', gap: '6px', flex: '1', minWidth: '200px' }}>
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

        {/* Bouton Gérer les intermédiaires */}
        <button
          onClick={() => {
            setIsPlacingIntermediates(!isPlacingIntermediates);
            setIsEditingTrack(false);
          }}
          style={{
            padding: '6px 12px',
            background: isPlacingIntermediates ? '#f59e0b' : '#374151',
            color: isPlacingIntermediates ? '#111827' : 'white',
            border: '1px solid #f59e0b',
            borderRadius: '6px',
            cursor: 'pointer',
            fontWeight: 'bold',
            fontSize: '13px',
          }}
        >
          🚩 {isPlacingIntermediates ? 'Fermer Balises' : 'Placer Balises'}
        </button>

        {/* Bouton Créer circuit */}
        {!isEditingTrack ? (
          <button
            onClick={() => {
              setIsEditingTrack(true);
              setIsPlacingIntermediates(false);
              setEditTrackPoints([]);
            }}
            style={{ padding: '6px 12px', background: '#2563eb', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '13px' }}
          >
            ✏️ Tracer circuit
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
              💾 Enregistrer ({editTrackPoints.length} pts)
            </button>
            <button onClick={() => setIsEditingTrack(false)} style={{ padding: '6px 10px', background: '#6b7280', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>
              Annuler
            </button>
          </div>
        )}
      </div>

      {/* Barre d'outils dédiée pour placer les balises intermédiaires */}
      {isPlacingIntermediates && (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', background: '#2d3748', border: '1px solid #f59e0b', padding: '10px', borderRadius: '8px' }}>
          <div style={{ fontWeight: 'bold', color: '#fbbf24', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span>👉 Cliquez sur la piste pour ajouter une balise intermédiaire (S1, S2, ...)</span>
          </div>

          <div style={{ display: 'flex', gap: '6px', marginLeft: 'auto', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: '12px', color: '#9ca3af' }}>Répartition auto :</span>
            <button onClick={() => handleAutoDistribute(1)} style={{ padding: '4px 8px', background: '#4b5563', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>
              1 balise (2 sect.)
            </button>
            <button onClick={() => handleAutoDistribute(2)} style={{ padding: '4px 8px', background: '#4b5563', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>
              2 balises (3 sect.)
            </button>
            <button onClick={() => handleAutoDistribute(3)} style={{ padding: '4px 8px', background: '#4b5563', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>
              3 balises (4 sect.)
            </button>
            <button onClick={() => handleAutoDistribute(4)} style={{ padding: '4px 8px', background: '#4b5563', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>
              4 balises (5 sect.)
            </button>

            <button onClick={handleRemoveLastIntermediate} style={{ padding: '4px 8px', background: '#ef4444', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>
              🗑️ Suppr. dernière
            </button>
            <button onClick={handleClearAllIntermediates} style={{ padding: '4px 8px', background: '#7f1d1d', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>
              Vider tout
            </button>
          </div>
        </div>
      )}

      {/* Bandeau Télémétrie en direct */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '8px' }}>
        <div style={{ background: '#1f2937', padding: '8px', borderRadius: '8px', textAlign: 'center' }}>
          <div style={{ fontSize: '11px', color: '#9ca3af' }}>VITESSE GPS</div>
          <div style={{ fontSize: '22px', fontWeight: 'bold', color: '#60a5fa' }}>{speed} <span style={{ fontSize: '12px' }}>km/h</span></div>
        </div>
        <div style={{ background: '#1f2937', padding: '8px', borderRadius: '8px', textAlign: 'center' }}>
          <div style={{ fontSize: '11px', color: '#9ca3af' }}>TOUR EN COURS</div>
          <div style={{ fontSize: '22px', fontWeight: 'bold' }}>#{currentLap}</div>
        </div>
        <div style={{ background: '#1f2937', padding: '8px', borderRadius: '8px', textAlign: 'center' }}>
          <div style={{ fontSize: '11px', color: '#9ca3af' }}>CHRONO TOUR</div>
          <div style={{ fontSize: '22px', fontWeight: 'bold', color: '#fef08a' }}>{formatSec(currentLapTime)}</div>
        </div>
        <div style={{ background: '#1f2937', padding: '8px', borderRadius: '8px', textAlign: 'center' }}>
          <div style={{ fontSize: '11px', color: '#9ca3af' }}>MEILLEUR TOUR</div>
          <div style={{ fontSize: '22px', fontWeight: 'bold', color: '#34d399' }}>{formatSec(bestLapTime)}</div>
        </div>

        {/* Cartes dynamiques des temps intermédiaires par rapport à la ligne de départ */}
        {sortedIntermediates.length > 0 ? (
          sortedIntermediates.map((inter, idx) => (
            <div key={inter.id} style={{ background: '#1f2937', padding: '8px', borderRadius: '8px', textAlign: 'center' }}>
              <div style={{ fontSize: '11px', color: '#fbbf24' }}>
                {inter.name} (DEPUIS DÉPART)
              </div>
              <div style={{ fontSize: '18px', fontWeight: 'bold', color: liveSplitTimes[idx] !== null ? '#f59e0b' : '#6b7280', marginTop: '2px' }}>
                {formatSec(liveSplitTimes[idx])}
              </div>
              <div style={{ fontSize: '10px', color: '#9ca3af' }}>à {Math.round(inter.distance)}m</div>
            </div>
          ))
        ) : (
          <div style={{ background: '#1f2937', padding: '8px', borderRadius: '8px', textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: '12px', color: '#6b7280' }}>Aucune balise intermédiaire</span>
          </div>
        )}
      </div>

      {/* Zone centrale : Carte Leaflet & Tableau des Tours */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(350px, 1fr) 420px', gap: '10px', flex: 1, minHeight: '360px' }}>
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
            <h3 style={{ margin: 0, fontSize: '14px', color: '#f3f4f6' }}>📋 Historique des tours & Intermédiaires</h3>
            <span style={{ fontSize: '12px', color: '#9ca3af' }}>{lapHistory.length} tour{lapHistory.length > 1 ? 's' : ''} bouclé{lapHistory.length > 1 ? 's' : ''}</span>
          </div>

          <div style={{ fontSize: '11px', color: '#9ca3af', fontStyle: 'italic' }}>
            * Les temps S1, S2... correspondent au chrono cumulé depuis la ligne de départ.
          </div>

          <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #374151', borderRadius: '6px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', textAlign: 'center' }}>
              <thead>
                <tr style={{ background: '#374151', color: '#9ca3af', position: 'sticky', top: 0 }}>
                  <th style={{ padding: '6px 4px' }}>Tour</th>
                  {sortedIntermediates.map((inter) => (
                    <th key={inter.id} style={{ padding: '6px 4px', color: '#fbbf24' }}>
                      {inter.name}
                    </th>
                  ))}
                  <th style={{ padding: '6px 4px', color: '#60a5fa' }}>Temps au tour</th>
                  <th style={{ padding: '6px 4px' }}>Vitesse Moy.</th>
                </tr>
              </thead>
              <tbody>
                {lapHistory.length === 0 ? (
                  <tr>
                    <td colSpan={3 + sortedIntermediates.length} style={{ padding: '24px', color: '#6b7280' }}>
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
                        {sortedIntermediates.map((_, idx) => {
                          const splitVal = item.intermediateTimes[idx];
                          return (
                            <td key={idx} style={{ padding: '6px 4px', color: '#f59e0b' }}>
                              {splitVal !== null && splitVal !== undefined ? `${splitVal.toFixed(1)}s` : '-'}
                            </td>
                          );
                        })}
                        <td style={{ padding: '6px 4px', color: isBest ? '#34d399' : '#fbbf24', fontWeight: 'bold' }}>
                          {formatSec(item.totalTime)}
                        </td>
                        <td style={{ padding: '6px 4px', color: '#93c5fd' }}>
                          {item.avgSpeed} km/h
                        </td>
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
