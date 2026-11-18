/* Strap API client. All durable account data lives on the server in Neon. */
(() => {
  const state = { user: null, data: {}, config: {}, ready: null };
  const request = async (url, options = {}) => {
    let authToken = null;
    try { authToken = await window.StrapNeonAuth?.getToken?.(); } catch { authToken = null; }
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}), ...(options.headers || {}) },
      ...options
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.message || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return payload;
  };
  const data = {
    get(key, fallback) { return Object.prototype.hasOwnProperty.call(state.data, key) ? state.data[key] : fallback; },
    async set(key, value) {
      state.data[key] = value;
      return request('/api/data', { method: 'PUT', body: JSON.stringify({ data: { [key]: value } }) });
    },
    all() { return state.data; }
  };
  state.ready = (async () => {
    try {
      const config = await request('/api/config');
      state.config = config || {};
      const me = await request('/api/auth/me');
      state.user = me.user;
      const saved = await request('/api/data');
      state.data = saved.data || {};
    } catch (error) {
      if (error.status !== 401) console.error('Strap initial data load failed:', error);
    }
    return state;
  })();
  window.StrapAPI = {
    request, data, ready: state.ready,
    get user() { return state.user; },
    get config() { return state.config; },
    setUser(user) { state.user = user; },
    async logout() { await request('/api/auth/logout', { method: 'POST', body: '{}' }); state.user = null; },
    async renameBusiness(name) { return request('/api/account/business', { method: 'PATCH', body: JSON.stringify({ name }) }); }
  };
})();