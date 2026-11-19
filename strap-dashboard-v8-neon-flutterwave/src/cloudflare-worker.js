import { createServer } from "node:http";
import { handleAsNodeRequest } from "cloudflare:node";

let appHandlerPromise;

async function getAppHandler(env) {
  if (!appHandlerPromise) {
    globalThis.STRAP_ENV = {
      ...env,
      DATABASE_URL: env.HYPERDRIVE.connectionString,
      APP_URL: env.APP_URL || "https://strap-preview.strap-preview.workers.dev",
      STRAP_WORKERS: "true"
    };
    appHandlerPromise = import("../server.mjs").then(({ default: app }) => {
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
    const dynamicPaths = url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/store/") ||
      url.pathname === "/robots.txt" ||
      url.pathname === "/sitemap.xml";
    if (!dynamicPaths) return env.ASSETS.fetch(request);

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
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
      return handleAsNodeRequest(8787, request);
    } catch (error) {
      console.error("Strap Worker request failed:", error);
      return Response.json({ ok: false, message: env.STRAP_DEBUG === "true" ? String(error?.stack || error?.message || error) : "Strap is temporarily unavailable. Please try again." }, { status: 503 });
    }
  }
};
