import { createTool } from '@mastra/core/tools';
import ts from 'typescript';
import { z } from 'zod';

/**
 * An **AST** (abstract syntax tree) is source code represented as a tree of
 * nodes you can query programmatically, instead of a flat string. The
 * `git-diff-tool` guesses at symbol names with regex over diff text — fast,
 * but blind to anything the regex doesn't anticipate. This tool asks the real
 * TypeScript compiler to parse the file and read its structure directly:
 * every import, every export, every top-level declaration, exactly as
 * TypeScript itself understands them.
 *
 * `ts.createSourceFile` does a **syntactic** parse only — it builds the tree
 * without resolving types or following imports to other files. That's
 * deliberate and enough for this tool: extracting "what does this file import
 * and export" needs no type information, and skipping the type checker keeps
 * this fast enough to run on every changed file in a diff.
 */

const importSchema = z.object({
  specifier: z.string().describe('The module string as written, e.g. "./utils" or "zod".'),
  kind: z.enum(['static', 'dynamic']).describe('"dynamic" for import(), which can appear anywhere in a file.'),
  isTypeOnly: z.boolean().describe('True for `import type { X } from ...`, which has no dependency at runtime.'),
  isSideEffectOnly: z.boolean().describe('True for `import "./x"` — no bindings, imported for its side effects.'),
  defaultImport: z.string().optional(),
  namespaceImport: z.string().optional().describe('The local name for `import * as ns from ...`.'),
  namedImports: z.array(z.string()).describe('Local names bound by `import { a, b } from ...`.'),
});

const exportSchema = z.object({
  name: z.string().describe('The exported (public) name — for `export { a as b }`, this is "b", not "a".'),
  isReExport: z.boolean().describe('True when this export forwards from another module (`export ... from`).'),
  reExportSource: z.string().optional().describe('The forwarded-from module specifier, present only when isReExport is true.'),
});

const declarationSchema = z.object({
  name: z.string(),
  kind: z.enum(['function', 'class', 'interface', 'type', 'enum', 'variable']),
  isExported: z.boolean(),
});

export const astParseInputSchema = z.object({
  filePath: z.string().describe('Repo-relative path, used only for error messages — parsing works on sourceText.'),
  sourceText: z.string().describe('The full contents of the TypeScript file to parse.'),
});

export const astParseOutputSchema = z.object({
  filePath: z.string(),
  imports: z.array(importSchema),
  exports: z.array(exportSchema),
  declarations: z.array(declarationSchema),
  /**
   * True when a file's only content is re-exports from other modules — the
   * classic `index.ts` barrel pattern. Declared here, at the single file
   * being parsed, because it's a fact about this file alone. The import
   * graph tool is what turns it into a warning about a *chain* of files.
   */
  isBarrel: z.boolean().describe('True when the file has no local declarations and re-exports from elsewhere.'),
});

export type ImportInfo = z.infer<typeof importSchema>;
export type ExportInfo = z.infer<typeof exportSchema>;
export type DeclarationInfo = z.infer<typeof declarationSchema>;
export type AstParseResult = z.infer<typeof astParseOutputSchema>;

function parseImport(node: ts.ImportDeclaration): ImportInfo | undefined {
  if (!ts.isStringLiteral(node.moduleSpecifier)) return undefined; // dynamic specifiers on a static import can't happen, but stay defensive

  const clause = node.importClause;
  const namedBindings = clause?.namedBindings;

  return {
    specifier: node.moduleSpecifier.text,
    kind: 'static',
    isTypeOnly: clause?.isTypeOnly ?? false,
    isSideEffectOnly: clause === undefined,
    defaultImport: clause?.name?.text,
    namespaceImport: namedBindings && ts.isNamespaceImport(namedBindings) ? namedBindings.name.text : undefined,
    namedImports:
      namedBindings && ts.isNamedImports(namedBindings) ? namedBindings.elements.map((el) => el.name.text) : [],
  };
}

/** Dynamic `import()` calls are expressions, not statements — they can appear
 * anywhere in a file, so finding them means walking the whole tree rather
 * than just the top-level statement list. */
function findDynamicImports(sourceFile: ts.SourceFile): ImportInfo[] {
  const found: ImportInfo[] = [];

  function visit(node: ts.Node): void {
    // `ts.isImportCall` exists at runtime but isn't part of the public .d.ts,
    // so it type-checks as absent even though it works — this is the typed
    // equivalent: a call expression whose callee is literally the `import`
    // keyword, as opposed to a function named `import` (which can't happen)
    // or a reference to some `import` variable (also can't happen — it's a
    // reserved word).
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) {
        found.push({
          specifier: arg.text,
          kind: 'dynamic',
          isTypeOnly: false,
          isSideEffectOnly: false,
          namedImports: [],
        });
      }
      // A computed specifier (a variable, a template with interpolation) has
      // no static string to resolve — the tool can see *that* a dynamic
      // import exists here, but not *what* it targets. That gap is exactly
      // the kind of thing the confidence score has to discount for.
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

function parseExportDeclaration(node: ts.ExportDeclaration): ExportInfo[] {
  const reExportSource =
    node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
  const isReExport = reExportSource !== undefined;

  const clause = node.exportClause;
  if (!clause) {
    // `export * from './x'` — re-exports everything, under no fixed name.
    return [{ name: '*', isReExport, reExportSource }];
  }
  if (ts.isNamespaceExport(clause)) {
    // `export * as ns from './x'`
    return [{ name: clause.name.text, isReExport, reExportSource }];
  }
  // `export { a, b as c }` or `export { a, b as c } from './x'`.
  // `.name` is the exported (public) name; `.propertyName`, if present, is
  // the original name in the source module — we only need the public one.
  return clause.elements.map((el) => ({ name: el.name.text, isReExport, reExportSource }));
}

interface DeclarationMatch {
  kind: DeclarationInfo['kind'];
  /** Undefined for an anonymous default export (`export default function () {}`). */
  nameNode: ts.Identifier | undefined;
}

/**
 * Narrows a statement to its declaration kind and name node in one pass.
 * Reading `.name` off each specific node type, rather than casting the
 * statement to a generic `NamedDeclaration`, is what TypeScript's own type
 * system will actually vouch for — `Statement` and `NamedDeclaration` don't
 * overlap enough for a direct cast to type-check.
 */
function matchDeclaration(node: ts.Statement): DeclarationMatch | undefined {
  if (ts.isFunctionDeclaration(node)) return { kind: 'function', nameNode: node.name };
  if (ts.isClassDeclaration(node)) return { kind: 'class', nameNode: node.name };
  if (ts.isInterfaceDeclaration(node)) return { kind: 'interface', nameNode: node.name };
  if (ts.isTypeAliasDeclaration(node)) return { kind: 'type', nameNode: node.name };
  if (ts.isEnumDeclaration(node)) return { kind: 'enum', nameNode: node.name };
  return undefined;
}

function isExported(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function isDefaultExport(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
}

/**
 * Parses a single TypeScript file's imports, exports, and top-level
 * declarations from its source text.
 *
 * Exported separately from the Mastra tool so the import-graph tool can call
 * it directly — and so it can be unit tested without going through Mastra's
 * tool-execution machinery, the same pattern used for
 * `parseUnifiedDiff`.
 */
export function parseTypeScriptFile(filePath: string, sourceText: string): AstParseResult {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);

  const imports: ImportInfo[] = [];
  const exports: ExportInfo[] = [];
  const declarations: DeclarationInfo[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const parsed = parseImport(statement);
      if (parsed) imports.push(parsed);
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      exports.push(...parseExportDeclaration(statement));
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      // `export default someExpression;` (isExportEquals false) or the
      // legacy CommonJS-interop `export = someExpression;` (true). Both name
      // a single value; there's no finer-grained name to report.
      exports.push({ name: 'default', isReExport: false });
      continue;
    }

    const match = matchDeclaration(statement);
    if (match) {
      const isDefault = isDefaultExport(statement);
      const declaredName = match.nameNode?.text ?? (isDefault ? 'default' : undefined);
      if (declaredName) {
        const exported = isExported(statement);
        // The declaration keeps its real local name (useful for matching
        // against symbol references elsewhere) — but a default export's
        // *public* binding is always literally "default", regardless of
        // what the function or class is named internally.
        declarations.push({ name: declaredName, kind: match.kind, isExported: exported });
        if (exported) exports.push({ name: isDefault ? 'default' : declaredName, isReExport: false });
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const exported = isExported(statement);
      for (const decl of statement.declarationList.declarations) {
        // Destructuring declarations (`const { a, b } = x`) have no single
        // name to report — a real gap, but a narrow one: top-level
        // destructuring is rare, and the diff tool's regex pass over the diff text
        // remains a fallback signal for anything this misses.
        if (!ts.isIdentifier(decl.name)) continue;
        const declaredName = decl.name.text;
        declarations.push({ name: declaredName, kind: 'variable', isExported: exported });
        if (exported) exports.push({ name: declaredName, isReExport: false });
      }
    }
  }

  imports.push(...findDynamicImports(sourceFile));

  // A barrel file re-exports other modules' content instead of declaring its
  // own — the textbook shape is an index.ts that is nothing but `export *
  // from './x'` lines. No local declarations, at least one re-export.
  const isBarrel = declarations.length === 0 && exports.some((e) => e.isReExport);

  return { filePath, imports, exports, declarations, isBarrel };
}

/**
 * The Mastra tool wrapping the parser above. Takes source text directly
 * (rather than reading a file itself) so it stays pure and Studio-testable —
 * paste any TypeScript snippet in and see exactly what the parser sees.
 */
export const astParseTool = createTool({
  id: 'ast-parse-tool',
  description:
    'Parses a TypeScript file into its imports, exports, and top-level declarations using the real ' +
    'TypeScript compiler (a syntactic parse only — no type checking). More accurate than pattern-matching ' +
    'over diff text, at the cost of needing the full file rather than just a diff.',
  inputSchema: astParseInputSchema,
  outputSchema: astParseOutputSchema,
  execute: async (inputData) => parseTypeScriptFile(inputData.filePath, inputData.sourceText),
});
