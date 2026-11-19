import { createServer } from "node:http";
import { httpServerHandler } from "cloudflare:node";

let appHandlerPromise;

async function getAppHandler(env) {
  if (!appHandlerPromise) {
    globalThis.STRAP_ENV = {
      ...env,
      DATABASE_URL: env.HYPERDRIVE.connectionString,
      APP_URL: env.APP_URL || "https://strap-preview.workers.dev",
      STRAP_WORKERS: "true"
    };
    appHandlerPromise = import("../server.mjs").then(({ default: app }) => {
      const server = createServer(app);
      server.listen(8787);
      return httpServerHandler({ port: 8787 });
    }).catch(error => {
      appHandlerPromise = null;
      throw error;
    });
  }
  return appHandlerPromise;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }
    try {
      const handler = await getAppHandler(env);
      return handler(request);
    } catch (error) {
      console.error("Strap Worker bootstrap failed:", error);
      return Response.json({ ok: false, message: env.STRAP_DEBUG === "true" ? String(error?.stack || error?.message || error) : "Strap is temporarily unavailable. Please try again." }, { status: 503 });
    }
  }
};
