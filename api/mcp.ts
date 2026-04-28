import type { VercelRequest, VercelResponse } from "@vercel/node";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "../src/index.js";
import { getSql, resolveUser, logCall } from "../src/db.js";
import { auth } from "../src/auth.js";

// ---------------------------------------------------------------------------
// Auth — Better Auth OAuth → per-user DB token → shared token fallback
// ---------------------------------------------------------------------------

interface AuthResult {
  authenticated: boolean;
  userId: string | null;
  token: string;
}

function extractToken(req: VercelRequest): string | null {
  // 1. Bearer header (Claude Code / .mcp.json)
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);

  // 2. Query param: /api/mcp?token=<token> (Cowork custom connector)
  const token = req.query?.token;
  if (typeof token === "string" && token.length >= 20) return token;

  return null;
}

async function authenticate(req: VercelRequest): Promise<AuthResult> {
  const token = extractToken(req);
  const hasBearer = !!token;

  // 1. Try Better Auth session/token validation
  if (token) {
    try {
      const session = await auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${token}` }),
      });
      if (session?.user?.id) {
        // Look up or create wl_users entry by auth_user_id
        const sql = getSql();
        let userId: string | null = null;
        if (sql) {
          try {
            const rows = (await sql`
              SELECT id FROM wl_users WHERE auth_user_id = ${session.user.id} LIMIT 1
            `) as { id: string }[];
            if (rows.length > 0) {
              userId = rows[0].id;
            } else {
              // Auto-create wl_users entry for new OAuth users
              const inserted = (await sql`
                INSERT INTO wl_users (name, token, auth_user_id, is_active)
                VALUES (${session.user.name || session.user.email || "oauth-user"}, ${`oauth-${session.user.id}`}, ${session.user.id}, true)
                RETURNING id
              `) as { id: string }[];
              userId = inserted[0]?.id ?? null;
            }
          } catch (err) {
            console.error("[mcp-auth] DB user lookup/create failed:", err);
          }
        }
        console.log("[mcp-auth]", { method: "better-auth", hasBearer, userId });
        return { authenticated: true, userId, token };
      }
    } catch (err) {
      console.error("[mcp-auth] Better Auth validation failed:", err);
    }
  }

  if (!token) {
    console.log("[mcp-auth]", { method: "none", hasBearer: false });
    return { authenticated: false, userId: null, token: "" };
  }

  // 2. Try per-user token from DB (legacy)
  const sql = getSql();
  if (sql) {
    try {
      const user = await resolveUser(sql, token);
      if (user) {
        console.log("[mcp-auth]", { method: "db-token", hasBearer, userId: user.id });
        return { authenticated: true, userId: user.id, token };
      }
    } catch (err) {
      console.error("[mcp-auth] DB token lookup failed:", err);
    }
  }

  // 3. Fall back to shared token
  const sharedToken = process.env.WL_MCP_TOKEN;
  if (sharedToken && token === sharedToken) {
    console.log("[mcp-auth]", { method: "shared-token", hasBearer });
    return { authenticated: true, userId: null, token };
  }

  console.log("[mcp-auth]", { method: "rejected", hasBearer });
  return { authenticated: false, userId: null, token };
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

  if (req.method === "POST") {
    try {
      const sql = getSql();

      const server = createServer({
        userId: authResult.userId,
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
            message: err instanceof Error ? err.message : "Internal error",
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
