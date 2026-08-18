import { describe, it } from 'vitest';

describe('outer', () => {
  it('does the basic thing', () => {});

  describe('inner', () => {
    it.only('does the focused thing', () => {});
  });

  describe.each([1, 2])('table case %i', (_n) => {
    it('handles the case', () => {});
  });
});
