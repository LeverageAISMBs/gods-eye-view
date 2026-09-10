// src/agentBridge.js
/**
 * The in-page surface an external agent drives GEV through.
 *
 * GEV's 28 capabilities already exist as a transport-agnostic dispatcher
 * (`createGevActionRunner` in voice/gevActions.js). Voice reaches it over a
 * WebRTC data channel; this exposes the SAME runner on `window.__godsEyeView`
 * so a CLI driving the page over CDP can call it without going through — or
 * depending on — the voice controller.
 *
 * Deliberately a separate, named surface rather than reaching into
 * `window.__gevVoiceCommands.runner`: the CLI must keep working when voice is
 * unconfigured, stopped, or removed, and a documented contract is what an
 * agent can be pointed at.
 *
 * Every result is plain JSON. Anything crossing the CDP boundary must survive
 * `structuredClone`, so errors become `{ok:false,error}` rather than throwing
 * across the bridge, where the stack would be lost and the message mangled.
 *
 * @module agentBridge
 */

/** Bumped when the contract changes shape, so a CLI can refuse a stale page. */
export const AGENT_BRIDGE_VERSION = 1;

/**
 * Normalise anything a tool returned (or threw) into a JSON-safe envelope.
 *
 * @param {string} tool
 * @param {unknown} result
 * @returns {object}
 */
export function toBridgeResult(tool, result) {
  // Tools already return {ok, action, ...}; pass that through untouched so the
  // agent sees exactly what the voice model sees.
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ok: result.ok !== false, tool, ...result };
  }
  // A bare value (or undefined) still needs the envelope's shape.
  return { ok: true, tool, result: result ?? null };
}

/**
 * Normalise a thrown error into the same envelope.
 *
 * @param {string} tool
 * @param {unknown} error
 */
export function toBridgeError(tool, error) {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : 'Tool execution failed';
  return { ok: false, tool, error: message || 'Tool execution failed' };
}

/**
 * Install the agent bridge on a host object (defaults to `window`).
 *
 * @param {object} options
 * @param {(name: string, args: object, runOptions?: object) => Promise<unknown>} options.runner
 * @param {object} [options.host]  Injectable for tests; defaults to globalThis.
 * @returns {{version: number, execute: Function, ready: Function}}
 */
export function installAgentBridge({ runner, host = globalThis }) {
  if (typeof runner !== 'function') {
    throw new TypeError('installAgentBridge requires the GEV action runner');
  }

  const bridge = {
    version: AGENT_BRIDGE_VERSION,

    /** True once the app handle carries everything a tool may touch. */
    ready() {
      const gev = host.__godsEyeView;
      return Boolean(gev?.viewer && gev?.dataManager && gev?.styleManager);
    },

    /**
     * Run one GEV tool. Never throws across the bridge.
     *
     * @param {string} name
     * @param {object} [args]
     * @returns {Promise<object>} JSON-safe result envelope.
     */
    async execute(name, args = {}) {
      const tool = typeof name === 'string' ? name.trim() : '';
      if (!tool) return { ok: false, tool: '', error: 'No tool name given' };
      try {
        return toBridgeResult(tool, await runner(tool, args && typeof args === 'object' ? args : {}));
      } catch (error) {
        return toBridgeError(tool, error);
      }
    },
  };

  const gev = host.__godsEyeView;
  if (gev) gev.agent = bridge;
  return bridge;
}
