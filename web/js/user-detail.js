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

document.getElementById('replayBtn').addEventListener('click', () => {
  window.location.href = `/replay.html?user_id=${encodeURIComponent(userId)}&name=${encodeURIComponent(userName)}`;
});

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

  const checkinTime = toIST(session.checkin_time);
  const checkoutTime = session.checkout_time
    ? toIST(session.checkout_time)
    : 'In progress...';
  const lastBattery = locations.length > 0 ? locations[locations.length - 1].battery_pct : null;
  const batteryHtml = lastBattery != null ? `<span><b>Battery:</b> ${lastBattery}%</span>` : '';
  const deviceParts = [session.device_model, session.os_version].filter(Boolean);
  const deviceHtml = deviceParts.length > 0
    ? `<span><b>Device:</b> ${esc(deviceParts.join(' \u00b7 '))}</span>` : '';
  infoEl.innerHTML = `
    <span><b>Check-in:</b> ${esc(checkinTime)}</span>
    <span><b>Check-out:</b> ${esc(checkoutTime)}</span>
    <span><b>Points:</b> ${locations.length}</span>
    ${batteryHtml}
    ${deviceHtml}
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
  const lastLoc = locations[locations.length - 1];
  const lastTime = toISTTime(lastLoc.recorded_at);
  const lastBatt = lastLoc.battery_pct != null ? `<br>Battery: ${lastLoc.battery_pct}%` : '';
  currentMarker = L.marker(lastPoint, { icon: createPulsingIcon(COLORS.current) })
    .addTo(map)
    .bindPopup(`<b>Current</b><br>Updated: ${esc(lastTime)}${lastBatt}`);

  // Check-out marker if session is ended
  if (session.checkout_lat != null && session.checkout_lng != null) {
    checkoutMarker = L.marker([session.checkout_lat, session.checkout_lng], {
      icon: createIcon(COLORS.checkout),
    })
      .addTo(map)
      .bindPopup(`<b>Check-out</b><br>${esc(toIST(session.checkout_time))}`);
  }

  // Speed-colored route segments
  if (locations.length > 1) {
    routeLine = createSpeedPolyline(locations);
    routeLine.addTo(map);
  }

  // Low battery warning banner
  let batteryBanner = document.getElementById('batteryWarning');
  if (!batteryBanner) {
    batteryBanner = document.createElement('div');
    batteryBanner.id = 'batteryWarning';
    batteryBanner.className = 'battery-warning-banner';
    const infoEl2 = document.getElementById('sessionInfo');
    infoEl2.parentNode.insertBefore(batteryBanner, infoEl2.nextSibling);
  }
  if (lastBattery != null && lastBattery <= 15) {
    batteryBanner.style.display = 'flex';
    batteryBanner.innerHTML = `\u26A0\uFE0F <b>Low Battery Warning:</b>&nbsp;Device battery is at ${lastBattery}%`;
  } else {
    batteryBanner.style.display = 'none';
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
