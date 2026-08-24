import { afterEach, describe, expect, it } from 'vitest';

import {
  CONFIDENCE_THRESHOLD,
  CRITICAL_MODEL,
  envNumber,
  envString,
  MAX_DIFF_CHARS,
  MODEL,
} from './config.ts';

/**
 * These assert the shape of the configuration, not the values themselves —
 * the values are meant to be tuned. What must not change silently is the
 * *contract*: a routable model string, a threshold that is a real probability,
 * and a diff ceiling that actually bounds anything.
 */
describe('config', () => {
  it.each([
    ['MODEL', MODEL],
    ['CRITICAL_MODEL', CRITICAL_MODEL],
  ])('%s is a routable "provider/model" string', (_name, value) => {
    // Mastra's model router needs the provider prefix. A bare "gpt-5.4-mini"
    // is the single most common wiring mistake, and it fails at request time
    // rather than at startup — so it is worth catching here.
    expect(value).toMatch(/^[a-z0-9-]+\/.+/);
  });

  it('keeps the confidence threshold a usable probability', () => {
    expect(CONFIDENCE_THRESHOLD).toBeGreaterThan(0);
    expect(CONFIDENCE_THRESHOLD).toBeLessThanOrEqual(1);
  });

  it('bounds the diff size', () => {
    expect(MAX_DIFF_CHARS).toBeGreaterThan(0);
    expect(Number.isFinite(MAX_DIFF_CHARS)).toBe(true);
  });
});

/**
 * These exist because of a real failure, not a hypothetical one. A GitHub
 * composite action passes every unsupplied input as an empty string, so
 * `TESTPILOT_MODEL: ${{ inputs.model }}` with no model given produced
 * `TESTPILOT_MODEL=""` — and `process.env.X ?? fallback` happily kept the
 * empty string, because `??` only guards null and undefined. The Action
 * failed on its first real run with "LanguageModel is required".
 */
describe('envString', () => {
  const KEY = 'TESTPILOT_TEST_ONLY_STRING';

  afterEach(() => {
    delete process.env[KEY];
  });

  it('uses the value when one is genuinely set', () => {
    process.env[KEY] = 'openai/gpt-5.4-mini';
    expect(envString(KEY, 'fallback')).toBe('openai/gpt-5.4-mini');
  });

  it('falls back when the variable is unset', () => {
    expect(envString(KEY, 'fallback')).toBe('fallback');
  });

  it('falls back on an empty string — the bug that broke the Action', () => {
    process.env[KEY] = '';
    expect(envString(KEY, 'fallback')).toBe('fallback');
  });

  it('falls back on whitespace, and trims a real value', () => {
    process.env[KEY] = '   ';
    expect(envString(KEY, 'fallback')).toBe('fallback');
    process.env[KEY] = '  spaced/model  ';
    expect(envString(KEY, 'fallback')).toBe('spaced/model');
  });
});

describe('envNumber', () => {
  const KEY = 'TESTPILOT_TEST_ONLY_NUMBER';

  afterEach(() => {
    delete process.env[KEY];
  });

  it('parses a real number, including zero when explicitly set', () => {
    process.env[KEY] = '0.35';
    expect(envNumber(KEY, 0.7)).toBe(0.35);
    process.env[KEY] = '0';
    expect(envNumber(KEY, 0.7)).toBe(0);
  });

  it('falls back when unset', () => {
    expect(envNumber(KEY, 0.7)).toBe(0.7);
  });

  it('falls back on an empty string rather than silently becoming 0', () => {
    // Number('') is 0, not NaN. An empty confidence threshold would mean
    // every score clears it and Testpilot never falls back to running
    // everything — the safety net gone, with nothing in the output saying so.
    process.env[KEY] = '';
    expect(envNumber(KEY, 0.7)).toBe(0.7);
  });

  it('falls back on values that are not finite numbers', () => {
    for (const bad of ['abc', 'NaN', 'Infinity', '   ']) {
      process.env[KEY] = bad;
      expect(envNumber(KEY, 0.7), `input ${JSON.stringify(bad)}`).toBe(0.7);
    }
  });
});
