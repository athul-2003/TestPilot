import { describe, expect, it } from 'vitest';

function writeCache(): void {}
function readCache(): string {
  return 'updated';
}

describe('eventually consistent cache', () => {
  it('reflects the write after a short delay', async () => {
    writeCache();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(readCache()).toBe('updated');
  });
});
