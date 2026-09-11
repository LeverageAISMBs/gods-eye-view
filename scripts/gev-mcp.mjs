#!/usr/bin/env node
/**
 * gev-mcp — God's Eye View as an MCP server.
 *
 * Exposes GEV's 28 capabilities (plus session control) over MCP stdio, so an
 * agent drives the globe natively instead of shelling out to the CLI. All calls
 * land on ONE long-lived browser session, which is what makes a sequence like
 * "fly to Austin, turn on flights, show me" mean anything.
 *
 * Registration is a translation of `GEV_REALTIME_TOOLS`, not a second
 * definition — the voice model and the agent see exactly the same surface, and
 * a new GEV capability appears here for free.
 *
 * Uses the official SDK (`@modelcontextprotocol/server` v2) on purpose: the
 * protocol is mid-transition between the 2025 and 2026-07-28 revisions, and
 * `serveStdio` negotiates the era per connection. Hand-rolling JSON-RPC would
 * mean picking one era and being wrong for half of clients.
 *
 * Wire it into a client as:
 *   { "command": "node", "args": ["scripts/gev-mcp.mjs"] }
 *
 * IMPORTANT: stdout is the protocol stream. Every diagnostic goes to stderr —
 * a stray console.log would corrupt the JSON-RPC framing.
 */
import puppeteer from 'puppeteer';
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { GEV_REALTIME_TOOLS } from '../vite.config.js';
import { GevSession, DEFAULT_SCREENSHOT_SETTLE_MS } from '../src/cli/gevSession.mjs';
import {
  CONTROL_TOOLS,
  buildMcpToolList,
  toMcpErrorResult,
  toMcpImageResult,
  toMcpToolResult,
} from '../src/cli/mcpTools.mjs';

const VERSION = '0.1.0';
const URL = process.env.GEV_MCP_URL || process.env.GEV_CLI_URL || 'http://localhost:5173';
const HEADFUL = process.env.GEV_MCP_HEADFUL === '1';
const IDLE_TIMEOUT_MS = Number(process.env.GEV_MCP_IDLE_MS) > 0
  ? Number(process.env.GEV_MCP_IDLE_MS)
  : undefined;

/** stdout belongs to the protocol; diagnostics go to stderr. */
const log = (message) => { process.stderr.write(`[gev-mcp] ${message}\n`); };

/**
 * One session for the process. stdio serves a single connection, and an agent
 * reconnecting should find the globe where it left it rather than rebooting.
 */
const session = new GevSession({
  puppeteer,
  url: URL,
  headful: HEADFUL,
  ...(IDLE_TIMEOUT_MS ? { idleTimeoutMs: IDLE_TIMEOUT_MS } : {}),
  log,
});

const CONTROL_NAMES = new Set(CONTROL_TOOLS.map((tool) => tool.name));

/** Handle the session-control tools this server adds. */
async function runControlTool(name, args) {
  if (name === 'gev_session_status') {
    return { content: [{ type: 'text', text: JSON.stringify(session.status(), null, 2) }],
      structuredContent: session.status(), isError: false };
  }
  if (name === 'gev_screenshot') {
    const settleMs = Number.isInteger(args?.settleMs) ? args.settleMs : DEFAULT_SCREENSHOT_SETTLE_MS;
    const { png, settled } = await session.screenshot({ settleMs });
    // The camera state travels with the picture: an agent cannot measure an
    // image, but it can read where the globe is pointed.
    const view = await session.execute('get_current_view_state', {}).catch(() => null);
    return toMcpImageResult(png, {
      settled,
      bytes: png.length,
      view: view?.ok ? view : null,
    });
  }
  throw new Error(`Unhandled control tool: ${name}`);
}

function buildServer() {
  const server = new McpServer(
    { name: 'gods-eye-view', version: VERSION },
    { capabilities: { tools: {} } }
  );

  for (const tool of buildMcpToolList(GEV_REALTIME_TOOLS)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // GEV's schemas are already JSON Schema; fromJsonSchema adapts them
        // without restating 28 tools in Zod.
        inputSchema: fromJsonSchema(tool.inputSchema),
        annotations: {
          readOnlyHint: tool.readOnly,
          // Every GEV action is a view change on a local globe: repeating one
          // is safe, and none of it reaches the outside world.
          destructiveHint: false,
          idempotentHint: tool.readOnly,
          openWorldHint: false,
        },
      },
      async (args) => {
        try {
          if (CONTROL_NAMES.has(tool.name)) return await runControlTool(tool.name, args || {});
          return toMcpToolResult(await session.execute(tool.name, args || {}));
        } catch (error) {
          // A thrown handler would surface as an opaque protocol error; this
          // gives the agent the actual reason it can act on.
          log(`${tool.name} failed: ${error?.message || error}`);
          return toMcpErrorResult(error, tool.name);
        }
      }
    );
  }

  return server;
}

const handle = serveStdio(buildServer, { onerror: (error) => log(`transport: ${error.message}`) });

const shutdown = async () => {
  try { await handle.close(); } catch { /* already down */ }
  try { await session.close(); } catch { /* already down */ }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
log(`serving GEV over MCP stdio (app at ${URL})`);
