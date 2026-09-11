// src/cli/cliArgs.mjs
/**
 * Argument parsing for the GEV CLI.
 *
 * Hand-rolled rather than pulling a dependency: the surface is a command plus a
 * handful of `--flag value` pairs, and this repo ships no runtime deps it does
 * not need. Pure and total — a malformed argv returns errors, never throws, so
 * the CLI can print usage instead of a stack trace.
 *
 * @module cli/cliArgs
 */

/** Flags that are booleans; everything else consumes the next token. */
export const BOOLEAN_FLAGS = Object.freeze([
  'help', 'json', 'headful', 'keep-frames', 'no-encode', 'quiet', 'show-first-run',
]);

/**
 * Parse argv (already sliced past node + script).
 *
 * @param {readonly string[]} argv
 * @returns {{command: string, positional: string[], flags: object, errors: string[]}}
 */
export function parseArgs(argv = []) {
  const tokens = Array.isArray(argv) ? argv.filter((t) => typeof t === 'string') : [];
  const errors = [];
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  const positional = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith('-')) {
      positional.push(token);
      continue;
    }
    // `--` ends flag parsing; everything after is positional, so a value can
    // legitimately start with a dash.
    if (token === '--') {
      positional.push(...tokens.slice(i + 1));
      break;
    }
    const [rawName, inlineValue] = splitFlag(token);
    const name = rawName.replace(/^--?/, '');
    if (!name) {
      errors.push(`unrecognised argument "${token}"`);
      continue;
    }
    if (BOOLEAN_FLAGS.includes(name)) {
      if (inlineValue !== null && !isTruthyFlagValue(inlineValue)) {
        flags[name] = false;
        continue;
      }
      flags[name] = true;
      continue;
    }
    if (inlineValue !== null) {
      flags[name] = inlineValue;
      continue;
    }
    const next = tokens[i + 1];
    if (next === undefined || (next.startsWith('--') && next.length > 2)) {
      errors.push(`--${name} needs a value`);
      continue;
    }
    flags[name] = next;
    i += 1;
  }

  return { command: positional.shift() || '', positional, flags, errors };
}

/** Split `--name=value` into parts; value is null when not inline. */
function splitFlag(token) {
  const eq = token.indexOf('=');
  return eq === -1 ? [token, null] : [token.slice(0, eq), token.slice(eq + 1)];
}

function isTruthyFlagValue(value) {
  const raw = String(value).trim().toLowerCase();
  return raw === '' || raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * Read a flag as a positive integer, falling back when absent or invalid.
 *
 * @param {object} flags
 * @param {string} name
 * @param {number} fallback
 * @returns {{value: number, error: string|null}}
 */
export function intFlag(flags, name, fallback) {
  const raw = flags?.[name];
  if (raw === undefined) return { value: fallback, error: null };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { value: fallback, error: `--${name} must be a positive whole number (got "${raw}")` };
  }
  return { value: parsed, error: null };
}

/**
 * Parse a `--args` JSON payload.
 *
 * Requires an OBJECT: tool arguments are always named, and accepting a bare
 * array or string here would push the failure into the browser where the error
 * is far less legible.
 *
 * @param {unknown} raw
 * @returns {{value: object, error: string|null}}
 */
export function jsonObjectFlag(raw) {
  if (raw === undefined) return { value: {}, error: null };
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (error) {
    return { value: {}, error: `--args is not valid JSON: ${error.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: {}, error: '--args must be a JSON object, e.g. \'{"query":"Austin"}\'' };
  }
  return { value: parsed, error: null };
}
