// src/cli/shotList.test.mjs
// A shot list drives a real browser for minutes and writes video to disk, so
// every field is validated strictly and nothing is silently coerced: a bad
// value must fail at parse time with an actionable message, not halfway
// through a take that then looks like an app bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FPS,
  DEFAULT_SETTLE_MS,
  DEFAULT_VIEWPORT,
  MAX_FPS,
  MAX_STEPS,
  estimateDurationMs,
  recordingSteps,
  validateShotList,
  validateStep,
} from './shotList.mjs';

const KNOWN = new Set(['fly_to_location', 'set_layer_visibility', 'move_camera']);
const isKnownTool = (name) => KNOWN.has(name);

test('a minimal shot list validates and fills defaults', () => {
  const { ok, shotList, errors } = validateShotList({
    name: 'austin',
    steps: [{ tool: 'fly_to_location', args: { query: 'Austin' } }],
  }, { isKnownTool });
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
  assert.equal(shotList.name, 'austin');
  assert.deepEqual(shotList.viewport, DEFAULT_VIEWPORT);
  assert.equal(shotList.capture.fps, DEFAULT_FPS);
  assert.equal(shotList.steps[0].settleMs, DEFAULT_SETTLE_MS);
  assert.equal(shotList.steps[0].record, false, 'setup moves are not footage by default');
});

test('a bare array is accepted as the steps', () => {
  const { ok, shotList } = validateShotList(
    [{ tool: 'fly_to_location' }],
    { isKnownTool }
  );
  assert.equal(ok, true);
  assert.equal(shotList.steps.length, 1);
});

test('an unknown tool is refused by name', () => {
  const { ok, errors } = validateShotList({ steps: [{ tool: 'fly_to_mars' }] }, { isKnownTool });
  assert.equal(ok, false);
  assert.deepEqual(errors, ['step 1: unknown tool "fly_to_mars"']);
});

test('a step does one thing: tool or hold, never both or neither', () => {
  assert.match(
    validateStep({ tool: 'fly_to_location', hold: 100 }, 0, isKnownTool).errors[0],
    /both "tool" and "hold"/
  );
  assert.match(validateStep({}, 0, isKnownTool).errors[0], /needs either "tool" or "hold"/);
  assert.equal(validateStep({ hold: 2000 }, 0, isKnownTool).errors.length, 0);
});

test('recording without a length is refused rather than capturing nothing', () => {
  const { errors } = validateStep({ tool: 'move_camera', record: true }, 2, isKnownTool);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^step 3: "record" needs "durationMs"/);
  // A hold supplies the window on its own.
  assert.equal(validateStep({ hold: 3000, record: true }, 0, isKnownTool).errors.length, 0);
});

test('a hold supplies its own capture duration', () => {
  const { step } = validateStep({ hold: 3000, record: true }, 0, isKnownTool);
  assert.equal(step.durationMs, 3000);
});

test('numeric fields reject anything that is not a whole positive number', () => {
  for (const bad of ['3000', 3000.5, -1, 0, NaN, Infinity, true, null, {}]) {
    const { errors } = validateStep({ hold: bad }, 0, isKnownTool);
    assert.equal(errors.length > 0, true, `hold: ${String(bad)}`);
  }
  // settleMs may legitimately be zero — an immediate cut.
  assert.equal(validateStep({ tool: 'move_camera', settleMs: 0 }, 0, isKnownTool).step.settleMs, 0);
});

test('args must be an object, not a string of JSON', () => {
  assert.match(
    validateStep({ tool: 'fly_to_location', args: '{"query":"Austin"}' }, 0, isKnownTool).errors[0],
    /"args" must be an object/
  );
  assert.match(
    validateStep({ tool: 'fly_to_location', args: ['Austin'] }, 0, isKnownTool).errors[0],
    /"args" must be an object/
  );
});

test('viewport and fps are bounded so a typo cannot fill the disk', () => {
  const tooBig = validateShotList({
    steps: [{ hold: 1 }],
    viewport: { width: 99999, height: 1080 },
    capture: { fps: 500 },
  }, { isKnownTool });
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.errors.length, 2);
  assert.match(tooBig.errors[0], /viewport\.width/);
  assert.match(tooBig.errors[1], new RegExp(`between 1 and ${MAX_FPS}`));
});

test('every error in a list is reported at once, addressed by step number', () => {
  const { ok, errors } = validateShotList({
    steps: [{ tool: 'nope' }, { args: {} }, { tool: 'move_camera', record: true }],
  }, { isKnownTool });
  assert.equal(ok, false);
  assert.equal(errors.length, 3, 'one round of fixes, not three');
  assert.match(errors[0], /^step 1:/);
  assert.match(errors[1], /^step 2:/);
  assert.match(errors[2], /^step 3:/);
});

test('an empty or malformed list is refused, never silently empty', () => {
  for (const bad of [null, undefined, 'nope', 42, {}, { steps: [] }, { steps: 'x' }]) {
    assert.equal(validateShotList(bad, { isKnownTool }).ok, false, String(bad));
  }
  const tooMany = validateShotList(
    { steps: Array.from({ length: MAX_STEPS + 1 }, () => ({ hold: 1 })) },
    { isKnownTool }
  );
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.errors[0], new RegExp(`limit is ${MAX_STEPS}`));
});

test('duration is known before the browser launches', () => {
  const { shotList } = validateShotList({
    steps: [
      { tool: 'set_layer_visibility', args: { layerId: 'flights' }, settleMs: 500 },
      { tool: 'move_camera', record: true, durationMs: 8000, settleMs: 0 },
      { hold: 2000, settleMs: 0 },
    ],
  }, { isKnownTool });
  // 500 settle + 8000 recorded + 2000 hold.
  assert.equal(estimateDurationMs(shotList), 10_500);
  assert.deepEqual(recordingSteps(shotList).map((s) => s.label), ['move_camera']);
});

test('a label falls back to something a log line can name', () => {
  const { shotList } = validateShotList({
    steps: [{ tool: 'move_camera' }, { hold: 250 }, { hold: 250, label: 'beauty pass' }],
  }, { isKnownTool });
  assert.deepEqual(shotList.steps.map((s) => s.label), ['move_camera', 'hold 250ms', 'beauty pass']);
});
