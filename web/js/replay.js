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
let currentIndex = 0;
let isPlaying = false;
let playSpeed = 1;
let playTimer = null;
let movingMarker = null;
let trailGroup = L.layerGroup().addTo(map);
let checkinMarker = null;
let isActiveSession = false;
let livePollTimer = null;

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

function resetMap() {
  if (movingMarker) map.removeLayer(movingMarker);
  if (checkinMarker) map.removeLayer(checkinMarker);
  trailGroup.clearLayers();
  movingMarker = null;
  checkinMarker = null;
}

function renderFrame(index) {
  if (index < 0 || index >= locations.length) return;
  currentIndex = index;
  scrubber.value = index;

  const loc = locations[index];
  const latlng = [loc.latitude, loc.longitude];

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

  // Rebuild trail up to current index (speed-colored)
  trailGroup.clearLayers();
  for (let i = 0; i < index; i++) {
    const a = locations[i], b = locations[i + 1];
    const dist = haversineDistance(a.latitude, a.longitude, b.latitude, b.longitude);
    const dt = (new Date(b.recorded_at) - new Date(a.recorded_at)) / 1000;
    const kmh = dt > 0 ? (dist / dt) * 3.6 : 0;
    L.polyline(
      [[a.latitude, a.longitude], [b.latitude, b.longitude]],
      { color: speedColor(kmh), weight: 4, opacity: 0.8 }
    ).addTo(trailGroup);
  }

  // Update time display
  timeDisplay.textContent = toIST(loc.recorded_at);

  // Pan map to follow marker
  map.panTo(latlng, { animate: true, duration: 0.3 });

  // Update popup
  const batt = loc.battery_pct != null ? ` | Battery: ${loc.battery_pct}%` : '';
  movingMarker.bindPopup(
    `<b>Point ${index + 1}/${locations.length}</b><br>${toIST(loc.recorded_at)}${batt}`
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
  playBtn.innerHTML = '&#9646;&#9646;';
  scheduleNextFrame();
}

function stopPlayback() {
  isPlaying = false;
  playBtn.innerHTML = '&#9654;';
  clearTimeout(playTimer);
  playTimer = null;
}

function scheduleNextFrame() {
  if (!isPlaying || currentIndex >= locations.length - 1) {
    stopPlayback();
    return;
  }
  const a = locations[currentIndex];
  const b = locations[currentIndex + 1];
  const realGapMs = new Date(b.recorded_at) - new Date(a.recorded_at);
  const delay = Math.max(50, Math.min(2000, realGapMs / playSpeed));
  playTimer = setTimeout(() => {
    currentIndex++;
    renderFrame(currentIndex);
    scheduleNextFrame();
  }, delay);
}

// Speed buttons
document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    playSpeed = parseInt(btn.dataset.speed);
    if (isPlaying) {
      clearTimeout(playTimer);
      scheduleNextFrame();
    }
  });
});

// Scrubber
scrubber.addEventListener('input', () => {
  const wasPlaying = isPlaying;
  if (isPlaying) stopPlayback();
  renderFrame(parseInt(scrubber.value));
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
