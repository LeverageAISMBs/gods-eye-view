// src/cli/driver.test.mjs
// runShotList is the sequencer: it decides what runs, what waits, and what gets
// captured. Launching Chrome for that would make it untestable, so the page and
// the capture are injected here — the browser-bound parts (launchGev, the CDP
// screencast) are exercised end to end by an actual take instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runShotList } from './driver.mjs';
import { validateShotList } from './shotList.mjs';

/** A page stand-in that records every tool call and returns scripted results. */
function fakePage(results = {}) {
  const calls = [];
  return {
    calls,
    async evaluate(fn, tool, args) {
      calls.push({ tool, args });
      const scripted = results[tool];
      if (scripted) return { ok: true, tool, ...scripted };
      return { ok: true, tool, action: tool };
    },
    // waitForSceneQuiet resolves immediately: pacing is asserted through the
    // recorded steps, not by making the test sleep for real.
    async waitForFunction() { return true; },
    async createCDPSession() { throw new Error('capture must not run without a frameDir'); },
  };
}

const plan = (steps) => validateShotList({ name: 't', steps }, { isKnownTool: () => true }).shotList;

test('every step runs in order and is reported by label', async () => {
  const page = fakePage();
  const outcome = await runShotList({
    page,
    shotList: plan([
      { tool: 'zoom_to_globe', settleMs: 0 },
      { tool: 'fly_to_location', args: { query: 'Austin' }, settleMs: 0 },
    ]),
    frameDir: null,
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(page.calls.map((c) => c.tool), ['zoom_to_globe', 'fly_to_location']);
  assert.deepEqual(page.calls[1].args, { query: 'Austin' });
  assert.deepEqual(outcome.steps.map((s) => s.label), ['zoom_to_globe', 'fly_to_location']);
  assert.equal(outcome.frames, 0);
});

test('a failing step is recorded but does not abandon the take', async () => {
  const page = fakePage({
    set_layer_visibility: { ok: false, error: 'Could not enable the requested layer' },
  });
  const outcome = await runShotList({
    page,
    shotList: plan([
      { tool: 'set_layer_visibility', args: { layerId: 'nope' }, settleMs: 0 },
      { tool: 'zoom_to_globe', settleMs: 0 },
    ]),
    frameDir: null,
  });
  // The second step still ran — one bad layer must not cost the whole shoot.
  assert.equal(page.calls.length, 2);
  assert.equal(outcome.ok, false, 'but the run reports failure overall');
  assert.deepEqual(outcome.steps.map((s) => s.ok), [false, true]);
  assert.equal(outcome.steps[0].result.error, 'Could not enable the requested layer');
});

test('a hold step waits without calling a tool', async () => {
  const page = fakePage();
  const startedAt = Date.now();
  const outcome = await runShotList({
    page,
    shotList: plan([{ hold: 60, settleMs: 0, label: 'beat' }]),
    frameDir: null,
  });
  assert.equal(page.calls.length, 0, 'a hold runs nothing');
  assert.equal(outcome.ok, true);
  assert.ok(Date.now() - startedAt >= 55, 'and it actually waits');
  assert.equal(outcome.steps[0].label, 'beat');
});

test('capture is skipped entirely when there is no frame directory', async () => {
  // createCDPSession throws in the fake; reaching it would fail this test.
  const page = fakePage();
  const outcome = await runShotList({
    page,
    shotList: plan([{ tool: 'move_camera', record: true, durationMs: 50, settleMs: 0 }]),
    frameDir: null,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.frames, 0);
});

test('progress is logged per step so a long take is followable', async () => {
  const lines = [];
  await runShotList({
    page: fakePage({ zoom_to_globe: { ok: false, error: 'cancelled' } }),
    shotList: plan([{ tool: 'zoom_to_globe', settleMs: 0 }]),
    frameDir: null,
    log: (message) => lines.push(message),
  });
  assert.match(lines[0], /^\[1\/1\] zoom_to_globe$/);
  assert.match(lines[1], /cancelled/);
});
