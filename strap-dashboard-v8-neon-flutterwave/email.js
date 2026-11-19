import crypto from 'node:crypto';

const EMAILJS_ENDPOINT = 'https://api.emailjs.com/api/v1.0/email/send';
const MAX_WEBHOOK_AGE_MS = 5 * 60 * 1000;
let cachedJwks = { keys: [], expiresAt: 0 };

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

async function getNeonJwks(jwksUrl) {
  if (cachedJwks.keys.length && cachedJwks.expiresAt > Date.now()) return cachedJwks.keys;
  const response = await fetch(jwksUrl, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error('Unable to load Neon Auth signing keys.');
  const body = await response.json();
  if (!Array.isArray(body.keys)) throw new Error('Neon Auth signing keys are unavailable.');
  cachedJwks = { keys: body.keys, expiresAt: Date.now() + 5 * 60 * 1000 };
  return cachedJwks.keys;
}

async function verifyNeonWebhook(rawBody, headers, env) {
  const signature = headers.get('x-neon-signature') || '';
  const keyId = headers.get('x-neon-signature-kid') || '';
  const timestamp = headers.get('x-neon-timestamp') || '';
  const eventId = headers.get('x-neon-event-id') || '';
  const eventType = headers.get('x-neon-event-type') || '';

  if (!signature || !keyId || !timestamp || !eventId || !eventType) {
    throw new Error('Missing Neon webhook signature headers.');
  }

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > MAX_WEBHOOK_AGE_MS) {
    throw new Error('Neon webhook timestamp is invalid or expired.');
  }

  const [headerB64, emptyPayload, signatureB64] = signature.split('.');
  if (!headerB64 || emptyPayload !== '' || !signatureB64) {
    throw new Error('Neon webhook signature format is invalid.');
  }

  const jwksUrl = env.NEON_AUTH_JWKS_URL ||
    (env.NEON_AUTH_BASE_URL ? `${String(env.NEON_AUTH_BASE_URL).replace(/\/$/, '')}/.well-known/jwks.json` : '');
  if (!jwksUrl) throw new Error('Neon Auth JWKS URL is not configured.');

  const keys = await getNeonJwks(jwksUrl);
  const jwk = keys.find(key => key.kid === keyId && key.kty === 'OKP' && key.crv === 'Ed25519');
  if (!jwk) throw new Error('Neon webhook signing key was not found.');

  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const payloadB64 = base64url(rawBody);
  const signaturePayloadB64 = base64url(`${timestamp}.${payloadB64}`);
  const signingInput = `${headerB64}.${signaturePayloadB64}`;
  const valid = crypto.verify(
    null,
    Buffer.from(signingInput, 'utf8'),
    publicKey,
    Buffer.from(signatureB64, 'base64url')
  );
  if (!valid) throw new Error('Neon webhook signature verification failed.');

  const payload = JSON.parse(rawBody);
  if (payload.event_id !== eventId || payload.event_type !== eventType) {
    throw new Error('Neon webhook headers do not match the event payload.');
  }
  return payload;
}

function getEmailJsConfig(env) {
  const config = {
    serviceId: env.EMAILJS_SERVICE_ID,
    templateId: env.EMAILJS_TEMPLATE_ID,
    publicKey: env.EMAILJS_PUBLIC_KEY,
    privateKey: env.EMAILJS_PRIVATE_KEY
  };
  if (Object.values(config).some(value => !value || String(value).includes('replace_me'))) {
    throw new Error('EmailJS is not fully configured.');
  }
  return config;
}

export async function handleNeonAuthEmailWebhook(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ ok: false, message: 'Method not allowed.' }, { status: 405 });
  }

  let payload;
  try {
    const rawBody = await request.text();
    payload = await verifyNeonWebhook(rawBody, request.headers, env);
  } catch (error) {
    console.warn('[neon-email] Rejected webhook:', error.message);
    return Response.json({ ok: false, message: 'Invalid authentication webhook.' }, { status: 401 });
  }

  if (payload.event_type !== 'send.otp') {
    return Response.json({ ok: true, ignored: true });
  }

  const email = String(payload.user?.email || '').trim().toLowerCase();
  const otp = String(payload.event_data?.otp_code || '');
  const otpType = String(payload.event_data?.otp_type || '');
  const allowedTypes = new Set(['email-verification', 'sign-in', 'forget-password']);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !/^\d{6}$/.test(otp) || !allowedTypes.has(otpType)) {
    return Response.json({ ok: false, message: 'The verification email payload is incomplete.' }, { status: 400 });
  }

  if (payload.event_data?.delivery_preference === 'sms') {
    return Response.json({ ok: false, message: 'SMS delivery is not enabled for Strap.' }, { status: 400 });
  }

  let config;
  try {
    config = getEmailJsConfig(env);
  } catch (error) {
    console.error('[neon-email] Configuration error:', error.message);
    return Response.json({ ok: false, message: 'Email delivery is not configured.' }, { status: 503 });
  }

  const appName = 'Strap';
  const subjects = {
    'email-verification': 'Verify your email address',
    'sign-in': 'Your Strap sign-in code',
    'forget-password': 'Reset your Strap password'
  };
  const descriptions = {
    'email-verification': 'Use this code to verify your email address and finish creating your Strap account.',
    'sign-in': 'Use this code to securely sign in to your Strap account.',
    'forget-password': 'Use this code to continue resetting your Strap password.'
  };
  const expiresAt = payload.event_data?.expires_at || '';
  const expiryLabel = expiresAt ? new Date(expiresAt).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC' : '15 minutes';

  const templateParams = {
    to_email: email,
    user_email: email,
    email,
    to_name: String(payload.user?.name || 'there').slice(0, 120),
    user_name: String(payload.user?.name || 'there').slice(0, 120),
    app_name: appName,
    otp_code: otp,
    otp,
    verification_code: otp,
    otp_type: otpType,
    subject: subjects[otpType],
    message: `${descriptions[otpType]} Your one-time code is ${otp}. It expires at ${expiryLabel}. If you did not request this, you can ignore this email.`,
    message_html: `<div style="font-family:Arial,sans-serif;color:#171717;line-height:1.6"><p>${descriptions[otpType]}</p><div style="margin:24px 0;padding:18px 22px;border-radius:12px;background:#f4f4f5;text-align:center;font-size:32px;font-weight:700;letter-spacing:8px;color:#111">${otp}</div><p>This code expires at ${expiryLabel}.</p><p style="color:#71717a;font-size:13px">If you did not request this code, you can safely ignore this email.</p></div>`,
    expires_at: expiresAt,
    expiry_time: expiryLabel,
    reply_to: 'support@strap.app'
  };

  let response;
  try {
    response = await fetch(EMAILJS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'application/json, text/plain' },
      body: JSON.stringify({
        service_id: config.serviceId,
        template_id: config.templateId,
        user_id: config.publicKey,
        accessToken: config.privateKey,
        template_params: templateParams
      }),
      signal: AbortSignal.timeout(4000)
    });
  } catch (error) {
    console.error('[neon-email] EmailJS request failed:', error.name || 'NetworkError');
    return Response.json({ ok: false, message: 'Email provider is temporarily unavailable.' }, { status: 502 });
  }

  if (!response.ok) {
    const providerMessage = (await response.text().catch(() => '')).slice(0, 300);
    console.error('[neon-email] EmailJS rejected the message:', response.status, providerMessage);
    return Response.json({ ok: false, message: 'Email provider could not deliver the verification email.' }, { status: 502 });
  }

  return Response.json({ ok: true, provider: 'EmailJS', event_id: payload.event_id });
}
