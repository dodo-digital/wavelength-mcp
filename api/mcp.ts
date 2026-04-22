import type { VercelRequest, VercelResponse } from "@vercel/node";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "../src/index.js";
import { getSql, resolveUser, logCall } from "../src/db.js";

// ---------------------------------------------------------------------------
// Auth — per-user token (DB) with shared token fallback
// ---------------------------------------------------------------------------

interface AuthResult {
  authenticated: boolean;
  userId: string | null;
  token: string;
}

async function authenticate(req: VercelRequest): Promise<AuthResult> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return { authenticated: false, userId: null, token: "" };
  }

  const token = header.slice(7);

  // Try per-user token from DB
  const sql = getSql();
  if (sql) {
    try {
      const user = await resolveUser(sql, token);
      if (user) {
        return { authenticated: true, userId: user.id, token };
      }
    } catch {
      // DB unavailable — fall through to shared token
    }
  }

  // Fall back to shared token
  const sharedToken = process.env.WL_MCP_TOKEN;
  if (sharedToken && token === sharedToken) {
    return { authenticated: true, userId: null, token };
  }

  return { authenticated: false, userId: null, token };
}

// ---------------------------------------------------------------------------
// Vercel serverless handler
// ---------------------------------------------------------------------------

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
  const auth = await authenticate(req);
  if (!auth.authenticated) {
    return res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Unauthorized" },
    });
  }

  if (req.method === "POST") {
    try {
      const sql = getSql();

      const server = createServer({
        onToolCall: sql
          ? async (entry) => {
              await logCall(sql, auth.userId, entry).catch(() => {});
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
