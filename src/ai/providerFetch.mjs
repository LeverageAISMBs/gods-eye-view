// src/ai/providerFetch.mjs
/**
 * Network layer for the AI provider adapter.
 *
 * Everything that leaves the machine for a model provider goes through here, so
 * the retry policy, the timeout, the typed errors, and the catalog cache are
 * defined once. Three call sites use it: the dev-server middleware in
 * `vite.config.js`, the CLI, and unit tests (which inject `fetchImpl`).
 *
 * RETRIES: at least three attempts on anything transient (network reset,
 * 408/429/5xx), exponential backoff with full jitter so a restarting dev server
 * does not stampede the provider. A 4xx that is not 408/429 is a permanent
 * answer — retrying it just burns the rate limit.
 *
 * @module ai/providerFetch
 */

import { aiProviderHeaders } from './providers.mjs';
import { normalizeVoiceCatalog, normalizeVoiceDirection } from './voiceCatalog.mjs';

/** Attempts, including the first. */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Base backoff; attempt N waits a random slice of BASE * 2^(N-1). */
export const DEFAULT_BACKOFF_MS = 400;
/** Ceiling on any single backoff, so a 5xx storm cannot stall a request. */
export const MAX_BACKOFF_MS = 8_000;
/** Per-attempt request timeout. */
export const DEFAULT_TIMEOUT_MS = 20_000;
/** How long a normalised catalog stays fresh. Model lists move in days. */
export const CATALOG_TTL_MS = 5 * 60_000;
/** Refuse to parse a provider body larger than this. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Statuses worth a second attempt. */
const RETRYABLE_STATUSES = Object.freeze(new Set([408, 409, 425, 429, 500, 502, 503, 504]));

/** Typed provider failure — never leaks the API key, always names the provider. */
export class AiProviderError extends Error {
  /**
   * @param {string} message
   * @param {object} details
   * @param {string} details.code       Stable machine code, e.g. 'PROVIDER_HTTP_ERROR'.
   * @param {string} details.providerId
   * @param {number} [details.status]   Upstream HTTP status, when there was one.
   * @param {boolean} [details.retryable]
   * @param {unknown} [details.cause]
   */
  constructor(message, { code, providerId, status = 0, retryable = false, cause }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AiProviderError';
    this.code = code;
    this.providerId = providerId;
    this.status = status;
    this.retryable = retryable;
  }

  /** Shape safe to return to the browser. */
  toJSON() {
    return {
      error: this.message,
      code: this.code,
      provider: this.providerId,
      status: this.status || null,
    };
  }
}

/** Full-jitter exponential backoff for a given attempt (1-indexed). */
export function backoffDelayMs(attempt, baseMs = DEFAULT_BACKOFF_MS, random = Math.random) {
  const ceiling = Math.min(MAX_BACKOFF_MS, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(random() * ceiling);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Pull the most useful message out of a provider's error body. */
function providerErrorMessage(body, fallback) {
  if (typeof body?.error?.message === 'string' && body.error.message.trim()) {
    return body.error.message.trim();
  }
  if (typeof body?.error === 'string' && body.error.trim()) return body.error.trim();
  if (typeof body?.message === 'string' && body.message.trim()) return body.message.trim();
  return fallback;
}

/**
 * One provider request, retried per the policy above.
 *
 * @param {object} options
 * @param {ReturnType<import('./providers.mjs').resolveAiProvider>} options.provider
 * @param {string} options.path            Path under the provider base URL, e.g. '/models'.
 * @param {'GET'|'POST'} [options.method]
 * @param {unknown} [options.body]         JSON-serialised when present.
 * @param {Record<string,string>} [options.headers]
 * @param {number} [options.maxAttempts]
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.random]
 * @param {(ms: number) => Promise<void>} [options.delay]
 * @returns {Promise<{status: number, ok: boolean, data: any, text: string, headers: Headers}>}
 */
export async function requestProvider({
  provider,
  path,
  method = 'GET',
  body,
  headers = {},
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  random = Math.random,
  delay = sleep,
}) {
  if (!provider?.configured) {
    throw new AiProviderError(
      `${provider?.label || 'AI provider'} is not configured — set ${provider?.keyEnvVar || 'an API key'}`,
      { code: 'PROVIDER_NOT_CONFIGURED', providerId: provider?.id || 'unknown', retryable: false }
    );
  }
  if (typeof fetchImpl !== 'function') {
    throw new AiProviderError('No fetch implementation available', {
      code: 'PROVIDER_NO_FETCH', providerId: provider.id, retryable: false,
    });
  }

  const url = `${provider.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const attempts = Math.max(1, Math.trunc(maxAttempts));
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method,
        headers: aiProviderHeaders(provider, headers),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await readResponseText(response, provider.id);
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }

      if (response.ok) {
        return { status: response.status, ok: true, data, text, headers: response.headers };
      }

      // Always throw: the catch below owns the single retry/backoff path, so a
      // retryable status can never fall through to the next attempt without
      // waiting first.
      throw new AiProviderError(
        providerErrorMessage(data, `${provider.label} request failed (HTTP ${response.status})`),
        {
          code: 'PROVIDER_HTTP_ERROR',
          providerId: provider.id,
          status: response.status,
          retryable: RETRYABLE_STATUSES.has(response.status),
        }
      );
    } catch (error) {
      if (error instanceof AiProviderError) {
        if (!error.retryable || attempt === attempts) throw error;
        lastError = error;
      } else {
        // Abort, DNS failure, socket reset — all transient by nature.
        const aborted = error?.name === 'AbortError';
        lastError = new AiProviderError(
          aborted
            ? `${provider.label} request timed out after ${timeoutMs}ms`
            : `${provider.label} request failed: ${error?.message || 'network error'}`,
          {
            code: aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK_ERROR',
            providerId: provider.id,
            retryable: true,
            cause: error,
          }
        );
        if (attempt === attempts) throw lastError;
      }
      await delay(backoffDelayMs(attempt, DEFAULT_BACKOFF_MS, random));
    } finally {
      clearTimeout(timer);
    }
  }

  /* c8 ignore next */
  throw lastError ?? new AiProviderError('Provider request failed', {
    code: 'PROVIDER_UNKNOWN_ERROR', providerId: provider.id, retryable: false,
  });
}

/** Read a response body, refusing anything implausibly large. */
async function readResponseText(response, providerId) {
  const tooLarge = () => new AiProviderError('Provider response exceeded the size limit', {
    code: 'PROVIDER_RESPONSE_TOO_LARGE', providerId, retryable: false,
  });
  const declared = Number(response.headers?.get?.('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw tooLarge();
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw tooLarge();
  return text;
}

/* ------------------------------------------------------------------ *
 * VOICE CATALOG
 * ------------------------------------------------------------------ */

/** @type {Map<string, {expiresAt: number, payload: object}>} */
const catalogCache = new Map();
/** @type {Map<string, Promise<object>>} In-flight dedup: one fetch per key. */
const catalogInFlight = new Map();

/** Drop cached catalogs. Exported for tests and for the CLI's --refresh. */
export function clearVoiceCatalogCache() {
  catalogCache.clear();
  catalogInFlight.clear();
}

/**
 * Fetch and normalise every voice-capable model a provider exposes.
 *
 * Cached for {@link CATALOG_TTL_MS} per provider+baseUrl+direction, with
 * concurrent callers sharing one in-flight request — a page that opens the
 * model picker twice must not bill two catalog fetches.
 *
 * @param {object} options
 * @param {ReturnType<import('./providers.mjs').resolveAiProvider>} options.provider
 * @param {'any'|'input'|'output'} [options.direction]
 * @param {boolean} [options.refresh] Bypass (and replace) the cached entry.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {number} [options.maxAttempts]
 * @param {(ms:number)=>Promise<void>} [options.delay]
 * @returns {Promise<{provider: string, direction: string, models: object[], total: number, fetchedAt: string, cached: boolean}>}
 */
export async function fetchVoiceCatalog({
  provider,
  direction = 'output',
  refresh = false,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  delay = sleep,
}) {
  const resolvedDirection = normalizeVoiceDirection(direction);
  const key = `${provider?.id}|${provider?.baseUrl}|${resolvedDirection}`;
  const timestamp = now();

  if (!refresh) {
    const hit = catalogCache.get(key);
    if (hit && hit.expiresAt > timestamp) return { ...hit.payload, cached: true };
    const pending = catalogInFlight.get(key);
    if (pending) return { ...(await pending), cached: true };
  }

  const work = (async () => {
    const { data } = await requestProvider({
      provider,
      path: '/models',
      fetchImpl,
      maxAttempts,
      delay,
    });
    const { models, total } = normalizeVoiceCatalog(data, {
      providerId: provider.id,
      direction: resolvedDirection,
    });
    const payload = {
      provider: provider.id,
      providerLabel: provider.label,
      direction: resolvedDirection,
      models,
      total,
      fetchedAt: new Date(now()).toISOString(),
    };
    catalogCache.set(key, { expiresAt: now() + CATALOG_TTL_MS, payload });
    return payload;
  })();

  catalogInFlight.set(key, work);
  try {
    return { ...(await work), cached: false };
  } finally {
    catalogInFlight.delete(key);
  }
}

/* ------------------------------------------------------------------ *
 * TEXT COMPLETION
 * ------------------------------------------------------------------ */

/**
 * Extract assistant text from either completion shape.
 *
 * `responses` (OpenAI) nests text under output[].content[].text; `chat`
 * (OpenRouter and every OpenAI-compatible gateway) puts it on
 * choices[0].message.content, which may itself be a content-part array.
 */
export function extractCompletionText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  if (Array.isArray(data?.output)) {
    const fromResponses = data.output
      .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
      .map((part) => (typeof part?.text === 'string' ? part.text : part?.output_text || ''))
      .join(' ')
      .trim();
    if (fromResponses) return fromResponses;
  }
  const message = data?.choices?.[0]?.message?.content;
  if (typeof message === 'string') return message.trim();
  if (Array.isArray(message)) {
    return message
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join(' ')
      .trim();
  }
  return '';
}

/**
 * One-shot text completion, in whichever shape the provider speaks.
 *
 * @param {object} options
 * @param {ReturnType<import('./providers.mjs').resolveAiProvider>} options.provider
 * @param {string} options.model
 * @param {string} options.instructions  System prompt.
 * @param {string} options.input         User content.
 * @param {number} [options.maxOutputTokens]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.maxAttempts]
 * @param {(ms:number)=>Promise<void>} [options.delay]
 * @returns {Promise<{text: string, model: string, provider: string, raw: any}>}
 */
export async function completeText({
  provider,
  model,
  instructions,
  input,
  maxOutputTokens = 100,
  fetchImpl = globalThis.fetch,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  delay = sleep,
}) {
  const trimmedModel = String(model ?? '').trim();
  if (!trimmedModel) {
    throw new AiProviderError('No model configured for text completion', {
      code: 'PROVIDER_NO_MODEL', providerId: provider?.id || 'unknown', retryable: false,
    });
  }

  const usesResponsesApi = provider.textApi === 'responses';
  const { path, body } = usesResponsesApi
    ? {
      path: '/responses',
      body: {
        model: trimmedModel,
        instructions,
        input,
        reasoning: { effort: 'minimal' },
        max_output_tokens: maxOutputTokens,
      },
    }
    : {
      path: '/chat/completions',
      body: {
        model: trimmedModel,
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: input },
        ],
        max_tokens: maxOutputTokens,
      },
    };

  const { data } = await requestProvider({
    provider, path, method: 'POST', body, fetchImpl, maxAttempts, delay,
  });
  return {
    text: extractCompletionText(data),
    model: typeof data?.model === 'string' ? data.model : trimmedModel,
    provider: provider.id,
    raw: data,
  };
}

/* ------------------------------------------------------------------ *
 * REALTIME SESSIONS
 * ------------------------------------------------------------------ */

/**
 * Mint an ephemeral Realtime client secret.
 *
 * Only a provider whose capabilities include `realtime` reaches this — see the
 * header of `providers.mjs` for why OpenRouter is not one of them.
 *
 * Returns the upstream body VERBATIM: `gevRealtime.js` parses the raw OpenAI
 * shape, so re-wrapping it here would break the client for no gain.
 *
 * @param {object} options
 * @param {ReturnType<import('./providers.mjs').resolveAiProvider>} options.provider
 * @param {object} options.sessionConfig
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.maxAttempts]
 * @param {(ms:number)=>Promise<void>} [options.delay]
 * @returns {Promise<{status: number, text: string, contentType: string}>}
 */
export async function mintRealtimeSecret({
  provider,
  sessionConfig,
  fetchImpl = globalThis.fetch,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  delay = sleep,
}) {
  if (!provider?.capabilities?.realtime) {
    throw new AiProviderError(
      `${provider?.label || 'This provider'} cannot mint Realtime voice sessions`,
      { code: 'PROVIDER_NO_REALTIME', providerId: provider?.id || 'unknown', retryable: false }
    );
  }
  const { status, text, headers } = await requestProvider({
    provider,
    path: '/realtime/client_secrets',
    method: 'POST',
    body: sessionConfig,
    fetchImpl,
    maxAttempts,
    delay,
  });
  return {
    status,
    text,
    contentType: headers?.get?.('content-type') || 'application/json',
  };
}
