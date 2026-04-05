const API_BASE = window.location.origin + '/api';

function getToken() {
  return localStorage.getItem('token');
}

function setToken(token) {
  localStorage.setItem('token', token);
}

function clearToken() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
}

function getUser() {
  try {
    const u = localStorage.getItem('user');
    return u ? JSON.parse(u) : null;
  } catch {
    localStorage.removeItem('user');
    return null;
  }
}

function setUser(user) {
  localStorage.setItem('user', JSON.stringify(user));
}

// HTML-escape to prevent XSS
function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = 'Bearer ' + token;

  let res;
  try {
    res = await fetch(API_BASE + path, { ...options, headers });
  } catch (err) {
    throw new Error('Network error — server may be offline');
  }

  if (res.status === 401) {
    clearToken();
    window.location.href = '/';
    throw new Error('Session expired');
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('Invalid server response');
  }

  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
