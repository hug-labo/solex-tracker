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
  html: '<div style="background-color:#3b82f6;color:white;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;border:3px solid white;box-shadow:0 0 10px rgba(0,0,0,0.6);transform:translate(-2px,-2px);">🛵</div>',
  iconSize: [34, 34],
  iconAnchor: [17, 17],
});

// Icône pour les balises de secteurs et départ
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

export interface IntermediatePoint {
  id: string;
  name: string;
  distance: number; // en mètres depuis la ligne de départ
  latLng: [number, number];
}

export interface LapRecord {
  lap: number;
  intermediateTimes: (number | null)[];
  totalTime: number;
  avgSpeed: number;
}

export interface SavedCircuit {
  id: string;
  name: string;
  points: [number, number][];
  intermediates?: IntermediatePoint[];
}

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

export default function App() {
  const [circuits, setCircuits] = useState<SavedCircuit[]>(() => {
    try {
      const saved = localStorage.getItem('solex_circuits_v5');
      if (saved) return JSON.parse(saved);
      const savedV4 = localStorage.getItem('solex_circuits_v4');
      if (savedV4) return JSON.parse(savedV4);
      const savedV3 = localStorage.getItem('solex_circuits_v3');
      if (savedV3) return JSON.parse(savedV3);
    } catch (e) {
      console.error('Erreur lecture circuits', e);
    }
    return DEFAULT_CIRCUITS;
  });

  const [selectedCircuitId, setSelectedCircuitId] = useState<string>(circuits[0]?.id || 'circuit-mans');

  const currentCircuit = useMemo(() => {
    return circuits.find((c) => c.id === selectedCircuitId) || circuits[0] || DEFAULT_CIRCUITS[0];
  }, [circuits, selectedCircuitId]);

  // Choix de la vue carte : Satellite, Plan standard, ou Vue Sombre / Nuit
  const [mapLayerType, setMapLayerType] = useState<'satellite' | 'streets' | 'dark'>('satellite');

  // Mode tracé de nouveau circuit
  const [isEditingTrack, setIsEditingTrack] = useState<boolean>(false);
  const [newCircuitName, setNewCircuitName] = useState<string>('Mon Nouveau Circuit');
  const [editTrackPoints, setEditTrackPoints] = useState<[number, number][]>([]);

  // Mode gestion du départ et des balises
  const [isPlacingMenuOpen, setIsPlacingMenuOpen] = useState<boolean>(false);
  const [placementMode, setPlacementMode] = useState<'none' | 'startLine' | 'intermediate'>('none');
  const [notificationMsg, setNotificationMsg] = useState<string | null>(null);

  // Recherche de lieu
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSearching, setIsSearching] = useState<boolean>(false);

  // Données de télémétrie en direct
  const [speed, setSpeed] = useState<number>(0);
  const [targetSpeed] = useState<number>(85);
  const [currentLap, setCurrentLap] = useState<number>(1);
  const [currentLapTime, setCurrentLapTime] = useState<number>(0);
  const [lapHistory, setLapHistory] = useState<LapRecord[]>([]);
  const [bestLapTime, setBestLapTime] = useState<number | null>(null);

  // Temps intermédiaires EN COURS (par rapport à la ligne de départ)
  const [liveSplitTimes, setLiveSplitTimes] = useState<(number | null)[]>([]);

  // Arrêt d'urgence (silencieux) et durée d'arrêt
  const [simStopped, setSimStopped] = useState<boolean>(false);
  const [alertStopped, setAlertStopped] = useState<boolean>(false);
  const [stopElapsedSeconds, setStopElapsedSeconds] = useState<number>(0);

  // Références carte Leaflet
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const currentTileLayerRef = useRef<L.TileLayer | null>(null);
  const polylineRef = useRef<L.Polyline | null>(null);
  const solexMarkerRef = useRef<L.Marker | null>(null);
  const sectorMarkersRef = useRef<L.Marker[]>([]);

  // Références physiques de simulation
  // Permet une reprise immédiate et exacte au point d'arrêt sans réinitialisation !
  const distanceCoveredInLapRef = useRef<number>(0);
  const lapStartTimeRef = useRef<number>(Date.now());
  const lastTickTimeRef = useRef<number>(Date.now());
  const simStoppedRef = useRef<boolean>(false);
  const stopDurationRef = useRef<number>(0);
  const recordedSplitsThisLapRef = useRef<(number | null)[]>([]);

  // Synchroniser la ref d'arrêt pour la boucle de simulation
  useEffect(() => {
    simStoppedRef.current = simStopped;
    if (!simStopped) {
      // Reprise de la course : réajuster le chronomètre pour que le temps d'arrêt n'occasionne aucun saut de position
      lastTickTimeRef.current = Date.now();
      setAlertStopped(false);
      setStopElapsedSeconds(0);
      stopDurationRef.current = 0;
    }
  }, [simStopped]);

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

  // Initialisation de la carte Leaflet
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const initialCenter = currentCircuit.points[0] || [47.95, 0.205];
    const map = L.map(mapContainerRef.current).setView(initialCenter, 16);

    // Couche initiale
    const satLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
        maxZoom: 19,
      }
    ).addTo(map);

    currentTileLayerRef.current = satLayer;

    polylineRef.current = L.polyline([...currentCircuit.points, currentCircuit.points[0]], {
      color: '#38bdf8',
      weight: 5,
      opacity: 0.9,
    }).addTo(map);

    solexMarkerRef.current = L.marker(initialCenter, { icon: solexIcon }).addTo(map);
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Changement dynamique de la couche de carte (Satellite, Plan, Sombre)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (currentTileLayerRef.current) {
      currentTileLayerRef.current.remove();
    }

    let newLayer: L.TileLayer;
    if (mapLayerType === 'satellite') {
      newLayer = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        {
          attribution: 'Tiles &copy; Esri World Imagery',
          maxZoom: 19,
        }
      );
    } else if (mapLayerType === 'dark') {
      newLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap &copy; CartoDB',
        maxZoom: 19,
      });
    } else {
      newLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19,
      });
    }

    newLayer.addTo(map);
    currentTileLayerRef.current = newLayer;

    // Ajuster la couleur du tracé pour une lisibilité optimale
    if (polylineRef.current) {
      polylineRef.current.setStyle({
        color: mapLayerType === 'streets' ? '#2563eb' : '#38bdf8',
      });
    }
  }, [mapLayerType]);

  // Affichage des balises Départ / Arrivée et Intermédiaires Sn
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    sectorMarkersRef.current.forEach((m) => m.remove());
    sectorMarkersRef.current = [];

    if (isEditingTrack) return;

    const pts = currentCircuit.points;
    if (pts.length < 2) return;

    const markers: L.Marker[] = [];

    // Ligne de départ / arrivée (Point 0)
    const startPos = pts[0];
    const startMarker = L.marker(startPos, {
      icon: createSectorIcon('🏁 DÉPART / ARRIVÉE', '#10b981', 0),
    }).addTo(map);
    startMarker.bindPopup('<b>🏁 Ligne de Départ / Arrivée</b><br>Chronométrage à 00:00.0');
    markers.push(startMarker);

    // Balises intermédiaires
    sortedIntermediates.forEach((inter) => {
      const pos = inter.latLng || getPositionFromDistance(inter.distance);
      const marker = L.marker(pos, {
        icon: createSectorIcon(`🚩 ${inter.name}`, '#f59e0b', inter.distance),
      }).addTo(map);
      marker.bindPopup(`<b>Balise ${inter.name}</b><br>Distance départ : ${Math.round(inter.distance)} m<br><small>Temps mesuré depuis le départ</small>`);
      markers.push(marker);
    });

    sectorMarkersRef.current = markers;

    if (polylineRef.current) {
      polylineRef.current.setLatLngs([...pts, pts[0]]);
    }
  }, [currentCircuit, isEditingTrack, sortedIntermediates]);

  // Gestion des clics sur la carte
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handleClick = (e: L.LeafletMouseEvent) => {
      const clickPos: [number, number] = [e.latlng.lat, e.latlng.lng];

      // Cas 1 : Tracé d'un nouveau circuit
      if (isEditingTrack) {
        setEditTrackPoints((prev) => [...prev, clickPos]);
        return;
      }

      // Cas 2 : Déplacement au clic de la ligne de Départ / Arrivée
      if (placementMode === 'startLine') {
        const newTrackPoints = reanchorTrackToStartPoint(currentCircuit.points, clickPos, trackMetrics.cumDistances);

        const newCum: number[] = [0];
        let newTotal = 0;
        for (let i = 0; i < newTrackPoints.length; i++) {
          const nextIdx = (i + 1) % newTrackPoints.length;
          const d = calculateDistanceMeters(newTrackPoints[i], newTrackPoints[nextIdx]);
          newTotal += d;
          newCum.push(newTotal);
        }

        const updatedIntermediates = (currentCircuit.intermediates || []).map((inter) => {
          const p = projectPointOnTrack(inter.latLng, newTrackPoints, newCum);
          return {
            ...inter,
            distance: p.distance,
            latLng: p.latLng,
          };
        });

        const updatedCircuit: SavedCircuit = {
          ...currentCircuit,
          points: newTrackPoints,
          intermediates: updatedIntermediates,
        };

        const updatedCircuits = circuits.map((c) => (c.id === currentCircuit.id ? updatedCircuit : c));
        setCircuits(updatedCircuits);
        localStorage.setItem('solex_circuits_v5', JSON.stringify(updatedCircuits));
        setPlacementMode('none');
        showToast('🏁 Ligne de Départ / Arrivée repositionnée au point cliqué !');

        // Réaligner la simulation au départ
        distanceCoveredInLapRef.current = 0;
        setLapHistory([]);
        setCurrentLap(1);
        setBestLapTime(null);
        return;
      }

      // Cas 3 : Ajout d'une balise intermédiaire
      if (placementMode === 'intermediate') {
        const { distance, latLng } = projectPointOnTrack(clickPos, currentCircuit.points, trackMetrics.cumDistances);

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
        saveIntermediates(updatedList);
        showToast(`🚩 Balise intermédiaire ajoutée à ${Math.round(distance)}m du départ !`);
        return;
      }
    };

    map.on('click', handleClick);
    return () => {
      map.off('click', handleClick);
    };
  }, [isEditingTrack, placementMode, currentCircuit, trackMetrics, sortedIntermediates, circuits]);

  // Synchronisation du tracé pendant l'édition
  useEffect(() => {
    if (!isEditingTrack || !polylineRef.current) return;
    polylineRef.current.setLatLngs(editTrackPoints);
  }, [editTrackPoints, isEditingTrack]);

  // BOUCLE DE SIMULATION HAUTE PRÉCISION (10 Hz = 100ms)
  // Gère l'arrêt silencieux et le redémarrage STRICTEMENT au point d'arrêt
  useEffect(() => {
    if (isEditingTrack || currentCircuit.points.length < 2) return;

    lastTickTimeRef.current = Date.now();
    lapStartTimeRef.current = Date.now();
    recordedSplitsThisLapRef.current = new Array(sortedIntermediates.length).fill(null);
    setLiveSplitTimes(new Array(sortedIntermediates.length).fill(null));

    const interval = setInterval(() => {
      const now = Date.now();
      const dt = (now - lastTickTimeRef.current) / 1000;
      lastTickTimeRef.current = now;

      // SI ARRÊTÉ : LE SOLEX RESTE STRICTEMENT AU POINT D'ARRÊT
      if (simStoppedRef.current) {
        setSpeed(0);
        stopDurationRef.current += dt;
        const totalStopSec = Math.floor(stopDurationRef.current);
        setStopElapsedSeconds(totalStopSec);

        // Alerte visuelle silencieuse après 10 secondes (aucun signal sonore)
        if (stopDurationRef.current >= 10) {
          setAlertStopped(true);
        }
        return;
      }

      // Si le Solex roule
      stopDurationRef.current = 0;
      setAlertStopped(false);
      setStopElapsedSeconds(0);

      // Fluctuation réaliste de vitesse (55 - 105 km/h)
      const currentDist = distanceCoveredInLapRef.current;
      const variation = Math.sin(currentDist / 45) * 12;
      const instSpeed = Math.max(55, Math.min(105, targetSpeed + variation));
      setSpeed(Math.round(instSpeed));

      // Distance parcourue (mètres = km/h / 3.6 * dt)
      // Reprend exactement à partir de distanceCoveredInLapRef.current !
      const deltaMeters = (instSpeed / 3.6) * dt;
      const newLapDist = distanceCoveredInLapRef.current + deltaMeters;
      const totalTrackDist = trackMetrics.totalDistance;

      const lapTimeElapsed = (now - lapStartTimeRef.current) / 1000;
      setCurrentLapTime(lapTimeElapsed);

      // Détection des franchissements de balises intermédiaires
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
  }, [isEditingTrack, currentCircuit, trackMetrics, sortedIntermediates, targetSpeed, currentLap]);

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
    showToast(`⚡ ${count} balise(s) réparties régulièrement.`);
  };

  const saveIntermediates = (newList: IntermediatePoint[]) => {
    const updatedCircuit = { ...currentCircuit, intermediates: newList };
    const updatedCircuits = circuits.map((c) => (c.id === currentCircuit.id ? updatedCircuit : c));
    setCircuits(updatedCircuits);
    localStorage.setItem('solex_circuits_v5', JSON.stringify(updatedCircuits));
    setLapHistory([]);
    setCurrentLap(1);
    setBestLapTime(null);
  };

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
        alert('Lieu introuvable.');
      }
    } catch (err) {
      alert('Erreur lors de la recherche.');
    } finally {
      setIsSearching(false);
    }
  };

  const handleRecenterSolex = () => {
    if (!mapRef.current) return;
    const pos = getPositionFromDistance(distanceCoveredInLapRef.current);
    mapRef.current.panTo(pos, { animate: true });
  };

  const handleFitCircuit = () => {
    if (!mapRef.current || !polylineRef.current) return;
    mapRef.current.fitBounds(polylineRef.current.getBounds(), { padding: [40, 40] });
  };

  const handleSaveCircuit = () => {
    if (editTrackPoints.length < 3) {
      alert('Veuillez cliquer au moins 3 points sur la carte pour former une boucle fermée.');
      return;
    }

    const newCircuit: SavedCircuit = {
      id: `circuit-${Date.now()}`,
      name: newCircuitName.trim() || `Circuit ${circuits.length + 1}`,
      points: editTrackPoints,
      intermediates: [],
    };

    const updated = [...circuits, newCircuit];
    setCircuits(updated);
    localStorage.setItem('solex_circuits_v5', JSON.stringify(updated));
    setSelectedCircuitId(newCircuit.id);
    setIsEditingTrack(false);
    setEditTrackPoints([]);
    setLapHistory([]);
    setCurrentLap(1);
    setBestLapTime(null);
    showToast('Circuit enregistré ! Le 1er point cliqué est la ligne de départ.');
  };

  const formatSec = (sec: number | null) => {
    if (sec === null || isNaN(sec)) return '--:--.-';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 10);
    return `${m}:${s < 10 ? '0' : ''}${s}.${ms}`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', padding: '10px', gap: '8px', boxSizing: 'border-box', background: '#0f172a', color: '#f8fafc', fontFamily: 'sans-serif' }}>
      {/* Alerte Arrêt Piste : SILENCIEUSE, purement visuelle */}
      {alertStopped && (
        <div style={{ backgroundColor: '#dc2626', color: 'white', padding: '10px 14px', borderRadius: '8px', textAlign: 'center', fontWeight: 'bold', fontSize: '15px', border: '2px solid #fecaca', boxShadow: '0 0 15px rgba(220,38,38,0.7)', animation: 'pulse 1s infinite' }}>
          🚨 ALERTE STANDS : SOLEX IMMOBILISÉ EN PISTE DEPUIS {stopElapsedSeconds}s !
        </div>
      )}

      {/* Notification Toast */}
      {notificationMsg && (
        <div style={{ backgroundColor: '#059669', color: 'white', padding: '8px 14px', borderRadius: '6px', textAlign: 'center', fontWeight: 'bold', fontSize: '13px', boxShadow: '0 4px 10px rgba(0,0,0,0.4)' }}>
          {notificationMsg}
        </div>
      )}

      {/* Barre supérieure principale */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', background: '#1e293b', padding: '8px 12px', borderRadius: '8px' }}>
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

        {/* Sélecteur de type de carte (Satellite, Plan, Sombre) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', background: '#0f172a', padding: '3px 6px', borderRadius: '6px', border: '1px solid #334155' }}>
          <span style={{ fontSize: '11px', color: '#94a3b8', marginRight: '2px' }}>Fond :</span>
          <button
            onClick={() => setMapLayerType('satellite')}
            style={{
              padding: '4px 8px',
              fontSize: '11px',
              fontWeight: 'bold',
              borderRadius: '4px',
              border: 'none',
              cursor: 'pointer',
              background: mapLayerType === 'satellite' ? '#2563eb' : 'transparent',
              color: mapLayerType === 'satellite' ? 'white' : '#94a3b8',
            }}
          >
            🛰️ Satellite
          </button>
          <button
            onClick={() => setMapLayerType('streets')}
            style={{
              padding: '4px 8px',
              fontSize: '11px',
              fontWeight: 'bold',
              borderRadius: '4px',
              border: 'none',
              cursor: 'pointer',
              background: mapLayerType === 'streets' ? '#2563eb' : 'transparent',
              color: mapLayerType === 'streets' ? 'white' : '#94a3b8',
            }}
          >
            🗺️ Plan
          </button>
          <button
            onClick={() => setMapLayerType('dark')}
            style={{
              padding: '4px 8px',
              fontSize: '11px',
              fontWeight: 'bold',
              borderRadius: '4px',
              border: 'none',
              cursor: 'pointer',
              background: mapLayerType === 'dark' ? '#2563eb' : 'transparent',
              color: mapLayerType === 'dark' ? 'white' : '#94a3b8',
            }}
          >
            🌙 Nuit
          </button>
        </div>

        {/* Métriques circuit */}
        <div style={{ background: '#334155', padding: '5px 8px', borderRadius: '6px', fontSize: '11px', color: '#7dd3fc' }}>
          📏 <strong>{Math.round(trackMetrics.totalDistance)} m</strong> | 🚩 <strong>{sortedIntermediates.length} balise{sortedIntermediates.length > 1 ? 's' : ''}</strong>
        </div>

        {/* Recherche de lieu */}
        <form onSubmit={handleSearchLocation} style={{ display: 'flex', gap: '4px', flex: '1', minWidth: '180px' }}>
          <input
            type="text"
            placeholder="Chercher un lieu, circuit..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ flex: 1, padding: '5px 8px', background: '#334155', color: 'white', border: '1px solid #475569', borderRadius: '6px', fontSize: '12px' }}
          />
          <button type="submit" disabled={isSearching} style={{ padding: '5px 10px', background: '#475569', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' }}>
            {isSearching ? '...' : '🔍'}
          </button>
        </form>

        {/* Boutons Recentrage */}
        <button onClick={handleRecenterSolex} style={{ padding: '5px 8px', background: '#334155', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' }}>
          🎯 Recentrer
        </button>
        <button onClick={handleFitCircuit} style={{ padding: '5px 8px', background: '#334155', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' }}>
          🗺️ Circuit complet
        </button>

        {/* Bouton Départ & Balises */}
        <button
          onClick={() => {
            setIsPlacingMenuOpen(!isPlacingMenuOpen);
            setIsEditingTrack(false);
            if (isPlacingMenuOpen) setPlacementMode('none');
          }}
          style={{
            padding: '5px 10px',
            background: isPlacingMenuOpen ? '#10b981' : '#334155',
            color: 'white',
            border: '1px solid #10b981',
            borderRadius: '6px',
            cursor: 'pointer',
            fontWeight: 'bold',
            fontSize: '12px',
          }}
        >
          🏁 {isPlacingMenuOpen ? 'Fermer Lignes' : 'Départ & Balises'}
        </button>

        {/* Bouton Tracer circuit */}
        {!isEditingTrack ? (
          <button
            onClick={() => {
              setIsEditingTrack(true);
              setIsPlacingMenuOpen(false);
              setPlacementMode('none');
              setEditTrackPoints([]);
            }}
            style={{ padding: '5px 10px', background: '#2563eb', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px' }}
          >
            ✏️ Tracer circuit
          </button>
        ) : (
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <input
              type="text"
              placeholder="Nom du circuit"
              value={newCircuitName}
              onChange={(e) => setNewCircuitName(e.target.value)}
              style={{ padding: '5px 8px', background: '#334155', color: 'white', border: '1px solid #f59e0b', borderRadius: '6px', fontSize: '12px' }}
            />
            <button onClick={handleSaveCircuit} style={{ padding: '5px 10px', background: '#10b981', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px' }}>
              💾 Enregistrer ({editTrackPoints.length} pts)
            </button>
            <button onClick={() => setIsEditingTrack(false)} style={{ padding: '5px 8px', background: '#64748b', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' }}>
              Annuler
            </button>
          </div>
        )}
      </div>

      {/* Barre d'outils Départ et Balises */}
      {isPlacingMenuOpen && (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', background: '#1e293b', border: '2px solid #10b981', padding: '8px 12px', borderRadius: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#a7f3d0' }}>Action au clic :</span>

            <button
              onClick={() => setPlacementMode(placementMode === 'startLine' ? 'none' : 'startLine')}
              style={{
                padding: '5px 10px',
                background: placementMode === 'startLine' ? '#10b981' : '#334155',
                color: 'white',
                border: '1px solid #10b981',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: 'bold',
                fontSize: '11px',
                boxShadow: placementMode === 'startLine' ? '0 0 10px rgba(16, 185, 129, 0.7)' : 'none',
              }}
            >
              🏁 {placementMode === 'startLine' ? '👉 Cliquez sur la piste pour fixer le Départ' : 'Déplacer Ligne Départ/Arrivée'}
            </button>

            <button
              onClick={() => setPlacementMode(placementMode === 'intermediate' ? 'none' : 'intermediate')}
              style={{
                padding: '5px 10px',
                background: placementMode === 'intermediate' ? '#f59e0b' : '#334155',
                color: placementMode === 'intermediate' ? '#0f172a' : 'white',
                border: '1px solid #f59e0b',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: 'bold',
                fontSize: '11px',
                boxShadow: placementMode === 'intermediate' ? '0 0 10px rgba(245, 158, 11, 0.7)' : 'none',
              }}
            >
              🚩 {placementMode === 'intermediate' ? '👉 Cliquez sur la piste pour ajouter une balise' : '+ Balise (S1, S2...)'}
            </button>
          </div>

          <div style={{ display: 'flex', gap: '4px', marginLeft: 'auto', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: '11px', color: '#94a3b8' }}>Auto :</span>
            <button onClick={() => handleAutoDistribute(1)} style={{ padding: '3px 6px', background: '#334155', color: 'white', border: '1px solid #475569', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }}>
              1 balise
            </button>
            <button onClick={() => handleAutoDistribute(2)} style={{ padding: '3px 6px', background: '#334155', color: 'white', border: '1px solid #475569', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }}>
              2 balises
            </button>
            <button onClick={() => handleAutoDistribute(3)} style={{ padding: '3px 6px', background: '#334155', color: 'white', border: '1px solid #475569', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }}>
              3 balises
            </button>
            <button onClick={() => handleAutoDistribute(4)} style={{ padding: '3px 6px', background: '#334155', color: 'white', border: '1px solid #475569', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }}>
              4 balises
            </button>

            <button onClick={handleRemoveLastIntermediate} style={{ padding: '3px 6px', background: '#ef4444', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }}>
              🗑️ Suppr. dernière
            </button>
            <button onClick={handleClearAllIntermediates} style={{ padding: '3px 6px', background: '#991b1b', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }}>
              Vider tout
            </button>
          </div>
        </div>
      )}

      {/* Bandeau Télémétrie en direct */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '6px' }}>
        <div style={{ background: '#1e293b', padding: '6px', borderRadius: '6px', textAlign: 'center' }}>
          <div style={{ fontSize: '10px', color: '#94a3b8' }}>VITESSE GPS</div>
          <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#38bdf8' }}>{speed} <span style={{ fontSize: '11px' }}>km/h</span></div>
        </div>
        <div style={{ background: '#1e293b', padding: '6px', borderRadius: '6px', textAlign: 'center' }}>
          <div style={{ fontSize: '10px', color: '#94a3b8' }}>TOUR EN COURS</div>
          <div style={{ fontSize: '20px', fontWeight: 'bold' }}>#{currentLap}</div>
        </div>
        <div style={{ background: '#1e293b', padding: '6px', borderRadius: '6px', textAlign: 'center' }}>
          <div style={{ fontSize: '10px', color: '#94a3b8' }}>CHRONO TOUR</div>
          <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#fef08a' }}>{formatSec(currentLapTime)}</div>
        </div>
        <div style={{ background: '#1e293b', padding: '6px', borderRadius: '6px', textAlign: 'center' }}>
          <div style={{ fontSize: '10px', color: '#94a3b8' }}>MEILLEUR TOUR</div>
          <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#4ade80' }}>{formatSec(bestLapTime)}</div>
        </div>

        {/* Temps intermédiaires dynamiques depuis la ligne de départ */}
        {sortedIntermediates.length > 0 ? (
          sortedIntermediates.map((inter, idx) => (
            <div key={inter.id} style={{ background: '#1e293b', padding: '6px', borderRadius: '6px', textAlign: 'center' }}>
              <div style={{ fontSize: '10px', color: '#fbbf24' }}>
                {inter.name} (DÉPART)
              </div>
              <div style={{ fontSize: '16px', fontWeight: 'bold', color: liveSplitTimes[idx] !== null ? '#f59e0b' : '#64748b', marginTop: '2px' }}>
                {formatSec(liveSplitTimes[idx])}
              </div>
              <div style={{ fontSize: '9px', color: '#94a3b8' }}>à {Math.round(inter.distance)}m</div>
            </div>
          ))
        ) : (
          <div style={{ background: '#1e293b', padding: '6px', borderRadius: '6px', textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: '11px', color: '#64748b' }}>Aucune balise</span>
          </div>
        )}
      </div>

      {/* Zone centrale : Carte Leaflet & Tableau des Tours */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(350px, 1fr) 420px', gap: '8px', flex: 1, minHeight: '350px' }}>
        {/* Carte */}
        <div style={{ borderRadius: '8px', overflow: 'hidden', border: '1px solid #334155', position: 'relative' }}>
          <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />

          {/* Bouton arrêt / reprise : reprend STRICTEMENT au point d'arrêt */}
          <div style={{ position: 'absolute', bottom: '12px', left: '12px', zIndex: 1000, display: 'flex', gap: '8px', alignItems: 'center' }}>
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
                fontSize: '12px',
                boxShadow: '0 4px 10px rgba(0,0,0,0.5)',
              }}
            >
              {simStopped ? '▶️ Reprendre au point d'arrêt' : '🛑 Arrêt piste (test alerte silencieuse)'}
            </button>

            {simStopped && (
              <span style={{ background: 'rgba(0,0,0,0.75)', color: '#fca5a5', padding: '6px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: 'bold' }}>
                Immobilisé : {stopElapsedSeconds}s
              </span>
            )}
          </div>
        </div>

        {/* Tableau d'affichage complet de tous les tours */}
        <div style={{ background: '#1e293b', borderRadius: '8px', padding: '10px', display: 'flex', flexDirection: 'column', gap: '6px', overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: '13px', color: '#f8fafc' }}>📋 Historique des tours & Intermédiaires</h3>
            <span style={{ fontSize: '11px', color: '#94a3b8' }}>{lapHistory.length} tour{lapHistory.length > 1 ? 's' : ''}</span>
          </div>

          <div style={{ fontSize: '10px', color: '#94a3b8', fontStyle: 'italic' }}>
            * Les temps S1, S2... sont mesurés en cumulé depuis la ligne de départ.
          </div>

          <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #334155', borderRadius: '6px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', textAlign: 'center' }}>
              <thead>
                <tr style={{ background: '#334155', color: '#94a3b8', position: 'sticky', top: 0 }}>
                  <th style={{ padding: '5px 3px' }}>Tour</th>
                  {sortedIntermediates.map((inter) => (
                    <th key={inter.id} style={{ padding: '5px 3px', color: '#fbbf24' }}>
                      {inter.name}
                    </th>
                  ))}
                  <th style={{ padding: '5px 3px', color: '#38bdf8' }}>Chrono</th>
                  <th style={{ padding: '5px 3px' }}>Moy.</th>
                </tr>
              </thead>
              <tbody>
                {lapHistory.length === 0 ? (
                  <tr>
                    <td colSpan={3 + sortedIntermediates.length} style={{ padding: '24px', color: '#64748b' }}>
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
                          borderBottom: '1px solid #334155',
                          background: isBest ? 'rgba(16, 185, 129, 0.15)' : 'transparent',
                          color: isBest ? '#4ade80' : '#f8fafc',
                          fontWeight: isBest ? 'bold' : 'normal',
                        }}
                      >
                        <td style={{ padding: '5px 3px' }}>#{item.lap}</td>
                        {sortedIntermediates.map((_, idx) => {
                          const splitVal = item.intermediateTimes[idx];
                          return (
                            <td key={idx} style={{ padding: '5px 3px', color: '#f59e0b' }}>
                              {splitVal !== null && splitVal !== undefined ? `${splitVal.toFixed(1)}s` : '-'}
                            </td>
                          );
                        })}
                        <td style={{ padding: '5px 3px', color: isBest ? '#4ade80' : '#fbbf24', fontWeight: 'bold' }}>
                          {formatSec(item.totalTime)}
                        </td>
                        <td style={{ padding: '5px 3px', color: '#7dd3fc' }}>
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
