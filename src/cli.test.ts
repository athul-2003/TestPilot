import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { formatUnknown, parseArgs } from './cli.ts';

describe('parseArgs', () => {
  it('defaults to the current directory and "main" with no flags', () => {
    const result = parseArgs([]);
    if (result === 'help') throw new Error('expected options, got help');
    expect(result.repoRoot).toBe(process.cwd());
    expect(result.base).toBe(process.env.GITHUB_BASE_REF ?? 'main');
    expect(result.json).toBe(false);
    expect(result.diffFile).toBeUndefined();
    expect(result.outFile).toBeUndefined();
  });

  it('resolves --repo-root to an absolute path', () => {
    const result = parseArgs(['--repo-root', 'some/relative/dir']);
    if (result === 'help') throw new Error('expected options, got help');
    expect(result.repoRoot).toBe(path.resolve('some/relative/dir'));
  });

  it('parses every flag together', () => {
    const result = parseArgs(['--base', 'develop', '--diff-file', 'x.diff', '--json', '--out', 'out.json']);
    if (result === 'help') throw new Error('expected options, got help');
    expect(result.base).toBe('develop');
    expect(result.diffFile).toBe('x.diff');
    expect(result.json).toBe(true);
    expect(result.outFile).toBe('out.json');
  });

  it('returns "help" for -h or --help, ignoring anything else on the line', () => {
    expect(parseArgs(['--help'])).toBe('help');
    expect(parseArgs(['-h'])).toBe('help');
    expect(parseArgs(['--base', 'main', '--help'])).toBe('help');
  });

  it('rejects an unrecognised flag', () => {
    expect(() => parseArgs(['--not-a-real-flag'])).toThrow(/Unrecognised argument/);
  });

  it('rejects a flag missing its required value', () => {
    expect(() => parseArgs(['--base'])).toThrow(/requires a value/);
  });
});

describe('formatUnknown', () => {
  it('prefers an Error\'s stack trace, falling back to its message', () => {
    const err = new Error('boom');
    expect(formatUnknown(err)).toBe(err.stack);
  });

  it('passes a plain string through unchanged', () => {
    expect(formatUnknown('already a string')).toBe('already a string');
  });

  it('formats a plain object as readable JSON, not "[object Object]"', () => {
    const result = formatUnknown({ code: 'FAILED', detail: 'something specific' });
    expect(result).toContain('"code": "FAILED"');
    expect(result).not.toBe('[object Object]');
  });

  it('falls back to String() for a value JSON cannot represent, such as a circular object', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatUnknown(circular)).not.toThrow();
  });
});
