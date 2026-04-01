// Redirect if already logged in
if (getToken() && getUser()?.role === 'admin') {
  window.location.href = '/dashboard.html';
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('error');
  errorEl.style.display = 'none';

  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value.trim();

  try {
    const data = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });

    if (data.user.role !== 'admin') {
      errorEl.textContent = 'Access denied. Admin only.';
      errorEl.style.display = 'block';
      return;
    }

    setToken(data.token);
    setUser(data.user);
    window.location.href = '/dashboard.html';
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
  }
});
