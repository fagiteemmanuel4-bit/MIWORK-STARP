import { createServer } from "node:http";
import { handleAsNodeRequest } from "cloudflare:node";
import { handleNeonAuthEmailWebhook } from "../email.js";
import pg from "pg";

const { Client } = pg;

let appHandlerPromise;
let withDatabaseClient;

async function getAppHandler(env) {
  if (!appHandlerPromise) {
    globalThis.STRAP_ENV = {
      ...env,
      DATABASE_URL: env.HYPERDRIVE.connectionString,
      APP_URL: env.APP_URL || "https://strap-preview.strap-preview.workers.dev",
      STRAP_WORKERS: "true"
    };
    appHandlerPromise = import("../server.mjs").then(({ default: app, withDatabaseClient: runWithDatabaseClient }) => {
      withDatabaseClient = runWithDatabaseClient;
      const server = createServer(app);
      server.listen(8787);
      return true;
    }).catch(error => {
      appHandlerPromise = null;
      throw error;
    });
  }
  return appHandlerPromise;
}

async function checkTurnstile(request, env) {
  const token = request.headers.get("x-turnstile-token") || "";
  if (!token || token.length > 2048 || !env.TURNSTILE_SECRET) {
    return { success: false, status: 403, message: "Complete the security check before creating your workspace." };
  }
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET);
  form.set("response", token);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) form.set("remoteip", ip);
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return { success: false, status: 503, message: "Security verification is temporarily unavailable. Try again." };
    const result = await response.json();
    const expectedHost = new URL(env.APP_URL).hostname;
    if (!result.success || result.action !== "strap_signup" || result.hostname !== expectedHost) {
      return { success: false, status: 403, message: "Security check expired or invalid. Please complete it again." };
    }
    return { success: true };
  } catch {
    return { success: false, status: 503, message: "Security verification is temporarily unavailable. Try again." };
  }
}

async function applyRateLimit(binding, key) {
  if (!binding) return true;
  const result = await binding.limit({ key });
  return result.success;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    // Neon Auth OTP delivery is handled directly at the Worker edge so its
    // signed raw request body can be verified before any JSON body parsing.
    if (request.method === "POST" && url.pathname === "/api/webhooks/neon-auth") {
      try {
        if (!(await applyRateLimit(env.API_RATE_LIMITER, `neon-auth:${ip}`))) {
          return Response.json({ ok: false, message: "Too many requests. Please try again shortly." }, {
            status: 429, headers: { "Retry-After": "60" }
          });
        }
        return await handleNeonAuthEmailWebhook(request, env);
      } catch (error) {
        console.error("Strap Neon Auth email webhook failed:", error);
        return Response.json({ ok: false, message: "Email delivery is temporarily unavailable." }, { status: 503 });
      }
    }

    // Never expose application source, configuration, repository metadata or
    // deployment files through the static asset binding. Express has a matching
    // guard for local Node deployments; the Worker must enforce it before ASSETS.
    if (/(^|\/)(?:server\\.mjs|package\\.json|README\\.md|\\.env(?:\\..*)?|\\.git)(?:\/|$)/i.test(url.pathname) ||
        /\\.(?:sql|md)$/i.test(url.pathname)) {
      return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    }

    // Route the canonical dashboard URL to its actual HTML asset. This avoids
    // depending on implicit clean-URL handling for /dashboard on mobile browsers.
    if (url.pathname === "/dashboard" || url.pathname === "/dashboard/") {
      const dashboardUrl = new URL(request.url);
      dashboardUrl.pathname = "/dashboard.html";
      return env.ASSETS.fetch(new Request(dashboardUrl, request));
    }

    const dynamicPaths = url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/store/") ||
      url.pathname === "/robots.txt" ||
      url.pathname === "/sitemap.xml";
    if (!dynamicPaths) return env.ASSETS.fetch(request);

    try {
      if (!(await applyRateLimit(env.API_RATE_LIMITER, ip))) {
        return Response.json({ ok: false, message: "Too many requests. Please wait a moment and try again." }, {
          status: 429, headers: { "Retry-After": "60" }
        });
      }
      if (request.method === "POST" && url.pathname === "/api/auth/register") {
        if (!(await applyRateLimit(env.AUTH_REGISTER_LIMITER, ip))) {
          return Response.json({ ok: false, message: "Too many account setup attempts. Please wait before trying again." }, {
            status: 429, headers: { "Retry-After": "60" }
          });
        }
        const check = await checkTurnstile(request, env);
        if (!check.success) return Response.json({ ok: false, message: check.message }, { status: check.status });
      }
      if (request.method === "POST" && url.pathname === "/api/auth/sync" &&
          !(await applyRateLimit(env.AUTH_SYNC_LIMITER, ip))) {
        return Response.json({ ok: false, message: "Too many sign-in attempts. Please wait and try again." }, {
          status: 429, headers: { "Retry-After": "60" }
        });
      }
      await getAppHandler(env);

      // Create the pg client inside this Worker invocation. Hyperdrive already
      // pools origin connections; a module-global pg Pool can retain stale
      // sockets between Worker requests and intermittently hang dashboard reads.
      const dbClient = new Client({
        connectionString: env.HYPERDRIVE.connectionString,
        connectionTimeoutMillis: 8000,
        query_timeout: 12000,
        ssl: { rejectUnauthorized: false }
      });
      await dbClient.connect();
      return await withDatabaseClient(dbClient, () => handleAsNodeRequest(8787, request));
    } catch (error) {
      console.error("Strap Worker request failed:", error);
      return Response.json({ ok: false, message: env.STRAP_DEBUG === "true" ? String(error?.stack || error?.message || error) : "Strap is temporarily unavailable. Please try again." }, { status: 503 });
    }
  }
};
