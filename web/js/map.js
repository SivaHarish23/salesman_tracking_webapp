function createMap(elementId, center, zoom) {
  const map = L.map(elementId).setView(center || [20, 78], zoom || 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(map);
  return map;
}

function createIcon(color) {
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="
      width: 16px; height: 16px; border-radius: 50%;
      background: ${color}; border: 3px solid #fff;
      box-shadow: 0 2px 6px rgba(0,0,0,0.3);
    "></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function createPulsingIcon(color) {
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="
      width: 18px; height: 18px; border-radius: 50%;
      background: ${color}; border: 3px solid #fff;
      box-shadow: 0 0 0 4px ${color}44, 0 2px 6px rgba(0,0,0,0.3);
    "></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

const COLORS = {
  checkin: '#1e8e3e',
  checkout: '#d93025',
  current: '#1a73e8',
  route: '#4285f4',
};

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function speedColor(kmh) {
  if (kmh <= 20) return '#1e8e3e';
  if (kmh >= 60) return '#d93025';
  if (kmh <= 40) {
    const t = (kmh - 20) / 20;
    return lerpColor('#1e8e3e', '#fbbc04', t);
  }
  const t = (kmh - 40) / 20;
  return lerpColor('#fbbc04', '#d93025', t);
}

function lerpColor(a, b, t) {
  const parse = c => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  const [r1, g1, b1] = parse(a);
  const [r2, g2, b2] = parse(b);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const bl = Math.round(b1 + (b2 - b1) * t);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${bl.toString(16).padStart(2, '0')}`;
}

function createSpeedPolyline(locations) {
  const group = L.layerGroup();
  for (let i = 0; i < locations.length - 1; i++) {
    const a = locations[i], b = locations[i + 1];
    const dist = haversineDistance(a.latitude, a.longitude, b.latitude, b.longitude);
    const dt = (new Date(b.recorded_at) - new Date(a.recorded_at)) / 1000;
    const kmh = dt > 0 ? (dist / dt) * 3.6 : 0;
    L.polyline(
      [[a.latitude, a.longitude], [b.latitude, b.longitude]],
      { color: speedColor(kmh), weight: 4, opacity: 0.8 }
    ).addTo(group);
  }
  return group;
}
