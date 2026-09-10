// src/ai/providerFetch.test.mjs
// Every provider call in the app goes through requestProvider, so its retry
// policy is the difference between a dev server that survives a 503 and one
// that hammers a rate limit. The tests inject fetch, the clock, and the RNG so
// the policy is asserted exactly, with no real network and no real waiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAiProvider } from './providers.mjs';
import {
  AiProviderError,
  DEFAULT_MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  backoffDelayMs,
  clearVoiceCatalogCache,
  completeText,
  extractCompletionText,
  fetchVoiceCatalog,
  mintRealtimeSecret,
  requestProvider,
} from './providerFetch.mjs';

const OPENROUTER = resolveAiProvider('openrouter', { OPENROUTER_API_KEY: 'sk-or-test' });
const OPENAI = resolveAiProvider('openai', { OPENAI_API_KEY: 'sk-openai-test' });

/** Minimal Response stand-in: only what requestProvider actually reads. */
function jsonResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** A fetch that replays a queue of responses (or throws queued errors). */
function scriptedFetch(steps) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  };
  impl.calls = calls;
  return impl;
}

/** Records backoff waits without spending real time. */
function recordingDelay() {
  const waits = [];
  const delay = async (ms) => { waits.push(ms); };
  delay.waits = waits;
  return delay;
}

test('an unconfigured provider fails before any network call is made', async () => {
  const fetchImpl = scriptedFetch([jsonResponse(200, {})]);
  await assert.rejects(
    () => requestProvider({ provider: resolveAiProvider('openrouter', {}), path: '/models', fetchImpl }),
    (error) => {
      assert.ok(error instanceof AiProviderError);
      assert.equal(error.code, 'PROVIDER_NOT_CONFIGURED');
      assert.match(error.message, /OPENROUTER_API_KEY/);
      return true;
    }
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('the request carries auth and hits the provider base URL', async () => {
  const fetchImpl = scriptedFetch([jsonResponse(200, { data: [] })]);
  await requestProvider({ provider: OPENROUTER, path: '/models', fetchImpl });
  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'https://openrouter.ai/api/v1/models');
  assert.equal(call.init.headers.Authorization, 'Bearer sk-or-test');
  assert.equal(call.init.headers['X-Title'], "God's Eye View");
});

test('a 503 is retried with backoff up to the attempt limit, then reported', async () => {
  const fetchImpl = scriptedFetch([jsonResponse(503, { error: { message: 'upstream busy' } })]);
  const delay = recordingDelay();
  await assert.rejects(
    () => requestProvider({ provider: OPENROUTER, path: '/models', fetchImpl, delay, random: () => 1 }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_HTTP_ERROR');
      assert.equal(error.status, 503);
      assert.equal(error.message, 'upstream busy', 'the provider message survives');
      return true;
    }
  );
  assert.equal(fetchImpl.calls.length, DEFAULT_MAX_ATTEMPTS);
  // One wait per failed attempt except the last — and never a zero-wait retry.
  assert.equal(delay.waits.length, DEFAULT_MAX_ATTEMPTS - 1);
  assert.deepEqual(delay.waits, [400, 800]);
});

test('a 401 is permanent: one attempt, no retry, no backoff', async () => {
  const fetchImpl = scriptedFetch([jsonResponse(401, { error: { message: 'invalid key' } })]);
  const delay = recordingDelay();
  await assert.rejects(
    () => requestProvider({ provider: OPENROUTER, path: '/models', fetchImpl, delay }),
    (error) => error.status === 401 && error.retryable === false
  );
  assert.equal(fetchImpl.calls.length, 1, 'retrying a bad key just burns the rate limit');
  assert.equal(delay.waits.length, 0);
});

test('a 429 is retried and a later success is returned', async () => {
  const fetchImpl = scriptedFetch([
    jsonResponse(429, { error: { message: 'slow down' } }),
    jsonResponse(200, { data: [{ id: 'x' }] }),
  ]);
  const result = await requestProvider({
    provider: OPENROUTER, path: '/models', fetchImpl, delay: recordingDelay(),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { data: [{ id: 'x' }] });
  assert.equal(fetchImpl.calls.length, 2);
});

test('a socket failure is transient and surfaces as a typed network error', async () => {
  const fetchImpl = scriptedFetch([new Error('ECONNRESET')]);
  await assert.rejects(
    () => requestProvider({ provider: OPENROUTER, path: '/models', fetchImpl, delay: recordingDelay() }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_NETWORK_ERROR');
      assert.equal(error.retryable, true);
      return true;
    }
  );
  assert.equal(fetchImpl.calls.length, DEFAULT_MAX_ATTEMPTS);
});

test('an aborted attempt is reported as a timeout, not a mystery failure', async () => {
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  await assert.rejects(
    () => requestProvider({
      provider: OPENROUTER, path: '/models', fetchImpl: scriptedFetch([abort]),
      delay: recordingDelay(), timeoutMs: 50,
    }),
    (error) => error.code === 'PROVIDER_TIMEOUT' && /50ms/.test(error.message)
  );
});

test('a non-JSON error body still produces a readable message', async () => {
  await assert.rejects(
    () => requestProvider({
      provider: OPENROUTER, path: '/models',
      fetchImpl: scriptedFetch([jsonResponse(400, '<html>gateway</html>')]),
      delay: recordingDelay(),
    }),
    (error) => error.message === 'OpenRouter request failed (HTTP 400)'
  );
});

test('backoff is exponential, jittered, and capped', () => {
  assert.equal(backoffDelayMs(1, 400, () => 1), 400);
  assert.equal(backoffDelayMs(3, 400, () => 1), 1600);
  assert.equal(backoffDelayMs(1, 400, () => 0), 0);
  assert.equal(backoffDelayMs(20, 400, () => 1), MAX_BACKOFF_MS);
  const jittered = backoffDelayMs(4, 400, () => 0.5);
  assert.ok(jittered > 0 && jittered < 3200, `jitter stays inside the ceiling: ${jittered}`);
});

test('a typed error serialises without leaking the key', () => {
  const error = new AiProviderError('nope', { code: 'PROVIDER_HTTP_ERROR', providerId: 'openrouter', status: 402 });
  assert.deepEqual(error.toJSON(), {
    error: 'nope', code: 'PROVIDER_HTTP_ERROR', provider: 'openrouter', status: 402,
  });
});

test('the voice catalog is fetched, normalised, and cached per provider', async (t) => {
  t.after(clearVoiceCatalogCache);
  clearVoiceCatalogCache();
  const fetchImpl = scriptedFetch([jsonResponse(200, {
    data: [
      {
        id: 'openai/gpt-audio',
        architecture: { input_modalities: ['text', 'audio'], output_modalities: ['text', 'audio'] },
        pricing: { audio: '0.000032', audio_output: '0.000064' },
      },
      { id: 'anthropic/claude', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
    ],
  })]);
  let clock = 1_000;
  const options = { provider: OPENROUTER, fetchImpl, now: () => clock };

  const first = await fetchVoiceCatalog(options);
  assert.equal(first.cached, false);
  assert.equal(first.total, 1);
  assert.equal(first.models[0].id, 'openai/gpt-audio');
  assert.equal(first.models[0].rates.audioOutput, 64);
  assert.equal(first.provider, 'openrouter');

  const second = await fetchVoiceCatalog(options);
  assert.equal(second.cached, true);
  assert.equal(fetchImpl.calls.length, 1, 'a warm catalog costs no second request');

  const refreshed = await fetchVoiceCatalog({ ...options, refresh: true });
  assert.equal(refreshed.cached, false);
  assert.equal(fetchImpl.calls.length, 2);

  clock += 10 * 60_000;
  await fetchVoiceCatalog(options);
  assert.equal(fetchImpl.calls.length, 3, 'the cache expires');
});

test('concurrent catalog requests share one upstream fetch', async (t) => {
  t.after(clearVoiceCatalogCache);
  clearVoiceCatalogCache();
  let resolveFetch;
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Promise((resolve) => { resolveFetch = () => resolve(jsonResponse(200, { data: [] })); });
  };
  const pending = [
    fetchVoiceCatalog({ provider: OPENROUTER, fetchImpl }),
    fetchVoiceCatalog({ provider: OPENROUTER, fetchImpl }),
  ];
  await new Promise((resolve) => { setImmediate(resolve); });
  resolveFetch();
  await Promise.all(pending);
  assert.equal(calls, 1);
});

test('text completion uses chat/completions on OpenRouter and responses on OpenAI', async () => {
  const chatFetch = scriptedFetch([jsonResponse(200, {
    model: 'openai/gpt-5-nano',
    choices: [{ message: { content: '  Austin skyline flights overhead  ' } }],
  })]);
  const chat = await completeText({
    provider: OPENROUTER, model: 'openai/gpt-5-nano',
    instructions: 'be brief', input: '{}', fetchImpl: chatFetch,
  });
  assert.equal(chat.text, 'Austin skyline flights overhead');
  assert.equal(chatFetch.calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  const chatBody = JSON.parse(chatFetch.calls[0].init.body);
  assert.deepEqual(chatBody.messages.map((m) => m.role), ['system', 'user']);

  const responsesFetch = scriptedFetch([jsonResponse(200, { output_text: 'five word summary here now' })]);
  const responses = await completeText({
    provider: OPENAI, model: 'gpt-5-nano',
    instructions: 'be brief', input: '{}', fetchImpl: responsesFetch,
  });
  assert.equal(responses.text, 'five word summary here now');
  assert.equal(responsesFetch.calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(JSON.parse(responsesFetch.calls[0].init.body).instructions, 'be brief');
});

test('completion text is read from either response shape', () => {
  assert.equal(extractCompletionText({ output_text: ' hi ' }), 'hi');
  assert.equal(
    extractCompletionText({ output: [{ content: [{ text: 'a' }, { text: 'b' }] }] }),
    'a b'
  );
  assert.equal(extractCompletionText({ choices: [{ message: { content: 'c' } }] }), 'c');
  assert.equal(
    extractCompletionText({ choices: [{ message: { content: [{ text: 'd' }] } }] }),
    'd'
  );
  for (const empty of [null, {}, { choices: [] }, { choices: [{ message: {} }] }]) {
    assert.equal(extractCompletionText(empty), '');
  }
});

test('an empty model is refused before a request is billed', async () => {
  const fetchImpl = scriptedFetch([jsonResponse(200, {})]);
  await assert.rejects(
    () => completeText({ provider: OPENROUTER, model: '   ', instructions: 'x', input: 'y', fetchImpl }),
    (error) => error.code === 'PROVIDER_NO_MODEL'
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('OpenRouter is refused the mic; OpenAI mints a secret passed through verbatim', async () => {
  await assert.rejects(
    () => mintRealtimeSecret({ provider: OPENROUTER, sessionConfig: {}, fetchImpl: scriptedFetch([]) }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_NO_REALTIME');
      assert.match(error.message, /OpenRouter cannot mint Realtime voice sessions/);
      return true;
    }
  );

  const body = '{"value":"ek_live_abc","session":{"model":"gpt-realtime-2"}}';
  const fetchImpl = scriptedFetch([jsonResponse(200, body, { 'content-type': 'application/json' })]);
  const minted = await mintRealtimeSecret({
    provider: OPENAI, sessionConfig: { session: { type: 'realtime' } }, fetchImpl,
  });
  assert.equal(minted.status, 200);
  // Verbatim: gevRealtime.js parses the raw upstream shape.
  assert.equal(minted.text, body);
  assert.equal(fetchImpl.calls[0].url, 'https://api.openai.com/v1/realtime/client_secrets');
});
