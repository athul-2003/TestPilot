import { describe, expect, it } from 'vitest';

import { parseTypeScriptFile } from './ast-parse-tool.ts';

describe('parseTypeScriptFile', () => {
  it('parses every static import shape', () => {
    const result = parseTypeScriptFile(
      'probe.ts',
      `
import { z } from 'zod';
import type { Foo } from './foo';
import Bar, { baz as qux } from './bar';
import * as ns from './ns';
import './side-effect';
`,
    );

    expect(result.imports).toEqual([
      {
        specifier: 'zod',
        kind: 'static',
        isTypeOnly: false,
        isSideEffectOnly: false,
        defaultImport: undefined,
        namespaceImport: undefined,
        namedImports: ['z'],
      },
      {
        specifier: './foo',
        kind: 'static',
        isTypeOnly: true,
        isSideEffectOnly: false,
        defaultImport: undefined,
        namespaceImport: undefined,
        namedImports: ['Foo'],
      },
      {
        specifier: './bar',
        kind: 'static',
        isTypeOnly: false,
        isSideEffectOnly: false,
        defaultImport: 'Bar',
        namespaceImport: undefined,
        // "baz as qux" binds the local name "qux" — the aliased name is what
        // downstream code actually uses, so that's what's reported.
        namedImports: ['qux'],
      },
      {
        specifier: './ns',
        kind: 'static',
        isTypeOnly: false,
        isSideEffectOnly: false,
        defaultImport: undefined,
        namespaceImport: 'ns',
        namedImports: [],
      },
      {
        specifier: './side-effect',
        kind: 'static',
        isTypeOnly: false,
        isSideEffectOnly: true,
        defaultImport: undefined,
        namespaceImport: undefined,
        namedImports: [],
      },
    ]);
  });

  it('finds a dynamic import anywhere in the file, not just at the top level', () => {
    const result = parseTypeScriptFile(
      'probe.ts',
      `
async function loader() {
  if (Math.random() > 0.5) {
    const mod = await import('./dynamic-target');
    return mod;
  }
}
`,
    );

    expect(result.imports).toEqual([
      {
        specifier: './dynamic-target',
        kind: 'dynamic',
        isTypeOnly: false,
        isSideEffectOnly: false,
        namedImports: [],
      },
    ]);
  });

  it('does not resolve a dynamic import with a non-literal specifier', () => {
    const result = parseTypeScriptFile('probe.ts', `const path = './x'; import(path);`);
    expect(result.imports).toEqual([]);
  });

  it('parses every export shape, using the public (not local) name', () => {
    const result = parseTypeScriptFile(
      'probe.ts',
      `
export function greet() {}
export class Widget {}
export const x = 1;
const y = 2;
export { y as z2 };
export * from './re-a';
export { qux2 } from './re-b';
export * as reNs from './re-c';
export default function defaultFn() {}
`,
    );

    expect(result.exports).toEqual(
      expect.arrayContaining([
        { name: 'greet', isReExport: false, reExportSource: undefined },
        { name: 'Widget', isReExport: false, reExportSource: undefined },
        { name: 'x', isReExport: false, reExportSource: undefined },
        { name: 'z2', isReExport: false, reExportSource: undefined },
        { name: '*', isReExport: true, reExportSource: './re-a' },
        { name: 'qux2', isReExport: true, reExportSource: './re-b' },
        { name: 'reNs', isReExport: true, reExportSource: './re-c' },
        { name: 'default', isReExport: false, reExportSource: undefined },
      ]),
    );
    // "y" itself was never exported under its own name — only the "z2" alias was.
    expect(result.exports.map((e) => e.name)).not.toContain('y');
  });

  it('extracts every top-level declaration kind, exported or not', () => {
    const result = parseTypeScriptFile(
      'probe.ts',
      `
export function fn() {}
class Internal {}
export interface Shape {}
type Alias = string;
export enum Color { Red, Blue }
export const a = 1, b = 2;
`,
    );

    expect(result.declarations).toEqual(
      expect.arrayContaining([
        { name: 'fn', kind: 'function', isExported: true },
        { name: 'Internal', kind: 'class', isExported: false },
        { name: 'Shape', kind: 'interface', isExported: true },
        { name: 'Alias', kind: 'type', isExported: false },
        { name: 'Color', kind: 'enum', isExported: true },
        { name: 'a', kind: 'variable', isExported: true },
        { name: 'b', kind: 'variable', isExported: true },
      ]),
    );
  });

  it('skips a destructured top-level declaration rather than guessing a name', () => {
    const result = parseTypeScriptFile('probe.ts', `export const { a, b } = getPair();`);
    expect(result.declarations).toEqual([]);
  });

  it('flags a file as a barrel when it has no declarations and only re-exports', () => {
    const barrel = parseTypeScriptFile('index.ts', `export * from './a';\nexport * from './b';\n`);
    expect(barrel.isBarrel).toBe(true);

    const notBarrel = parseTypeScriptFile('regular.ts', `export function fn() {}\nexport * from './a';\n`);
    expect(notBarrel.isBarrel).toBe(false);

    const empty = parseTypeScriptFile('empty.ts', ``);
    expect(empty.isBarrel).toBe(false);
  });
});
