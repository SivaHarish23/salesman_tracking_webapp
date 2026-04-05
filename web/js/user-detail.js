// Auth guard
if (!getToken() || getUser()?.role !== 'admin') {
  window.location.href = '/';
}

const params = new URLSearchParams(window.location.search);
const userId = params.get('id');
const userName = params.get('name');

// Validate userId
if (!userId || isNaN(parseInt(userId))) {
  window.location.href = '/dashboard.html';
}

document.getElementById('userName').textContent = userName || 'Salesman';

const map = createMap('detail-map', [20, 78], 5);
let checkinMarker, checkoutMarker, currentMarker, routeLine;
let pollInterval;
let eventSource;

// Clean up on page unload
window.addEventListener('beforeunload', cleanup);

function cleanup() {
  clearInterval(pollInterval);
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function renderSession(data) {
  if (!data) return;

  const session = data.session;
  const locations = data.locations || [];

  // Update status
  const statusEl = document.getElementById('userStatus');
  if (session && session.is_active) {
    statusEl.textContent = 'Active';
    statusEl.className = 'user-status status active';
  } else {
    statusEl.textContent = 'Inactive';
    statusEl.className = 'user-status status inactive';
  }

  // Session info
  const infoEl = document.getElementById('sessionInfo');
  if (!session) {
    infoEl.textContent = 'No session data available';
    return;
  }

  const checkinTime = new Date(session.checkin_time).toLocaleString();
  const checkoutTime = session.checkout_time
    ? new Date(session.checkout_time).toLocaleString()
    : 'In progress...';
  infoEl.innerHTML = `
    <span><b>Check-in:</b> ${esc(checkinTime)}</span>
    <span><b>Check-out:</b> ${esc(checkoutTime)}</span>
    <span><b>Points:</b> ${locations.length}</span>
  `;

  // Clear old layers
  if (checkinMarker) map.removeLayer(checkinMarker);
  if (checkoutMarker) map.removeLayer(checkoutMarker);
  if (currentMarker) map.removeLayer(currentMarker);
  if (routeLine) map.removeLayer(routeLine);
  checkinMarker = checkoutMarker = currentMarker = routeLine = null;

  if (locations.length === 0) return;

  const points = locations.map(l => [l.latitude, l.longitude]);

  // Check-in marker (first point)
  checkinMarker = L.marker(points[0], { icon: createIcon(COLORS.checkin) })
    .addTo(map)
    .bindPopup(`<b>Check-in</b><br>${esc(checkinTime)}`);

  // Current location marker (last point)
  const lastPoint = points[points.length - 1];
  const lastTime = new Date(locations[locations.length - 1].recorded_at).toLocaleTimeString();
  currentMarker = L.marker(lastPoint, { icon: createPulsingIcon(COLORS.current) })
    .addTo(map)
    .bindPopup(`<b>Current</b><br>Updated: ${esc(lastTime)}`);

  // Check-out marker if session is ended
  if (session.checkout_lat != null && session.checkout_lng != null) {
    checkoutMarker = L.marker([session.checkout_lat, session.checkout_lng], {
      icon: createIcon(COLORS.checkout),
    })
      .addTo(map)
      .bindPopup(`<b>Check-out</b><br>${esc(new Date(session.checkout_time).toLocaleString())}`);
  }

  // Route polyline
  if (points.length > 1) {
    routeLine = L.polyline(points, {
      color: COLORS.route,
      weight: 4,
      opacity: 0.7,
    }).addTo(map);
  }

  // Fit map to show all points
  map.fitBounds(points, { padding: [60, 60], maxZoom: 16 });
}

// ---------------------------------------------------------------------------
// SSE with polling fallback
// ---------------------------------------------------------------------------

function startSSE() {
  const token = getToken();
  eventSource = new EventSource(
    API_BASE + `/admin/users/${encodeURIComponent(userId)}/session/stream?token=` + encodeURIComponent(token)
  );

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      renderSession(data);
    } catch (err) {
      console.error('SSE parse error:', err);
    }
  };

  eventSource.onerror = () => {
    console.warn('SSE connection lost, falling back to polling');
    eventSource.close();
    eventSource = null;
    startPolling();
  };
}

async function loadSession() {
  try {
    const data = await apiFetch(`/admin/users/${encodeURIComponent(userId)}/session`);
    renderSession(data);
  } catch (err) {
    console.error('Failed to load session:', err);
    document.getElementById('sessionInfo').textContent = 'Error loading session data';
  }
}

function startPolling() {
  clearInterval(pollInterval);
  loadSession();
  pollInterval = setInterval(loadSession, 15000);
}

// Try SSE first, fall back to polling
if (typeof EventSource !== 'undefined') {
  loadSession(); // Initial REST load
  startSSE();
} else {
  startPolling();
}
