// src/ai/providers.test.mjs
// Provider resolution is a spend boundary and a security boundary: it decides
// WHICH account a request bills and whether an arbitrary env string can become
// a base URL. Both are pinned here, along with the rule that matters most for
// upgrades — adding an OpenRouter key must never take the mic away from an
// install that already had OPENAI_API_KEY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_PROVIDER_IDS,
  DEFAULT_AI_PROVIDER,
  aiProviderDefinition,
  aiProviderHeaders,
  describeAiProvider,
  isKnownAiProvider,
  isTruthyFlag,
  SUPPORTED_REALTIME_TRANSPORTS,
  isSupportedRealtimeTransport,
  resolveAiProvider,
  resolveDefaultAiProvider,
  resolveRealtimeProvider,
  resolveUnsupportedRealtimeProvider,
} from './providers.mjs';

test('registry exposes the four adapters, OpenRouter as default', () => {
  assert.deepEqual(AI_PROVIDER_IDS, [
    'openrouter', 'openai', 'google-gemini', 'openai-compatible',
  ]);
  assert.equal(DEFAULT_AI_PROVIDER, 'openrouter');
});

test('only OpenAI-shaped realtime providers advertise the realtime capability', () => {
  assert.equal(aiProviderDefinition('openrouter').capabilities.realtime, false);
  assert.equal(aiProviderDefinition('openai').capabilities.realtime, true);
  assert.equal(aiProviderDefinition('openrouter').capabilities.audioChat, true);
});

test('a live-voice transport is declared by name, separately from what runs it', () => {
  // Gemini Live is a real API — over WSS with hand-framed PCM, not WebRTC/SDP.
  // The registry says so rather than pretending the capability is absent.
  assert.equal(aiProviderDefinition('google-gemini').realtimeTransport, 'websocket_bidi');
  assert.equal(aiProviderDefinition('openai').realtimeTransport, 'webrtc_sdp');
  assert.equal(aiProviderDefinition('openrouter').realtimeTransport, null);
  // This build ships exactly one client, so only that transport is runnable.
  assert.deepEqual(SUPPORTED_REALTIME_TRANSPORTS, ['webrtc_sdp']);
  assert.equal(isSupportedRealtimeTransport('websocket_bidi'), false);
});

test('a Gemini key serves catalog and text but is never handed the mic', () => {
  const env = { GEMINI_API_KEY: 'gem-1' };
  const provider = resolveAiProvider('google-gemini', env);
  assert.equal(provider.configured, true);
  assert.equal(provider.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(provider.capabilities.catalog, true);
  assert.equal(provider.capabilities.text, true);
  // Declared transport, no client for it -> the capability gate says no. Handing
  // this to the WebRTC dialer would produce a mic that never connects.
  assert.equal(provider.realtimeTransport, 'websocket_bidi');
  assert.equal(provider.capabilities.realtime, false);
  assert.equal(resolveRealtimeProvider(env), null);
  assert.equal(resolveDefaultAiProvider(env).id, 'google-gemini');
});

test('an unrunnable voice provider is surfaced to explain the mic, not to serve it', () => {
  const gemini = resolveUnsupportedRealtimeProvider({ GEMINI_API_KEY: 'gem-1' });
  assert.equal(gemini?.id, 'google-gemini');
  assert.equal(gemini?.realtimeTransport, 'websocket_bidi');
  // Nothing configured, or a provider that has no live-voice API at all.
  assert.equal(resolveUnsupportedRealtimeProvider({}), null);
  assert.equal(resolveUnsupportedRealtimeProvider({ OPENROUTER_API_KEY: 'or' }), null);
  // An OpenAI key runs the mic, so nothing needs explaining.
  assert.equal(resolveUnsupportedRealtimeProvider({ OPENAI_API_KEY: 'oa' }), null);
});

test('the secondary Gemini key env var is honoured', () => {
  assert.equal(resolveAiProvider('google-gemini', { GOOGLE_AI_API_KEY: 'g' }).configured, true);
  assert.equal(resolveAiProvider('google-gemini', {}).configured, false);
});

test('unknown, hostile, and inherited ids resolve to the default provider', () => {
  for (const bad of ['', '  ', 'anthropic', '__proto__', 'constructor', 'toString', null, 42, {}]) {
    assert.equal(aiProviderDefinition(bad).id, DEFAULT_AI_PROVIDER, `id: ${String(bad)}`);
    assert.equal(isKnownAiProvider(bad), false);
  }
  assert.equal(isKnownAiProvider('OpenRouter'), true, 'case and padding are tolerated');
  assert.equal(isKnownAiProvider(' openai '), true);
});

test('a provider is configured only with both a key and a base URL', () => {
  const openrouter = resolveAiProvider('openrouter', { OPENROUTER_API_KEY: 'sk-or-1' });
  assert.equal(openrouter.configured, true);
  assert.equal(openrouter.baseUrl, 'https://openrouter.ai/api/v1');

  // The generic gateway ships with no default base URL, so a key alone is not enough.
  const keyOnly = resolveAiProvider('openai-compatible', { GEV_AI_API_KEY: 'k' });
  assert.equal(keyOnly.configured, false);
  const complete = resolveAiProvider('openai-compatible', {
    GEV_AI_API_KEY: 'k',
    GEV_AI_BASE_URL: 'https://gateway.internal/v1/',
  });
  assert.equal(complete.configured, true);
  assert.equal(complete.baseUrl, 'https://gateway.internal/v1', 'trailing slash trimmed');
});

test('a non-http base URL is rejected rather than handed to fetch', () => {
  for (const bad of ['file:///etc/passwd', 'data:text/plain,hi', 'not a url', 'ftp://x/y']) {
    const provider = resolveAiProvider('openai-compatible', {
      GEV_AI_API_KEY: 'k',
      GEV_AI_BASE_URL: bad,
    });
    assert.equal(provider.baseUrl, '', `base URL: ${bad}`);
    assert.equal(provider.configured, false);
  }
});

test('GEV_AI_PROVIDER wins outright, even when that provider has no key', () => {
  const resolved = resolveDefaultAiProvider({
    GEV_AI_PROVIDER: 'openrouter',
    OPENAI_API_KEY: 'sk-openai',
  });
  // Falling through to OpenAI here would silently bill the wrong account.
  assert.equal(resolved.id, 'openrouter');
  assert.equal(resolved.configured, false);
  assert.equal(resolved.source, 'explicit');
});

test('with nothing named, the first configured provider wins, OpenRouter first', () => {
  assert.equal(resolveDefaultAiProvider({ OPENAI_API_KEY: 'k' }).id, 'openai');
  assert.equal(
    resolveDefaultAiProvider({ OPENAI_API_KEY: 'k', OPENROUTER_API_KEY: 'k2' }).id,
    'openrouter'
  );
  const empty = resolveDefaultAiProvider({});
  assert.equal(empty.id, 'openrouter');
  assert.equal(empty.configured, false);
  assert.equal(empty.source, 'default');
});

test('an unknown GEV_AI_PROVIDER falls back to detection, not to a bogus provider', () => {
  const resolved = resolveDefaultAiProvider({ GEV_AI_PROVIDER: 'bogus', OPENAI_API_KEY: 'k' });
  assert.equal(resolved.id, 'openai');
  assert.equal(resolved.source, 'detected');
});

test('voice keeps working on an OpenAI key after OpenRouter becomes the default', () => {
  const env = { GEV_AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'or', OPENAI_API_KEY: 'oa' };
  assert.equal(resolveDefaultAiProvider(env).id, 'openrouter');
  const realtime = resolveRealtimeProvider(env);
  assert.equal(realtime?.id, 'openai', 'the mic falls through to the only provider that can serve it');
});

test('realtime resolves to null when nothing configured can mint a session', () => {
  assert.equal(resolveRealtimeProvider({ OPENROUTER_API_KEY: 'or' }), null);
  assert.equal(resolveRealtimeProvider({}), null);
});

test('GEV_AI_REALTIME grants realtime to a gateway only, never to OpenRouter', () => {
  const env = {
    GEV_AI_REALTIME: 'true',
    GEV_AI_API_KEY: 'k',
    GEV_AI_BASE_URL: 'https://gateway.internal/v1',
    OPENROUTER_API_KEY: 'or',
  };
  assert.equal(resolveRealtimeProvider(env)?.id, 'openai-compatible');
  assert.equal(resolveAiProvider('openrouter', env).capabilities.realtime, false);
  // Without the opt-in the gateway is not assumed to proxy the Realtime API.
  assert.equal(resolveRealtimeProvider({ ...env, GEV_AI_REALTIME: '' }), null);
});

test('flag parsing accepts the usual spellings and nothing else', () => {
  for (const yes of ['1', 'true', 'TRUE', ' yes ', 'on']) assert.equal(isTruthyFlag(yes), true);
  for (const no of ['0', 'false', '', 'maybe', null, undefined]) assert.equal(isTruthyFlag(no), false);
});

test('the browser-facing description never carries the API key', () => {
  const described = describeAiProvider(resolveDefaultAiProvider({ OPENROUTER_API_KEY: 'sk-secret' }));
  assert.equal(JSON.stringify(described).includes('sk-secret'), false);
  assert.equal(described.configured, true);
  assert.equal(described.keyEnvVar, 'OPENROUTER_API_KEY');
  assert.equal(described.capabilities.realtime, false);
});

test('OpenRouter requests carry its attribution headers; OpenAI carries its own', () => {
  const openrouter = aiProviderHeaders(resolveAiProvider('openrouter', { OPENROUTER_API_KEY: 'k' }));
  assert.equal(openrouter.Authorization, 'Bearer k');
  assert.equal(openrouter['X-Title'], "God's Eye View");
  assert.match(openrouter['HTTP-Referer'], /^https:\/\//);

  const openai = aiProviderHeaders(resolveAiProvider('openai', { OPENAI_API_KEY: 'k' }));
  assert.equal(openai['OpenAI-Safety-Identifier'], 'gev-local-dev');
  assert.equal(openai['X-Title'], undefined);
});
