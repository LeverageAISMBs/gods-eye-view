// src/ai/providers.mjs
/**
 * AI provider registry + resolution.
 *
 * God's Eye View talks to a model provider on three separate planes, and they
 * do NOT resolve together:
 *
 *   1. CATALOG  — list the models a key can reach, with pricing. Any
 *      OpenAI-compatible `/models` endpoint serves this.
 *   2. TEXT     — one-shot completions (the five-word HUD summary).
 *   3. REALTIME — a WebRTC voice session minted from an ephemeral client
 *      secret. This is NOT part of the OpenAI-compatible surface: it needs
 *      `POST /realtime/client_secrets` plus a `/realtime/calls` SDP exchange,
 *      which today only OpenAI (and an OpenAI-shaped gateway pointed at it)
 *      implements. OpenRouter's audio support is turn-based chat/completions
 *      with `modalities: ['text','audio']`, verified against
 *      https://openrouter.ai/docs/guides/overview/multimodal/audio on
 *      2026-09-10 — a different transport, not a drop-in.
 *
 * So the default provider (OpenRouter, per `GEV_AI_PROVIDER`) owns catalog and
 * text, while `resolveRealtimeProvider` independently picks the first
 * realtime-capable configured provider. A repo that only has OPENAI_API_KEY set
 * keeps working exactly as before; adding OPENROUTER_API_KEY moves catalog and
 * HUD text over without touching the mic.
 *
 * Pure module — no network, no DOM, no imports — so the dev-server middleware
 * (`vite.config.js`), the CLI, and unit tests share one source of truth.
 *
 * @module ai/providers
 */

/** @typedef {'openrouter'|'openai'|'google-gemini'|'openai-compatible'} AiProviderId */

/**
 * How a provider carries a live voice session.
 *
 * NOT interchangeable, which is exactly why this is a named transport and not a
 * `realtime: true` flag. Verified against both vendors' docs on 2026-09-10:
 *
 *   webrtc_sdp      OpenAI Realtime. Mint at POST /realtime/client_secrets, then
 *                   the browser POSTs an SDP offer to /realtime/calls and runs an
 *                   RTCPeerConnection: audio on media tracks, tool calls on an
 *                   RTCDataChannel.
 *   websocket_bidi  Gemini Live. Mint at POST /v1beta/auth_tokens, then the
 *                   browser opens a WSS connection to
 *                   ...GenerativeService.BidiGenerateContentConstrained and hand-
 *                   frames base64 PCM16 @16kHz; tool calls arrive as toolCall
 *                   messages on the same socket.
 *
 * A provider declares what it SPEAKS; SUPPORTED_REALTIME_TRANSPORTS declares what
 * this build IMPLEMENTS. Only the intersection can serve a mic — so declaring a
 * transport can never hand the browser a session it cannot actually run.
 *
 * @typedef {'webrtc_sdp'|'websocket_bidi'} RealtimeTransport
 */

/**
 * @typedef {object} AiProviderCapabilities
 * @property {boolean} catalog  Can enumerate models (`GET {baseUrl}/models`).
 * @property {boolean} text     Can serve one-shot text completions.
 * @property {boolean} realtime Can serve a voice session THIS BUILD can run.
 * @property {boolean} audioChat Can return audio from chat/completions.
 */

/**
 * @typedef {object} AiProviderDefinition
 * @property {AiProviderId} id
 * @property {string} label
 * @property {string} defaultBaseUrl
 * @property {readonly string[]} keyEnvVars   Checked in order; first non-empty wins.
 * @property {string|null} baseUrlEnvVar      Env var that may override the base URL.
 * @property {AiProviderCapabilities} capabilities
 * @property {RealtimeTransport|null} realtimeTransport  What it speaks, if anything.
 * @property {string} docsUrl
 * @property {'chat'|'responses'} textApi     Which completion shape the provider speaks.
 */

/** Env var that names the default provider for catalog + text. */
export const AI_PROVIDER_ENV_VAR = 'GEV_AI_PROVIDER';

/** Provider used when nothing (or nonsense) is configured. */
export const DEFAULT_AI_PROVIDER = 'openrouter';

/**
 * Attribution headers OpenRouter uses for app rankings. Optional per its API
 * reference, but sending them keeps this app identifiable on a shared key.
 */
export const OPENROUTER_APP_TITLE = "God's Eye View";
export const OPENROUTER_APP_URL = 'https://github.com/bilawalsidhu/gods-eye-view';

/**
 * The realtime transports THIS BUILD can actually run end to end.
 *
 * `src/voice/gevRealtime.js` implements exactly one: an RTCPeerConnection with
 * media tracks and a data channel. Adding 'websocket_bidi' here is a promise
 * that a Gemini Live client exists — do not add it before one does, or
 * resolveRealtimeProvider will hand the browser a session it cannot run.
 */
export const SUPPORTED_REALTIME_TRANSPORTS = Object.freeze(['webrtc_sdp']);

/** True only for a transport this build implements. */
export function isSupportedRealtimeTransport(transport) {
  return SUPPORTED_REALTIME_TRANSPORTS.includes(transport);
}

/** @type {Readonly<Record<AiProviderId, AiProviderDefinition>>} */
export const AI_PROVIDERS = Object.freeze({
  openrouter: Object.freeze({
    id: 'openrouter',
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    keyEnvVars: Object.freeze(['OPENROUTER_API_KEY']),
    baseUrlEnvVar: 'OPENROUTER_BASE_URL',
    docsUrl: 'https://openrouter.ai/keys',
    textApi: 'chat',
    // No live-session endpoint of any kind. See the module header.
    realtimeTransport: null,
    capabilities: Object.freeze({
      catalog: true,
      text: true,
      realtime: false,
      audioChat: true,
    }),
  }),
  openai: Object.freeze({
    id: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    keyEnvVars: Object.freeze(['OPENAI_API_KEY']),
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    docsUrl: 'https://platform.openai.com/api-keys',
    textApi: 'responses',
    realtimeTransport: 'webrtc_sdp',
    capabilities: Object.freeze({
      catalog: true,
      text: true,
      realtime: true,
      audioChat: true,
    }),
  }),
  'google-gemini': Object.freeze({
    id: 'google-gemini',
    label: 'Google Gemini',
    // Google's OpenAI-compatibility layer: /models and /chat/completions both
    // work through the same adapter as every other provider here, verified
    // against https://ai.google.dev/gemini-api/docs/openai on 2026-09-10.
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnvVars: Object.freeze(['GEMINI_API_KEY', 'GOOGLE_AI_API_KEY']),
    baseUrlEnvVar: 'GEMINI_BASE_URL',
    docsUrl: 'https://aistudio.google.com/apikey',
    textApi: 'chat',
    // Gemini Live is a real live-voice API, but over WSS with hand-framed PCM —
    // NOT the WebRTC/SDP path this build implements. Declared honestly so the
    // registry can say so; `realtime` below stays false until a client exists.
    realtimeTransport: 'websocket_bidi',
    capabilities: Object.freeze({
      catalog: true,
      text: true,
      realtime: false,
      audioChat: true,
    }),
  }),
  'openai-compatible': Object.freeze({
    id: 'openai-compatible',
    label: 'OpenAI-compatible endpoint',
    // Intentionally empty: this provider is unusable until GEV_AI_BASE_URL
    // names a real gateway (Azure OpenAI, LiteLLM, vLLM, Ollama, …).
    defaultBaseUrl: '',
    keyEnvVars: Object.freeze(['GEV_AI_API_KEY']),
    baseUrlEnvVar: 'GEV_AI_BASE_URL',
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    textApi: 'chat',
    // A gateway that proxies OpenAI's Realtime endpoints speaks the transport
    // we implement — but only claims it when GEV_AI_REALTIME=1 says so.
    realtimeTransport: 'webrtc_sdp',
    capabilities: Object.freeze({
      catalog: true,
      text: true,
      // Opt-in: see resolveAiProvider.
      realtime: false,
      audioChat: true,
    }),
  }),
});

/** Every provider id this build knows. */
export const AI_PROVIDER_IDS = Object.freeze(Object.keys(AI_PROVIDERS));

/** Env flag that grants an OpenAI-compatible gateway the realtime capability. */
export const AI_REALTIME_OPT_IN_ENV_VAR = 'GEV_AI_REALTIME';

/**
 * Order used when no provider is named explicitly: OpenRouter first (the
 * documented default), then a direct OpenAI key, then a custom gateway.
 */
const AUTO_DETECT_ORDER = Object.freeze([
  'openrouter', 'openai', 'google-gemini', 'openai-compatible',
]);

/** Realtime search order — most likely to actually serve a mic session first. */
const REALTIME_ORDER = Object.freeze(['openai', 'openai-compatible']);

/**
 * Providers that speak a live-voice transport this build cannot run.
 *
 * Kept separate from REALTIME_ORDER on purpose: these must never be SELECTED,
 * but the token endpoint uses them to explain WHY the mic is unavailable —
 * "Gemini Live needs the websocket_bidi transport" beats "no provider found"
 * when the user has a Gemini key sitting right there.
 */
const REALTIME_UNIMPLEMENTED_ORDER = Object.freeze(['google-gemini']);

/** True only for a provider id this build registers (own properties only). */
export function isKnownAiProvider(id) {
  const key = typeof id === 'string' ? id.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(AI_PROVIDERS, key);
}

/**
 * Map a requested provider id to its definition, falling back to the default.
 *
 * Deliberately total, and an own-property check rather than `AI_PROVIDERS[id] ||
 * fallback`: `'constructor'` and `'__proto__'` are truthy on Object.prototype
 * and would sail past a `||`, handing a caller a definition whose `baseUrl` is
 * undefined.
 *
 * @param {unknown} id
 * @returns {AiProviderDefinition}
 */
export function aiProviderDefinition(id) {
  return isKnownAiProvider(id)
    ? AI_PROVIDERS[String(id).trim().toLowerCase()]
    : AI_PROVIDERS[DEFAULT_AI_PROVIDER];
}

/** Read the first non-empty env value from a list of candidate names. */
function readEnv(env, names) {
  for (const name of names) {
    const value = String(env?.[name] ?? '').trim();
    if (value) return value;
  }
  return '';
}

/** Strip trailing slashes so `${baseUrl}/models` never doubles up. */
function normalizeBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return '';
  }
  // An http(s) scheme is the whole allowlist: a `file:` or `data:` base URL
  // would turn a config typo into a local-file read by the fetch layer.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/**
 * Resolve one provider against an env bag: its base URL, key, capabilities, and
 * whether it is usable at all.
 *
 * Never throws and never returns the key in a shape meant for logging — callers
 * that serialise this to the browser must use {@link describeAiProvider}.
 *
 * @param {unknown} id
 * @param {Record<string, string|undefined>} [env]
 * @returns {{
 *   id: AiProviderId, label: string, baseUrl: string, apiKey: string,
 *   configured: boolean, capabilities: AiProviderCapabilities,
 *   textApi: 'chat'|'responses', docsUrl: string, keyEnvVar: string,
 * }}
 */
export function resolveAiProvider(id, env = {}) {
  const definition = aiProviderDefinition(id);
  const baseUrl = normalizeBaseUrl(
    (definition.baseUrlEnvVar ? readEnv(env, [definition.baseUrlEnvVar]) : '')
      || definition.defaultBaseUrl
  );
  const apiKey = readEnv(env, definition.keyEnvVars);
  const realtimeOptIn = isTruthyFlag(env?.[AI_REALTIME_OPT_IN_ENV_VAR]);
  const declaredRealtime = definition.capabilities.realtime
    // Only the generic gateway can be *granted* realtime — flipping the flag
    // must never claim OpenRouter can mint a client secret.
    || (definition.id === 'openai-compatible' && realtimeOptIn);
  const capabilities = Object.freeze({
    ...definition.capabilities,
    // The transport gate is final: a provider may declare a live-voice API, and
    // an operator may opt a gateway in, but if this build has no client for that
    // transport the answer is still no. This is what stops a Gemini key from
    // being handed to a WebRTC dialer that would silently never connect.
    realtime: declaredRealtime && isSupportedRealtimeTransport(definition.realtimeTransport),
  });
  return {
    id: definition.id,
    label: definition.label,
    baseUrl,
    apiKey,
    // A key alone is not enough: the generic gateway also needs a base URL.
    configured: Boolean(apiKey && baseUrl),
    capabilities,
    realtimeTransport: definition.realtimeTransport,
    textApi: definition.textApi,
    docsUrl: definition.docsUrl,
    keyEnvVar: definition.keyEnvVars[0],
  };
}

/**
 * A configured provider that speaks a live-voice transport this build cannot
 * run, or null. Used only to explain an unavailable mic — never to serve one.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {ReturnType<typeof resolveAiProvider>|null}
 */
export function resolveUnsupportedRealtimeProvider(env = {}) {
  for (const id of REALTIME_UNIMPLEMENTED_ORDER) {
    const provider = resolveAiProvider(id, env);
    if (provider.configured && provider.realtimeTransport
      && !isSupportedRealtimeTransport(provider.realtimeTransport)) {
      return provider;
    }
  }
  return null;
}

/** Accept the usual truthy spellings of an env flag. */
export function isTruthyFlag(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Pick the provider that serves catalog + text.
 *
 * `GEV_AI_PROVIDER` wins outright when it names a known provider — including
 * when that provider is unconfigured, so a typo'd key surfaces as "OpenRouter
 * has no key" rather than silently falling through to OpenAI and spending on
 * the wrong account. With nothing named, the first configured provider in
 * {@link AUTO_DETECT_ORDER} wins; with nothing configured at all, the default.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {ReturnType<typeof resolveAiProvider> & { source: 'explicit'|'detected'|'default' }}
 */
export function resolveDefaultAiProvider(env = {}) {
  const requested = String(env?.[AI_PROVIDER_ENV_VAR] ?? '').trim();
  if (requested && isKnownAiProvider(requested)) {
    return { ...resolveAiProvider(requested, env), source: 'explicit' };
  }
  for (const id of AUTO_DETECT_ORDER) {
    const provider = resolveAiProvider(id, env);
    if (provider.configured) return { ...provider, source: 'detected' };
  }
  return { ...resolveAiProvider(DEFAULT_AI_PROVIDER, env), source: 'default' };
}

/**
 * Pick the provider that mints Realtime voice sessions, independently of the
 * default provider.
 *
 * Returns null when nothing configured can serve the mic — the caller turns
 * that into an honest "voice needs a realtime-capable provider" response rather
 * than a dead microphone.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {ReturnType<typeof resolveAiProvider>|null}
 */
export function resolveRealtimeProvider(env = {}) {
  const requested = String(env?.[AI_PROVIDER_ENV_VAR] ?? '').trim();
  // An explicitly named provider is honoured for voice too, but only when it
  // can actually mint a secret; otherwise voice falls through to one that can.
  if (requested && isKnownAiProvider(requested)) {
    const provider = resolveAiProvider(requested, env);
    if (provider.configured && provider.capabilities.realtime) return provider;
  }
  for (const id of REALTIME_ORDER) {
    const provider = resolveAiProvider(id, env);
    if (provider.configured && provider.capabilities.realtime) return provider;
  }
  return null;
}

/**
 * Key-free description of a provider, safe to serialise to the browser or a
 * log line.
 *
 * @param {ReturnType<typeof resolveAiProvider> & {source?: string}} provider
 */
export function describeAiProvider(provider) {
  return {
    id: provider.id,
    label: provider.label,
    baseUrl: provider.baseUrl,
    configured: provider.configured,
    capabilities: { ...provider.capabilities },
    realtimeTransport: provider.realtimeTransport,
    keyEnvVar: provider.keyEnvVar,
    docsUrl: provider.docsUrl,
    ...(provider.source ? { source: provider.source } : {}),
  };
}

/**
 * Auth + attribution headers for a provider request.
 *
 * @param {ReturnType<typeof resolveAiProvider>} provider
 * @param {Record<string, string>} [extra]
 */
export function aiProviderHeaders(provider, extra = {}) {
  /** @type {Record<string, string>} */
  const headers = {
    Authorization: `Bearer ${provider.apiKey}`,
    'Content-Type': 'application/json',
    ...extra,
  };
  if (provider.id === 'openrouter') {
    headers['HTTP-Referer'] = OPENROUTER_APP_URL;
    headers['X-Title'] = OPENROUTER_APP_TITLE;
  }
  if (provider.id === 'openai') {
    headers['OpenAI-Safety-Identifier'] = 'gev-local-dev';
  }
  // Gemini's OpenAI-compat layer takes the key as a normal bearer token, so it
  // needs nothing extra here — the default Authorization header above is it.
  return headers;
}
