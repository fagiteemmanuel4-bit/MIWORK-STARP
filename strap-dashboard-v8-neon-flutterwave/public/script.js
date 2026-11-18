(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ===== Live authentication API ===== */
  const api = {
    async signIn(email, password) {
      try { await window.StrapAPI.request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }); return { ok: true }; }
      catch (e) { return { ok: false, msg: e.message }; }
    },
    async sendCode(email, purpose = 'verify') {
      try { const result = await window.StrapAPI.request('/api/auth/verification/send', { method: 'POST', body: JSON.stringify({ email, purpose }) }); return { ok: true, skipVerification: result.verificationRequired === false }; }
      catch (e) { return { ok: false, msg: e.message }; }
    },
    async verifyCode(email, code, purpose = 'reset') {
      try { return await window.StrapAPI.request('/api/auth/verification/verify', { method: 'POST', body: JSON.stringify({ email, code, purpose }) }); }
      catch (e) { return { ok: false, msg: e.message }; }
    },
    async resetPassword(email, code, password) {
      try {
        await window.StrapAPI.request('/api/auth/password/reset', { method: 'POST', body: JSON.stringify({ email, password }) });
        return { ok: true };
      } catch (e) { return { ok: false, msg: e.message }; }
    }
  };

  /* ===== helpers ===== */
  const toast = msg => {
    const t = $('#toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toast.id); toast.id = setTimeout(() => t.classList.remove('on'), 2600);
  };
  const emailError = v => !v.trim() ? 'Enter your email address.' :
    !emailRe.test(v.trim()) ? 'That email doesn’t look right. Use a format like name@example.com.' : '';
  /* ===== SIGN-UP / BUSINESS SETUP FLOW ===== */
  Object.assign(api, {
    async verifySignupCode(email, code) {
      try { return await window.StrapAPI.request('/api/auth/verification/verify', { method: 'POST', body: JSON.stringify({ email, code, purpose: 'signup' }) }); }
      catch (e) { return { ok: false, msg: e.message }; }
    },
    async createAccount(data) {
      try {
        const photoUrl = typeof data.photo === 'string' ? data.photo : null;
        const result = await window.StrapAPI.request('/api/auth/register', { method: 'POST', body: JSON.stringify({
          email: data.email, password: data.password, name: data.name, bizname: data.bizname,
          currency: data.currency || 'NGN', bcountry: data.bcountry || data.country,
          photoUrl, ...data
        }) });
        window.StrapAPI.setUser(result.user); return { ok: true, user: result.user };
      } catch (e) { return { ok: false, msg: e.message }; }
    },
    async subscribe({ amount }) {
      try {
        const result = await window.StrapAPI.request('/api/payments/initialize', { method: 'POST', body: JSON.stringify({ amount, currency: D.currency || 'NGN' }) });
        return { ok: true, checkoutUrl: result.checkoutUrl, txRef: result.txRef };
      } catch (e) { return { ok: false, msg: e.message }; }
    }
  });
  const flow = $('#flow'), land = $('#land');
  const SUB = new URLSearchParams(location.search).get('subscribe') === '1';
  const D = {}; let hist = [], tmr, tmr2;
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const ARROW = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>';
  const COUNTRIES = [['Nigeria','NGN'],['Ghana','GHS'],['Kenya','KES'],['South Africa','ZAR'],['Egypt','EGP'],['Uganda','UGX'],['Tanzania','TZS'],['Rwanda','RWF'],['Senegal','XOF'],['Côte d’Ivoire','XOF'],['Cameroon','XAF'],['United Kingdom','GBP'],['United States','USD'],['Canada','CAD'],['United Arab Emirates','AED'],['India','INR']];
  const CC = Object.fromEntries(COUNTRIES), COUNTRY_OPTS = [...COUNTRIES.map(c => c[0]), 'Other'];
  const CURS = [['NGN','Nigerian naira (NGN)'],['GHS','Ghanaian cedi (GHS)'],['KES','Kenyan shilling (KES)'],['ZAR','South African rand (ZAR)'],['EGP','Egyptian pound (EGP)'],['UGX','Ugandan shilling (UGX)'],['TZS','Tanzanian shilling (TZS)'],['RWF','Rwandan franc (RWF)'],['XOF','West African CFA franc (XOF)'],['XAF','Central African CFA franc (XAF)'],['GBP','British pound (GBP)'],['USD','US dollar (USD)'],['EUR','Euro (EUR)'],['CAD','Canadian dollar (CAD)'],['AED','UAE dirham (AED)'],['INR','Indian rupee (INR)']];
  const first = () => (D.name || '').split(/\s+/)[0];
  const sel = m => v => v ? '' : m;
  const txt = (m, n = 2) => v => v.trim().length >= n ? '' : m;
  const score = p => (p.length >= 8) + (/[a-z]/i.test(p) && /\d/.test(p)) + (p.length >= 12) + (/[^A-Za-z0-9]/.test(p) && /[A-Z]/.test(p));
  const pwErr = p => p.length < 10 ? 'Use at least 8 characters.' : (!/[a-z]/i.test(p) || !/\d/.test(p)) ? 'Include a letter and a number.' : '';
  const dobErr = v => {
    if (!v) return 'Enter your date of birth.';
    const [y, m, d] = v.split('-').map(Number), n = new Date();
    let a = n.getFullYear() - y; if (n.getMonth() + 1 < m || (n.getMonth() + 1 === m && n.getDate() < d)) a--;
    return y < 1900 || a < 0 ? 'Enter a valid date.' : a < 18 ? 'You must be 18 or older.' : '';
  };
  const urlErr = v => /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(v.trim()) ? '' : 'Enter a valid website, like www.mybusiness.com.';

  /* ---- subscription plan (edit prices and length here) ---- */
  const PLAN = {
    intro: 3000, introMonths: 3, regular: 4000,
    features: ['Point of sale with barcode scanning', 'Product catalogue and stock tracking', 'Low-stock alerts', 'Sales and revenue reports', 'Multiple branches']
  };
  const ngn = n => '\u20A6' + n.toLocaleString('en-NG');
  const planDate = () => { const d = new Date(); d.setMonth(d.getMonth() + PLAN.introMonths); return d; };
  const fmtDate = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  const STEPS = {
    /* ---- log in: same look and motion as creating an account ---- */
    lemail: { t: 'Welcome back', s: 'Enter your email address to sign in.', f: [{ key: 'lemail', type: 'email', ph: 'example@email.com', ac: 'email', v: emailError, link: ['Forgot password?', 'fgemail'] }], btn: 'Continue',
      note: 'New to Strap? <a href="#" data-flow="email">Create an account</a>', next: 'lpass' },
    lpass: { t: 'Enter your password', s: () => `Signing in as ${D.lemail}`, f: [{ key: 'lpw', type: 'password', ph: 'Password', ac: 'current-password', v: v => v ? '' : 'Enter your password.' }], btn: 'Sign in',
      act: async () => { const r = await api.signIn(D.lemail, D.lpw); if (!r.ok) r.msg = 'Email or password is incorrect.'; return r; }, next: 'lok' },
    lok: { k: 'success', noBack: 1, t: 'You’re signed in', s: 'Welcome back to Strap.', label: 'Open dashboard', auto: 2200, go: () => { location.href = 'dashboard.html'; } },
    fgemail: { t: 'Reset your password', s: 'Enter your account email and we’ll send you a 6 digit code.', f: [{ key: 'fgemail', type: 'email', ph: 'example@email.com', ac: 'email', def: () => D.lemail, v: emailError }], btn: 'Send code',
      act: () => api.sendCode(D.fgemail, 'reset'), next: 'fgcode' },
    fgcode: { k: 'code', purpose: 'reset', len: 6, wait: 30, mail: 'fgemail', save: 'fgcode', verify: (m, c) => api.verifyCode(m, c), t: 'Enter the code', s: () => `We sent a 6 digit code to ${D.fgemail}.`, next: 'fgnew' },
    fgnew: { t: 'Create a new password', s: 'Use at least 10 characters with a letter and a number.', f: [
      { key: 'fgpw', type: 'password', ph: 'New password', ac: 'new-password', meter: 1, v: pwErr },
      { key: 'fgpw2', type: 'password', ph: 'Confirm password', ac: 'new-password', v: v => v === D.fgpw ? '' : 'Passwords don’t match.' }], btn: 'Update password',
      act: () => api.resetPassword(D.fgemail, D.fgcode, D.fgpw), next: 'fgdone' },
    fgdone: { k: 'success', noBack: 1, t: 'Password updated', s: 'You can now sign in with your new password.', label: 'Back to sign in', go: () => { hist = []; D.fgpw = D.fgpw2 = D.lpw = ''; go('lemail'); } },
    email: { t: 'Enter your email address', s: 'We’ll send you a verification code', f: [{ key: 'email', type: 'email', ph: 'example@email.com', ac: 'email', v: emailError }], btn: 'Continue',
      note: 'By continuing, you agree to receive transactional messaging about your account. <a href="#" data-legal="privacy">Privacy Policy</a> &amp; <a href="#" data-legal="terms">Terms</a>', next: 'password' },
    password: { t: 'Set Password', s: 'You’ll verify your email next', f: [{ key: 'password', type: 'password', ph: 'Create a password', ac: 'new-password', meter: 1, v: pwErr }], btn: 'Continue',
      act: () => api.sendCode(D.email, 'signup'), next: 'code', skipVerificationNext: 'verified' },
    code: { k: 'code', purpose: 'signup', t: 'Code sent to your Email', s: 'If you can’t find the mail, check spam before you resend the code.', next: 'verified' },
    verified: { k: 'verified', mid: 1, noBack: 1, t: 'Verified', s: 'Ready to set up your business?', next: 'name' },
    name: { t: 'What’s your name?', noBack: 1, f: [{ key: 'name', ph: 'Your full name', ac: 'name', v: v => v.trim().split(/\s+/).filter(Boolean).length < 2 ? 'Enter your first and last name.' : '' }], btn: 'Continue', next: 'dob' },
    dob: { t: 'When were you born?', s: 'You must be 18 or older to set up a business.', f: [{ key: 'dob', type: 'date', ph: '', ac: 'bday', v: dobErr }], btn: 'Continue', next: 'country' },
    country: { t: 'Which country are you in?', f: [{ key: 'country', opts: COUNTRY_OPTS, ph: 'Select', v: sel('Select your country.'), sync: v => { D.currency = CC[v] || 'USD'; } }], btn: 'Continue', next: 'currency' },
    currency: { t: 'Which currency do you sell in?', s: 'Your prices and reports will show in this currency.', f: [{ key: 'currency', opts: CURS, ph: 'Select', v: sel('Select a currency.') }], btn: 'Continue', next: 'bizname' },
    bizname: { t: 'What’s your business name?', f: [{ key: 'bizname', ph: () => (first() ? first() + '’s Business' : 'Your business name'), v: txt('Enter your business name.') }], btn: 'Continue', next: 'registered' },
    registered: { k: 'choice', t: 'Is this a registered business?', key: 'registered', o: [['Yes', 'yes'], ['No', 'no']],
      note: 'If your business is registered you might be asked to enter your business registration number', next: v => v === 'yes' ? 'regno' : 'mode' },
    regno: { t: 'Business registration number', s: 'You can skip this and add it later.', f: [{ key: 'regno', ph: 'e.g. RC1234567', v: txt('Enter a valid registration number.', 4) }], btn: 'Continue', skip: 'mode', next: 'mode' },
    mode: { t: 'Select business mode?', s: 'Choosing the right business mode helps us give you the best experience for your business on Strap.',
      f: [{ key: 'mode', opts: ['Shop or supermarket', 'Food service', 'Fashion or electronics', 'Online store only', 'Growing brand', 'Other'], ph: 'Select', v: sel('Select a business mode.') }], btn: 'Continue', next: 'branches' },
    branches: { t: 'How many branches do you run?', f: [{ key: 'branches', opts: ['1 (single shop)', '2 to 5', '6 to 20', 'More than 20'], ph: 'Select', v: sel('Select an option.') }], btn: 'Continue', next: 'location' },
    location: { t: 'Where is your business located?', f: [
      { key: 'bcountry', opts: COUNTRY_OPTS, ph: 'Country', def: () => D.country, v: sel('Select a country.') },
      { key: 'state', ph: 'State or region', ac: 'address-level1', v: txt('Enter a state or region.') },
      { key: 'city', ph: 'City or town', ac: 'address-level2', v: txt('Enter a city or town.') }], btn: 'Continue', next: 'address' },
    address: { t: 'What’s the full business address?', s: 'This is where customers and deliveries can find you.', f: [
      { key: 'street', ph: 'Street address', ac: 'street-address', v: txt('Enter the street address.', 4) },
      { key: 'landmark', ph: 'Landmark or nearby area (optional)' },
      { key: 'postcode', ph: 'Postal code (optional)', ac: 'postal-code' }], btn: 'Continue', next: 'hasSite' },
    hasSite: { k: 'choice', t: 'Does your business have a website?', key: 'hasSite', o: [['Yes', 'yes'], ['No', 'no']], next: v => v === 'yes' ? 'siteUrl' : 'siteLater' },
    siteUrl: { t: 'What’s your website?', f: [{ key: 'site', type: 'url', ph: 'www.mybusiness.com', v: urlErr }], btn: 'Continue', next: 'photo' },
    siteLater: { k: 'choice', t: 'Want Strap to get you one later?', s: 'We can help you set up an online storefront when you’re ready.', key: 'wantSite', o: [['Yes, set one up later', 'yes'], ['No, not now', 'no']], next: 'photo' },
    photo: { k: 'image', t: 'Set business profile picture', next: 'plan' },
    plan: { k: 'plan', t: `Start for ${ngn(PLAN.intro)}/month`,
      s: () => `${ngn(PLAN.intro)}/mo for ${PLAN.introMonths} months. Continues at ${ngn(PLAN.regular)}/mo from ${fmtDate(planDate())}.`,
      skipTop: 'done', onSkip: () => { D.plan = { status: 'skipped' }; }, next: 'done' },
    subscribe: { k: 'plan', open: 1, t: `Go Premium for ${ngn(PLAN.intro)}/month`, s: () => `${ngn(PLAN.intro)}/mo for ${PLAN.introMonths} months. Continues at ${ngn(PLAN.regular)}/mo from ${fmtDate(planDate())}.`, next: 'sq' },
    /* after paying for Premium: a few questions, then verify the account's contact details */
    sq: { t: 'A few quick questions', s: 'This helps us set Premium up for your business.', noBack: 1, f: [
      { key: 'sTeam', opts: ['Just me', '2 to 5 people', '6 to 20 people', 'More than 20'], ph: 'How many people work with you?', v: sel('Select an option.') },
      { key: 'sUse', opts: ['Selling in my shop', 'Managing stock', 'Running several branches', 'Reports and tracking money', 'Something else'], ph: 'What will you use Premium for most?', v: sel('Select an option.') }], btn: 'Continue', pw: 1, next: 'sc' },
    sc: { t: 'Confirm your contact details', s: 'We’ll send a code to each one to make sure they belong to you. We use them for receipts and billing notices.', f: [
      { key: 'sEmail', type: 'email', ph: 'example@email.com', ac: 'email', def: () => D.email, v: emailError },
      { key: 'sPhone', type: 'tel', ph: 'Phone number, e.g. 0803 000 0000', ac: 'tel', v: v => v.replace(/\D/g, '').length < 7 ? 'Enter a valid phone number.' : '' }], btn: 'Send codes', pw: 1,
      act: () => api.sendCode(D.sEmail), next: 'sce' },
    sce: { k: 'code', len: 6, wait: 30, mail: 'sEmail', verify: (m, c) => api.verifyCode(m, c), pw: 1, t: 'Check your email', s: () => `We sent a 6 digit code to ${D.sEmail}.`, next: 'scp' },
    scp: { k: 'code', len: 6, wait: 30, mail: 'sPhone', verify: (m, c) => api.verifyCode(m, c), pw: 1, t: 'Check your phone', s: () => `We sent a 6 digit code by SMS to ${D.sPhone}.`, next: 'subdone' },
    subdone: { k: 'success', noBack: 1, t: 'Premium is active', s: 'Thank you. Your branch, staff and product limits are now raised.', label: 'Back to dashboard', auto: 2800, before: () => { if (D.sEmail) D.plan = { ...D.plan, contact: { email: D.sEmail, phone: D.sPhone, verified: true } };  }, go: () => { location.href = 'dashboard.html'; } },
    done: { k: 'final', noBack: 1, mid: 1, t: 'You’re all set' }
  };

  let rid = 0;
  const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function startFlow(first = 'email') {
    hist = [];
    land.hidden = true; flow.hidden = false; go(first);
  }
  function closeFlow() {
    clearInterval(tmr); hist = []; rid++;
    const fin = () => { flow.hidden = true; flow.replaceChildren(); land.hidden = false; };
    const old = flow.firstElementChild;
    if (old && !reduced()) { old.classList.add('leave', 'bk'); setTimeout(fin, 190); } else fin();
  }
  function go(id) { if (id === 'verified') hist = []; hist.push(id); render(id, 1); }
  function back() { hist.pop(); hist.length ? render(hist[hist.length - 1], -1) : SUB ? (location.href = 'dashboard.html') : closeFlow(); }
  const pill = (label, cls = '') => { const b = el('button', 'pill ' + cls, label); b.type = 'button'; return b; };
  const nxt = st => typeof st.next === 'function' ? st.next(D) : st.next;
  const lock = (b, on, l) => { if (on) { b.dataset.l = b.textContent; b.textContent = l || 'Please wait…'; } else if (b.dataset.l) b.textContent = b.dataset.l; b.disabled = on; };

  // old page slides/fades out, then the new page is built and its rows rise in one by one
  function render(id, dir = 1) {
    clearInterval(tmr); clearTimeout(tmr2);
    const my = ++rid, old = flow.firstElementChild;
    if (old && !flow.hidden && !reduced()) {
      old.classList.add('leave', dir < 0 ? 'bk' : 'fwd');
      setTimeout(() => { if (my === rid) build(id, dir); }, 190);
    } else build(id, dir);
  }
  function build(id, dir) {
    const st = STEPS[id], box = el('form', 'step enter' + (dir < 0 ? ' bk' : '') + (st.mid ? ' mid' : '') + (st.k === 'success' ? ' okw' : ''));
    box.noValidate = true; box.addEventListener('submit', e => e.preventDefault());
    const top = el('div', 'top');
    if (st.noBack) top.append(el('div', 'back-ic'));
    else { const b = el('button', 'back-ic'); b.type = 'button'; b.innerHTML = ARROW; b.setAttribute('aria-label', 'Back'); b.onclick = back; top.append(b); }
    if (st.skipTop) { const s = el('button', 'skip-top', 'Skip'); s.type = 'button'; s.onclick = () => { if (st.onSkip) st.onSkip(); go(st.skipTop); }; top.append(s); }
    box.append(top);
    const body = el('div', 'body'), foot = el('div', 'foot');
    body.append(el('h2', 'st', st.t));
    if (st.s) body.append(el('p', 'ss', typeof st.s === 'function' ? st.s() : st.s));
    ({ code: kCode, verified: kVerified, choice: kChoice, image: kImage, plan: kPlan, success: kSuccess, final: kFinal }[st.k] || kForm)(st, body, foot);
    if (st.pw) foot.append(el('p', 'note', 'Powered by Flutterwave'));
    box.append(body, el('div', 'sp'), foot);
    $$('.st,.ss,.fg,.acc,.paycard,.avatar,.tl,.okm,.foot > *,.skip-top', box).forEach((n, k) => { n.classList.add('rise'); n.style.setProperty('--i', Math.min(k, 8)); });
    flow.replaceChildren(box); window.scrollTo(0, 0);
    const i = box.querySelector('input:not([type=file])'); if (i && !st.k) i.focus();
  }

  function kForm(st, body, foot) {
    const wrap = el('div', 'fields'), rows = [], gerr = el('p', 'ferr'); gerr.setAttribute('role', 'alert');
    const btn = pill(st.btn); btn.type = 'submit';
    st.f.forEach(f => {
      const g = el('div', 'fg'), err = el('p', 'ferr'); err.setAttribute('role', 'alert'); let i;
      if (f.opts) {
        i = el('select', 'fi fs'); i.dataset.dd = f.key; i.append(new Option(f.ph || 'Select', ''));
        f.opts.forEach(o => i.append(Array.isArray(o) ? new Option(o[1], o[0]) : new Option(o, o)));
      } else {
        i = el('input', 'fi'); i.type = f.type || 'text'; if (f.type === 'date') i.dataset.dd = f.key;
        i.placeholder = typeof f.ph === 'function' ? f.ph() : f.ph;
        if (f.type === 'date') i.max = new Date().toISOString().slice(0, 10);
        if (f.ac) i.autocomplete = f.ac;
      }
      i.setAttribute('aria-label', f.ph && typeof f.ph === 'string' ? f.ph : f.key);
      const pre = D[f.key] || (f.def && f.def()); if (pre) i.value = pre;
      g.append(i);
      if (f.type === 'password') {
        i.classList.add('pwi'); const e = el('button', 'eye2', 'Show'); e.type = 'button';
        e.onclick = () => { const h = i.type === 'password'; i.type = h ? 'text' : 'password'; e.textContent = h ? 'Hide' : 'Show'; }; g.append(e);
        if (f.meter) { const m = el('div', 'meter'); m.append(el('i'), el('i'), el('i'), el('i')); g.append(m); f.m = m; }
      }
      g.append(err);
      if (f.link) { const a = el('button', 'flink', f.link[0]); a.type = 'button'; a.onclick = () => go(f.link[1]); g.append(a); }
      wrap.append(g); rows.push([f, i, err]);
    });
    const invalid = () => rows.some(([f, i]) => f.v && f.v(i.value));
    const upd = () => { btn.disabled = invalid(); };
    rows.forEach(([f, i, err]) => {
      const on = () => {
        D[f.key] = i.value.trim(); if (f.sync) f.sync(i.value); err.textContent = ''; gerr.textContent = ''; i.removeAttribute('aria-invalid');
        if (f.m) f.m.dataset.s = i.value ? Math.max(1, score(i.value)) : 0; upd();
      };
      i.addEventListener('input', on); i.addEventListener('change', on);
      i.addEventListener('blur', () => { const m = f.v ? f.v(i.value) : ''; if (i.value.trim() && m) { err.textContent = m; i.setAttribute('aria-invalid', 'true'); } });
    });
    upd(); body.append(wrap, gerr);
    btn.onclick = async () => {
      if (btn.disabled) return;
      rows.forEach(([f, i]) => D[f.key] = i.value.trim());
      if (st.act) {
        lock(btn, true); const r = await st.act(); lock(btn, false);
        if (!r.ok) { gerr.textContent = r.msg || 'Something went wrong. Try again.'; return; }
        if (r.skipVerification && st.skipVerificationNext) { go(st.skipVerificationNext); return; }
      }
      go(nxt(st));
    };
    foot.append(btn);
    if (st.skip) { const s = pill('Skip for now', 'alt'); s.onclick = () => go(st.skip); foot.append(s); }
    if (st.note) { const n = el('p', 'note'); n.innerHTML = st.note; $$('a[data-flow]', n).forEach(a => a.onclick = e => { e.preventDefault(); hist = []; go(a.dataset.flow); }); foot.append(n); }
  }

  function kChoice(st, body, foot) {
    st.o.forEach(([label, val]) => { const b = pill(label); b.onclick = () => { D[st.key] = val; go(nxt2(st, val)); }; foot.append(b); });
    if (st.note) { const n = el('p', 'note', st.note); foot.append(n); }
  }
  const nxt2 = (st, v) => typeof st.next === 'function' ? st.next(v) : st.next;

  function kVerified(st, body, foot) { const b = pill('Get Started'); b.onclick = () => go(st.next); foot.append(b); }

  function kCode(st, body, foot) {
    const N = st.len || 8, mail = () => D[st.mail || 'email'];
    const g = el('div', 'fg fields'), i = el('input', 'fi code8'), err = el('p', 'ferr'); err.setAttribute('role', 'alert');
    i.inputMode = 'numeric'; i.maxLength = N; i.autocomplete = 'one-time-code'; i.placeholder = `Enter the ${N} digit code`; i.setAttribute('aria-label', `${N} digit code`);
    const tl = el('div', 'tl'), note = el('span'), rs = el('button', '', 'Resend'); rs.type = 'button';
    tl.append(note, rs); g.append(i, err); body.append(g, tl);
    const btn = pill('Verify'); btn.type = 'submit'; btn.disabled = true; foot.append(btn);
    const start = () => {
      let s = st.wait || 180; rs.disabled = true; clearInterval(tmr);
      const tick = () => { note.textContent = s > 0 ? `Try again in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}s` : 'Didn’t get the code?'; if (s-- <= 0) { clearInterval(tmr); rs.disabled = false; } };
      tick(); tmr = setInterval(tick, 1000);
    };
    start();
    rs.onclick = async () => { await api.sendCode(mail(), st.purpose || 'verify'); i.value = ''; btn.disabled = true; err.textContent = ''; start(); toast('New code sent'); };
    i.addEventListener('input', () => { i.value = i.value.replace(/\D/g, '').slice(0, N); err.textContent = ''; btn.disabled = i.value.length < N; if (i.value.length === N) btn.click(); });
    btn.onclick = async () => {
      if (btn.disabled) return; lock(btn, true, 'Verifying…');
      const r = await (st.verify || api.verifySignupCode)(mail(), i.value); lock(btn, false);
      if (!r.ok) { err.textContent = r.msg || 'That code isn’t right. Check it and try again.'; i.value = ''; btn.disabled = true; i.focus(); return; }
      if (st.save) D[st.save] = i.value;
      clearInterval(tmr); go(st.next);
    };
    i.focus();
  }

  function kImage(st, body, foot) {
    const av = el('div', 'avatar'); av.innerHTML = '<svg viewBox="0 0 200 200" fill="none" stroke="#0a0a0a" stroke-width="3" aria-hidden="true"><circle cx="100" cy="100" r="96"/><circle cx="100" cy="80" r="30"/><path d="M42 168c8-30 32-46 58-46s50 16 58 46"/></svg>';
    const err = el('p', 'ferr'); err.style.textAlign = 'center';
    const file = el('input'); file.type = 'file'; file.accept = 'image/*'; file.hidden = true;
    const btn = pill('Choose Media'), alt = pill('Skip for now', 'alt');
    let chosen = false;
    btn.onclick = () => chosen ? go(st.next) : file.click();
    alt.onclick = () => { D.photo = null; go(st.next); };
    file.onchange = () => {
      const f = file.files[0]; if (!f) return;
      if (!f.type.startsWith('image/')) { err.textContent = 'Choose an image file (JPG, PNG or WebP).'; return; }
      if (f.size > 5 * 1024 * 1024) { err.textContent = 'That image is over 5 MB. Choose a smaller one.'; return; }
      err.textContent = ''; D.photo = f; chosen = true;
      const img = el('img'); img.alt = 'Business profile picture preview'; img.src = URL.createObjectURL(f); av.replaceChildren(img);
      btn.textContent = 'Continue'; alt.textContent = 'Choose another'; alt.onclick = () => file.click();
    };
    body.append(av, err); foot.append(btn, alt, file);
  }

  /* ---- Flutterwave hosted checkout. Card data is entered only on Flutterwave. ---- */
  function kPlan(st, body, foot) {
    const acc = el('div', 'acc'), head = el('button', 'acc-h'), sign = el('span', 'acc-i', '+'), bx = el('div', 'acc-b'), inner = el('div'), list = el('ul', 'acc-l');
    head.type = 'button'; head.setAttribute('aria-expanded', 'false'); head.append(el('span', '', 'What’s included'), sign);
    PLAN.features.forEach(f => list.append(el('li', '', f))); inner.append(list); bx.append(inner); bx.inert = true;
    head.onclick = () => { const open = !acc.classList.contains('open'); acc.classList.toggle('open', open); head.setAttribute('aria-expanded', String(open)); bx.inert = !open; };
    if (st.open) { acc.classList.add('open'); head.setAttribute('aria-expanded', 'true'); bx.inert = false; }
    const card = el('div', 'paycard'), gerr = el('p', 'ferr'), btn = pill('Continue to secure payment');
    gerr.setAttribute('role', 'alert'); btn.type = 'button';
    btn.onclick = async () => {
      lock(btn, true, 'Preparing secure checkout…');
      try {
        // Create the Neon account before checkout so the payment is linked to a real user.
        const account = await api.createAccount(D);
        if (!account.ok) { gerr.textContent = account.msg || 'We could not create your account.'; lock(btn, false); return; }
        const result = await api.subscribe({ amount: PLAN.intro });
        if (!result.ok) { gerr.textContent = result.msg || 'Could not start payment.'; lock(btn, false); return; }
        location.href = result.checkoutUrl;
      } catch (e) { gerr.textContent = e.message; lock(btn, false); }
    };
    card.append(el('div', 'cardh', 'Secure payment'), el('p', 'note', 'You’ll complete payment on Flutterwave. Strap never receives or stores your card number, expiry date or CVV.'), gerr, btn,
      el('p', 'note', `Subscription amount: ${ngn(PLAN.intro)}. Cancel anytime.`),
      el('p', 'note', 'Payments powered by Flutterwave'));
    body.append(acc, card);
  }

  // animated success: ring and tick draw themselves, sparks burst, then we move on (button or automatically)
  function kSuccess(st, body, foot) {
    if (st.before) st.before();
    const m = el('div', 'okm');
    m.innerHTML = '<svg viewBox="0 0 120 120" aria-hidden="true"><circle class="okr" cx="60" cy="60" r="54" pathLength="1"/><circle class="okd" cx="60" cy="60" r="44"/><path class="okt" d="M41 62l14 14 26-31" pathLength="1"/></svg><i></i><i></i><i></i>';
    body.prepend(m);
    const b = pill(st.label || 'Continue'); let done = false; const run = () => { if (done) return; done = true; clearTimeout(tmr2); st.go(); };
    b.onclick = run; foot.append(b);
    clearTimeout(tmr2); if (st.auto) tmr2 = setTimeout(run, reduced() ? 600 : st.auto);
  }
  function kFinal(st, body, foot) {
    body.append(el('p', 'ss', `${D.bizname || 'Your business'} is ready to set up on Strap.`));
    const b = pill('Open my workspace');
    b.onclick = () => launch(b);
    foot.append(b);
  }

  /* ===== hand off to the dashboard page (dashboard.html) ===== */
  const loader = $('#loader');
  function readPhoto(f) {
    return new Promise(res => {
      if (!f) return res(null);
      const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => res(null); r.readAsDataURL(f);
    });
  }
  async function launch(btn) {
    lock(btn, true, 'Setting up…');
    document.body.classList.add('lock'); loader.hidden = false; void loader.offsetWidth; loader.classList.add('on');
    const t0 = Date.now(); let acc;
    try { acc = await api.createAccount(D); } catch (e) { acc = { ok: false }; }
    if (!acc.ok) {
      loader.classList.remove('on'); setTimeout(() => { loader.hidden = true; document.body.classList.remove('lock'); }, 300);
      lock(btn, false); toast('We couldn’t finish setup. Try again.'); return;
    }
    await sleep(Math.max(0, 900 - (Date.now() - t0)));
    location.href = 'dashboard.html';
  }

  /* ===== landing: create account or log in; ?subscribe=1 opens the card screen only ===== */
  $('#l-signup').addEventListener('click', () => startFlow('email'));
  $('#l-login').addEventListener('click', () => startFlow('lemail'));
  if (SUB) { land.hidden = true; flow.hidden = false; hist = []; go('subscribe'); }

  /* ===== legal and support links: pages are being updated, so they show a short notice for now ===== */
  const NOTICE = { terms: ['Terms of Use', 'Our terms of use are being updated.'], privacy: ['Privacy Policy', 'Our privacy policy is being updated.'], support: ['Support', 'Support is currently being updated. Please check back soon.'] };
  const sheetEl = $('#notice');
  const closeNotice = () => { sheetEl.classList.remove('on'); setTimeout(() => { sheetEl.hidden = true; }, 260); };
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-legal]'); if (!a) return; e.preventDefault();
    const [t, d] = NOTICE[a.dataset.legal] || NOTICE.support; $('#notice-t').textContent = t; $('#notice-d').textContent = d;
    sheetEl.hidden = false; void sheetEl.offsetWidth; sheetEl.classList.add('on');
  });
  $('#notice-x').addEventListener('click', closeNotice); $('.n-scrim', sheetEl).addEventListener('click', closeNotice);
})();
