import type { VercelRequest, VercelResponse } from "@vercel/node";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { verifyAccessToken } from "better-auth/oauth2";
import { createServer } from "../src/index.js";
import { getSql, resolveUser, logCall, upsertOAuthUser, upsertSharedTokenUser } from "../src/db.js";
import { auth, authIssuerURLs, authJwksURL, mcpResourceURL } from "../src/auth.js";

// ---------------------------------------------------------------------------
// Auth — Better Auth OAuth → per-user DB token → shared token fallback
// ---------------------------------------------------------------------------

interface AuthResult {
  authenticated: boolean;
  userId: string | null;
  isAdmin: boolean;
  token: string;
}

function extractToken(req: VercelRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);

  return null;
}

async function authenticate(req: VercelRequest): Promise<AuthResult> {
  const token = extractToken(req);
  const hasBearer = !!token;

  // 1. Try Better Auth OAuth provider access-token validation
  if (token) {
    try {
      const payload = await verifyAccessToken(token, {
        jwksUrl: authJwksURL,
        verifyOptions: {
          issuer: authIssuerURLs,
        } as any,
      });

      if (typeof payload.sub === "string") {
        const audience = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
        if (audience.length > 0 && !audience.includes(mcpResourceURL)) {
          console.error("[mcp-auth] OAuth token audience mismatch:", {
            audience,
            expected: mcpResourceURL,
          });
          return { authenticated: false, userId: null, isAdmin: false, token };
        }

        const sql = getSql();
        if (!sql) {
          console.error("[mcp-auth] OAuth token valid but database is not configured");
          return { authenticated: false, userId: null, isAdmin: false, token };
        }

        try {
          const user = await upsertOAuthUser(sql, {
            id: payload.sub,
            name: typeof payload.name === "string" ? payload.name : null,
            email: typeof payload.email === "string" ? payload.email : null,
          });
          console.log("[mcp-auth]", { method: "oauth-access-token", hasBearer, userId: user.id });
          return { authenticated: true, userId: user.id, isAdmin: user.is_admin, token };
        } catch (err) {
          console.error("[mcp-auth] OAuth token DB user lookup/create failed:", err);
          return { authenticated: false, userId: null, isAdmin: false, token };
        }
      }
    } catch (err) {
      console.error("[mcp-auth] OAuth access-token validation failed:", err);
    }
  }

  // 2. Try Better Auth session/token validation
  if (token) {
    try {
      const session = await auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${token}` }),
      });
      if (session?.user?.id) {
        const sql = getSql();
        if (!sql) {
          console.error("[mcp-auth] OAuth session valid but database is not configured");
          return { authenticated: false, userId: null, isAdmin: false, token };
        }

        try {
          const user = await upsertOAuthUser(sql, session.user);
          console.log("[mcp-auth]", { method: "better-auth", hasBearer, userId: user.id });
          return { authenticated: true, userId: user.id, isAdmin: user.is_admin, token };
        } catch (err) {
          console.error("[mcp-auth] DB user lookup/create failed:", err);
          return { authenticated: false, userId: null, isAdmin: false, token };
        }
      }
    } catch (err) {
      console.error("[mcp-auth] Better Auth validation failed:", err);
    }
  }

  if (!token) {
    console.log("[mcp-auth]", { method: "none", hasBearer: false });
    return { authenticated: false, userId: null, isAdmin: false, token: "" };
  }

  // 3. Try per-user token from DB (legacy)
  const sql = getSql();
  if (sql) {
    try {
      const user = await resolveUser(sql, token);
      if (user) {
        console.log("[mcp-auth]", { method: "db-token", hasBearer, userId: user.id });
        return { authenticated: true, userId: user.id, isAdmin: user.is_admin, token };
      }
    } catch (err) {
      console.error("[mcp-auth] DB token lookup failed:", err);
    }
  }

  // 4. Fall back to shared token
  const sharedToken = process.env.WL_MCP_TOKEN;
  if (sharedToken && token === sharedToken) {
    if (!sql) {
      console.error("[mcp-auth] Shared token matched but database is not configured");
      return { authenticated: false, userId: null, isAdmin: false, token };
    }

    try {
      const user = await upsertSharedTokenUser(sql, token);
      console.log("[mcp-auth]", { method: "shared-token", hasBearer, userId: user.id });
      return { authenticated: true, userId: user.id, isAdmin: user.is_admin, token };
    } catch (err) {
      console.error("[mcp-auth] Shared token user lookup/create failed:", err);
      return { authenticated: false, userId: null, isAdmin: false, token };
    }
  }

  console.log("[mcp-auth]", { method: "rejected", hasBearer });
  return { authenticated: false, userId: null, isAdmin: false, token };
}

// ---------------------------------------------------------------------------
// Vercel serverless handler
// ---------------------------------------------------------------------------

const RESOURCE_METADATA_URL =
  "https://wavelength-mcp.vercel.app/.well-known/oauth-protected-resource";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  // CORS headers for MCP clients
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version"
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Mcp-Session-Id, Mcp-Protocol-Version"
  );

  // Preflight
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // Health check
  if (req.method === "GET") {
    return res.status(200).json({
      name: "wavelength-mcp",
      status: "ok",
      transport: "streamable-http",
    });
  }

  // Auth check on all non-GET/OPTIONS requests
  const authResult = await authenticate(req);
  if (!authResult.authenticated) {
    res.setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`
    );
    return res.status(401).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "Authorization required. Connect with OAuth to authenticate.",
      },
    });
  }

  // Rate limiting — 100 tool calls per hour per user (DB-backed)
  if (authResult.userId) {
    const sql = getSql();
    if (sql) {
      try {
        const rows = (await sql`
          SELECT count(*)::int AS cnt FROM wl_calls
          WHERE user_id = ${authResult.userId}
            AND created_at > now() - interval '1 hour'
        `) as { cnt: number }[];
        if (rows[0]?.cnt >= 100) {
          return res.status(429).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Rate limit exceeded. Max 100 tool calls per hour.",
            },
          });
        }
      } catch (err) {
        console.error("[mcp] Rate limit check failed:", err);
        // Don't block on rate limit check failure
      }
    }
  }

  if (req.method === "POST") {
    try {
      const sql = getSql();

      const server = createServer({
        userId: authResult.userId,
        isAdmin: authResult.isAdmin,
        onToolCall: sql
          ? async (entry) => {
              await logCall(sql, authResult.userId, entry).catch(() => {});
            }
          : undefined,
      });

      // Stateless: new transport per request (no session persistence needed)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      await server.connect(transport);

      // Pass pre-parsed body from Vercel
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        return res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal error",
          },
        });
      }
    }
  } else if (req.method === "DELETE") {
    // Session termination — no-op for stateless server
    return res.status(200).end();
  } else {
    return res.status(405).json({ error: "Method not allowed" });
  }
}
