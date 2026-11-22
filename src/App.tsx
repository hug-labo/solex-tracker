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

// Circuit démo (coordonnées GPS fictives)
const CIRCUIT_POINTS: [number, number][] = [
  [47.9500, 0.2000], // Ligne départ / arrivée
  [47.9515, 0.2030],
  [47.9530, 0.2060], // Secteur 1
  [47.9525, 0.2100],
  [47.9490, 0.2120],
  [47.9470, 0.2080], // Secteur 2
  [47.9480, 0.2030],
  [47.9500, 0.2000], // Boucle
];

export default function App() {
  const [speed, setSpeed] = useState<number>(0);
  const [lap, setLap] = useState<number>(1);
  const [lapTime, setLapTime] = useState<number>(0);
  const [bestLap, setBestLap] = useState<number | null>(null);
  const [alertStopped, setAlertStopped] = useState<boolean>(false);
  const [isSimulating, setIsSimulating] = useState<boolean>(true);
  const [simStopped, setSimStopped] = useState<boolean>(false);

  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const stopTimerRef = useRef<number>(0);

  // Initialisation de la carte
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = L.map(mapContainerRef.current).setView([47.9500, 0.2050], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
    }).addTo(map);

    // Tracé du circuit
    L.polyline(CIRCUIT_POINTS, { color: '#3b82f6', weight: 4 }).addTo(map);

    // Ligne Départ / Arrivée
    L.marker(CIRCUIT_POINTS[0]).addTo(map).bindPopup('🏁 Départ / Arrivée');

    // Marqueur du Solex
    const marker = L.marker(CIRCUIT_POINTS[0]).addTo(map).bindPopup('🛵 Solex #1');
    markerRef.current = marker;
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Bip sonore avec Web Audio API
  const playBeep = () => {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
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

  // Boucle de simulation de course
  useEffect(() => {
    if (!isSimulating) return;

    let index = 0;
    const interval = setInterval(() => {
      // Si arrêt d'urgence simulé
      if (simStopped) {
        setSpeed(0);
        stopTimerRef.current += 1;
        if (stopTimerRef.current >= 10) {
          setAlertStopped(true);
          playBeep();
        }
        return;
      }

      // En course normale
      stopTimerRef.current = 0;
      setAlertStopped(false);

      const currentSpeed = Math.floor(65 + Math.random() * 25); // 65 à 90 km/h
      setSpeed(currentSpeed);

      index = (index + 1) % CIRCUIT_POINTS.length;
      const nextPoint = CIRCUIT_POINTS[index];

      if (markerRef.current) {
        markerRef.current.setLatLng(nextPoint);
      }

      // Nouveau tour franchi
      if (index === 0) {
        setLap((l) => l + 1);
        setBestLap((prev) => (!prev || lapTime < prev ? lapTime : prev));
        setLapTime(0);
      } else {
        setLapTime((t) => t + 1);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [isSimulating, simStopped, lapTime]);

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', padding: '16px', gap: '16px' }}>
      {/* Alerte arrêt en piste */}
      {alertStopped && (
        <div style={{ backgroundColor: '#dc2626', color: 'white', padding: '14px', borderRadius: '8px', textAlign: 'center', fontWeight: 'bold', fontSize: '18px', animation: 'pulse 1s infinite' }}>
          ⚠️ ALERTE : SOLEX IMMOBILISÉ EN PISTE DEPUIS PLUS DE 10 SECONDES !
        </div>
      )}

      {/* En-tête télémétrie */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '12px' }}>
        <div style={{ background: '#1f2937', padding: '12px', borderRadius: '8px', textAlign: 'center' }}>
          <div style={{ fontSize: '12px', color: '#9ca3af' }}>VITESSE</div>
          <div style={{ fontSize: '28px', fontWeight: 'bold', color: '#60a5fa' }}>{speed} <span style={{ fontSize: '14px' }}>km/h</span></div>
        </div>
        <div style={{ background: '#1f2937', padding: '12px', borderRadius: '8px', textAlign: 'center' }}>
          <div style={{ fontSize: '12px', color: '#9ca3af' }}>TOUR</div>
          <div style={{ fontSize: '28px', fontWeight: 'bold' }}>#{lap}</div>
        </div>
        <div style={{ background: '#1f2937', padding: '12px', borderRadius: '8px', textAlign: 'center' }}>
          <div style={{ fontSize: '12px', color: '#9ca3af' }}>TEMPS ACTUEL</div>
          <div style={{ fontSize: '28px', fontWeight: 'bold' }}>{formatTime(lapTime)}</div>
        </div>
        <div style={{ background: '#1f2937', padding: '12px', borderRadius: '8px', textAlign: 'center' }}>
          <div style={{ fontSize: '12px', color: '#9ca3af' }}>MEILLEUR TOUR</div>
          <div style={{ fontSize: '28px', fontWeight: 'bold', color: '#34d399' }}>{bestLap ? formatTime(bestLap) : '--:--'}</div>
        </div>
      </div>

      {/* Carte en direct */}
      <div style={{ flex: 1, minHeight: '300px', borderRadius: '8px', overflow: 'hidden' }}>
        <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />
      </div>

      {/* Contrôles du simulateur */}
      <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
        <button
          onClick={() => setSimStopped(!simStopped)}
          style={{
            padding: '10px 18px',
            backgroundColor: simStopped ? '#10b981' : '#ef4444',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            fontWeight: 'bold',
          }}
        >
          {simStopped ? '▶️ Reprendre la course' : '🛑 Simuler un arrêt piste (>10s)'}
        </button>
      </div>
    </div>
  );
}
