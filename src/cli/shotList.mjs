// src/cli/shotList.mjs
/**
 * The shot list: the instruction format an agent hands the GEV CLI.
 *
 * A shot list is an ordered plan of GEV tool calls plus the waits and capture
 * windows between them — "turn on flights, fly to Austin, orbit for eight
 * seconds while recording". It is the unit an AI agent authors, a human edits,
 * and the driver replays deterministically.
 *
 * Validation is STRICT and total: it never coerces a bad field into a plausible
 * one, and it never throws. A shot list drives a browser for minutes and writes
 * video to disk; failing at parse time with "step 3: durationMs must be a
 * positive integer" costs seconds, while a silently-coerced 0 costs the whole
 * take and looks like a bug in the app.
 *
 * Pure module — no fs, no network, no puppeteer — so the same validator runs in
 * the CLI, in tests, and (later) in an MCP server.
 *
 * @module cli/shotList
 */

/** Capture defaults. 30fps at 1080p is the baseline for short-form delivery. */
export const DEFAULT_VIEWPORT = Object.freeze({ width: 1920, height: 1080 });
export const DEFAULT_FPS = 30;
/** Hard ceilings — a typo'd duration must not fill the disk or hang a machine. */
export const MAX_FPS = 60;
export const MAX_STEP_DURATION_MS = 600_000;
export const MAX_STEPS = 500;
/** How long to let the globe settle after a navigation tool, when unspecified. */
export const DEFAULT_SETTLE_MS = 1_500;

/** A finite integer within [min, max], else null. Rejects '', true, NaN, '3px'. */
function boundedInt(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value)) return null;
  return value >= min && value <= max ? value : null;
}

/** A non-empty trimmed string, else ''. */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Validate one step.
 *
 * A step is either a TOOL step (`tool`, optional `args`) or a HOLD step
 * (`hold` ms, nothing else to run) — never both, because "run this and also do
 * nothing" has no meaningful ordering.
 *
 * @param {unknown} raw
 * @param {number} index
 * @param {(name: string) => boolean} isKnownTool
 * @returns {{step: object|null, errors: string[]}}
 */
export function validateStep(raw, index, isKnownTool = () => true) {
  const at = `step ${index + 1}`;
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { step: null, errors: [`${at}: must be an object`] };
  }

  const tool = text(raw.tool);
  const hasHold = raw.hold !== undefined;
  if (tool && hasHold) {
    errors.push(`${at}: has both "tool" and "hold" — a step does one or the other`);
  }
  if (!tool && !hasHold) {
    errors.push(`${at}: needs either "tool" or "hold"`);
  }
  if (tool && !isKnownTool(tool)) {
    errors.push(`${at}: unknown tool "${tool}"`);
  }
  if (raw.args !== undefined
    && (!raw.args || typeof raw.args !== 'object' || Array.isArray(raw.args))) {
    errors.push(`${at}: "args" must be an object`);
  }

  let hold = 0;
  if (hasHold) {
    hold = boundedInt(raw.hold, 1, MAX_STEP_DURATION_MS);
    if (hold === null) {
      errors.push(`${at}: "hold" must be a whole number of ms between 1 and ${MAX_STEP_DURATION_MS}`);
      hold = 0;
    }
  }

  let settleMs = DEFAULT_SETTLE_MS;
  if (raw.settleMs !== undefined) {
    settleMs = boundedInt(raw.settleMs, 0, MAX_STEP_DURATION_MS);
    if (settleMs === null) {
      errors.push(`${at}: "settleMs" must be a whole number of ms between 0 and ${MAX_STEP_DURATION_MS}`);
      settleMs = DEFAULT_SETTLE_MS;
    }
  }

  // `record` marks the window worth keeping. Without it the driver still runs
  // the step, it just does not capture frames — setup moves are not footage.
  const record = raw.record === true;
  let durationMs = 0;
  if (raw.durationMs !== undefined) {
    durationMs = boundedInt(raw.durationMs, 1, MAX_STEP_DURATION_MS);
    if (durationMs === null) {
      errors.push(`${at}: "durationMs" must be a whole number of ms between 1 and ${MAX_STEP_DURATION_MS}`);
      durationMs = 0;
    }
  }
  if (record && !durationMs && !hold) {
    errors.push(`${at}: "record" needs "durationMs" (or a "hold") so the capture window has a length`);
  }

  if (errors.length) return { step: null, errors };
  return {
    step: Object.freeze({
      index,
      label: text(raw.label) || tool || `hold ${hold}ms`,
      tool: tool || null,
      args: Object.freeze({ ...(raw.args || {}) }),
      hold,
      settleMs,
      record,
      durationMs: durationMs || hold,
    }),
    errors: [],
  };
}

/**
 * Validate a whole shot list.
 *
 * @param {unknown} raw            Parsed JSON (an object, or a bare step array).
 * @param {object} [options]
 * @param {(name: string) => boolean} [options.isKnownTool]
 * @returns {{ok: boolean, shotList: object|null, errors: string[]}}
 */
export function validateShotList(raw, { isKnownTool = () => true } = {}) {
  const errors = [];
  // A bare array is the common hand-written case; treat it as the steps.
  const source = Array.isArray(raw) ? { steps: raw } : raw;
  if (!source || typeof source !== 'object') {
    return { ok: false, shotList: null, errors: ['shot list must be a JSON object or an array of steps'] };
  }

  const rawSteps = source.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    errors.push('shot list needs a non-empty "steps" array');
  } else if (rawSteps.length > MAX_STEPS) {
    errors.push(`shot list has ${rawSteps.length} steps; the limit is ${MAX_STEPS}`);
  }

  const steps = [];
  if (Array.isArray(rawSteps)) {
    rawSteps.slice(0, MAX_STEPS).forEach((rawStep, index) => {
      const { step, errors: stepErrors } = validateStep(rawStep, index, isKnownTool);
      if (step) steps.push(step);
      errors.push(...stepErrors);
    });
  }

  const viewport = { ...DEFAULT_VIEWPORT };
  if (source.viewport !== undefined) {
    if (!source.viewport || typeof source.viewport !== 'object') {
      errors.push('"viewport" must be an object with width and height');
    } else {
      // 3840 covers 4K masters; below 320 nothing composes.
      const width = boundedInt(source.viewport.width, 320, 3840);
      const height = boundedInt(source.viewport.height, 320, 2160);
      if (width === null) errors.push('"viewport.width" must be a whole number between 320 and 3840');
      if (height === null) errors.push('"viewport.height" must be a whole number between 320 and 2160');
      if (width !== null) viewport.width = width;
      if (height !== null) viewport.height = height;
    }
  }

  let fps = DEFAULT_FPS;
  if (source.capture !== undefined) {
    if (!source.capture || typeof source.capture !== 'object') {
      errors.push('"capture" must be an object');
    } else if (source.capture.fps !== undefined) {
      fps = boundedInt(source.capture.fps, 1, MAX_FPS);
      if (fps === null) {
        errors.push(`"capture.fps" must be a whole number between 1 and ${MAX_FPS}`);
        fps = DEFAULT_FPS;
      }
    }
  }

  if (errors.length) return { ok: false, shotList: null, errors };
  return {
    ok: true,
    errors: [],
    shotList: Object.freeze({
      name: text(source.name) || 'gev-shot',
      viewport: Object.freeze(viewport),
      capture: Object.freeze({ fps }),
      steps: Object.freeze(steps),
    }),
  };
}

/**
 * Total wall-clock a shot list will take, in ms.
 *
 * Used to warn before a long take and to size a progress readout — an agent
 * that asks for ten minutes of footage should be told so before the browser
 * launches, not after.
 *
 * @param {{steps: readonly object[]}} shotList
 */
export function estimateDurationMs(shotList) {
  return (shotList?.steps || []).reduce(
    (total, step) => total + step.hold + step.settleMs + (step.record ? step.durationMs : 0),
    0
  );
}

/** Steps that actually produce footage. */
export function recordingSteps(shotList) {
  return (shotList?.steps || []).filter((step) => step.record);
}
