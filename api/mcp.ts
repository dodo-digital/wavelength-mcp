import type { VercelRequest, VercelResponse } from "@vercel/node";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "../src/index.js";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function checkAuth(req: VercelRequest): boolean {
  const token = process.env.WL_MCP_TOKEN;
  if (!token) return false;

  const header = req.headers.authorization;
  if (!header) return false;

  return header === `Bearer ${token}`;
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
  if (!checkAuth(req)) {
    return res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Unauthorized" },
    });
  }

  if (req.method === "POST") {
    try {
      const server = createServer();

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
