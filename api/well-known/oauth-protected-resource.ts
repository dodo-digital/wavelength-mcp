import type { VercelRequest, VercelResponse } from "@vercel/node";

const RESOURCE_URL = "https://wavelength-mcp.vercel.app";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  console.log("[oauth-meta] protected resource metadata requested");

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");

  if (_req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (_req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  return res.status(200).json({
    resource: RESOURCE_URL,
    authorization_servers: [RESOURCE_URL],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "profile", "email"],
  });
}
