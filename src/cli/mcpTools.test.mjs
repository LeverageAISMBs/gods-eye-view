// src/cli/mcpTools.test.mjs
// What the MCP server puts on the wire is decided here, so it is asserted here
// — a malformed content block or a success-shaped failure would otherwise only
// show up as an agent quietly misreading what GEV did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTROL_TOOLS,
  buildMcpToolList,
  titleForTool,
  toMcpErrorResult,
  toMcpImageResult,
  toMcpToolResult,
} from './mcpTools.mjs';
import { GEV_REALTIME_TOOLS } from '../../vite.config.js';

test('every GEV capability is exposed, alongside the control tools', () => {
  const tools = buildMcpToolList(GEV_REALTIME_TOOLS);
  assert.equal(tools.length, GEV_REALTIME_TOOLS.length + CONTROL_TOOLS.length);
  const names = new Set(tools.map((t) => t.name));
  // One source of truth: whatever the voice model can call, an agent can call.
  for (const tool of GEV_REALTIME_TOOLS) assert.ok(names.has(tool.name), tool.name);
  assert.ok(names.has('gev_session_status'));
  assert.ok(names.has('gev_screenshot'));
});

test('the real GEV schemas carry through untouched', () => {
  const tools = buildMcpToolList(GEV_REALTIME_TOOLS);
  const fly = tools.find((t) => t.name === 'fly_to_location');
  const source = GEV_REALTIME_TOOLS.find((t) => t.name === 'fly_to_location');
  assert.equal(fly.inputSchema, source.parameters, 'the same object, not a re-description');
  assert.equal(fly.inputSchema.type, 'object');
  assert.ok(fly.description.length > 20);
});

test('a no-argument tool still gets a valid object schema', () => {
  const [tool] = buildMcpToolList([{ name: 'zoom_to_globe', description: 'Zoom out.' }])
    .filter((t) => t.name === 'zoom_to_globe');
  // MCP requires an inputSchema; GEV omits `parameters` when there are none.
  assert.deepEqual(tool.inputSchema, { type: 'object', properties: {} });
});

test('malformed tool entries are dropped rather than registered broken', () => {
  const tools = buildMcpToolList([null, {}, { name: '   ' }, 42, { name: 'good' }]);
  const gevNames = tools.filter((t) => !t.name.startsWith('gev_')).map((t) => t.name);
  assert.deepEqual(gevNames, ['good']);
  assert.deepEqual(buildMcpToolList(null).map((t) => t.name), CONTROL_TOOLS.map((t) => t.name));
});

test('titles read as English', () => {
  assert.equal(titleForTool('fly_to_location'), 'Fly to location');
  assert.equal(titleForTool('set_hud'), 'Set hud');
  assert.equal(titleForTool(''), 'GEV action');
  assert.equal(titleForTool(null), 'GEV action');
});

test('a successful result carries both structured and text form', () => {
  const result = toMcpToolResult({ ok: true, tool: 'fly_to_location', destination: 'Austin' });
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent, { ok: true, tool: 'fly_to_location', destination: 'Austin' });
  // The text block is the spec's backwards-compatible form: a client that
  // ignores structuredContent must still receive the whole result.
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test("a GEV failure is an MCP error, not a success the agent must re-read", () => {
  const result = toMcpToolResult({ ok: false, tool: 'track_entity', error: 'Nothing matched UAL999' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /UAL999/);
});

test('a missing or malformed result never produces an empty success', () => {
  for (const bad of [null, undefined, 'nope', 42, []]) {
    const result = toMcpToolResult(bad);
    assert.equal(result.isError, true, String(bad));
    assert.equal(result.structuredContent.ok, false);
  }
});

test('an image result is valid MCP image content plus readable state', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const result = toMcpImageResult(png, { altitudeM: 1800, place: 'Austin' });
  assert.equal(result.isError, false);
  assert.equal(result.content[0].type, 'image');
  assert.equal(result.content[0].mimeType, 'image/png');
  assert.equal(result.content[0].data, png.toString('base64'));
  // A picture cannot be reasoned about numerically; the state travels with it.
  assert.deepEqual(JSON.parse(result.content[1].text), { ok: true, altitudeM: 1800, place: 'Austin' });
});

test('errors arrive as a sentence, whatever was thrown', () => {
  assert.match(toMcpErrorResult(new Error('boom'), 'x').content[0].text, /boom/);
  assert.equal(toMcpErrorResult('plain string').structuredContent.error, 'plain string');
  for (const weird of [null, undefined, {}, new Error('')]) {
    const result = toMcpErrorResult(weird);
    assert.equal(result.isError, true);
    assert.ok(result.structuredContent.error.length > 0);
  }
});
