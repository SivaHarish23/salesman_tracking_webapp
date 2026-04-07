// Auth guard
if (!getToken() || getUser()?.role !== 'admin') {
  window.location.href = '/';
}

const params = new URLSearchParams(window.location.search);
const userId = params.get('user_id');
const userName = params.get('name') || 'Salesman';

if (!userId) window.location.href = '/dashboard.html';

document.getElementById('replayTitle').textContent = `Replay — ${userName}`;
document.getElementById('backBtn').addEventListener('click', () => {
  window.location.href = `/user-detail.html?id=${encodeURIComponent(userId)}&name=${encodeURIComponent(userName)}`;
});

const map = createMap('replay-map', [20, 78], 5);
const sessionSelect = document.getElementById('sessionSelect');
const playBtn = document.getElementById('playBtn');
const scrubber = document.getElementById('scrubber');
const timeDisplay = document.getElementById('timeDisplay');
const controls = document.getElementById('replayControls');
const liveBadge = document.getElementById('liveBadge');

let locations = [];
let currentIndex = 0;    // float index for smooth interpolation
let isPlaying = false;
let playSpeed = 1;
let animFrameId = null;
let lastFrameTime = null;
let movingMarker = null;
let trailGroup = L.layerGroup().addTo(map);
let checkinMarker = null;
let isActiveSession = false;
let livePollTimer = null;
let smoothPoints = [];    // spline-smoothed [lat,lng] array
let rawPts = [];          // cached [lat,lng] from locations
let segSubCount = 8;      // sub-points per segment (must match map.js)
let lastPanLatlng = null;  // throttle map panning

// Load sessions list
async function loadSessions() {
  try {
    const data = await apiFetch(`/admin/users/${encodeURIComponent(userId)}/sessions`);
    const sessions = data.sessions || [];
    sessionSelect.innerHTML = '<option value="">Select session...</option>';
    sessions.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      const dt = toIST(s.checkin_time);
      const status = s.is_active ? ' (LIVE)' : '';
      const pts = s.point_count || 0;
      opt.textContent = `${dt} — ${pts} pts${status}`;
      opt.dataset.active = s.is_active;
      sessionSelect.appendChild(opt);
    });
  } catch (err) {
    console.error('Failed to load sessions:', err);
  }
}

sessionSelect.addEventListener('change', async () => {
  const sessionId = sessionSelect.value;
  if (!sessionId) return;
  stopPlayback();
  clearLivePoll();
  const opt = sessionSelect.options[sessionSelect.selectedIndex];
  isActiveSession = opt.dataset.active === 'true';
  await loadSessionLocations(sessionId);
});

async function loadSessionLocations(sessionId) {
  try {
    const data = await apiFetch(`/admin/users/${encodeURIComponent(userId)}/session?session_id=${sessionId}`);
    locations = data.locations || [];
    if (locations.length === 0) {
      timeDisplay.textContent = 'No data';
      return;
    }
    currentIndex = 0;
    scrubber.max = locations.length - 1;
    scrubber.value = 0;
    controls.style.display = 'flex';

    rebuildSmoothPoints();
    resetMap();
    renderFrame(0);

    const bounds = locations.map(l => [l.latitude, l.longitude]);
    map.fitBounds(bounds, { padding: [60, 60], maxZoom: 16 });

    liveBadge.style.display = isActiveSession ? '' : 'none';
    if (isActiveSession) startLivePoll(sessionId);
  } catch (err) {
    console.error('Failed to load session locations:', err);
  }
}

function rebuildSmoothPoints() {
  rawPts = locations.map(l => [l.latitude, l.longitude]);
  smoothPoints = catmullRomSpline(rawPts, segSubCount);
}

function resetMap() {
  if (movingMarker) map.removeLayer(movingMarker);
  if (checkinMarker) map.removeLayer(checkinMarker);
  trailGroup.clearLayers();
  movingMarker = null;
  checkinMarker = null;
  lastPanLatlng = null;
}

function renderFrame(index) {
  if (locations.length === 0) return;
  const maxIdx = locations.length - 1;
  const idx = Math.max(0, Math.min(index, maxIdx));
  currentIndex = idx;
  scrubber.value = Math.round(idx);

  // Map float location-index to float smooth-point-index
  const smoothIdx = idx * segSubCount;
  const latlng = interpolateOnPath(smoothPoints, smoothIdx);

  // Update or create moving marker
  if (movingMarker) {
    movingMarker.setLatLng(latlng);
  } else {
    movingMarker = L.marker(latlng, { icon: createPulsingIcon(COLORS.current) }).addTo(map);
  }

  // Checkin marker at first point
  if (!checkinMarker && locations.length > 0) {
    checkinMarker = L.marker(
      [locations[0].latitude, locations[0].longitude],
      { icon: createIcon(COLORS.checkin) }
    ).addTo(map);
  }

  // Rebuild smooth trail up to current position
  trailGroup.clearLayers();
  const floorIdx = Math.floor(idx);

  // 1. Continuous glow trail up to current marker position
  if (floorIdx > 0 || (idx - floorIdx) > 0.001) {
    const trailEnd = Math.min(Math.ceil(idx), locations.length - 1);
    const glowPts = rawPts.slice(0, trailEnd + 1);
    if (glowPts.length >= 2) {
      const smoothGlow = catmullRomSpline(glowPts, segSubCount);
      const trimAt = Math.min(Math.ceil(idx * segSubCount) + 1, smoothGlow.length);
      const trimmed = smoothGlow.slice(0, trimAt);
      trimmed.push(latlng);
      L.polyline(trimmed, {
        color: '#4285f4', weight: 14, opacity: 0.2,
        lineCap: 'round', lineJoin: 'round',
      }).addTo(trailGroup);
    }
  }

  // 2. Speed-colored segments on top — butt caps = no dots at junctions
  for (let i = 0; i < floorIdx && i < locations.length - 1; i++) {
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
    for (let s = 1; s <= segSubCount; s++) {
      const t = s / segSubCount;
      const t2 = t * t, t3 = t2 * t;
      subPts.push([
        0.5 * ((2*p1[0]) + (-p0[0]+p2[0])*t + (2*p0[0]-5*p1[0]+4*p2[0]-p3[0])*t2 + (-p0[0]+3*p1[0]-3*p2[0]+p3[0])*t3),
        0.5 * ((2*p1[1]) + (-p0[1]+p2[1])*t + (2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*t2 + (-p0[1]+3*p1[1]-3*p2[1]+p3[1])*t3)
      ]);
    }
    L.polyline(subPts, { color, weight: 5, opacity: 0.9, lineCap: 'butt', lineJoin: 'round' }).addTo(trailGroup);
  }
  // Partial segment for fractional part
  if (floorIdx < locations.length - 1) {
    const frac = idx - floorIdx;
    if (frac > 0.001) {
      const i = floorIdx;
      const a = locations[i], b = locations[i + 1];
      const dist = haversineDistance(a.latitude, a.longitude, b.latitude, b.longitude);
      const dt = (new Date(b.recorded_at) - new Date(a.recorded_at)) / 1000;
      const kmh = dt > 0 ? (dist / dt) * 3.6 : 0;
      const color = speedColor(kmh);
      const p0 = rawPts[Math.max(0, i - 1)];
      const p1 = rawPts[i];
      const p2 = rawPts[i + 1];
      const p3 = rawPts[Math.min(rawPts.length - 1, i + 2)];
      const subSteps = Math.ceil(frac * segSubCount);
      const subPts = [p1];
      for (let s = 1; s <= subSteps; s++) {
        const t = s / segSubCount;
        const t2 = t * t, t3 = t2 * t;
        subPts.push([
          0.5 * ((2*p1[0]) + (-p0[0]+p2[0])*t + (2*p0[0]-5*p1[0]+4*p2[0]-p3[0])*t2 + (-p0[0]+3*p1[0]-3*p2[0]+p3[0])*t3),
          0.5 * ((2*p1[1]) + (-p0[1]+p2[1])*t + (2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*t2 + (-p0[1]+3*p1[1]-3*p2[1]+p3[1])*t3)
        ]);
      }
      subPts.push(latlng);
      L.polyline(subPts, { color, weight: 5, opacity: 0.9, lineCap: 'butt', lineJoin: 'round' }).addTo(trailGroup);
    }
  }

  // Update time display using nearest integer location
  const nearIdx = Math.min(Math.round(idx), maxIdx);
  const loc = locations[nearIdx];
  timeDisplay.textContent = toIST(loc.recorded_at);

  // Throttled map pan — only when marker moves >50px on screen
  if (!lastPanLatlng || map.latLngToContainerPoint(latlng).distanceTo(map.latLngToContainerPoint(lastPanLatlng)) > 50) {
    map.panTo(latlng, { animate: true, duration: 0.3 });
    lastPanLatlng = latlng;
  }

  // Update popup
  const batt = loc.battery_pct != null ? ` | Battery: ${loc.battery_pct}%` : '';
  movingMarker.bindPopup(
    `<b>Point ${nearIdx + 1}/${locations.length}</b><br>${toIST(loc.recorded_at)}${batt}`
  );
}

// Playback controls
playBtn.addEventListener('click', () => {
  if (isPlaying) {
    stopPlayback();
  } else {
    startPlayback();
  }
});

function startPlayback() {
  if (locations.length === 0) return;
  if (currentIndex >= locations.length - 1) currentIndex = 0;
  isPlaying = true;
  lastFrameTime = null;
  playBtn.innerHTML = '&#9646;&#9646;';
  animFrameId = requestAnimationFrame(animateLoop);
}

function stopPlayback() {
  isPlaying = false;
  playBtn.innerHTML = '&#9654;';
  if (animFrameId) cancelAnimationFrame(animFrameId);
  animFrameId = null;
  lastFrameTime = null;
}

function animateLoop(timestamp) {
  if (!isPlaying || currentIndex >= locations.length - 1) {
    stopPlayback();
    return;
  }
  if (!lastFrameTime) {
    lastFrameTime = timestamp;
    animFrameId = requestAnimationFrame(animateLoop);
    return;
  }
  const dtMs = timestamp - lastFrameTime;
  lastFrameTime = timestamp;

  // Calculate how far to advance based on the real gap between current pair of points
  const floorIdx = Math.floor(currentIndex);
  const a = locations[floorIdx];
  const b = locations[Math.min(floorIdx + 1, locations.length - 1)];
  const realGapMs = Math.max(100, new Date(b.recorded_at) - new Date(a.recorded_at));
  // Advance as a fraction of the gap, scaled by playback speed
  const advance = (dtMs * playSpeed) / realGapMs;
  currentIndex = Math.min(currentIndex + advance, locations.length - 1);

  renderFrame(currentIndex);

  if (currentIndex >= locations.length - 1) {
    stopPlayback();
  } else {
    animFrameId = requestAnimationFrame(animateLoop);
  }
}

// Speed buttons
document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    playSpeed = parseInt(btn.dataset.speed);
    // rAF loop automatically picks up the new playSpeed, no restart needed
  });
});

// Scrubber
scrubber.addEventListener('input', () => {
  const wasPlaying = isPlaying;
  if (isPlaying) stopPlayback();
  currentIndex = parseInt(scrubber.value);
  lastPanLatlng = null; // reset pan throttle on manual scrub
  renderFrame(currentIndex);
  if (wasPlaying) startPlayback();
});

// LIVE polling for active sessions
function startLivePoll(sessionId) {
  clearLivePoll();
  livePollTimer = setInterval(async () => {
    try {
      const data = await apiFetch(`/admin/users/${encodeURIComponent(userId)}/session?session_id=${sessionId}`);
      const newLocs = data.locations || [];
      if (newLocs.length > locations.length) {
        const wasAtEnd = currentIndex >= locations.length - 1;
        locations = newLocs;
        rebuildSmoothPoints();
        scrubber.max = locations.length - 1;
        if (wasAtEnd && !isPlaying) {
          renderFrame(locations.length - 1);
        }
      }
      if (!data.session?.is_active) {
        liveBadge.style.display = 'none';
        clearLivePoll();
      }
    } catch (_) {}
  }, 10000);
}

function clearLivePoll() {
  clearInterval(livePollTimer);
  livePollTimer = null;
}

// Init
loadSessions();
