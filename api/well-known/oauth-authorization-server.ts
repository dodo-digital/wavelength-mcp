import type { VercelRequest, VercelResponse } from "@vercel/node";

const BASE = "https://wavelength-mcp.vercel.app";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  console.log("[oauth-meta] authorization server metadata requested");

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");

  if (_req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (_req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // RFC 8414 Authorization Server Metadata
  // Endpoints map to Better Auth's OAuth Provider routes
  return res.status(200).json({
    issuer: BASE,
    authorization_endpoint: `${BASE}/api/auth/oauth2/authorize`,
    token_endpoint: `${BASE}/api/auth/oauth2/token`,
    registration_endpoint: `${BASE}/api/auth/oauth2/register`,
    scopes_supported: ["mcp", "openid", "profile", "email"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
    ],
    code_challenge_methods_supported: ["S256"],
  });
}
