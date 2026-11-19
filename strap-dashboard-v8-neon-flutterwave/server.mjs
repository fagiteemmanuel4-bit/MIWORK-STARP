import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pg from 'pg';
import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV = globalThis.STRAP_ENV || process.env;
const app = express();
const { Pool } = pg;
const pool = new Pool({
  connectionString: ENV.HYPERDRIVE?.connectionString || ENV.DATABASE_URL,
  ssl: ENV.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: Number(ENV.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});
const required = ['DATABASE_URL', 'APP_URL'];
for (const key of required) if (!ENV[key] || ENV[key].includes('replace_me')) {
  console.warn(`[config] ${key} is not configured; related requests will fail until .env is completed.`);
}
const PORT = Number(ENV.PORT || 3000);
const APP_URL = (ENV.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const CURRENCY = ENV.DEFAULT_CURRENCY || 'NGN';
const FLW_SECRET = ENV.FLW_SECRET_KEY || '';
const FLW_BASE = 'https://api.flutterwave.com/v3';
const NEON_AUTH_BASE_URL_RAW = ENV.NEON_AUTH_BASE_URL || '';
const NEON_AUTH_BASE_URL = NEON_AUTH_BASE_URL_RAW.endsWith('/') ? NEON_AUTH_BASE_URL_RAW.slice(0, -1) : NEON_AUTH_BASE_URL_RAW;
const NEON_AUTH_JWKS_URL = ENV.NEON_AUTH_JWKS_URL || (NEON_AUTH_BASE_URL ? `${NEON_AUTH_BASE_URL}/.well-known/jwks.json` : '');
let neonJwks;

app.set('trust proxy', Number(ENV.TRUST_PROXY || 1));
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
// Workers-compatible JSON body parser: avoids body-parser/iconv-lite's Node stream shim.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') { req.body = {}; return next(); }
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') { req.body = {}; return next(); }
  let raw = '', size = 0, tooLarge = false;
  req.setEncoding('utf8');
  req.on('data', chunk => {
    size += Buffer.byteLength(chunk);
    if (size > 2 * 1024 * 1024) { tooLarge = true; return; }
    if (!tooLarge) raw += chunk;
  });
  req.on('end', () => {
    if (tooLarge) return fail(res, 413, 'Request body is too large.');
    try { req.body = raw ? JSON.parse(raw) : {}; next(); }
    catch { return fail(res, 400, 'Request body must be valid JSON.'); }
  });
  req.on('error', next);
});
// Vercel routes all requests through the Express function so HTML, CSS, JS and API
// requests are served by the same app root. Strip the internal rewrite prefix early,
 // before Express route matching and rate-limit middleware.
app.use((req, _res, next) => {
  if (req.url.startsWith('/api/_static/')) req.url = req.url.slice('/api/_static'.length) || '/';
  next();
});
app.use(rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false }));

const randomToken = () => crypto.randomBytes(32).toString('base64url');
const emailNorm = value => String(value || '').trim().toLowerCase();
const safeEqual = (a, b) => {
  const aa = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
};
const cleanText = (v, max = 160) => String(v ?? '').trim().slice(0, max);
const fail = (res, status, message) => res.status(status).json({ ok: false, message });
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function getNeonIdentity(req) {
  const authorization = String(req.headers.authorization || '');
  const token = authorization.slice(0, 7).toLowerCase() === 'bearer ' ? authorization.slice(7).trim() : '';
  if (!token || !NEON_AUTH_JWKS_URL || !NEON_AUTH_BASE_URL) return null;
  try {
    neonJwks ||= createRemoteJWKSet(new URL(NEON_AUTH_JWKS_URL));
    const { payload } = await jwtVerify(token, neonJwks, { issuer: new URL(NEON_AUTH_BASE_URL).origin });
    if (!payload.sub || !payload.email) return null;
    return { id: String(payload.sub), email: emailNorm(payload.email), name: cleanText(payload.name || payload.email.split('@')[0], 120), photoUrl: typeof payload.picture === 'string' ? payload.picture : null, emailVerified: payload.email_verified === true || payload.emailVerified === true };
  } catch (error) {
    console.warn('[auth] Neon token rejected:', error.code || error.message);
    return null;
  }
}
async function neonIdentity(req, res, next) {
  try {
    const identity = await getNeonIdentity(req);
    if (!identity) return fail(res, 401, 'Your Neon Auth session is invalid. Please sign in again.');
    req.neonIdentity = identity;
    next();
  } catch (error) { next(error); }
}
async function auth(req, res, next) {
  try {
    const identity = await getNeonIdentity(req);
    if (!identity) return fail(res, 401, 'Your Neon Auth session is invalid. Please sign in again.');
    if (!identity.emailVerified) return fail(res, 403, 'Verify your email with Neon Auth before accessing Strap.');
    let result = await pool.query(
      `SELECT u.id,u.email,u.full_name,u.photo_url,u.created_at,
              b.id AS business_id,b.name AS business_name,b.currency,b.country,b.plan,b.profile AS business_profile
       FROM users u LEFT JOIN businesses b ON b.owner_id=u.id AND b.is_default=true
       WHERE u.neon_auth_user_id=$1 AND u.disabled_at IS NULL LIMIT 1`,
      [identity.id]
    );
    if (!result.rowCount) {
      result = await pool.query(
        `SELECT u.id,u.email,u.full_name,u.photo_url,u.created_at,
                b.id AS business_id,b.name AS business_name,b.currency,b.country,b.plan
         FROM users u LEFT JOIN businesses b ON b.owner_id=u.id AND b.is_default=true
         WHERE u.email=$1 AND u.neon_auth_user_id IS NULL AND u.disabled_at IS NULL LIMIT 1`,
        [identity.email]
      );
      if (result.rowCount) {
        const linked = await pool.query('UPDATE users SET neon_auth_user_id=$2,updated_at=now() WHERE id=$1 AND neon_auth_user_id IS NULL RETURNING id', [result.rows[0].id, identity.id]);
        if (!linked.rowCount) return fail(res, 409, 'This email is already linked to another authentication account.');
      }
    }
    if (!result.rowCount) return fail(res, 401, 'Your Strap profile is not linked to this Neon Auth account. Please sign in again.');
    req.user = result.rows[0];
    next();
  } catch (error) { next(error); }
}
async function flutterwave(pathname, payload) {
  const response = await fetch(`${FLW_BASE}${pathname}`, {
    method: payload ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${FLW_SECRET}`, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status === 'error') throw new Error(body.message || 'Flutterwave request failed.');
  return body;
}
function profileIsComplete(user) {
  const emailPrefix = String(user.email || '').split('@')[0].toLowerCase();
  const name = cleanText(user.full_name, 120);
  const words = name.split(/\s+/).filter(Boolean);
  const profile = user.business_profile && typeof user.business_profile === 'object' ? user.business_profile : {};
  const businessName = cleanText(user.business_name, 140);
  return words.length >= 2 && name.toLowerCase() !== emailPrefix &&
    businessName.length >= 2 && businessName.toLowerCase() !== 'my business' &&
    Boolean(profile.country && profile.mode && profile.branches && profile.bcountry && profile.state && profile.city && profile.street);
}
function publicUser(user) {
  return { id: user.id, email: user.email, name: user.full_name, photoUrl: user.photo_url || null,
    bizname: user.business_name || '', currency: user.currency || CURRENCY, country: user.country || '',
    profile: user.business_profile || {}, profileComplete: profileIsComplete(user) };
}

app.get('/api/config', (_req, res) => res.json({
  ok: true,
  storeBaseDomain: ENV.STORE_BASE_DOMAIN || '',
  emailVerificationRequired: true,
  emailProvider: 'Neon Auth',
  paymentsEnabled: false,
  paymentsComingSoon: true
}));
app.get('/api/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, database: 'connected' });
}));

app.post('/api/auth/register', neonIdentity, asyncRoute(async (req, res) => {
  const email = req.neonIdentity.email;
  if (!req.neonIdentity.emailVerified) return fail(res, 403, 'Verify your email with Neon Auth before creating your Strap workspace.');
  const name = cleanText(req.body.name, 120), bizname = cleanText(req.body.bizname, 140);
  if (!name || !bizname) return fail(res, 400, 'Your name and business name are required.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let found = await client.query('SELECT id,email,full_name,photo_url,neon_auth_user_id FROM users WHERE neon_auth_user_id=$1 LIMIT 1', [req.neonIdentity.id]);
    if (!found.rowCount) found = await client.query('SELECT id,email,full_name,photo_url,neon_auth_user_id FROM users WHERE email=$1 LIMIT 1', [email]);
    if (found.rowCount && found.rows[0].neon_auth_user_id && found.rows[0].neon_auth_user_id !== req.neonIdentity.id) {
      await client.query('ROLLBACK');
      return fail(res, 409, 'This email is already linked to another authentication account. Sign in with the original account.');
    }
    let user;
    if (found.rowCount) {
      const updated = await client.query(
        'UPDATE users SET neon_auth_user_id=$2,full_name=$3,photo_url=COALESCE($4,photo_url),updated_at=now() WHERE id=$1 RETURNING id,email,full_name,photo_url,created_at',
        [found.rows[0].id, req.neonIdentity.id, name, req.body.photoUrl || null]
      );
      user = updated.rows[0];
    } else {
      const passwordHash = 'NEON_AUTH_ONLY';
      const inserted = await client.query(
        'INSERT INTO users(email,password_hash,full_name,photo_url,neon_auth_user_id) VALUES($1,$2,$3,$4,$5) RETURNING id,email,full_name,photo_url,created_at',
        [email, passwordHash, name, req.body.photoUrl || null, req.neonIdentity.id]
      );
      user = inserted.rows[0];
    }
    const profile = {};
    for (const key of ['dob','country','registered','regno','mode','branches','bcountry','state','city','street','landmark','postcode','hasSite','site','wantSite','currency']) {
      if (req.body[key] !== undefined) profile[key] = req.body[key];
    }
    await client.query(
      `INSERT INTO businesses(owner_id,name,currency,country,plan,is_default,profile)
       VALUES($1,$2,$3,$4,'free',true,$5::jsonb)
       ON CONFLICT (owner_id) WHERE is_default=true DO UPDATE SET name=EXCLUDED.name,currency=EXCLUDED.currency,country=EXCLUDED.country,profile=EXCLUDED.profile,updated_at=now()`,
      [user.id, bizname, cleanText(req.body.currency || CURRENCY, 8), cleanText(req.body.bcountry || req.body.country, 80), JSON.stringify(profile)]
    );
    await client.query('INSERT INTO account_data(user_id,data) VALUES($1,$2::jsonb) ON CONFLICT(user_id) DO NOTHING', [user.id, JSON.stringify({})]);
    await client.query('COMMIT');
        const b = await pool.query('SELECT name,currency,country,profile FROM businesses WHERE owner_id=$1 AND is_default=true LIMIT 1', [user.id]);
    res.status(found.rowCount ? 200 : 201).json({ ok: true, user: publicUser({ ...user, business_name: b.rows[0]?.name, currency: b.rows[0]?.currency, country: b.rows[0]?.country, business_profile: b.rows[0]?.profile || {} }) });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return fail(res, 409, 'An account already exists with this email.');
    throw error;
  } finally { client.release(); }
}));
app.post('/api/auth/sync', neonIdentity, asyncRoute(async (req, res) => {
  if (!req.neonIdentity.emailVerified) return fail(res, 403, 'Verify your email with Neon Auth before signing in.');
  let result = await pool.query(
    'SELECT u.id,u.email,u.full_name,u.photo_url,u.neon_auth_user_id,u.created_at,b.name AS business_name,b.currency,b.country,b.profile AS business_profile FROM users u LEFT JOIN businesses b ON b.owner_id=u.id AND b.is_default=true WHERE u.neon_auth_user_id=$1 LIMIT 1',
    [req.neonIdentity.id]
  );
  if (!result.rowCount) {
    result = await pool.query(
      'SELECT u.id,u.email,u.full_name,u.photo_url,u.neon_auth_user_id,u.created_at,b.name AS business_name,b.currency,b.country,b.profile AS business_profile FROM users u LEFT JOIN businesses b ON b.owner_id=u.id AND b.is_default=true WHERE u.email=$1 LIMIT 1',
      [req.neonIdentity.email]
    );
  }
  if (!result.rowCount) {
    return res.status(409).json({ ok: false, code: 'PROFILE_SETUP_REQUIRED', message: 'Your sign-in is valid. Finish setting up your Strap profile to continue.' });
  }
  if (result.rows[0].neon_auth_user_id && result.rows[0].neon_auth_user_id !== req.neonIdentity.id) return fail(res, 409, 'This email is linked to a different Strap account.');
  if (!result.rows[0].neon_auth_user_id) {
    const linked = await pool.query('UPDATE users SET neon_auth_user_id=$2,updated_at=now() WHERE id=$1 AND neon_auth_user_id IS NULL RETURNING id', [result.rows[0].id, req.neonIdentity.id]);
    if (!linked.rowCount) return fail(res, 409, 'This email is already linked to another authentication account.');
  }
  res.json({ ok: true, user: publicUser(result.rows[0]) });
}));;
app.post('/api/storefront/subdomain/check', auth, asyncRoute(async (req, res) => {
  const name = cleanText(req.body.name, 40).toLowerCase();
  const reserved = new Set(['www','app','api','admin','mail','shop','store','strap','support','demo','test','dashboard','sitemap','robots']);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/.test(name) || reserved.has(name)) return res.json({ ok: true, available: false });
  const existing = await pool.query(
    "SELECT 1 FROM account_data a WHERE a.user_id<>$2 AND a.data #>> '{onlineStore,domain,slug}'=$1 LIMIT 1",
    [name, req.user.id]
  );
  res.json({ ok: true, available: !existing.rowCount });
}));
app.post('/api/storefront/domain/verify', auth, asyncRoute(async (req, res) => {
  const host = cleanText(req.body.host, 253).toLowerCase().replace(/^https?:\/\//,'').split('/')[0];
  const token = cleanText(req.body.token, 100);
  if (!host || !token) return fail(res, 400, 'Domain and verification token are required.');
  const expected = `strap-verify=${token}`;
  try {
    const dnsUrl = new URL("https://cloudflare-dns.com/dns-query");
    dnsUrl.searchParams.set("name", `_strap-verify.${host}`);
    dnsUrl.searchParams.set("type", "TXT");
    const response = await fetch(dnsUrl, { headers: { accept: "application/dns-json" } });
    if (!response.ok) throw new Error("DNS verification lookup failed");
    const answer = await response.json();
    const verified = (answer.Answer || []).some(record => String(record.data || "").replace(/^"|"$/g, "").replace(/"\s*"/g, "") === expected);
    res.json({ ok: true, verified });
  } catch { res.json({ ok: true, verified: false }); }
}));
app.get('/api/auth/me', auth, asyncRoute(async (req, res) => res.json({ ok: true, user: publicUser(req.user) })));
app.get('/api/data', auth, asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT data FROM account_data WHERE user_id=$1', [req.user.id]);
  const data = result.rows[0]?.data || {};
  // PIN verifier material is server-only and must never be sent to the browser.
  const { security_pin: _privatePin, ...safeData } = data;
  res.json({ ok: true, data: safeData });
}));
app.put('/api/data', auth, asyncRoute(async (req, res) => {
  const data = req.body?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail(res, 400, 'A JSON object is required.');
  if (Object.prototype.hasOwnProperty.call(data, 'security_pin')) return fail(res, 400, 'Security PIN data can only be changed through the security endpoints.');
  await pool.query(
    `INSERT INTO account_data(user_id,data,updated_at) VALUES($1,$2::jsonb,now())
     ON CONFLICT(user_id) DO UPDATE SET data=account_data.data || EXCLUDED.data,updated_at=now()`,
    [req.user.id, JSON.stringify(data)]
  );
  res.json({ ok: true });
}));

const hashActivityPin = async (pin, salt, iterations = 210000) => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Secure PIN storage is not available in this runtime.');
  const key = await subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations, hash: 'SHA-256' }, key, 256);
  return Buffer.from(new Uint8Array(bits)).toString('hex');
};
const weakPins = new Set(['0000','1111','2222','3333','4444','5555','6666','7777','8888','9999','1234','4321','0123','3210','1212','2580']);
app.post('/api/security/pin', auth, asyncRoute(async (req, res) => {
  const pin = String(req.body?.pin || '');
  if (!/^\d{4}$/.test(pin) || weakPins.has(pin)) return fail(res, 400, 'Choose a less predictable 4-digit PIN.');
  const salt = crypto.randomBytes(16).toString('hex');
  const iterations = 210000;
  const hash = await hashActivityPin(pin, salt, iterations);
  const verifier = { salt, hash, iterations, failCount: 0, lockedUntil: 0, updatedAt: new Date().toISOString() };
  await pool.query(
    "INSERT INTO account_data(user_id,data,updated_at) VALUES($1,jsonb_build_object('security_pin',$2::jsonb),now()) ON CONFLICT(user_id) DO UPDATE SET data=jsonb_set(account_data.data,'{security_pin}',$2::jsonb,true),updated_at=now()",
    [req.user.id, JSON.stringify(verifier)]
  );
  res.json({ ok: true, configured: true });
}));
app.post('/api/security/pin/verify', auth, asyncRoute(async (req, res) => {
  const pin = String(req.body?.pin || '');
  if (!/^\d{4}$/.test(pin)) return fail(res, 400, 'Enter your 4-digit PIN.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query('SELECT data FROM account_data WHERE user_id=$1 FOR UPDATE', [req.user.id]);
    const verifier = row.rows[0]?.data?.security_pin;
    if (!verifier?.salt || !verifier?.hash) { await client.query('ROLLBACK'); return fail(res, 404, 'No activity PIN has been set for this workspace.'); }
    const now = Date.now();
    if (+verifier.lockedUntil > now) {
      await client.query('ROLLBACK');
      return res.status(429).json({ ok: false, code: 'PIN_LOCKED', message: 'Too many incorrect attempts. Try again in a few minutes.', retryAfter: Math.ceil((verifier.lockedUntil - now) / 1000) });
    }
    const candidate = await hashActivityPin(pin, verifier.salt, Number(verifier.iterations) || 210000);
    const a = Buffer.from(candidate, 'hex'), b = Buffer.from(verifier.hash, 'hex');
    let mismatch = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) mismatch |= (a[i] || 0) ^ (b[i] || 0);
    const valid = mismatch === 0;
    const failCount = valid ? 0 : (Number(verifier.failCount) || 0) + 1;
    const updated = { ...verifier, failCount, lockedUntil: !valid && failCount >= 5 ? now + 5 * 60 * 1000 : 0, lastCheckedAt: new Date(now).toISOString() };
    await client.query("UPDATE account_data SET data=jsonb_set(data,'{security_pin}',$2::jsonb,true),updated_at=now() WHERE user_id=$1", [req.user.id, JSON.stringify(updated)]);
    await client.query('COMMIT');
    res.json({ ok: true, valid, locked: updated.lockedUntil > now, retryAfter: updated.lockedUntil > now ? 300 : 0 });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}));

app.delete('/api/account', auth, asyncRoute(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM users WHERE id=$1', [req.user.id]);
    await client.query('COMMIT');
    res.clearCookie(COOKIE_NAME, { path: '/', ...(ENV.SESSION_COOKIE_DOMAIN ? { domain: ENV.SESSION_COOKIE_DOMAIN } : {}) });
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));
app.patch('/api/account/business', auth, asyncRoute(async (req, res) => {
  const name = cleanText(req.body.name, 140);
  if (!name) return fail(res, 400, 'Business name is required.');
  await pool.query('UPDATE businesses SET name=$2,updated_at=now() WHERE owner_id=$1 AND is_default=true', [req.user.id, name]);
  res.json({ ok: true });
}));


// Public storefront reads and order writes. The same Neon account document powers
// the owner dashboard and the externally shareable storefront.
const publicSlugOk = value => /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/.test(String(value || ''));
const htmlEscape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const xmlEscape = value => String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const storeSlug = value => String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60);
const productPathSlug = product => storeSlug(product.title || 'product') + '/' + encodeURIComponent(String(product.id || ''));
const safeStoreImage = value => {
  const url = String(value || '');
  if (/^https?:\/\/[^\s"'<>]+$/i.test(url)) return url;
  if (/^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(url) && url.length < 700000) return url;
  return '';
};
async function loadPublicStore(slug, executor = pool, lock = false) {
  if (!publicSlugOk(slug)) return null;
  const result = await executor.query(
    "SELECT a.user_id,a.data->'onlineStore' AS config,a.data->'features' AS features,b.currency " +
    "FROM account_data a JOIN businesses b ON b.owner_id=a.user_id AND b.is_default=true " +
    "WHERE a.data #>> '{onlineStore,domain,slug}'=$1 AND a.data #>> '{onlineStore,status}'='live' LIMIT 1" +
    (lock ? ' FOR UPDATE OF a' : ''),
    [slug]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0], config = row.config || {};
  if (config.domain?.type !== 'sub' || config.domain?.status !== 'live') return null;
  const features = row.features || {}, active = features.active || 'b0';
  let products = Array.isArray(features.itemsByBranch?.[active]) ? features.itemsByBranch[active] : [];
  products = products.filter(p => p && p.id && (!p.status || p.status === 'active'));
  if (config.sync === 'manual') {
    const ids = new Set(Array.isArray(config.productIds) ? config.productIds.map(String) : []);
    products = products.filter(p => ids.has(String(p.id)));
  }
  return { userId: row.user_id, config, features, products, currency: row.currency || config.currency || CURRENCY };
}
const seoDescription = value => cleanText(String(value || '').replace(/<[^>]*>/g,' ').replace(/\s+/g,' '), 300);
const productCanonical = (slug, product) => APP_URL + '/store/' + encodeURIComponent(slug) + '/products/' + encodeURIComponent(String(product.id)) + '/' + encodeURIComponent(storeSlug(product.title));
function storefrontProductCard(slug, product, currency) {
  const image = safeStoreImage(product.image);
  const imageHtml = image ? '<img src="' + htmlEscape(image) + '" alt="' + htmlEscape(product.title) + '" loading="lazy">' : '<span>' + htmlEscape(String(product.title || '?').charAt(0).toUpperCase()) + '</span>';
  const out = !!(product.tracked && !product.sellWhenOut && Number(product.qty || 0) <= 0);
  return '<article class="stf-p' + (out ? ' out' : '') + '"><a class="stf-product-open" href="/store/' + encodeURIComponent(slug) + '/products/' + encodeURIComponent(String(product.id)) + '/' + encodeURIComponent(storeSlug(product.title)) + '">' +
    '<div class="stf-img">' + imageHtml + (out ? '<i class="stf-tag dark">Sold out</i>' : '') + '</div><b>' + htmlEscape(product.title) + '</b><small>' + htmlEscape(currency) + ' ' + Math.round(Number(product.price) || 0).toLocaleString('en') + '</small></a></article>';
}
function publicStoreMarkup(config, products, slug, product) {
  const theme = config.theme || {}, font = ['Sora','Inter','DM Serif Display','Space Mono'].includes(theme.font) ? theme.font : 'Sora';
  const color = v => /^#[0-9a-f]{6}$/i.test(String(v || '')) ? v : '#ffffff';
  const accent = color(theme.accent || '#e6f53a'), background = color(theme.bg || '#ffffff'), ink = color(theme.ink || '#0a0a0a');
  const radius = Math.max(0, Math.min(32, Number(theme.radius) || 18));
  const vars = "--f:'" + font + "',sans-serif;--a:" + accent + ";--bg:" + background + ";--ink:" + ink + ";--r:" + radius + "px";
  if (product) {
    const image = safeStoreImage(product.image);
    return '<div class="stf" style="' + vars + '"><header class="stf-top"><a href="/store/' + encodeURIComponent(slug) + '">' + htmlEscape(config.name || 'Store') + '</a><a class="stf-cart" href="/store/' + encodeURIComponent(slug) + '">Shop all</a></header><main class="stf-sec"><a href="/store/' + encodeURIComponent(slug) + '">← Back to store</a><div class="stf-product-detail">' +
      (image ? '<img src="' + htmlEscape(image) + '" alt="' + htmlEscape(product.title) + '">' : '') +
      '<h1>' + htmlEscape(product.title) + '</h1><p class="stf-price">' + htmlEscape(config.currency || CURRENCY) + ' ' + Math.round(Number(product.price) || 0).toLocaleString('en') + '</p>' +
      '<p>' + htmlEscape(seoDescription(product.description)) + '</p><p>' + (product.tracked && Number(product.qty || 0) <= 0 ? 'Sold out' : 'Available') + '</p>' +
      '<p>Contact ' + htmlEscape(config.contact?.email || config.contact?.phone || config.name || 'the store') + ' to order.</p></div></main><footer class="stf-foot">' + htmlEscape(config.name || '') + '<small>Powered by Strap</small></footer></div>';
  }
  const list = products || [], sections = Array.isArray(config.sections) ? config.sections : [];
  const renderSection = section => {
    const type = section.type;
    if (type === 'announcement') return '<div class="stf-ann">' + htmlEscape(section.text || 'Welcome to our store') + '</div>';
    if (type === 'hero') return '<section class="stf-hero ' + htmlEscape(section.style || 'center') + '"><div><h1>' + htmlEscape(config.name || 'Your store') + '</h1><p>' + htmlEscape(config.tagline || 'Good things, delivered to your door.') + '</p><a class="stf-btn" href="#stf-products">' + htmlEscape(section.cta || 'Shop now') + '</a></div></section>';
    if (type === 'banner') return '<section class="stf-banner"><div><h2>' + htmlEscape(section.title || 'A little something special') + '</h2><p>' + htmlEscape(section.text || '') + '</p></div></section>';
    if (type === 'products') return '<section class="stf-sec" id="stf-products"><h2>' + htmlEscape(section.title || 'Products') + '</h2>' + (list.length ? '<div class="stf-grid ' + (section.layout === 'list' ? 'list' : '') + '">' + list.map(p => storefrontProductCard(slug,p,config.currency || CURRENCY)).join('') + '</div>' : '<p class="stf-empty">No active products are available yet.</p>') + '</section>';
    if (type === 'about') return '<section class="stf-sec"><h2>' + htmlEscape(section.title || 'About us') + '</h2><p class="stf-about">' + htmlEscape(section.text || config.tagline || (config.name + ' welcomes you.')) + '</p></section>';
    if (type === 'contact') return '<section class="stf-sec"><h2>' + htmlEscape(section.title || 'Contact') + '</h2><p class="stf-about">' + [config.contact?.email,config.contact?.phone,config.contact?.address].filter(Boolean).map(htmlEscape).join(' · ') + '</p></section>';
    if (type === 'testimonials') return '<section class="stf-sec"><h2>' + htmlEscape(section.title || 'What customers say') + '</h2><blockquote class="stf-quote">“' + htmlEscape(section.text || 'Lovely quality and service.') + '”</blockquote></section>';
    if (type === 'faq') return '<section class="stf-sec"><h2>' + htmlEscape(section.title || 'FAQs') + '</h2><details class="stf-faq"><summary>' + htmlEscape(section.question || 'How long does delivery take?') + '</summary><p>' + htmlEscape(section.answer || 'Contact the store for delivery details.') + '</p></details></section>';
    if (type === 'policies') return '<section class="stf-sec"><h2>' + htmlEscape(section.title || 'Store policies') + '</h2><p class="stf-about">' + htmlEscape(section.text || 'Contact the store for returns and delivery information.') + '</p></section>';
    if (type === 'footer') return '<footer class="stf-foot"><b>' + htmlEscape(config.name || '') + '</b><span>' + [config.contact?.email,config.contact?.phone,config.contact?.address].filter(Boolean).map(htmlEscape).join(' · ') + '</span><small>Powered by Strap</small></footer>';
    return '';
  };
  return '<div class="stf" style="' + vars + '"><header class="stf-top"><b>' + htmlEscape(config.name || 'Your store') + '</b><a class="stf-cart" href="#stf-products">Shop products</a></header>' +
    (sections.length ? sections.map(renderSection).join('') : '<section class="stf-hero"><div><h1>' + htmlEscape(config.name || 'Your store') + '</h1><p>' + htmlEscape(config.tagline || '') + '</p></div></section>') + '</div>';
}
function renderPublicStorePage(slug, config, products, product) {
  const storeName = cleanText(config.name || 'Online store', 140);
  const productTitle = product ? cleanText(product.seo?.title || product.title, 180) : storeName;
  const title = product ? productTitle + ' | ' + storeName : storeName + ' | Online store';
  const description = seoDescription(product?.seo?.description || product?.description || config.tagline || ('Shop ' + storeName + ' online. Browse products and place an order.'));
  const canonical = product ? productCanonical(slug, product) : APP_URL + '/store/' + encodeURIComponent(slug);
  const image = safeStoreImage(product?.image || products.find(p => safeStoreImage(p.image))?.image || '');
  const productLd = product ? { '@context':'https://schema.org', '@type':'Product', name:product.title, description, image:image?[image]:undefined, sku:product.sku || undefined, offers:{ '@type':'Offer', priceCurrency:config.currency || CURRENCY, price:String(Math.max(0,Number(product.price)||0)), availability:product.tracked && Number(product.qty||0)<=0 ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock', url:canonical } } : null;
  const storeLd = { '@context':'https://schema.org', '@type':'OnlineStore', name:storeName, url:APP_URL + '/store/' + encodeURIComponent(slug), description };
  const jsonld = JSON.stringify(productLd || storeLd).replace(/</g,'\\u003c');
  const context = JSON.stringify({ slug, productId:product?.id || null }).replace(/</g,'\\u003c');
  const body = publicStoreMarkup(config, products, slug, product);
  const css = '<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/products.css"><link rel="stylesheet" href="/storeshop.css">';
  const scripts = '<script src="/ui.js" defer></script><script src="/store.js" defer></script><script src="/kit.js" defer></script><script src="/storefront.js" defer></script><script src="/storeshop.js" defer></script><script src="/store-runtime.js" defer></script>';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>' + htmlEscape(title) + '</title>' +
    '<meta name="description" content="' + htmlEscape(description) + '"><link rel="canonical" href="' + htmlEscape(canonical) + '">' +
    '<meta property="og:type" content="' + (product ? 'product' : 'website') + '"><meta property="og:title" content="' + htmlEscape(title) + '"><meta property="og:description" content="' + htmlEscape(description) + '">' +
    (image ? '<meta property="og:image" content="' + htmlEscape(image) + '">' : '') +
    '<meta name="twitter:card" content="' + (image ? 'summary_large_image' : 'summary') + '"><meta name="twitter:title" content="' + htmlEscape(title) + '"><meta name="twitter:description" content="' + htmlEscape(description) + '">' +
    '<meta name="robots" content="index,follow,max-image-preview:large"><script type="application/ld+json">' + jsonld + '</script>' + css + '</head><body style="margin:0"><main id="store-root">' + body + '</main><script>window.STRAP_PUBLIC_CONTEXT=' + context + ';</script>' + scripts + '</body></html>';
}
app.get('/api/public/store/:slug', asyncRoute(async (req, res) => {
  const store = await loadPublicStore(String(req.params.slug || '').toLowerCase());
  if (!store) return fail(res, 404, 'This storefront is not available.');
  res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.json({ ok: true, store: store.config, products: store.products, currency: store.currency });
}));
app.post('/api/public/store/:slug/orders', asyncRoute(async (req, res) => {
  const slug = String(req.params.slug || '').toLowerCase();
  if (!publicSlugOk(slug)) return fail(res, 404, 'This storefront is not available.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      "SELECT a.user_id,a.data FROM account_data a WHERE a.data #>> '{onlineStore,domain,slug}'=$1 FOR UPDATE",
      [slug]
    );
    if (!result.rowCount) { await client.query('ROLLBACK'); return fail(res, 404, 'This storefront is not available.'); }
    const ownerId = result.rows[0].user_id, data = result.rows[0].data || {}, config = data.onlineStore || {};
    if (config.status !== 'live' || config.domain?.type !== 'sub' || config.domain?.status !== 'live') { await client.query('ROLLBACK'); return fail(res, 404, 'This storefront is not currently taking orders.'); }
    const features = data.features || {}, active = features.active || 'b0';
    const allProducts = Array.isArray(features.itemsByBranch?.[active]) ? features.itemsByBranch[active] : [];
    const visible = allProducts.filter(p => p && (!p.status || p.status === 'active'));
    const productMap = new Map(visible.map(p => [String(p.id), p]));
    const manualIds = new Set(Array.isArray(config.productIds) ? config.productIds.map(String) : []);
    const customer = req.body?.customer || {}, name = cleanText(customer.name, 120), phone = cleanText(customer.phone, 40), email = emailNorm(customer.email);
    if (name.length < 2 || phone.replace(/\D/g,'').length < 7 || (email && !/^[^\s@]+@[^\s@]+\\.[^\s@]{2,}$/.test(email))) { await client.query('ROLLBACK'); return fail(res, 400, 'Enter a valid name and phone number before placing your order.'); }
    const method = req.body?.method, payment = req.body?.payment;
    if (!['delivery','pickup'].includes(method) || !['cod','transfer'].includes(payment)) { await client.query('ROLLBACK'); return fail(res, 400, 'Choose a valid delivery and payment method.'); }
    const address = method === 'delivery' ? cleanText(req.body?.address, 500) : 'Pickup at store';
    if (method === 'delivery' && address.length < 5) { await client.query('ROLLBACK'); return fail(res, 400, 'Enter your delivery address.'); }
    const submitted = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!submitted.length || submitted.length > 40) { await client.query('ROLLBACK'); return fail(res, 400, 'Your cart is empty or contains too many different products.'); }
    const lines = []; let subtotal = 0;
    for (const requested of submitted) {
      const product = productMap.get(String(requested.id));
      const qty = Number(requested.qty);
      if (!product || (config.sync === 'manual' && !manualIds.has(String(product.id)))) { await client.query('ROLLBACK'); return fail(res, 409, 'A product in your cart is no longer available. Refresh the store and try again.'); }
      if (!Number.isInteger(qty) || qty < 1 || qty > 99) { await client.query('ROLLBACK'); return fail(res, 400, 'A product quantity is invalid.'); }
      if (product.tracked && !product.sellWhenOut && Number(product.qty || 0) < qty) { await client.query('ROLLBACK'); return fail(res, 409, 'There is not enough stock for ' + cleanText(product.title,100) + '. Please update your cart.'); }
      const selected = requested.options && typeof requested.options === 'object' ? requested.options : {};
      for (const group of (Array.isArray(product.options) ? product.options : [])) {
        if (!group?.name || !Array.isArray(group.values) || !group.values.length) continue;
        if (!selected[group.name] || !group.values.includes(String(selected[group.name]))) { await client.query('ROLLBACK'); return fail(res, 400, 'Choose all options for ' + cleanText(product.title,100) + '.'); }
      }
      const price = Math.max(0, Number(product.price) || 0);
      subtotal += price * qty;
      if (product.tracked) product.qty = Math.max(0, Number(product.qty || 0) - qty);
      lines.push({ id:String(product.id), title:cleanText(product.title,160), price, qty, options:selected, image:safeStoreImage(product.image) });
    }
    let discount = 0;
    const promoCode = cleanText(req.body?.promo,40).toUpperCase();
    if (promoCode) {
      const promos = Array.isArray(config.promos) ? config.promos : [{ code:'WELCOME10', type:'pct', value:10 }];
      const promo = promos.find(p => String(p.code || '').toUpperCase() === promoCode);
      if (!promo) { await client.query('ROLLBACK'); return fail(res, 400, 'That discount code is no longer valid.'); }
      const value = Math.max(0, Number(promo.value) || 0);
      discount = Math.min(subtotal, promo.type === 'pct' ? subtotal * Math.min(100,value) / 100 : value);
    }
    const shipping = config.shipping || {}, freeOver = Math.max(0, Number(shipping.freeOver) || 0);
    const delivery = method === 'delivery' && !(freeOver > 0 && subtotal - discount >= freeOver) ? Math.max(0, Number(shipping.fee) || 0) : 0;
    const total = Math.max(0, subtotal - discount + delivery);
    const storeState = data.store && typeof data.store === 'object' ? data.store : {};
    const orders = Array.isArray(storeState.orders) ? storeState.orders : [];
    const now = Date.now(), orderId = 'O-' + now.toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const tracking = 'ST-' + now.toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
    const order = {
      id:orderId, tracking, ts:now, status:'new', paid:false, paymentStatus:'unpaid', channel:'online',
      customer:{ name, phone, email }, address, note:cleanText(req.body?.note,500), method, payment,
      lines, subtotal, discount, delivery, total, currency:config.currency || CURRENCY,
      events:[{ status:'new', at:now, note:'Order received from online store' }]
    };
    data.store = { ...storeState, orders:[order,...orders].slice(0,5000), oseq:(Number(storeState.oseq)||1000)+1 };
    data.features = features;
    await client.query('UPDATE account_data SET data=$2::jsonb,updated_at=now() WHERE user_id=$1', [ownerId, JSON.stringify(data)]);
    await client.query('COMMIT');
    res.status(201).json({ ok:true, order });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}));
app.get('/robots.txt', asyncRoute(async (_req,res) => {
  res.type('text/plain').send('User-agent: *\nAllow: /store/\nDisallow: /dashboard\nDisallow: /api/\nSitemap: ' + APP_URL + '/sitemap.xml\n');
}));
app.get('/sitemap.xml', asyncRoute(async (_req,res) => {
  const result = await pool.query("SELECT data->'onlineStore' AS config,data->'features' AS features FROM account_data WHERE data->'onlineStore' IS NOT NULL");
  const urls = [];
  for (const row of result.rows) {
    const c = row.config || {}, slug = c.domain?.slug;
    if (c.status !== 'live' || c.domain?.type !== 'sub' || c.domain?.status !== 'live' || !publicSlugOk(slug)) continue;
    const updated = c.updatedAt || c.createdAt || new Date().toISOString();
    const base = APP_URL + '/store/' + encodeURIComponent(slug);
    urls.push('<url><loc>' + xmlEscape(base) + '</loc><lastmod>' + xmlEscape(new Date(updated).toISOString()) + '</lastmod></url>');
    const feat = row.features || {}, list = Array.isArray(feat.itemsByBranch?.[feat.active || 'b0']) ? feat.itemsByBranch[feat.active || 'b0'] : [];
    const items = c.sync === 'manual' ? list.filter(p => (c.productIds || []).includes(p.id)) : list;
    for (const p of items.filter(x => x && (!x.status || x.status === 'active')).slice(0,50000-urls.length)) {
      urls.push('<url><loc>' + xmlEscape(productCanonical(slug,p)) + '</loc><lastmod>' + xmlEscape(new Date(c.updatedAt || c.createdAt || Date.now()).toISOString()) + '</lastmod></url>');
    }
  }
  res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + urls.join('') + '</urlset>');
}));
app.get('/store/:slug/products/:productId/:productSlug', asyncRoute(async (req,res) => {
  const slug = String(req.params.slug || '').toLowerCase(), store = await loadPublicStore(slug);
  if (!store) return res.status(404).type('text/html').send('<!doctype html><title>Store not found</title><h1>Store not found</h1>');
  const product = store.products.find(p => String(p.id) === String(req.params.productId));
  if (!product) return res.status(404).type('text/html').send('<!doctype html><title>Product not found</title><h1>Product not found</h1>');
  res.set('Cache-Control','public, max-age=60, stale-while-revalidate=300').type('html').send(renderPublicStorePage(slug,store.config,store.products,product));
}));
app.get('/store/:slug', asyncRoute(async (req,res) => {
  const slug = String(req.params.slug || '').toLowerCase(), store = await loadPublicStore(slug);
  if (!store) return res.status(404).type('text/html').send('<!doctype html><title>Store not found</title><h1>Store not found</h1>');
  res.set('Cache-Control','public, max-age=60, stale-while-revalidate=300').type('html').send(renderPublicStorePage(slug,store.config,store.products,null));
}));

app.post('/api/payments/initialize', auth, (_req, res) => fail(res, 503, 'Payments are coming soon. You can use Strap’s free workspace in the meantime.'));
app.post('/api/payments/verify', auth, asyncRoute(async (req, res) => {
  const txRef = cleanText(req.body.txRef, 180);
  const local = await pool.query('SELECT * FROM payments WHERE tx_ref=$1 AND user_id=$2', [txRef, req.user.id]);
  if (!local.rowCount) return fail(res, 404, 'Payment reference not found.');
  const result = await flutterwave(`/transactions/${encodeURIComponent(req.body.transactionId || txRef)}/verify`);
  const d = result.data || {};
  const paid = d.status === 'successful' && d.tx_ref === txRef &&
    Number(d.amount) >= Number(local.rows[0].amount) && d.currency === local.rows[0].currency;
  if (!paid) {
    await pool.query("UPDATE payments SET status='failed',provider_response=$2::jsonb,updated_at=now() WHERE tx_ref=$1", [txRef, JSON.stringify(d)]);
    return fail(res, 402, 'Flutterwave could not confirm this payment.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("UPDATE payments SET status='successful',provider_transaction_id=$2,provider_response=$3::jsonb,updated_at=now() WHERE tx_ref=$1",
      [txRef, String(d.id), JSON.stringify(d)]);
    await client.query("UPDATE businesses SET plan='premium',updated_at=now() WHERE owner_id=$1 AND is_default=true", [req.user.id]);
    await client.query("INSERT INTO account_data(user_id,data) VALUES($1,'{}'::jsonb) ON CONFLICT(user_id) DO NOTHING", [req.user.id]);
    await client.query("UPDATE account_data SET data=jsonb_set(data,'{features}',COALESCE(data->'features','{}'::jsonb) || '{\"plan\":\"premium\"}'::jsonb,true),updated_at=now() WHERE user_id=$1", [req.user.id]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  res.json({ ok: true, status: 'successful' });
}));

app.post('/api/webhooks/flutterwave', asyncRoute(async (req, res) => {
  const signature = req.headers['verif-hash'];
  if (!ENV.FLW_WEBHOOK_SECRET_HASH || !safeEqual(signature || '', ENV.FLW_WEBHOOK_SECRET_HASH)) return fail(res, 401, 'Invalid webhook signature.');
  const data = req.body?.data || {};
  if (data.tx_ref) {
    const payment = await pool.query('SELECT * FROM payments WHERE tx_ref=$1', [data.tx_ref]);
    if (payment.rowCount && data.status === 'successful' && Number(data.amount) >= Number(payment.rows[0].amount) && data.currency === payment.rows[0].currency) {
      await pool.query("UPDATE payments SET status='successful',provider_transaction_id=$2,provider_response=$3::jsonb,updated_at=now() WHERE tx_ref=$1",
        [data.tx_ref, String(data.id), JSON.stringify(data)]);
      await pool.query("UPDATE businesses SET plan='premium',updated_at=now() WHERE owner_id=$1 AND is_default=true", [payment.rows[0].user_id]);
      await pool.query("INSERT INTO account_data(user_id,data) VALUES($1,'{}'::jsonb) ON CONFLICT(user_id) DO NOTHING", [payment.rows[0].user_id]);
      await pool.query("UPDATE account_data SET data=jsonb_set(data,'{features}',COALESCE(data->'features','{}'::jsonb) || '{\"plan\":\"premium\"}'::jsonb,true),updated_at=now() WHERE user_id=$1", [payment.rows[0].user_id]);
    }
  }
  res.json({ received: true });
}));

app.use((req, res, next) => {
  if (/(^|\/)(?:server\.mjs|package\.json|README\.md|\.env(?:\..*)?|\.git)(?:\/|$)/i.test(req.path) || /\.(?:sql|md)$/i.test(req.path)) return res.sendStatus(404);
  next();
});
if (ENV.STRAP_WORKERS !== 'true') {
  app.use(express.static(__dirname, { extensions: ['html'], dotfiles: 'deny' }));
  app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
}
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, message: ENV.NODE_ENV === 'production' ? 'Something went wrong. Please try again.' : err.message });
});
if (!ENV.VERCEL && ENV.STRAP_WORKERS !== 'true') app.listen(PORT, () => console.log(`Strap server listening on ${APP_URL}`));

export default app;
