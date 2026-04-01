// Auth guard
if (!getToken() || getUser()?.role !== 'admin') {
  window.location.href = '/';
}

const params = new URLSearchParams(window.location.search);
const userId = params.get('id');
const userName = params.get('name');

document.getElementById('userName').textContent = userName || 'Salesman';

const map = createMap('detail-map', [20, 78], 5);
let checkinMarker, checkoutMarker, currentMarker, routeLine;
let pollInterval;

async function loadSession() {
  try {
    const data = await apiFetch(`/admin/users/${userId}/session`);
    const session = data.session;
    const locations = data.locations;

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
      <span><b>Check-in:</b> ${checkinTime}</span>
      <span><b>Check-out:</b> ${checkoutTime}</span>
      <span><b>Points:</b> ${locations.length}</span>
    `;

    // Clear old layers
    if (checkinMarker) map.removeLayer(checkinMarker);
    if (checkoutMarker) map.removeLayer(checkoutMarker);
    if (currentMarker) map.removeLayer(currentMarker);
    if (routeLine) map.removeLayer(routeLine);

    if (locations.length === 0) return;

    const points = locations.map(l => [l.latitude, l.longitude]);

    // Check-in marker (first point)
    checkinMarker = L.marker(points[0], { icon: createIcon(COLORS.checkin) })
      .addTo(map)
      .bindPopup(`<b>Check-in</b><br>${checkinTime}`);

    // Current location marker (last point)
    const lastPoint = points[points.length - 1];
    const lastTime = new Date(locations[locations.length - 1].recorded_at).toLocaleTimeString();
    currentMarker = L.marker(lastPoint, { icon: createPulsingIcon(COLORS.current) })
      .addTo(map)
      .bindPopup(`<b>Current</b><br>Updated: ${lastTime}`);

    // Check-out marker if session is ended
    if (session.checkout_lat && session.checkout_lng) {
      checkoutMarker = L.marker([session.checkout_lat, session.checkout_lng], {
        icon: createIcon(COLORS.checkout),
      })
        .addTo(map)
        .bindPopup(`<b>Check-out</b><br>${new Date(session.checkout_time).toLocaleString()}`);
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

  } catch (err) {
    console.error('Failed to load session:', err);
    document.getElementById('sessionInfo').textContent = 'Error loading session data';
  }
}

// Initial load
loadSession();

// Poll every 15 seconds
pollInterval = setInterval(loadSession, 15000);
