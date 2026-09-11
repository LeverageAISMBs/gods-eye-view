// src/cli/mcpTools.mjs
/**
 * Shaping GEV's tools and results for MCP.
 *
 * The 28 GEV capabilities already carry JSON Schemas (they are handed to the
 * voice model verbatim), so MCP registration is a translation, not a second
 * definition — there is exactly one source of truth for what GEV can do, and
 * adding a tool to the voice surface adds it here for free.
 *
 * Pure module: no SDK import, no browser, no fs. What the MCP server sends on
 * the wire is decided here and unit-tested, so a malformed content block is
 * caught by `npm test` rather than by an agent getting confused mid-task.
 *
 * @module cli/mcpTools
 */

/** Prefix for the session-control tools this server adds beyond GEV's own. */
export const CONTROL_TOOL_PREFIX = 'gev_';

/**
 * Tools this server adds on top of the 28 GEV capabilities.
 *
 * An agent driving a long-lived browser needs to ask what state it is in and to
 * see the result of what it just did — neither is a GEV capability, because the
 * voice model shares a screen with the user and never had to ask.
 */
export const CONTROL_TOOLS = Object.freeze([
  Object.freeze({
    name: 'gev_session_status',
    title: 'GEV session status',
    description: 'Report whether the God\'s Eye View browser session is running, what URL it is on, '
      + 'and how many tools have been executed. Booting happens automatically on the first tool call; '
      + 'this never starts it.',
    inputSchema: Object.freeze({ type: 'object', properties: Object.freeze({}) }),
    readOnly: true,
  }),
  Object.freeze({
    name: 'gev_screenshot',
    title: 'Screenshot the globe',
    description: 'Capture what the globe looks like right now and return it as an image. '
      + 'Use this to SEE the result of a navigation or layer change — the tool results describe '
      + 'state, this shows it.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        settleMs: Object.freeze({
          type: 'integer',
          minimum: 0,
          maximum: 30000,
          description: 'Wait up to this long for terrain and tiles to finish streaming before the '
            + 'shot. Defaults to 4000. Cutting early gives a half-resolved globe.',
        }),
      }),
    }),
    readOnly: true,
  }),
]);

/**
 * Build the full MCP tool list: GEV's capabilities plus the control tools.
 *
 * @param {readonly object[]} gevTools `GEV_REALTIME_TOOLS` entries.
 * @returns {object[]} `{name, title, description, inputSchema, readOnly}`
 */
export function buildMcpToolList(gevTools = []) {
  const fromGev = (Array.isArray(gevTools) ? gevTools : [])
    .filter((tool) => tool && typeof tool.name === 'string' && tool.name.trim())
    .map((tool) => Object.freeze({
      name: tool.name.trim(),
      title: titleForTool(tool.name),
      description: String(tool.description || '').trim() || `Run the GEV ${tool.name} action.`,
      // GEV omits `parameters` for no-argument tools; MCP still wants a schema.
      inputSchema: tool.parameters && typeof tool.parameters === 'object'
        ? tool.parameters
        : { type: 'object', properties: {} },
      readOnly: false,
    }));
  return [...CONTROL_TOOLS, ...fromGev];
}

/** "fly_to_location" -> "Fly to location", for the optional MCP display title. */
export function titleForTool(name) {
  const words = String(name || '').replace(/_/g, ' ').trim();
  if (!words) return 'GEV action';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Turn a GEV bridge result into an MCP tool result.
 *
 * Both halves are sent on purpose: `structuredContent` is what a client can
 * validate and parse, and the text block is the spec's backwards-compatible
 * form — a client on the older revision, or one that ignores structured
 * content, still gets the whole result rather than an empty response.
 *
 * `isError` follows GEV's own `ok`, so a tool that legitimately reports "nothing
 * matched UAL999" surfaces as a failed call the agent can react to, not as a
 * success whose text it has to re-read.
 *
 * @param {object} result A `{ok, tool, ...}` envelope from the agent bridge.
 * @returns {{content: object[], structuredContent: object, isError: boolean}}
 */
export function toMcpToolResult(result) {
  const payload = result && typeof result === 'object' && !Array.isArray(result)
    ? result
    : { ok: false, error: 'Tool returned no result' };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: payload.ok === false,
  };
}

/**
 * An MCP image result for a captured frame.
 *
 * @param {Buffer|Uint8Array} png
 * @param {object} [context] Extra state worth returning alongside the picture.
 */
export function toMcpImageResult(png, context = {}) {
  const base64 = Buffer.from(png).toString('base64');
  return {
    content: [
      { type: 'image', data: base64, mimeType: 'image/png' },
      // The picture alone cannot be reasoned about numerically; the caption
      // carries the camera state the agent needs to decide its next move.
      { type: 'text', text: JSON.stringify({ ok: true, ...context }, null, 2) },
    ],
    structuredContent: { ok: true, ...context },
    isError: false,
  };
}

/**
 * An MCP error result that reads as a sentence, not a stack trace.
 *
 * @param {unknown} error
 * @param {string} [tool]
 */
export function toMcpErrorResult(error, tool = '') {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : 'Tool execution failed';
  const payload = {
    ok: false,
    ...(tool ? { tool } : {}),
    error: message || 'Tool execution failed',
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}
