import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { Pool } from "@neondatabase/serverless";

// Fail fast on missing Microsoft SSO config — better than silent OAuth failures
const msClientId = process.env.MICROSOFT_CLIENT_ID;
const msClientSecret = process.env.MICROSOFT_CLIENT_SECRET;
export const publicBaseURL = "https://wavelength-mcp.vercel.app";
export const authBaseURL = process.env.BETTER_AUTH_URL || publicBaseURL;
export const authRouteBaseURL = `${publicBaseURL}/api/auth`;
export const authJwksURL = `${authRouteBaseURL}/jwks`;
export const authIssuerURLs = Array.from(
  new Set([authBaseURL, authRouteBaseURL, publicBaseURL])
);
export const mcpResourceURL = `${publicBaseURL}/mcp`;
if (!msClientId || !msClientSecret) {
  throw new Error(
    "MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET must be set in environment"
  );
}

export const auth = betterAuth({
  baseURL: authBaseURL,
  secret: process.env.AUTH_SECRET,
  database: new Pool({
    connectionString: process.env.POSTGRES_URL,
  }),
  socialProviders: {
    microsoft: {
      clientId: msClientId,
      clientSecret: msClientSecret,
      tenantId: process.env.MICROSOFT_TENANT_ID || "common",
    },
  },
  plugins: [
    jwt(),
    oauthProvider({
      loginPage: "/sign-in",
      consentPage: "/consent",
      validAudiences: [
        publicBaseURL,
        mcpResourceURL,
        `${publicBaseURL}/api/auth`,
        authBaseURL,
      ],
      allowDynamicClientRegistration: true,
      // Required for MCP OAuth flow — clients aren't authenticated at registration time.
      // Risk: anyone can register OAuth clients. Mitigated by user consent step.
      allowUnauthenticatedClientRegistration: true,
      scopes: ["openid", "profile", "email", "offline_access"],
    }),
  ],
});
