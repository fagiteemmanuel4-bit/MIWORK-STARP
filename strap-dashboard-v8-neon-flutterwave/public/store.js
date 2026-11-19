/* Strap – shared in-memory state. Durable account data is persisted to Neon through StrapAPI. */
window.StrapStore = (() => {
  const blank = () => ({
    sales: [], payments: [], held: [], collections: [], credits: [], seq: 0, closed: null, pin: null, lock: { n: 0, until: 0 }, receipt: null, online: null, orders: [], oseq: 1000, pageData: { customers: [], purchase: [], transfers: [], gift: [] },
    prefs: { sound: true, vibrate: true, creditReminders: true, orderAlerts: true, lowStock: true }
  });
  let S = blank(), saveDepth = 0, saveDirty = false;
  const save = () => {
    if (saveDepth) { saveDirty = true; return Promise.resolve({ deferred: true }); }
    return window.StrapAPI ? window.StrapAPI.data.set('store', S) : Promise.reject(new Error('Strap storage is not ready.'));
  };
  async function batch(mutator, includeFeatures = false) {
    const storeBefore = JSON.parse(JSON.stringify(S));
    const featuresBefore = includeFeatures && window.StrapFeatures ? JSON.parse(JSON.stringify(window.StrapFeatures.state)) : null;
    saveDepth++; saveDirty = false;
    try {
      const result = await mutator();
      saveDepth--;
      saveDirty = false;
      const payload = { store: S };
      if (includeFeatures && window.StrapFeatures) payload.features = window.StrapFeatures.state;
      await window.StrapAPI.data.setMany(payload);
      return result;
    } catch (error) {
      saveDepth = Math.max(0, saveDepth - 1);
      saveDirty = false;
      Object.keys(S).forEach(key => { if (!(key in storeBefore)) delete S[key]; });
      Object.assign(S, storeBefore);
      if (featuresBefore && window.StrapFeatures?.state) {
        const target = window.StrapFeatures.state;
        Object.keys(target).forEach(key => { if (!(key in featuresBefore)) delete target[key]; });
        Object.assign(target, featuresBefore);
        window.dispatchEvent(new CustomEvent('strap:state-restored', { detail: { sections: ['store','features'] } }));
      }
      throw error;
    }
  }
  const timeout = (promise, ms, message) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ]);
  async function hydrate() {
    const remote = window.StrapAPI?.data.get('store');
    if (remote && typeof remote === 'object' && !Array.isArray(remote)) Object.assign(S, remote);
    const savedOnlineStore = window.StrapAPI?.data.get('onlineStore');
    if (!S.online && savedOnlineStore && typeof savedOnlineStore === 'object') S.online = savedOnlineStore;
    const base = blank();
    for (const key of ['sales','payments','held','collections','credits','orders']) S[key] = Array.isArray(S[key]) ? S[key] : base[key];
    S.prefs = Object.assign({}, base.prefs, S.prefs || {});
    S.lock = Object.assign({ n: 0, until: 0 }, S.lock || {});
    S.pageData = Object.assign({}, base.pageData, S.pageData || {});
    for (const key of Object.keys(base.pageData)) S.pageData[key] = Array.isArray(S.pageData[key]) ? S.pageData[key] : [];
    return S;
  }

  const api = {
    DEMO: false,
    async sendCode(email) {
      try {
        const { error } = await timeout(window.StrapNeonAuth.client.emailOtp.sendVerificationOtp({ email, type: 'email-verification' }), 15000, 'Email verification is taking too long. Please retry.');
        if (error) throw error;
        return { ok: true };
      } catch (e) { return { ok: false, msg: e.message || 'Could not send the Neon verification code.' }; }
    },
    async verifyCode(email, code) {
      try {
        const { error } = await timeout(window.StrapNeonAuth.client.emailOtp.checkVerificationOtp({ email, otp: code, type: 'email-verification' }), 15000, 'Code verification is taking too long. Please retry.');
        if (error) throw error;
        return { ok: true };
      } catch (e) { return { ok: false, msg: e.message || 'The verification code is invalid.' }; }
    },
    async savePin(pin) {
      try { await window.StrapAPI.request('/api/security/pin', { method: 'POST', body: JSON.stringify({ pin }) }); return { ok: true }; }
      catch (e) { return { ok: false, msg: e.message || 'Could not save your activity PIN.' }; }
    },
    async checkPin(pin) {
      try { const result = await window.StrapAPI.request('/api/security/pin/verify', { method: 'POST', body: JSON.stringify({ pin }) }); return { ok: true, valid: !!result.valid }; }
      catch (e) { return { ok: false, valid: false, msg: e.message || 'Could not verify your activity PIN.' }; }
    },
    async changePassword(current, next) {
      try {
        const { error } = await window.StrapNeonAuth.client.changePassword({
          currentPassword: current,
          newPassword: next,
          revokeOtherSessions: true
        });
        if (error) throw error;
        await window.StrapAPI.refresh();
        return { ok: true };
      } catch (e) { return { ok: false, msg: e.message || 'Could not update your Neon Auth password.' }; }
    },
    async scheduleCreditReminder(credit) { return { ok: false, msg: 'Scheduled reminders need a background worker and are not enabled yet.' }; },
    get BASE_DOMAIN() { return window.StrapAPI?.config?.storeBaseDomain || location.hostname; },
    async checkSubdomain(name) {
      try { return await window.StrapAPI.request('/api/storefront/subdomain/check', { method: 'POST', body: JSON.stringify({ name }) }); }
      catch (e) { return { ok: false, available: false, msg: e.message }; }
    },
    async verifyDomain(host, token) {
      try { return await window.StrapAPI.request('/api/storefront/domain/verify', { method: 'POST', body: JSON.stringify({ host, token }) }); }
      catch (e) { return { ok: false, verified: false, msg: e.message }; }
    },
    async createStore(config) {
      try { await window.StrapAPI.data.set('onlineStore', config); return { ok: true }; }
      catch (e) { return { ok: false, msg: e.message }; }
    },
    async saveStore(config) {
      try { await window.StrapAPI.data.set('onlineStore', config); return { ok: true }; }
      catch (e) { return { ok: false, msg: e.message }; }
    },
    async pullOrders() {
      await window.StrapAPI.refreshData();
      const latest = window.StrapAPI.data.get('store', {}) || {};
      Object.assign(S, latest);
      S.orders = Array.isArray(latest.orders) ? latest.orders : [];
      if (window.StrapFeatures) await window.StrapFeatures.hydrate();
      window.dispatchEvent(new CustomEvent('strap:remote-data-refreshed', { detail: { sections: ['store','features'] } }));
      return S.orders;
    }
  };

  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const lineCount = s => s.lines.reduce((a, l) => a + l.qty, 0);

  // ---- hashing for the 4-digit PIN (the real check should live on your server) ----
  async function hashPin(pin, salt) {
    const data = new TextEncoder().encode(salt + ':' + pin);
    try { const buf = await crypto.subtle.digest('SHA-256', data); return [...new Uint8Array(buf)].map(b => pad(b.toString(16))).join(''); }
    catch (e) { let h = 5381; for (const c of salt + ':' + pin) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return 'x' + h.toString(16); }
  }

  // product collections – created on the Collections page, chosen when adding a product
  const collections = {
    all: () => S.collections,
    find: name => S.collections.find(c => c.name.toLowerCase() === String(name).trim().toLowerCase()),
    add(name, description = '') {
      const n = String(name).trim().slice(0, 40); if (!n) return null;
      const ex = collections.find(n); if (ex) return ex;
      const c = { id: uid('col'), name: n, description: String(description).trim().slice(0, 80), createdAt: Date.now() };
      S.collections.unshift(c); save(); return c;
    },
    remove(id) { S.collections = S.collections.filter(c => c.id !== id); save(); }
  };

  const credits = {
    balance: c => Math.max(0, Math.round((c.total - c.payments.reduce((a, p) => a + p.amount, 0)) * 100) / 100),
    paid: c => c.payments.reduce((a, p) => a + p.amount, 0),
    open: () => S.credits.filter(c => credits.balance(c) > 0).sort((a, b) => a.due.localeCompare(b.due)),
    settled: () => S.credits.filter(c => credits.balance(c) <= 0).sort((a, b) => b.createdAt - a.createdAt),
    owed: () => S.credits.reduce((a, c) => a + credits.balance(c), 0),
    // days until due: negative = overdue
    daysLeft: c => Math.round((new Date(c.due + 'T00:00:00') - new Date(dayKey() + 'T00:00:00')) / 864e5),
    due: (within = 0) => credits.open().filter(c => credits.daysLeft(c) <= within)
  };

  return {
    api, dayKey, credits, collections, lineCount, prefs: S.prefs, hydrate,
    get state() { return S; },
    save,
    nextNo() { S.seq++; save(); return 'S-' + pad(S.seq, 4); },

    // ----- sales & money -----
    addSale(sale) { S.sales.unshift(sale); save(); return sale; },
    addPayment(p) { S.payments.push({ id: uid('pay'), ts: Date.now(), ...p }); save(); },
    sales(days = 0) {
      if (!days) return S.sales;
      const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - (days - 1));
      return S.sales.filter(s => s.ts >= from.getTime());
    },
    earned(days = 1) {
      const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - (days - 1));
      return S.payments.filter(p => !days || p.ts >= from.getTime()).reduce((a, p) => a + p.amount, 0);
    },
    earnedAll() { return S.payments.reduce((a, p) => a + p.amount, 0); },
    dayStats() {
      const sales = S.sales.filter(s => dayKey(s.ts) === dayKey());
      const creditToday = sales.filter(s => s.method === 'credit');
      return {
        sales, count: sales.length, items: sales.reduce((a, s) => a + lineCount(s), 0),
        earned: S.payments.filter(p => dayKey(p.ts) === dayKey()).reduce((a, p) => a + p.amount, 0),
        creditGiven: creditToday.reduce((a, s) => a + s.total, 0), owedTotal: credits.owed()
      };
    },

    // ----- held sales -----
    addHeld(h) { S.held.unshift({ id: uid('h'), ts: Date.now(), ...h }); save(); },
    removeHeld(id) { S.held = S.held.filter(h => h.id !== id); save(); },

    // ----- credit book -----
    addCredit(c) { S.credits.unshift({ id: uid('c'), createdAt: Date.now(), payments: [], ...c }); save(); return S.credits[0]; },
    payCredit(id, amount) {
      const c = S.credits.find(x => x.id === id); if (!c) return null;
      const amt = Math.min(Math.max(0, +amount || 0), credits.balance(c)); if (!amt) return c;
      c.payments.push({ ts: Date.now(), amount: amt });
      S.payments.push({ id: uid('pay'), ts: Date.now(), amount: amt, saleId: c.saleId, method: 'credit', type: 'credit' });
      save(); return c;
    },

    // ----- closing the day -----
    isClosed() { return !!(S.closed && S.closed.day === dayKey()); },
    closeDay(info) { S.closed = { day: dayKey(), ts: Date.now(), ...info }; save(); },
    reopenDay() { S.closed = null; save(); },

    // ----- activity PIN -----
    hasPin() { return !!(S.pin && (S.pin.configured || S.pin.hash)); },
    async setPin(pin) {
      const result = await api.savePin(pin);
      if (!result.ok) return result;
      S.pin = { configured: true }; S.lock = { n: 0, until: 0 };
      try { await save(); return { ok: true }; }
      catch (error) { return { ok: false, msg: 'The PIN was created but workspace sync failed. Refresh and check Settings before retrying.' }; }
    },
    async checkPin(pin) {
      if (S.pin?.configured) {
        const result = await api.checkPin(pin);
        if (!result.ok) throw new Error(result.msg || 'Could not verify your activity PIN. Check your connection and try again.');
        return !!result.valid;
      }
      if (S.pin?.hash) return (await hashPin(pin, S.pin.salt)) === S.pin.hash;
      return false;
    },
    lockLeft() { return Math.max(0, Math.ceil((S.lock.until - Date.now()) / 1000)); },
    pinFail() { S.lock.n++; if (S.lock.n >= 5) { S.lock = { n: 0, until: Date.now() + 30000 }; } save(); return S.lock.n; },
    pinOk() { S.lock = { n: 0, until: 0 }; save(); },

    // ----- online store (one JSON config) & its orders -----
    online() { return S.online; },
    async setOnline(c) {
      if (!c || typeof c !== 'object') throw new Error('A valid online store configuration is required.');
      S.online = c;
      await window.StrapAPI.data.setMany({ store: S, onlineStore: c });
      return S.online;
    },
    async removeOnline() {
      S.online = null; S.orders = [];
      await window.StrapAPI.data.setMany({ store: S, onlineStore: null });
    },
    orders() { return S.orders; },
    addOrder(o) { S.oseq++; const now=Date.now(); const order = { id: 'O-' + S.oseq, ts: now, status: 'new', paid: false, channel: 'online', tracking: 'ST-' + now.toString(36).toUpperCase(), events: [{status:'new',at:now,note:'Order received'}], ...o }; S.orders.unshift(order); save(); return order; },
    async setOrderStatus(id, status) { const o = S.orders.find(x => x.id === id); if (o) { o.status = status; o.events = o.events || []; o.events.push({status,at:Date.now(),note:({processing:'Order is being prepared',fulfilled:'Order marked fulfilled',cancelled:'Order cancelled'})[status]||'Order updated'}); await save(); } return o; },

    // ----- receipt template (JSON) & prefs -----
    getReceiptRaw() { return S.receipt; },
    setReceiptRaw(t) { S.receipt = t; save(); }
  };
})();
