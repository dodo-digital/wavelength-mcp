import type { VercelRequest, VercelResponse } from "@vercel/node";
import { toNodeHandler } from "better-auth/node";
import { auth } from "../src/auth.js";

// Disable Vercel body parsing — Better Auth needs the raw stream
export const config = { api: { bodyParser: false } };

const handler = toNodeHandler(auth);

const ALLOWED_ORIGIN = "https://wavelength-mcp.vercel.app";

export default async function (req: VercelRequest, res: VercelResponse) {
  console.log("[auth]", req.method, req.url);

  // CORS — restrict to own origin. MCP clients make direct HTTP requests
  // (not browser-based), so they don't need CORS headers.
  const origin = req.headers.origin;
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );
  }

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // Better Auth handler expects standard Node req/res
  return handler(req, res);
}
