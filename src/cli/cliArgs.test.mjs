// src/cli/cliArgs.test.mjs
// The CLI is meant to be driven by an AI agent composing command lines, so
// parsing is total: a malformed argv produces an error the agent can read and
// correct, never a stack trace or a silently-wrong default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intFlag, jsonObjectFlag, parseArgs } from './cliArgs.mjs';

test('a command, its positionals, and its flags come apart cleanly', () => {
  const { command, positional, flags, errors } = parseArgs([
    'exec', 'fly_to_location', '--args', '{"query":"Austin"}', '--json',
  ]);
  assert.deepEqual(errors, []);
  assert.equal(command, 'exec');
  assert.deepEqual(positional, ['fly_to_location']);
  assert.equal(flags.args, '{"query":"Austin"}');
  assert.equal(flags.json, true);
});

test('--flag=value and --flag value are the same thing', () => {
  assert.equal(parseArgs(['run', '--out=/tmp/a']).flags.out, '/tmp/a');
  assert.equal(parseArgs(['run', '--out', '/tmp/a']).flags.out, '/tmp/a');
});

test('a value-taking flag with no value is an error, not a swallowed command', () => {
  const { errors, flags } = parseArgs(['exec', 'move_camera', '--args']);
  assert.deepEqual(errors, ['--args needs a value']);
  assert.equal(flags.args, undefined);
});

test('boolean flags never consume the next token', () => {
  const { flags, positional } = parseArgs(['run', '--headful', 'plan.json']);
  assert.equal(flags.headful, true);
  assert.deepEqual(positional, ['plan.json'], 'plan.json is the file, not the flag value');
  assert.equal(parseArgs(['run', '--headful=false']).flags.headful, false);
});

test('-- ends flag parsing so a value may start with a dash', () => {
  const { positional } = parseArgs(['exec', '--', '--not-a-flag']);
  assert.deepEqual(positional, ['--not-a-flag']);
});

test('an empty argv yields an empty command rather than throwing', () => {
  for (const bad of [[], undefined, null, 'nope', [1, 2]]) {
    const parsed = parseArgs(bad);
    assert.equal(parsed.command, '');
    assert.deepEqual(parsed.errors, []);
  }
});

test('integer flags reject anything that is not a positive whole number', () => {
  assert.deepEqual(intFlag({ fps: '30' }, 'fps', 24), { value: 30, error: null });
  assert.deepEqual(intFlag({}, 'fps', 24), { value: 24, error: null });
  for (const bad of ['0', '-1', '29.97', 'abc', '']) {
    const { value, error } = intFlag({ fps: bad }, 'fps', 24);
    assert.equal(value, 24, `falls back for ${bad}`);
    assert.match(error, /--fps must be a positive whole number/);
  }
});

test('--args must be a JSON object, and says why when it is not', () => {
  assert.deepEqual(jsonObjectFlag('{"query":"Austin"}'), { value: { query: 'Austin' }, error: null });
  assert.deepEqual(jsonObjectFlag(undefined), { value: {}, error: null });
  assert.match(jsonObjectFlag('{query:Austin}').error, /not valid JSON/);
  // A bare array or scalar would fail far less legibly inside the browser.
  assert.match(jsonObjectFlag('["Austin"]').error, /must be a JSON object/);
  assert.match(jsonObjectFlag('"Austin"').error, /must be a JSON object/);
});
