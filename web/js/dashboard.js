// Auth guard
if (!getToken() || getUser()?.role !== 'admin') {
  window.location.href = '/';
}

const map = createMap('map', [20, 78], 5);
const markers = {};
let pollInterval;
let eventSource;

document.getElementById('logoutBtn').addEventListener('click', () => {
  cleanup();
  clearToken();
  window.location.href = '/';
});

// Clean up on page unload
window.addEventListener('beforeunload', cleanup);

function cleanup() {
  clearInterval(pollInterval);
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function renderUsers(users) {
  const list = document.getElementById('userList');
  if (!users || !users.length) {
    list.innerHTML = '<p style="padding:20px;color:#888;">No salesmen found</p>';
    return;
  }

  list.innerHTML = '';
  users.forEach(u => {
    const card = document.createElement('div');
    card.className = 'user-card';
    card.addEventListener('click', () => viewUser(u.id, u.username));

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = u.username;

    const status = document.createElement('span');
    status.className = 'status ' + (u.is_active ? 'active' : 'inactive');
    status.textContent = u.is_active ? 'Active' : 'Inactive';

    card.appendChild(name);
    card.appendChild(status);
    list.appendChild(card);
  });
}

function renderLocations(locations) {
  // Clear old markers
  Object.values(markers).forEach(m => map.removeLayer(m));
  Object.keys(markers).forEach(k => delete markers[k]);

  if (!locations || !locations.length) return;

  const bounds = [];
  locations.forEach(loc => {
    const latlng = [loc.latitude, loc.longitude];
    bounds.push(latlng);
    markers[loc.user_id] = L.marker(latlng, { icon: createPulsingIcon(COLORS.current) })
      .addTo(map)
      .bindPopup(`<b>${esc(loc.username)}</b><br>Updated: ${esc(new Date(loc.recorded_at).toLocaleTimeString())}`);
  });

  if (bounds.length > 0) {
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 });
  }
}

function viewUser(id, username) {
  window.location.href = `/user-detail.html?id=${encodeURIComponent(id)}&name=${encodeURIComponent(username)}`;
}

// ---------------------------------------------------------------------------
// SSE with polling fallback
// ---------------------------------------------------------------------------

function startSSE() {
  const token = getToken();
  // EventSource doesn't support custom headers, so pass token as query param
  eventSource = new EventSource(API_BASE + '/admin/locations/live/stream?token=' + encodeURIComponent(token));

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      renderUsers(data.users);
      renderLocations(data.locations);
    } catch (err) {
      console.error('SSE parse error:', err);
    }
  };

  eventSource.onerror = () => {
    // SSE failed — fall back to polling
    console.warn('SSE connection lost, falling back to polling');
    eventSource.close();
    eventSource = null;
    startPolling();
  };
}

async function loadUsers() {
  try {
    const data = await apiFetch('/admin/users');
    renderUsers(data?.users);
  } catch (err) {
    console.error('Failed to load users:', err);
  }
}

async function loadLiveLocations() {
  try {
    const data = await apiFetch('/admin/locations/live');
    renderLocations(data?.locations);
  } catch (err) {
    console.error('Failed to load locations:', err);
  }
}

function startPolling() {
  // Stop any existing polling first
  clearInterval(pollInterval);
  loadUsers();
  loadLiveLocations();
  pollInterval = setInterval(() => {
    loadUsers();
    loadLiveLocations();
  }, 10000);
}

// Try SSE first, fall back to polling if EventSource is not supported
if (typeof EventSource !== 'undefined') {
  // Initial load via REST (SSE takes a moment to connect)
  loadUsers();
  loadLiveLocations();
  startSSE();
} else {
  startPolling();
}
