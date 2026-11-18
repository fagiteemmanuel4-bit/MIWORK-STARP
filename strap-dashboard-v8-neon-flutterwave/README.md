# Strap — Neon + Flutterwave backend

This build keeps the existing Strap UI and workflows in place while replacing browser-based account persistence and demo authentication with a Node.js API backed by Neon PostgreSQL.

## What is connected

- **Neon PostgreSQL:** users, business profiles, password hashes, server sessions, email verification records, payment records, and the account data document.
- **Authentication:** email/password registration and login, email verification codes, password reset, password change, logout, and account deletion.
- **Email delivery:** Resend or SMTP, configured in `.env`. Neon stores verification records; it does not send email.
- **Flutterwave:** hosted checkout initialization, server-side transaction verification, and a webhook endpoint. Card numbers and CVVs are never sent to this app.
- **Account data:** sales, payments, held sales, credits, collections, products, branches, preferences, PIN settings, and storefront configuration are synchronized to the signed-in user's Neon account document.
- **Browser storage:** the app no longer uses `localStorage` or `sessionStorage` for account data. Unsaved UI-only state such as a buyer preview cart remains in memory only.

The app uses the existing frontend files; no visual redesign has been made.

## 1. Configure the environment

Open `.env` and fill in the values. Do not commit this file.

### Neon

1. Create a Neon project.
2. Open **Connect** in the Neon dashboard.
3. Copy the connection string into `DATABASE_URL`.
4. Keep `DATABASE_SSL=true`.

### Email

Choose **one** delivery method:

- Resend: set `RESEND_API_KEY` and `EMAIL_FROM`. Verify the sending domain in Resend first.
- SMTP: set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `EMAIL_FROM`.

`EMAIL_FROM` must be an address/domain authorized by your email provider.

### Flutterwave

1. Open Flutterwave Dashboard → Settings → API.
2. Use the **test** secret key while testing and paste it into `FLW_SECRET_KEY`.
3. Set `FLW_WEBHOOK_SECRET_HASH` to the webhook secret hash configured in Flutterwave.
4. Set `APP_URL` to the exact public origin where this app is hosted.
5. Optional: set `FLW_PAYMENT_PLAN_ID` if you have created a recurring payment plan in Flutterwave. Without it, checkout is a one-time payment.
6. Configure the Flutterwave webhook URL as:

   `https://YOUR-APP-DOMAIN/api/webhooks/flutterwave`

Do not put Flutterwave secret keys in frontend JavaScript. The server reads them from `.env`.

### Session secrets

Replace `SESSION_SECRET` and `CODE_PEPPER` with long, random values. For example, generate two independent values using:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

Run it twice and paste one value into each variable.

## 2. Create the Neon tables

In Neon Dashboard:

1. Open your project.
2. Open **SQL Editor**.
3. Create a new SQL snippet.
4. Copy the entire contents of `database/schema.sql`.
5. Run it.

The schema is safe to run again. It creates the tables and indexes required by this backend.

Tables created:

| Table | Purpose |
|---|---|
| `users` | User identity and password hash |
| `businesses` | Business profile, currency, plan |
| `sessions` | Hashed, expiring server sessions |
| `email_verifications` | Hashed one-time email codes |
| `account_data` | Per-user JSONB documents for app modules |
| `payments` | Flutterwave transaction references and verification state |

## 3. Install and run locally

Use Node.js 20 or newer.

```bash
npm install
npm run dev
```

Open:

`http://localhost:3000`

Check backend/database connectivity:

`http://localhost:3000/api/health`

A healthy response looks like:

```json
{
  "ok": true,
  "database": "connected"
}
```

For a normal production process:

```bash
npm start
```

## 4. Deploy

This package now includes a Node/Express server, so deploy it to a Node-capable host (for example, a Node web service or VPS), not as a static-only website.

Set every `.env` value in the host's environment-variable settings. Use the same variable names. Set:

- `NODE_ENV=production`
- `APP_URL=https://your-real-domain`
- `DATABASE_URL` to the Neon connection string
- `FLW_SECRET_KEY` to the live Flutterwave secret only when ready for real charges
- Email provider credentials for your verified sender

The app serves the existing HTML, CSS, and JavaScript from the same origin as the API. This avoids needing a separate frontend API URL or cross-origin cookie setup.

## 5. Test checklist

Before switching to live credentials:

1. Visit `/api/health` and confirm Neon is connected.
2. Create a new account with an email inbox you can access.
3. Confirm the 8-digit signup code arrives and is accepted.
4. Sign out, then sign in again.
5. Add a product, refresh, and confirm it remains.
6. Create a sale, refresh, and confirm sales and dashboard totals remain.
7. Test password reset and password change.
8. Use Flutterwave test credentials to complete a checkout.
9. Confirm the payment is marked successful only after server-side verification.
10. Test the webhook endpoint using Flutterwave's webhook test tools.

## Important implementation boundaries

This is a backend foundation and first integration pass, not a claim that every existing feature is now production-complete.

- The existing buyer storefront is still a **preview**. Its place-order action is disabled so it cannot falsely claim to create a real customer order. A public storefront order API, stock reservation, delivery workflow, and customer payment flow still need to be implemented before accepting public orders.
- Product records are persisted in Neon, but uploaded product images/files do not yet have durable object storage. Configure an object-storage service (for example, S3/R2) and its upload flow before relying on product media in production.
- Flutterwave checkout is hosted and verified server-side. A recurring billing cycle is only enabled when `FLW_PAYMENT_PLAN_ID` is configured correctly in Flutterwave. Otherwise the current checkout is a one-time payment.
- Staff and branch settings are saved in the account's Neon data document, but separate staff identities, role-based access enforcement, and staff login sessions are not implemented in this pass.
- Activity PIN hashes are saved with the account data. Two-factor settings are currently account preferences and are not yet enforced as an additional login challenge.
- Credit reminder preferences are saved, but a scheduled background worker/cron job is still required to deliver reminders at due dates.
- Website marketplace import and domain provisioning require external provider integrations. The current domain verification endpoint checks the `_strap-verify` TXT record; it does not automatically provision DNS or SSL.
- Legacy browser demo data is not migrated. This build starts with an empty Neon account for each newly registered user.

## Security notes

- Passwords are hashed with bcrypt.
- Email codes are hashed before storage and expire.
- Session tokens are random, stored hashed in Neon, and sent in an HttpOnly cookie.
- Flutterwave secrets remain on the server.
- Never expose `.env`, `DATABASE_URL`, `FLW_SECRET_KEY`, `RESEND_API_KEY`, SMTP credentials, or session secrets to the browser.
- Use Flutterwave test credentials until the complete test checklist passes.

## Main files added

- `server.mjs` — API server, auth, email, Neon access, Flutterwave integration
- `api-client.js` — frontend API client
- `database/schema.sql` — Neon SQL schema
- `.env` — editable environment-variable file
- `package.json` — Node dependencies and commands
