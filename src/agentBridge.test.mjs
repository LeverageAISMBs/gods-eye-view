// src/agentBridge.test.mjs
// The bridge is the seam an external agent drives GEV through, and everything
// crossing it must survive structuredClone. A tool that throws must arrive as
// {ok:false,error}, not as an exception thrown across the CDP boundary where
// the message is mangled and the stack is lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_BRIDGE_VERSION,
  installAgentBridge,
  toBridgeError,
  toBridgeResult,
} from './agentBridge.js';

const readyHost = () => ({
  __godsEyeView: { viewer: {}, dataManager: {}, styleManager: {} },
});

test('the bridge installs itself on the app handle', () => {
  const host = readyHost();
  const bridge = installAgentBridge({ runner: async () => ({ ok: true }), host });
  assert.equal(host.__godsEyeView.agent, bridge);
  assert.equal(bridge.version, AGENT_BRIDGE_VERSION);
  assert.equal(bridge.ready(), true);
});

test('readiness requires every collaborator a tool may touch', () => {
  const bridge = installAgentBridge({ runner: async () => ({}), host: {} });
  assert.equal(bridge.ready(), false, 'no app handle at all');

  const partial = { __godsEyeView: { viewer: {} } };
  assert.equal(installAgentBridge({ runner: async () => ({}), host: partial }).ready(), false);
});

test('a tool result passes through with the envelope, not reshaped', () => {
  const result = toBridgeResult('fly_to_location', {
    ok: true, action: 'fly_to_location', destination: 'Austin',
  });
  // The agent sees exactly what the voice model sees, plus `tool`.
  assert.deepEqual(result, {
    ok: true, tool: 'fly_to_location', action: 'fly_to_location', destination: 'Austin',
  });
});

test('a tool reporting failure keeps ok:false', () => {
  const result = toBridgeResult('track_entity', { ok: false, reason: 'Nothing matched UAL999' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'Nothing matched UAL999');
});

test('a bare or empty return still gets a well-formed envelope', () => {
  assert.deepEqual(toBridgeResult('x', undefined), { ok: true, tool: 'x', result: null });
  assert.deepEqual(toBridgeResult('x', 42), { ok: true, tool: 'x', result: 42 });
  assert.deepEqual(toBridgeResult('x', [1]), { ok: true, tool: 'x', result: [1] });
});

test('a thrown tool becomes a JSON-safe failure, never an exception', async () => {
  const bridge = installAgentBridge({
    runner: async () => { throw new Error('Unknown data layer: bogus'); },
    host: readyHost(),
  });
  const result = await bridge.execute('set_layer_visibility', { layerId: 'bogus' });
  assert.deepEqual(result, {
    ok: false, tool: 'set_layer_visibility', error: 'Unknown data layer: bogus',
  });
  // Must survive the CDP boundary.
  assert.doesNotThrow(() => structuredClone(result));
});

test('non-Error throws and empty messages still produce a usable error', async () => {
  for (const thrown of ['just a string', { weird: true }, null, new Error('')]) {
    const bridge = installAgentBridge({
      runner: async () => { throw thrown; },
      host: readyHost(),
    });
    const result = await bridge.execute('move_camera');
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0, `usable message for ${String(thrown)}`);
  }
  assert.deepEqual(toBridgeError('t', 'boom'), { ok: false, tool: 't', error: 'boom' });
});

test('a missing or hostile tool name is refused before the runner is called', async () => {
  let called = false;
  const bridge = installAgentBridge({
    runner: async () => { called = true; return {}; },
    host: readyHost(),
  });
  for (const bad of ['', '   ', null, undefined, 42, {}]) {
    const result = await bridge.execute(bad);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'No tool name given');
  }
  assert.equal(called, false);
});

test('args are normalised so a bad payload cannot reach a tool as a non-object', async () => {
  const seen = [];
  const bridge = installAgentBridge({
    runner: async (_name, args) => { seen.push(args); return { ok: true }; },
    host: readyHost(),
  });
  await bridge.execute('move_camera', null);
  await bridge.execute('move_camera', 'nope');
  await bridge.execute('move_camera');
  assert.deepEqual(seen, [{}, {}, {}]);
});

test('the tool name is trimmed before dispatch', async () => {
  const seen = [];
  const bridge = installAgentBridge({
    runner: async (name) => { seen.push(name); return { ok: true }; },
    host: readyHost(),
  });
  await bridge.execute('  fly_to_location  ');
  assert.deepEqual(seen, ['fly_to_location']);
});

test('installing without a runner fails loudly at wiring time', () => {
  assert.throws(() => installAgentBridge({ runner: null, host: {} }), TypeError);
  assert.throws(() => installAgentBridge({ host: {} }), /requires the GEV action runner/);
});
