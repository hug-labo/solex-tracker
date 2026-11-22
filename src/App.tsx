import React, { useState, useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix icônes Leaflet par défaut
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

// Circuit démo par défaut
const DEFAULT_CIRCUIT: [number, number][] = [
  [47.9500, 0.2000],
  [47.9518, 0.2025],
  [47.9535, 0.2060],
  [47.9525, 0.2095],
  [47.9505, 0.2110],
  [47.9485, 0.2090],
  [47.9470, 0.2050],
  [47.9485, 0.2015],
];

export default function App() {
  const [circuit, setCircuit] = useState<[number, number][]>(() => {
    const saved = localStorage.getItem('solex_circuit');
    return saved ? JSON.parse(saved) : DEFAULT_CIRCUIT;
  });

  const [speed, setSpeed] = useState<number>(0);
  const [lap, setLap] = useState<number>(1);
  const [lapTime, setLapTime] = useState<number>(0);
  const [bestLap, setBestLap] = useState<number | null>(null);
  const [alertStopped, setAlertStopped] = useState<boolean>(false);
  const [simStopped, setSimStopped] = useState<boolean>(false);
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [editPoints, setEditPoints] = useState<[number, number][]>([]);

  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const polylineRef = useRef<L.Polyline | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const startMarkerRef = useRef<L.Marker | null>(null);

  const indexRef = useRef<number>(0);
  const stopTimerRef = useRef<number>(0);
  const lapTimeRef = useRef<number>(0);

  // Initialisation de la carte
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const initialCenter = circuit[0] || [47.9500, 0.2050];
    const map = L.map(mapContainerRef.current).setView(initialCenter, 16);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    polylineRef.current = L.polyline(circuit, { color: '#3b82f6', weight: 5 }).addTo(map);

    if (circuit.length > 0) {
      startMarkerRef.current = L.marker(circuit[0]).addTo(map).bindPopup('🏁 Départ / Arrivée');
      markerRef.current = L.marker(circuit[0]).addTo(map).bindPopup('🛵 Solex #1');
    }

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Clic sur la carte en mode éditeur
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handleClick = (e: L.LeafletMouseEvent) => {
      if (!isEditing) return;
      const newPoint: [number, number] = [e.latlng.lat, e.latlng.lng];
      setEditPoints((prev) => [...prev, newPoint]);
    };

    map.on('click', handleClick);
    return () => {
      map.off('click', handleClick);
    };
  }, [isEditing]);

  // Synchronisation du tracé
  useEffect(() => {
    if (!mapRef.current) return;

    const activeTrack = isEditing ? editPoints : circuit;
    if (polylineRef.current) {
      polylineRef.current.setLatLngs(activeTrack);
    }

    if (!isEditing && circuit.length > 0) {
      if (startMarkerRef.current) startMarkerRef.current.setLatLng(circuit[0]);
      if (markerRef.current) markerRef.current.setLatLng(circuit[0]);
    }
  }, [circuit, editPoints, isEditing]);

  // Bip sonore
  const playBeep = () => {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(800, ctx.currentTime);
      osc.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
    } catch (e) {
      console.log('Audio non autorisé');
    }
  };

  // Boucle de simulation
  useEffect(() => {
    if (isEditing || circuit.length === 0) return;

    const interval = setInterval(() => {
      if (simStopped) {
        setSpeed(0);
        stopTimerRef.current += 1;
        if (stopTimerRef.current >= 10) {
          setAlertStopped(true);
          playBeep();
        }
        return;
      }

      stopTimerRef.current = 0;
      setAlertStopped(false);

      const currentSpeed = Math.floor(70 + Math.random() * 25);
      setSpeed(currentSpeed);

      indexRef.current = (indexRef.current + 1) % circuit.length;
      const nextPos = circuit[indexRef.current];

      if (markerRef.current) {
        markerRef.current.setLatLng(nextPos);
      }

      lapTimeRef.current += 1;
      setLapTime(lapTimeRef.current);

      if (indexRef.current === 0) {
        setLap((l) => l + 1);
        const finishedLapTime = lapTimeRef.current;
        setBestLap((prev) => (!prev || finishedLapTime < prev ? finishedLapTime : prev));
        lapTimeRef.current = 0;
        setLapTime(0);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [simStopped, isEditing, circuit]);

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const handleSaveCircuit = () => {
    if (editPoints.length < 3) {
      alert('Veuillez cliquer au moins 3 points sur la carte pour former un circuit.');
      return;
    }
    const closed = [...editPoints, editPoints[0]];
    setCircuit(closed);
    localStorage.setItem('solex_circuit', JSON.stringify(closed));
    setIsEditing(false);
    indexRef.current = 0;
    lapTimeRef.current = 0;
    setLapTime(0);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', padding: '12px', gap: '12px' }}>
      {alertStopped && (
        <div style={{ backgroundColor: '#dc2626', color: 'white', padding: '12px', borderRadius: '8px', textAlign: 'center', fontWeight: 'bold', fontSize: '16px' }}>
          ⚠️ ALERTE : SOLEX IMMOBILISÉ EN PISTE DEPUIS PLUS DE 10 SECONDES !
        </div>
      )}

      {/* Télémétrie */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '10px' }}>
        <div style={{ background: '#1f2937', padding: '10px', borderRadius: '8px', textAlign: 'center' }}>
          <div style={{ fontSize: '11px', color: '#9ca3af' }}>VITESSE</div>
          <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#60a5fa' }}>{speed} <span style={{ fontSize: '12px' }}>km/h</span></div>
        </div>
        <div style={{ background: '#1f2937', padding: '10px', borderRadius: '8px', textAlign: 'center' }}>
          <div style={{ fontSize: '11px', color: '#9ca3af' }}>TOUR</div>
          <div style={{ fontSize: '24px', fontWeight: 'bold' }}>#{lap}</div>
        </div>
        <div style={{ background: '#1f2937', padding: '10px', borderRadius: '8px', textAlign: 'center' }}>
          <div style={{ fontSize: '11px', color: '#9ca3af' }}>CHRONO TOUR</div>
          <div style={{ fontSize: '24px', fontWeight: 'bold' }}>{formatTime(lapTime)}</div>
        </div>
        <div style={{ background: '#1f2937', padding: '10px', borderRadius: '8px', textAlign: 'center' }}>
          <div style={{ fontSize: '11px', color: '#9ca3af' }}>MEILLEUR TOUR</div>
          <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#34d399' }}>{bestLap ? formatTime(bestLap) : '--:--'}</div>
        </div>
      </div>

      {/* Barre d'outils */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', background: '#1f2937', padding: '8px 12px', borderRadius: '8px' }}>
        {!isEditing ? (
          <>
            <button
              onClick={() => {
                setIsEditing(true);
                setEditPoints([]);
              }}
              style={{ padding: '8px 14px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
            >
              ✏️ Créer / Tracer un circuit
            </button>
            <button
              onClick={() => setSimStopped(!simStopped)}
              style={{
                padding: '8px 14px',
                backgroundColor: simStopped ? '#10b981' : '#ef4444',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: 'bold',
                marginLeft: 'auto',
              }}
            >
              {simStopped ? '▶️ Reprendre' : '🛑 Simuler arrêt piste'}
            </button>
          </>
        ) : (
          <>
            <span style={{ fontSize: '14px', color: '#fbbf24', fontWeight: 'bold' }}>
              Mode création : cliquez sur la carte pour placer les virages ({editPoints.length} points)
            </span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
              <button
                onClick={handleSaveCircuit}
                style={{ padding: '8px 14px', background: '#10b981', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
              >
                💾 Enregistrer & Rouler
              </button>
              <button
                onClick={() => setIsEditing(false)}
                style={{ padding: '8px 14px', background: '#6b7280', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
              >
                Annuler
              </button>
            </div>
          </>
        )}
      </div>

      {/* Carte */}
      <div style={{ flex: 1, minHeight: '350px', borderRadius: '8px', overflow: 'hidden' }}>
        <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  );
}
