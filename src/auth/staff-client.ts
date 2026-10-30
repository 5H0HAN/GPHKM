"use client";

import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";

export const staffAuthClient = createAuthClient({
  plugins: [twoFactorClient({ twoFactorPage: "/staff/sign-in/verify" })],
});
