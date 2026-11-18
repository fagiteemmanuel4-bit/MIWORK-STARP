import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import nodemailer from 'nodemailer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});
const required = ['DATABASE_URL', 'APP_URL', 'SESSION_SECRET', 'FLW_SECRET_KEY'];
for (const key of required) if (!process.env[key] || process.env[key].includes('replace_me')) {
  console.warn(`[config] ${key} is not configured; related requests will fail until .env is completed.`);
}
const PORT = Number(process.env.PORT || 3000);
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'strap_session';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 14);
const CURRENCY = process.env.DEFAULT_CURRENCY || 'NGN';
const CODE_TTL_MIN = Number(process.env.EMAIL_CODE_TTL_MINUTES || 10);
const CODE_PEPPER = process.env.CODE_PEPPER || process.env.SESSION_SECRET || 'change-this';
const SESSION_SECRET = process.env.SESSION_SECRET || 'development-only-change-this';
const FLW_SECRET = process.env.FLW_SECRET_KEY || '';
const FLW_BASE = 'https://api.flutterwave.com/v3';

app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }));

const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');
const emailNorm = value => String(value || '').trim().toLowerCase();
const safeEqual = (a, b) => {
  const aa = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
};
const cleanText = (v, max = 160) => String(v ?? '').trim().slice(0, max);
const fail = (res, status, message) => res.status(status).json({ ok: false, message });
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

let mailer;
function getMailer() {
  if (mailer) return mailer;
  if (process.env.RESEND_API_KEY) return null;
  if (process.env.SMTP_HOST) {
    mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || 'false') === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
    return mailer;
  }
  return null;
}
async function sendEmail(to, subject, html, textBody) {
  const from = process.env.EMAIL_FROM || 'Strap <no-reply@example.com>';
  if (process.env.RESEND_API_KEY) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html, text: textBody })
    });
    if (!response.ok) throw new Error(`Email provider rejected the message (${response.status}).`);
    return;
  }
  const transport = getMailer();
  if (!transport) throw new Error('Email is not configured. Add RESEND_API_KEY or SMTP settings to .env.');
  await transport.sendMail({ from, to, subject, html, text: textBody });
}
async function issueCode(email, purpose, length = 6) {
  const code = crypto.randomInt(0, 10 ** length).toString().padStart(length, '0');
  await pool.query(
    `INSERT INTO email_verifications(email, purpose, code_hash, expires_at)
     VALUES ($1,$2,$3,now() + ($4::text || ' minutes')::interval)`,
    [email, purpose, hash(`${CODE_PEPPER}:${email}:${purpose}:${code}`), String(CODE_TTL_MIN)]
  );
  await sendEmail(email, purpose === 'signup' ? 'Verify your Strap account' : 'Your Strap security code',
    `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#111"><h2>Strap verification</h2><p>Use this code to continue. It expires in ${CODE_TTL_MIN} minutes.</p><p style="font-size:30px;letter-spacing:8px;font-weight:700">${code}</p><p>If you did not request this, you can ignore this email.</p></div>`,
    `Your Strap verification code is ${code}. It expires in ${CODE_TTL_MIN} minutes.`);
}
async function verifyCode(email, purpose, code) {
  const result = await pool.query(
    `SELECT id, code_hash FROM email_verifications
     WHERE email=$1 AND purpose=$2 AND consumed_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`,
    [email, purpose]
  );
  const row = result.rows[0];
  if (!row || !safeEqual(row.code_hash, hash(`${CODE_PEPPER}:${email}:${purpose}:${code}`))) return false;
  await pool.query('UPDATE email_verifications SET consumed_at=now(), verified_at=now() WHERE id=$1', [row.id]);
  return true;
}
async function createSession(userId, res) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await pool.query('INSERT INTO sessions(user_id, token_hash, expires_at) VALUES($1,$2,$3)', [userId, hash(token), expires]);
  res.cookie(COOKIE_NAME, token, {
    ...(process.env.SESSION_COOKIE_DOMAIN ? { domain: process.env.SESSION_COOKIE_DOMAIN } : {}),
    httpOnly: true, secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax', path: '/', expires
  });
}
async function auth(req, res, next) {
  try {
    const token = req.cookies[COOKIE_NAME];
    if (!token) return fail(res, 401, 'Please sign in.');
    const result = await pool.query(
      `SELECT u.id,u.email,u.full_name,u.photo_url,u.created_at,
              b.id AS business_id,b.name AS business_name,b.currency,b.country,b.plan
       FROM sessions s JOIN users u ON u.id=s.user_id
       LEFT JOIN businesses b ON b.owner_id=u.id AND b.is_default=true
       WHERE s.token_hash=$1 AND s.expires_at > now() AND u.disabled_at IS NULL LIMIT 1`,
      [hash(token)]
    );
    if (!result.rowCount) return fail(res, 401, 'Your session has expired. Please sign in again.');
    req.user = result.rows[0];
    next();
  } catch (e) { next(e); }
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

app.get('/api/config', (_req, res) => res.json({ ok: true, storeBaseDomain: process.env.STORE_BASE_DOMAIN || '' }));
app.get('/api/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, database: 'connected' });
}));

app.post('/api/auth/verification/send', asyncRoute(async (req, res) => {
  const email = emailNorm(req.body.email);
  const purpose = ['signup', 'reset', 'verify'].includes(req.body.purpose) ? req.body.purpose : 'verify';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'Enter a valid email address.');
  if (purpose === 'signup') {
    const exists = await pool.query('SELECT 1 FROM users WHERE email=$1', [email]);
    if (exists.rowCount) return fail(res, 409, 'An account already exists with this email.');
  }
  await issueCode(email, purpose, purpose === 'signup' ? 8 : 6);
  res.json({ ok: true });
}));
app.post('/api/auth/verification/verify', asyncRoute(async (req, res) => {
  const email = emailNorm(req.body.email), purpose = ['signup', 'reset', 'verify'].includes(req.body.purpose) ? req.body.purpose : 'verify';
  const code = cleanText(req.body.code, 8);
  if (!email || !code) return fail(res, 400, 'Enter the verification code.');
  const ok = await verifyCode(email, purpose, code);
  res.json({ ok });
}));
app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const email = emailNorm(req.body.email), password = String(req.body.password || '');
  const name = cleanText(req.body.name, 120), bizname = cleanText(req.body.bizname, 140);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'A valid email is required.');
  if (password.length < 10) return fail(res, 400, 'Use a password with at least 10 characters.');
  if (!name || !bizname) return fail(res, 400, 'Your name and business name are required.');
  const existingUser = await pool.query('SELECT id,password_hash,full_name,photo_url FROM users WHERE email=$1', [email]);
  if (existingUser.rowCount) {
    const existing = existingUser.rows[0];
    if (!(await bcrypt.compare(password, existing.password_hash))) return fail(res, 409, 'An account already exists with this email. Please sign in.');
    await createSession(existing.id, res);
    const b = await pool.query('SELECT name,currency,country FROM businesses WHERE owner_id=$1 AND is_default=true LIMIT 1', [existing.id]);
    return res.json({ ok: true, user: publicUser({ ...existing, business_name: b.rows[0]?.name, currency: b.rows[0]?.currency, country: b.rows[0]?.country }) });
  }
  const verified = await pool.query(
    `SELECT 1 FROM email_verifications WHERE email=$1 AND purpose='signup' AND verified_at > now() - interval '20 minutes' ORDER BY verified_at DESC LIMIT 1`, [email]
  );
  if (!verified.rowCount) return fail(res, 400, 'Verify your email address before creating an account.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const passwordHash = await bcrypt.hash(password, 12);
    const userResult = await client.query(
      'INSERT INTO users(email,password_hash,full_name,photo_url) VALUES($1,$2,$3,$4) RETURNING id,email,full_name,photo_url,created_at',
      [email, passwordHash, name, req.body.photoUrl || null]
    );
    const user = userResult.rows[0];
    const profile = {};
    for (const key of ['dob','country','registered','regno','mode','branches','bcountry','state','city','street','landmark','postcode','hasSite','site','wantSite','currency']) {
      if (req.body[key] !== undefined) profile[key] = req.body[key];
    }
    await client.query(
      `INSERT INTO businesses(owner_id,name,currency,country,plan,is_default,profile)
       VALUES($1,$2,$3,$4,'free',true,$5::jsonb)`,
      [user.id, bizname, cleanText(req.body.currency || CURRENCY, 8), cleanText(req.body.bcountry || req.body.country, 80),
       JSON.stringify(profile)]
    );
    await client.query('INSERT INTO account_data(user_id,data) VALUES($1,$2::jsonb)', [user.id, JSON.stringify({})]);
    await client.query('COMMIT');
    await createSession(user.id, res);
    res.status(201).json({ ok: true, user: { ...user, business_name: bizname, currency: req.body.currency || CURRENCY } });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return fail(res, 409, 'An account already exists with this email.');
    throw e;
  } finally { client.release(); }
}));
app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const email = emailNorm(req.body.email), password = String(req.body.password || '');
  const result = await pool.query('SELECT id,email,password_hash,full_name,photo_url FROM users WHERE email=$1 AND disabled_at IS NULL', [email]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return fail(res, 401, 'Email or password is incorrect.');
  await createSession(user.id, res);
  const b = await pool.query('SELECT name,currency,country FROM businesses WHERE owner_id=$1 AND is_default=true LIMIT 1', [user.id]);
  res.json({ ok: true, user: publicUser({ ...user, business_name: b.rows[0]?.name, currency: b.rows[0]?.currency, country: b.rows[0]?.country }) });
}));
app.post('/api/auth/password/reset', asyncRoute(async (req, res) => {
  const email = emailNorm(req.body.email), password = String(req.body.password || '');
  if (password.length < 10) return fail(res, 400, 'Use a password with at least 10 characters.');
  const verified = await pool.query(
    `SELECT 1 FROM email_verifications WHERE email=$1 AND purpose='reset' AND verified_at > now() - interval '20 minutes' ORDER BY verified_at DESC LIMIT 1`, [email]
  );
  if (!verified.rowCount) return fail(res, 400, 'Verify the reset code first.');
  const result = await pool.query('UPDATE users SET password_hash=$2,updated_at=now() WHERE email=$1 RETURNING id', [email, await bcrypt.hash(password, 12)]);
  if (!result.rowCount) return fail(res, 404, 'No account was found for that email.');
  await pool.query('DELETE FROM sessions WHERE user_id=$1', [result.rows[0].id]);
  res.clearCookie(COOKIE_NAME, { path: '/', ...(process.env.SESSION_COOKIE_DOMAIN ? { domain: process.env.SESSION_COOKIE_DOMAIN } : {}) });
  res.json({ ok: true });
}));
app.post('/api/auth/password/change', auth, asyncRoute(async (req, res) => {
  const current = String(req.body.current || ''), next = String(req.body.next || '');
  const result = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (!result.rowCount || !(await bcrypt.compare(current, result.rows[0].password_hash))) return fail(res, 400, 'Your current password is incorrect.');
  if (next.length < 10) return fail(res, 400, 'Use a password with at least 10 characters.');
  await pool.query('UPDATE users SET password_hash=$2 WHERE id=$1', [req.user.id, await bcrypt.hash(next, 12)]);
  res.json({ ok: true });
}));
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
    const records = await resolveTxt(`_strap-verify.${host}`);
    const verified = records.some(parts => parts.join('') === expected);
    res.json({ ok: true, verified });
  } catch { res.json({ ok: true, verified: false }); }
}));
app.get('/api/auth/me', auth, asyncRoute(async (req, res) => res.json({ ok: true, user: publicUser(req.user) })));
app.post('/api/auth/logout', auth, asyncRoute(async (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  await pool.query('DELETE FROM sessions WHERE token_hash=$1', [hash(token)]);
  res.clearCookie(COOKIE_NAME, { path: '/', ...(process.env.SESSION_COOKIE_DOMAIN ? { domain: process.env.SESSION_COOKIE_DOMAIN } : {}) });
  res.json({ ok: true });
}));

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
    res.clearCookie(COOKIE_NAME, { path: '/', ...(process.env.SESSION_COOKIE_DOMAIN ? { domain: process.env.SESSION_COOKIE_DOMAIN } : {}) });
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

app.post('/api/payments/initialize', auth, asyncRoute(async (req, res) => {
  if (!FLW_SECRET) return fail(res, 503, 'Flutterwave is not configured. Add FLW_SECRET_KEY to .env.');
  const amount = Number(req.body.amount);
  const currency = cleanText(req.body.currency || req.user.currency || CURRENCY, 8);
  if (!Number.isFinite(amount) || amount <= 0) return fail(res, 400, 'Invalid payment amount.');
  const txRef = `STRAP-${req.user.id}-${crypto.randomUUID()}`;
  await pool.query(
    `INSERT INTO payments(user_id,tx_ref,amount,currency,status,purpose) VALUES($1,$2,$3,$4,'pending','subscription')`,
    [req.user.id, txRef, amount, currency]
  );
  const result = await flutterwave('/payments', {
    tx_ref: txRef, amount, currency, redirect_url: `${APP_URL}/dashboard.html?payment=verify`,
    customer: { email: req.user.email, name: req.user.full_name },
    ...(process.env.FLW_PAYMENT_PLAN_ID ? { payment_plan: Number(process.env.FLW_PAYMENT_PLAN_ID) } : {}),
    customizations: { title: process.env.FLW_BUSINESS_NAME || 'Strap', description: 'Strap subscription' },
    meta: { user_id: req.user.id, purpose: 'subscription' }
  });
  if (!result.data?.link) throw new Error('Flutterwave did not return a checkout link.');
  res.json({ ok: true, checkoutUrl: result.data.link, txRef });
}));
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
  if (!process.env.FLW_WEBHOOK_SECRET_HASH || !safeEqual(signature || '', process.env.FLW_WEBHOOK_SECRET_HASH)) return fail(res, 401, 'Invalid webhook signature.');
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
app.use(express.static(__dirname, { extensions: ['html'], dotfiles: 'deny' }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, message: process.env.NODE_ENV === 'production' ? 'Something went wrong. Please try again.' : err.message });
});
app.listen(PORT, () => console.log(`Strap server listening on ${APP_URL}`));
