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

// Centripetal Catmull-Rom spline (alpha=0.5) — smooth curve through all points
function catmullRomSpline(points, numPerSeg) {
  if (points.length < 2) return points.slice();
  numPerSeg = numPerSeg || 8;
  const pts = [points[0], ...points, points[points.length - 1]]; // duplicate ends
  const result = [];
  for (let i = 1; i < pts.length - 2; i++) {
    const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2];
    for (let s = 0; s < numPerSeg; s++) {
      const t = s / numPerSeg;
      const t2 = t * t, t3 = t2 * t;
      const lat = 0.5 * (
        (2 * p1[0]) +
        (-p0[0] + p2[0]) * t +
        (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
        (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3
      );
      const lng = 0.5 * (
        (2 * p1[1]) +
        (-p0[1] + p2[1]) * t +
        (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
        (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3
      );
      result.push([lat, lng]);
    }
  }
  result.push(pts[pts.length - 2]); // add last original point
  return result;
}

// Interpolate a position along an array of [lat,lng] at float index t
function interpolateOnPath(points, t) {
  if (points.length === 0) return [0, 0];
  if (t <= 0) return points[0];
  if (t >= points.length - 1) return points[points.length - 1];
  const i = Math.floor(t);
  const f = t - i;
  const a = points[i], b = points[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

function createSpeedPolyline(locations) {
  const group = L.layerGroup();
  if (locations.length < 2) return group;

  const rawPts = locations.map(l => [l.latitude, l.longitude]);
  const NUM_SUB = 8;

  // 1. Single continuous glow layer (no segment seams)
  const fullSmooth = catmullRomSpline(rawPts, NUM_SUB);
  L.polyline(fullSmooth, {
    color: '#4285f4', weight: 14, opacity: 0.2,
    lineCap: 'round', lineJoin: 'round',
  }).addTo(group);

  // 2. Speed-colored segments on top — butt caps eliminate dots at junctions
  for (let i = 0; i < locations.length - 1; i++) {
    const a = locations[i], b = locations[i + 1];
    const dist = haversineDistance(a.latitude, a.longitude, b.latitude, b.longitude);
    const dt = (new Date(b.recorded_at) - new Date(a.recorded_at)) / 1000;
    const kmh = dt > 0 ? (dist / dt) * 3.6 : 0;
    const color = speedColor(kmh);
    const p0 = rawPts[Math.max(0, i - 1)];
    const p1 = rawPts[i];
    const p2 = rawPts[i + 1];
    const p3 = rawPts[Math.min(rawPts.length - 1, i + 2)];
    const subPts = [p1];
    for (let s = 1; s <= NUM_SUB; s++) {
      const t = s / NUM_SUB;
      const t2 = t * t, t3 = t2 * t;
      subPts.push([
        0.5 * ((2*p1[0]) + (-p0[0]+p2[0])*t + (2*p0[0]-5*p1[0]+4*p2[0]-p3[0])*t2 + (-p0[0]+3*p1[0]-3*p2[0]+p3[0])*t3),
        0.5 * ((2*p1[1]) + (-p0[1]+p2[1])*t + (2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*t2 + (-p0[1]+3*p1[1]-3*p2[1]+p3[1])*t3)
      ]);
    }
    L.polyline(subPts, {
      color, weight: 5, opacity: 0.9,
      lineCap: 'butt', lineJoin: 'round',
    }).addTo(group);
  }
  return group;
}
