import { describe, expect, it } from 'vitest';

import { findMissedRegressions } from './regression-guard.ts';

describe('findMissedRegressions', () => {
  it('finds nothing when nothing skipped actually failed', () => {
    expect(findMissedRegressions(['a.test.ts', 'b.test.ts'], ['c.test.ts'])).toEqual([]);
  });

  it('finds a skipped test that genuinely failed', () => {
    expect(findMissedRegressions(['a.test.ts', 'b.test.ts'], ['a.test.ts'])).toEqual(['a.test.ts']);
  });

  it('finds every skipped test that failed, not just the first', () => {
    expect(findMissedRegressions(['a.test.ts', 'b.test.ts', 'c.test.ts'], ['a.test.ts', 'c.test.ts'])).toEqual([
      'a.test.ts',
      'c.test.ts',
    ]);
  });

  it('is not confused by a failing test Testpilot correctly did not skip', () => {
    // b.test.ts failed, but it isn't in the skip list at all — must-run or
    // should-run, not a miss.
    expect(findMissedRegressions(['a.test.ts'], ['b.test.ts'])).toEqual([]);
  });

  it('returns an empty array for an empty skip list', () => {
    expect(findMissedRegressions([], ['a.test.ts'])).toEqual([]);
  });
});
