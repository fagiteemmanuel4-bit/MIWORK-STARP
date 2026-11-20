import { createAuthClient } from "https://esm.sh/@neondatabase/auth@0.7.0-beta?bundle";

const NEON_AUTH_URL = "https://ep-old-night-bdy63bd2.neonauth.c-8.us-east-2.aws.neon.tech/neondb/auth";

try {
  const client = createAuthClient(NEON_AUTH_URL);
  async function getToken() {
    let lastError = null;
    // Return a signed JWT only; a session cookie identifier is not a Bearer token.
    try {
      if (typeof client.getJWTToken === "function") {
        const token = await client.getJWTToken();
        if (typeof token === "string" && token.trim()) return token;
      }
    } catch (error) { lastError = error; }
    try {
      if (typeof client.token === "function") {
        const result = await client.token();
        if (result?.error) throw result.error;
        const token = result?.data?.token;
        if (typeof token === "string" && token.trim()) return token;
      }
    } catch (error) { lastError ||= error; }
    try {
      const result = await client.getSession();
      if (result?.error) throw result.error;
      const token = result?.data?.session?.access_token;
      if (typeof token === "string" && token.trim()) return token;
    } catch (error) { lastError ||= error; }
    throw lastError || new Error("Neon Auth did not return a session JWT. Please sign in again.");
  }
  window.StrapNeonAuth = { client, getToken };
  window.StrapNeonAuthError = null;
  window.dispatchEvent(new Event("strap-neon-auth-ready"));
} catch (error) {
  window.StrapNeonAuthError = error;
  console.error("Strap Neon Auth could not initialize:", error);
  window.dispatchEvent(new Event("strap-neon-auth-ready"));
}
