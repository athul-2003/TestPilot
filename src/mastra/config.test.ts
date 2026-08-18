import { describe, expect, it } from 'vitest';

import {
  CONFIDENCE_THRESHOLD,
  CRITICAL_MODEL,
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
