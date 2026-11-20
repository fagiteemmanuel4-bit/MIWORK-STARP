/* Strap API client. Auth and account data are loaded only after Neon Auth is ready. */
(() => {
  const state = { user: null, data: {}, config: {}, ready: null, error: null };
  let authReadyPromise;
  const waitForAuth = () => {
    if (window.StrapNeonAuth?.client) return Promise.resolve(window.StrapNeonAuth);
    if (!authReadyPromise) {
      authReadyPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          window.removeEventListener('strap-neon-auth-ready', onReady);
          reject(new Error('Neon Auth did not initialize. Check your connection and reload.'));
        }, 15000);
        const onReady = () => {
          clearTimeout(timeout);
          if (window.StrapNeonAuth?.client) resolve(window.StrapNeonAuth);
          else reject(new Error('Neon Auth initialized without a client.'));
        };
        window.addEventListener('strap-neon-auth-ready', onReady, { once: true });
        if (window.StrapNeonAuth?.client) onReady();
      });
    }
    return authReadyPromise;
  };
  const getAuthToken = async () => {
    const auth = await waitForAuth();
    if (typeof auth.getToken === 'function') return await auth.getToken();
    const client = auth.client;
    // Neon Auth exposes the signed JWT through getJWTToken(). The session's
    // .token field is an opaque cookie identifier, not a JWT.
    if (typeof client.getJWTToken === 'function') {
      const jwt = await client.getJWTToken();
      if (typeof jwt === 'string' && jwt.trim()) return jwt;
    }
    if (typeof client.token === 'function') {
      const result = await client.token();
      if (result?.error) throw result.error;
      if (typeof result?.data?.token === 'string' && result.data.token.trim()) return result.data.token;
    }
    const sessionResult = await client.getSession?.();
    if (sessionResult?.error) throw sessionResult.error;
    return sessionResult?.data?.session?.access_token || null;
  };
  const request = async (url, options = {}) => {
    let authToken = null;
    const publicRequest = ['/api/config', '/api/auth/verification/send', '/api/auth/verification/verify'].includes(url);
    if (url !== '/api/config') {
      try { authToken = await getAuthToken(); }
      catch (error) {
        if (!publicRequest) throw error;
        console.warn('Neon Auth token not needed for this public request:', error.message);
      }
    }
    if (!authToken && !publicRequest) {
      throw new Error('Your Neon Auth session is missing or expired. Please sign in again.');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {
        ...options,
        cache: 'no-store',
        signal: options.signal || controller.signal,
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          ...(options.headers || {})
        }
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload.message || `Request failed (${response.status})`);
        error.status = response.status;
        error.code = payload.code || '';
        error.payload = payload;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('This request took too long. Check your connection and try again.');
      if (error instanceof TypeError) throw new Error('Could not reach Strap. Check your connection and try again.');
      throw error;
    } finally { clearTimeout(timeout); }
  };
  const writeQueues = new Map();
  const data = {
    get(key, fallback) { return Object.prototype.hasOwnProperty.call(state.data, key) ? state.data[key] : fallback; },
    async set(key, value) {
      return data.setMany({ [key]: value });
    },
    async setMany(values) {
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('A data object is required.');
      const keys = Object.keys(values);
      if (!keys.length) return { ok: true };
      const previous = Promise.all(keys.map(key => (writeQueues.get(key) || Promise.resolve()).catch(() => {})));
      const next = previous.then(async () => {
        const result = await request('/api/data', { method: 'PUT', body: JSON.stringify({ data: values }) });
        Object.assign(state.data, values);
        return result;
      });
      keys.forEach(key => writeQueues.set(key, next));
      try { return await next; }
      catch (error) {
        window.dispatchEvent(new CustomEvent('strap:persistence-error', { detail: { keys, message: error.message } }));
        throw error;
      } finally {
        keys.forEach(key => { if (writeQueues.get(key) === next) writeQueues.delete(key); });
      }
    },
    async flush() { await Promise.all([...writeQueues.values()]); },
    all() { return state.data; }
  };
  state.ready = (async () => {
    try {
      state.config = await request('/api/config') || {};
      await waitForAuth();
      const me = await request('/api/auth/me');
      state.user = me.user || null;
      if (state.user) {
        const saved = await request('/api/data');
        state.data = saved.data || {};
      }
    } catch (error) {
      state.error = error;
      if (error.status !== 401) console.error('Strap initial data load failed:', error);
    }
    return state;
  })();
  window.StrapAPI = {
    request, data, ready: state.ready,
    get user() { return state.user; },
    get error() { return state.error; },
    get config() { return state.config; },
    setUser(user) { state.user = user; state.error = null; },
    async refresh() {
      state.error = null;
      await waitForAuth();
      const me = await request('/api/auth/me');
      state.user = me.user || null;
      const saved = state.user ? await request('/api/data') : { data: {} };
      state.data = saved.data || {};
      return state;
    },
    async refreshData() {
      if (!state.user) throw new Error('Sign in to refresh your store data.');
      const saved = await request('/api/data');
      state.data = saved.data || {};
      return state.data;
    },
    async logout() {
      try { await window.StrapNeonAuth?.client?.signOut(); }
      finally { state.user = null; state.data = {}; }
    },
    async renameBusiness(name) { return request('/api/account/business', { method: 'PATCH', body: JSON.stringify({ name }) }); }
  };
})();