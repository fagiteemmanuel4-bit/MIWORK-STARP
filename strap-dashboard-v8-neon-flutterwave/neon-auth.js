import { createAuthClient } from "https://esm.sh/@neon/auth";

const authClient = createAuthClient("https://ep-old-night-bdy63bd2.neonauth.c-8.us-east-2.aws.neon.tech/neondb/auth");

window.StrapNeonAuth = {
  client: authClient,
  async getToken() {
    try {
      const result = await authClient.token();
      if (result?.error) return null;
      return result?.data?.token || null;
    } catch {
      return null;
    }
  }
};
