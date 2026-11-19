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
const cleanText = (v, max = 160) => String(v ?? '').trim().slice(0, max);
const fail = (res, status, message) => res.status(status).json({ ok: false, message });
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function getNeonIdentity(req) {
  const authorization = String(req.headers.authorization || '');
  const token = authorization.slice(0, 7).toLowerCase() === 'bearer ' ? authorization.slice(7).trim() : '';
  if (!token || !NEON_AUTH_JWKS_URL || !NEON_AUTH_BASE_URL) return null;
  try {
    neonJwks ||= createRemoteJWKSet(new URL(NEON_AUTH_JWKS_URL));
    const { payload } = await jwtVerify(token, neonJwks, { issuer: NEON_AUTH_BASE_URL });
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
              b.id AS business_id,b.name AS business_name,b.currency,b.country,b.plan
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
function publicUser(user) {
  return { id: user.id, email: user.email, name: user.full_name, photoUrl: user.photo_url || null,
    bizname: user.business_name || '', currency: user.currency || CURRENCY, country: user.country || '' };
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
        const b = await pool.query('SELECT name,currency,country FROM businesses WHERE owner_id=$1 AND is_default=true LIMIT 1', [user.id]);
    res.status(found.rowCount ? 200 : 201).json({ ok: true, user: publicUser({ ...user, business_name: b.rows[0]?.name, currency: b.rows[0]?.currency, country: b.rows[0]?.country }) });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return fail(res, 409, 'An account already exists with this email.');
    throw error;
  } finally { client.release(); }
}));
app.post('/api/auth/sync', neonIdentity, asyncRoute(async (req, res) => {
  if (!req.neonIdentity.emailVerified) return fail(res, 403, 'Verify your email with Neon Auth before signing in.');
  let result = await pool.query(
    'SELECT u.id,u.email,u.full_name,u.photo_url,u.neon_auth_user_id,u.created_at,b.name AS business_name,b.currency,b.country FROM users u LEFT JOIN businesses b ON b.owner_id=u.id AND b.is_default=true WHERE u.neon_auth_user_id=$1 LIMIT 1',
    [req.neonIdentity.id]
  );
  if (!result.rowCount) {
    result = await pool.query(
      'SELECT u.id,u.email,u.full_name,u.photo_url,u.neon_auth_user_id,u.created_at,b.name AS business_name,b.currency,b.country FROM users u LEFT JOIN businesses b ON b.owner_id=u.id AND b.is_default=true WHERE u.email=$1 LIMIT 1',
      [req.neonIdentity.email]
    );
  }
  if (!result.rowCount) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        'INSERT INTO users(email,password_hash,full_name,photo_url,neon_auth_user_id) VALUES($1,$2,$3,$4,$5) RETURNING id,email,full_name,photo_url,created_at',
        [req.neonIdentity.email, await bcrypt.hash(randomToken(), 12), req.neonIdentity.name, req.neonIdentity.photoUrl, req.neonIdentity.id]
      );
      const user = inserted.rows[0];
      await client.query(
        "INSERT INTO businesses(owner_id,name,currency,country,plan,is_default,profile) VALUES($1,'My Business',$2,NULL,'free',true,'{}'::jsonb)",
        [user.id, CURRENCY]
      );
      await client.query("INSERT INTO account_data(user_id,data) VALUES($1,'{}'::jsonb) ON CONFLICT(user_id) DO NOTHING", [user.id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code !== '23505') throw error;
    } finally { client.release(); }
    result = await pool.query(
      'SELECT u.id,u.email,u.full_name,u.photo_url,u.neon_auth_user_id,u.created_at,b.name AS business_name,b.currency,b.country FROM users u LEFT JOIN businesses b ON b.owner_id=u.id AND b.is_default=true WHERE u.neon_auth_user_id=$1 OR (u.email=$2 AND u.neon_auth_user_id IS NULL) LIMIT 1',
      [req.neonIdentity.id, req.neonIdentity.email]
    );
  }
  if (!result.rowCount) return fail(res, 409, 'We could not finish setting up your Strap profile. Please try again.');
  if (result.rows[0].neon_auth_user_id && result.rows[0].neon_auth_user_id !== req.neonIdentity.id) return fail(res, 409, 'This email is linked to a different Strap account.');
  if (!result.rows[0].neon_auth_user_id) {
    const linked = await pool.query('UPDATE users SET neon_auth_user_id=$2,updated_at=now() WHERE id=$1 AND neon_auth_user_id IS NULL RETURNING id', [result.rows[0].id, req.neonIdentity.id]);
    if (!linked.rowCount) return fail(res, 409, 'This email is already linked to another authentication account.');
  }
    res.json({ ok: true, user: publicUser(result.rows[0]) });
}));;
app.post('/api/storefront/subdomain/check', auth, asyncRoute(async (req, res) => {
  const name = cleanText(req.body.name, 40).toLowerCase();
  const reserved = new Set(['www','app','api','admin','mail','shop','store','strap','support','demo','test']);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/.test(name) || reserved.has(name)) return res.json({ ok: true, available: false });
  const existing = await pool.query("SELECT 1 FROM businesses WHERE lower(regexp_replace(name,'[^a-zA-Z0-9]+','-','g'))=$1", [name]);
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
  res.json({ ok: true, data: result.rows[0]?.data || {} });
}));
app.put('/api/data', auth, asyncRoute(async (req, res) => {
  const data = req.body?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail(res, 400, 'A JSON object is required.');
  await pool.query(
    `INSERT INTO account_data(user_id,data,updated_at) VALUES($1,$2::jsonb,now())
     ON CONFLICT(user_id) DO UPDATE SET data=account_data.data || EXCLUDED.data,updated_at=now()`,
    [req.user.id, JSON.stringify(data)]
  );
  res.json({ ok: true });
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
