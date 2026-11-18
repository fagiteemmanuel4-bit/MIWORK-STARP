import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/cloudflare-worker.js" with { type: "cf-worker" };

export default defineConfig(({ isPreview }) => ({
  accountId: "e00174af8acd4774a87dde93f0f13b58",
  worker: {
    name: isPreview ? "strap-preview" : "strap",
    entrypoint,
    compatibilityDate: "2026-11-18",
    compatibilityFlags: ["nodejs_compat"],
    assets: {
      directory: "./public",
      binding: "ASSETS"
    },
    env: {
      HYPERDRIVE: bindings.hyperdrive({ id: "cf43f792e75c41b0adafce60f71ddc3b" }),
      SESSION_SECRET: bindings.secret(),
      NEON_AUTH_BASE_URL: bindings.secret(),
      NEON_AUTH_JWKS_URL: bindings.secret(),
      APP_URL: bindings.text(isPreview ? "https://strap-preview.workers.dev" : "https://strap.workers.dev"),
      DEFAULT_CURRENCY: bindings.text("NGN"),
      NODE_ENV: bindings.text("production"),
      TRUST_PROXY: bindings.text("1")
    }
  }
}));
