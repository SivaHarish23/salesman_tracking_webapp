// Auth guard
if (!getToken() || getUser()?.role !== 'admin') {
  window.location.href = '/';
}

const map = createMap('map', [20, 78], 5);
const markers = {};
let pollInterval;

document.getElementById('logoutBtn').addEventListener('click', () => {
  clearToken();
  window.location.href = '/';
});

async function loadUsers() {
  try {
    const data = await apiFetch('/admin/users');
    const list = document.getElementById('userList');
    if (!data.users.length) {
      list.innerHTML = '<p style="padding:20px;color:#888;">No salesmen found</p>';
      return;
    }

    list.innerHTML = data.users.map(u => `
      <div class="user-card" onclick="viewUser(${u.id}, '${u.username}')">
        <span class="name">${u.username}</span>
        <span class="status ${u.is_active ? 'active' : 'inactive'}">
          ${u.is_active ? 'Active' : 'Inactive'}
        </span>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load users:', err);
  }
}

async function loadLiveLocations() {
  try {
    const data = await apiFetch('/admin/locations/live');

    // Clear old markers
    Object.values(markers).forEach(m => map.removeLayer(m));
    Object.keys(markers).forEach(k => delete markers[k]);

    if (!data.locations.length) return;

    const bounds = [];
    data.locations.forEach(loc => {
      const latlng = [loc.latitude, loc.longitude];
      bounds.push(latlng);
      markers[loc.user_id] = L.marker(latlng, { icon: createPulsingIcon(COLORS.current) })
        .addTo(map)
        .bindPopup(`<b>${loc.username}</b><br>Updated: ${new Date(loc.recorded_at).toLocaleTimeString()}`);
    });

    if (bounds.length > 0) {
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 });
    }
  } catch (err) {
    console.error('Failed to load locations:', err);
  }
}

function viewUser(id, username) {
  window.location.href = `/user-detail.html?id=${id}&name=${username}`;
}

// Initial load
loadUsers();
loadLiveLocations();

// Poll every 15 seconds
pollInterval = setInterval(() => {
  loadUsers();
  loadLiveLocations();
}, 15000);
