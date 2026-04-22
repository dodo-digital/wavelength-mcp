import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./index.js";

// ---------------------------------------------------------------------------
// Local dev server (not used in Vercel — use `npm run dev`)
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

const WL_TOKEN = process.env.WL_MCP_TOKEN;

// Auth middleware
app.use("/mcp", (req, res, next) => {
  if (req.method === "OPTIONS" || req.method === "GET") return next();

  if (!WL_TOKEN) {
    console.warn("WL_MCP_TOKEN not set — auth disabled for local dev");
    return next();
  }

  const header = req.headers.authorization;
  if (header !== `Bearer ${WL_TOKEN}`) {
    return res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Unauthorized" },
    });
  }

  next();
});

// Health
app.get("/mcp", (_req, res) => {
  res.json({ name: "wavelength-mcp", status: "ok", transport: "streamable-http" });
});

// MCP endpoint
app.post("/mcp", async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : "Internal error",
        },
      });
    }
  }
});

// Session termination
app.delete("/mcp", (_req, res) => {
  res.status(200).end();
});

const PORT = parseInt(process.env.PORT ?? "3001", 10);
app.listen(PORT, () => {
  console.log(`Wavelength MCP server running on http://localhost:${PORT}/mcp`);
});
