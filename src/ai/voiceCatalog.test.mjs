// src/ai/voiceCatalog.test.mjs
// The catalog is what a user picks a voice model from, so the two things that
// must not drift are pinned here: the modality filter (a model that cannot
// speak must never be offered) and the per-token -> per-1M price conversion
// (a factor-of-a-million error would mis-size the voice spend cap).
//
// The OpenRouter rows below are verbatim excerpts of GET
// https://openrouter.ai/api/v1/models, read on 2026-09-10.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VOICE_DIRECTION,
  normalizeVoiceCatalog,
  normalizeVoiceDirection,
  normalizeVoiceModelEntry,
} from './voiceCatalog.mjs';
import { VOICE_MODELS } from '../voice/voiceCost.js';

const OPENROUTER_GPT_AUDIO = Object.freeze({
  id: 'openai/gpt-audio',
  name: 'OpenAI: GPT Audio',
  context_length: 128000,
  architecture: {
    modality: 'text+audio->text+audio',
    input_modalities: ['text', 'audio'],
    output_modalities: ['text', 'audio'],
  },
  pricing: {
    prompt: '0.0000025',
    completion: '0.00001',
    audio: '0.000032',
    audio_output: '0.000064',
  },
  supported_parameters: ['max_tokens', 'tool_choice', 'tools', 'temperature'],
  supported_voices: null,
});

const OPENROUTER_LISTENER = Object.freeze({
  id: 'mistralai/voxtral-small-24b-2507',
  name: 'Mistral: Voxtral Small',
  context_length: 32000,
  architecture: { input_modalities: ['text', 'audio'], output_modalities: ['text'] },
  pricing: { prompt: '0.0000001', completion: '0.0000003' },
  supported_parameters: ['max_tokens'],
});

const OPENROUTER_TEXT_ONLY = Object.freeze({
  id: 'anthropic/claude-3.5-sonnet',
  name: 'Anthropic: Claude',
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  pricing: { prompt: '0.000003', completion: '0.000015' },
});

test('audio pricing converts from USD-per-token to USD-per-1M tokens', () => {
  const entry = normalizeVoiceModelEntry(OPENROUTER_GPT_AUDIO, 'openrouter');
  assert.deepEqual(entry.rates, {
    textInput: 2.5,
    textOutput: 10,
    audioInput: 32,
    audioOutput: 64,
  });
  assert.equal(entry.ratesUnit, 'usd_per_million_tokens');
  // Same units as the live session meter — an OpenRouter row can price a
  // session with the estimator in voiceCost.js without a second conversion.
  assert.equal(entry.rates.audioInput, VOICE_MODELS.standard.rates.audioInput);
  assert.equal(entry.rates.audioOutput, VOICE_MODELS.standard.rates.audioOutput);
});

test('text rates stand in for missing audio rates rather than pricing at zero', () => {
  const entry = normalizeVoiceModelEntry(OPENROUTER_LISTENER, 'openrouter');
  assert.equal(entry.rates.audioInput, 0.1, 'falls back to the prompt rate');
  assert.equal(entry.rates.audioOutput, 0.3);
});

test('modality metadata is believed over the model id', () => {
  const listener = normalizeVoiceModelEntry(OPENROUTER_LISTENER, 'openrouter');
  assert.equal(listener.audioInput, true);
  assert.equal(listener.audioOutput, false, 'Voxtral listens; it does not speak');
  assert.equal(normalizeVoiceModelEntry(OPENROUTER_TEXT_ONLY, 'openrouter'), null);
});

test('tool support and context length carry through', () => {
  const entry = normalizeVoiceModelEntry(OPENROUTER_GPT_AUDIO, 'openrouter');
  assert.equal(entry.tools, true, 'GEV voice control is entirely tool calls');
  assert.equal(entry.contextLength, 128000);
  assert.equal(normalizeVoiceModelEntry(OPENROUTER_LISTENER, 'openrouter').tools, false);
});

test('a bare OpenAI model row falls back to id-derived voice capability', () => {
  // GET https://api.openai.com/v1/models publishes no modality fields at all.
  const realtime = normalizeVoiceModelEntry(
    { id: 'gpt-realtime-2', object: 'model', owned_by: 'openai' },
    'openai'
  );
  assert.equal(realtime.audioOutput, true);
  assert.equal(realtime.realtime, true, 'only a realtime model can drive the mic');
  assert.equal(realtime.rates, null, 'OpenAI publishes no prices on /models');

  assert.equal(normalizeVoiceModelEntry({ id: 'gpt-5-nano' }, 'openai'), null);
  assert.equal(normalizeVoiceModelEntry({ id: 'gpt-audio-mini' }, 'openai').realtime, false);
});

test('direction filters which side of the conversation is required', () => {
  const payload = { data: [OPENROUTER_GPT_AUDIO, OPENROUTER_LISTENER, OPENROUTER_TEXT_ONLY] };
  assert.deepEqual(
    normalizeVoiceCatalog(payload, { providerId: 'openrouter', direction: 'output' })
      .models.map((m) => m.id),
    ['openai/gpt-audio']
  );
  assert.equal(normalizeVoiceCatalog(payload, { direction: 'input' }).total, 2);
  assert.equal(normalizeVoiceCatalog(payload, { direction: 'any' }).total, 2);
  assert.equal(DEFAULT_VOICE_DIRECTION, 'output');
});

test('an unknown direction resolves to the default instead of throwing', () => {
  for (const bad of ['', 'sideways', null, 7, {}]) {
    assert.equal(normalizeVoiceDirection(bad), DEFAULT_VOICE_DIRECTION);
  }
  assert.equal(normalizeVoiceDirection(' INPUT '), 'input');
});

test('realtime models sort first, then cheapest speakers, then by id', () => {
  const speaker = (id, audioOutput) => ({
    id,
    architecture: { output_modalities: ['audio'] },
    pricing: { audio_output: audioOutput },
    supported_parameters: ['tools'],
  });
  const { models } = normalizeVoiceCatalog({
    data: [
      OPENROUTER_GPT_AUDIO,
      speaker('openai/gpt-audio-mini', '0.000020'),
      { ...speaker('openai/gpt-realtime-2', '0.000064'), pricing: {} },
    ],
  }, { providerId: 'openrouter', direction: 'output' });
  assert.deepEqual(models.map((m) => m.id), [
    'openai/gpt-realtime-2',
    'openai/gpt-audio-mini',
    'openai/gpt-audio',
  ]);
});

test('a zero-priced music model never outranks a model that can hold a conversation', () => {
  // Verbatim shape of google/lyria-3-pro-preview from the live catalog: audio
  // output, no tools, and a per-token price of 0 because it bills per song.
  const { models } = normalizeVoiceCatalog({
    data: [
      { id: 'google/lyria-3-pro-preview', architecture: { output_modalities: ['text', 'audio'] }, pricing: { prompt: '0', completion: '0' } },
      OPENROUTER_GPT_AUDIO,
    ],
  }, { providerId: 'openrouter', direction: 'output' });
  assert.deepEqual(models.map((m) => m.id), ['openai/gpt-audio', 'google/lyria-3-pro-preview']);
});

test('a malformed payload yields an empty catalog, never a throw', () => {
  for (const bad of [null, undefined, 'nope', 42, {}, { data: 'nope' }, { data: [null, 1, [], {}] }]) {
    const result = normalizeVoiceCatalog(bad, { providerId: 'openrouter' });
    assert.equal(result.total, 0);
    assert.deepEqual(result.models, []);
  }
});

test('negative and non-numeric prices are dropped, not trusted', () => {
  const entry = normalizeVoiceModelEntry({
    id: 'x/speaker',
    architecture: { output_modalities: ['audio'] },
    pricing: { prompt: '-1', completion: 'free', audio_output: '0.000001' },
  }, 'openrouter');
  assert.deepEqual(entry.rates, {
    textInput: 0, textOutput: 0, audioInput: 0, audioOutput: 1,
  });
});
