// src/ai/voiceCatalog.mjs
/**
 * Normalise a provider's model list into GEV's voice-model catalog.
 *
 * Two upstream shapes, one output shape:
 *
 *   - OPENROUTER `GET /api/v1/models` returns rich entries — verified against
 *     the live endpoint on 2026-09-10:
 *       architecture.input_modalities / architecture.output_modalities
 *       pricing.prompt | completion | audio | audio_output  (USD PER TOKEN,
 *         as decimal strings — "0.000032" is $32 / 1M tokens)
 *       supported_parameters (contains "tools" when the model can call tools)
 *       supported_voices (often null; a string list when the provider publishes one)
 *   - OPENAI `GET /v1/models` returns `{id, object, created, owned_by}` and
 *     NOTHING about modality, so voice capability there is derived from the id.
 *
 * Rates are emitted as USD per 1,000,000 tokens to match
 * `src/voice/voiceCost.js`, so a catalog entry can price a session with the
 * same estimator the live meter uses.
 *
 * Pure module — no network, no DOM. The fetching lives in `providerFetch.mjs`.
 *
 * @module ai/voiceCatalog
 */

/** USD-per-token → USD-per-1M-tokens. */
const TOKENS_PER_RATE_UNIT = 1_000_000;

/**
 * Id fragments that mark a model as voice-capable when the provider publishes
 * no modality metadata (OpenAI's `/v1/models`). Deliberately narrow: a false
 * positive here offers the user a model that cannot speak.
 */
const VOICE_ID_HINTS = Object.freeze(['realtime', 'audio', 'voxtral', 'tts', 'omni']);

/** Id fragments that mark a model as a *realtime session* model, not turn-based. */
const REALTIME_ID_HINTS = Object.freeze(['realtime']);

/** Which side of the conversation a caller cares about. */
export const VOICE_DIRECTIONS = Object.freeze(['any', 'input', 'output']);
export const DEFAULT_VOICE_DIRECTION = 'output';

/** Total: an unknown/hostile direction resolves to the default. */
export function normalizeVoiceDirection(direction) {
  const raw = typeof direction === 'string' ? direction.trim().toLowerCase() : '';
  return VOICE_DIRECTIONS.includes(raw) ? raw : DEFAULT_VOICE_DIRECTION;
}

/**
 * Parse a provider price string to a finite USD-per-1M number, else null.
 *
 * Rounded to 6 decimals: multiplying a per-token decimal by a million lands on
 * binary-float noise ("0.0000001" -> 0.09999999999999999), which would reach
 * the model picker as a price nobody can read. Six decimals is well below a
 * hundredth of a cent per million tokens, so no real rate is distorted.
 */
function ratePerMillion(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * TOKENS_PER_RATE_UNIT * 1e6) / 1e6;
}

/** True when any hint appears in the (lowercased) model id. */
function idMatches(id, hints) {
  const key = String(id ?? '').toLowerCase();
  return hints.some((hint) => key.includes(hint));
}

/** Lowercased string array, or null when the provider published nothing. */
function stringList(value) {
  if (!Array.isArray(value)) return null;
  const items = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
  return items.length ? Object.freeze(items) : null;
}

/**
 * Build the per-1M rate table for one entry, or null when the provider
 * published no usable pricing. Text rates fall back to prompt/completion so an
 * audio model always prices its text side.
 */
function normalizeRates(pricing) {
  if (!pricing || typeof pricing !== 'object') return null;
  const textInput = ratePerMillion(pricing.prompt);
  const textOutput = ratePerMillion(pricing.completion);
  const audioInput = ratePerMillion(pricing.audio);
  const audioOutput = ratePerMillion(pricing.audio_output);
  if ([textInput, textOutput, audioInput, audioOutput].every((rate) => rate === null)) {
    return null;
  }
  return Object.freeze({
    textInput: textInput ?? 0,
    textOutput: textOutput ?? 0,
    audioInput: audioInput ?? textInput ?? 0,
    audioOutput: audioOutput ?? textOutput ?? 0,
  });
}

/**
 * Normalise a single upstream model entry.
 *
 * @param {unknown} entry
 * @param {string} providerId
 * @returns {object|null} A catalog entry, or null when the row is unusable.
 */
export function normalizeVoiceModelEntry(entry, providerId) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (!id) return null;

  const architecture = entry.architecture && typeof entry.architecture === 'object'
    ? entry.architecture
    : null;
  const inputModalities = stringList(architecture?.input_modalities) || [];
  const outputModalities = stringList(architecture?.output_modalities) || [];
  const hasModalityMetadata = inputModalities.length > 0 || outputModalities.length > 0;

  // With modality metadata, believe it. Without it (OpenAI's bare list), the id
  // is the only signal there is.
  const audioInput = hasModalityMetadata
    ? inputModalities.includes('audio')
    : idMatches(id, VOICE_ID_HINTS);
  const audioOutput = hasModalityMetadata
    ? outputModalities.includes('audio')
    : idMatches(id, VOICE_ID_HINTS);
  if (!audioInput && !audioOutput) return null;

  const supportedParameters = stringList(entry.supported_parameters) || [];
  const contextLength = Number.isFinite(Number(entry.context_length))
    ? Number(entry.context_length)
    : null;

  return Object.freeze({
    id,
    label: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id,
    providerId,
    audioInput,
    audioOutput,
    // A realtime model speaks over a session transport; everything else here is
    // turn-based chat/completions audio. The mic path needs the former.
    realtime: idMatches(id, REALTIME_ID_HINTS),
    tools: supportedParameters.includes('tools'),
    contextLength,
    rates: normalizeRates(entry.pricing),
    supportedVoices: stringList(entry.supported_voices),
    ratesUnit: 'usd_per_million_tokens',
  });
}

/**
 * Rank catalog entries by how useful they are for GEV voice control:
 * realtime first (only those can drive the mic), then tool-callers, then
 * speakers, then cheapest audio output, then id order for a stable list.
 *
 * The tool-calling rung is not cosmetic. GEV voice control IS tool calls, and
 * the live OpenRouter catalog puts music-generation models (Lyria) in the
 * audio-output bucket priced at 0 per token — without this rung they sort
 * "cheapest" and head a list of models that cannot hold a conversation.
 */
function compareVoiceModels(a, b) {
  if (a.realtime !== b.realtime) return a.realtime ? -1 : 1;
  if (a.tools !== b.tools) return a.tools ? -1 : 1;
  if (a.audioOutput !== b.audioOutput) return a.audioOutput ? -1 : 1;
  const aCost = a.rates?.audioOutput ?? Number.POSITIVE_INFINITY;
  const bCost = b.rates?.audioOutput ?? Number.POSITIVE_INFINITY;
  if (aCost !== bCost) return aCost - bCost;
  return a.id.localeCompare(b.id);
}

/**
 * Normalise a whole provider model-list payload into the voice catalog.
 *
 * Total by construction: a malformed payload yields an empty catalog rather
 * than throwing, because this runs inside a dev-server request handler where a
 * throw would surface as a bare 502 with no diagnosis.
 *
 * @param {unknown} payload      Raw `{data: [...]}` (or a bare array) from the provider.
 * @param {object} [options]
 * @param {string} [options.providerId]
 * @param {'any'|'input'|'output'} [options.direction] Which audio side to require.
 * @returns {{models: object[], total: number, direction: string}}
 */
export function normalizeVoiceCatalog(payload, options = {}) {
  const providerId = String(options.providerId ?? '').trim() || 'unknown';
  const direction = normalizeVoiceDirection(options.direction);
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : [];

  const models = rows
    .map((row) => normalizeVoiceModelEntry(row, providerId))
    .filter((entry) => {
      if (!entry) return false;
      if (direction === 'input') return entry.audioInput;
      if (direction === 'output') return entry.audioOutput;
      return true;
    })
    .sort(compareVoiceModels);

  return { models, total: models.length, direction };
}
