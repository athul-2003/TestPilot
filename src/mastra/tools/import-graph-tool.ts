import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createTool } from '@mastra/core/tools';
import ts from 'typescript';
import { z } from 'zod';

import { TESTPILOT_CACHE_DIRNAME, MAX_IMPACT_DEPTH } from '../config.ts';
import { parseTypeScriptFile } from './ast-parse-tool.ts';

/**
 * Given a set of changed files, this tool answers "who depends on them?" —
 * directly and transitively — by building a **reverse dependency graph**: for
 * every file in the repo, which other files import it. A changed file's
 * dependents are exactly the tests most likely to be affected, which is the
 * question test selection ultimately needs answered.
 *
 * Building that graph means resolving every import specifier in every file to
 * an actual path on disk — relative imports, `tsconfig` path aliases, and
 * barrel files (an `index.ts` that only re-exports other modules) all need
 * handling, or the graph silently gets the wrong answer. See the file-level
 * comments below for how each is handled.
 */

// --- Schemas -------------------------------------------------------------

const dependentSchema = z.object({
  file: z.string(),
  depth: z.number().int().positive().describe('1 = imports the changed file directly; 2 = imports an importer; and so on.'),
  throughBarrel: z
    .boolean()
    .describe(
      'True if a barrel file sits anywhere on the path from the changed file to this dependent. A barrel ' +
        're-exports rather than uses its imports directly, so relationships passing through one are a weaker ' +
        'signal than a direct import — test selection should weigh these down.',
    ),
});

const impactedEntrySchema = z.object({
  file: z.string(),
  found: z.boolean().describe('False when the file was not present in the scanned repo — e.g. it was deleted.'),
  isBarrel: z.boolean(),
  dependents: z.array(dependentSchema),
  depthLimitReached: z
    .boolean()
    .describe('True if the search hit maxDepth with more of the graph left unexplored — the dependents list may be incomplete.'),
});

export const importGraphInputSchema = z.object({
  repoRoot: z.string().describe('Absolute path to the repository being analysed.'),
  changedFiles: z.array(z.string()).min(1).describe('Repo-relative paths (forward slashes) of the changed files.'),
  maxDepth: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`How many hops to follow before giving up. Defaults to ${MAX_IMPACT_DEPTH}.`),
  cacheDir: z
    .string()
    .optional()
    .describe('Overrides where the on-disk graph cache lives. Mainly for tests, so runs stay isolated from each other.'),
});

export const importGraphOutputSchema = z.object({
  impacted: z.array(impactedEntrySchema),
  graphStats: z.object({
    filesScanned: z.number().describe('Total .ts/.tsx files found in the repo (excluding node_modules and build output).'),
    filesParsed: z
      .number()
      .describe('Subset of filesScanned that were freshly parsed rather than served from the on-disk cache.'),
  }),
});

export type Dependent = z.infer<typeof dependentSchema>;
export type ImpactedEntry = z.infer<typeof impactedEntrySchema>;
export type ImportGraphResult = z.infer<typeof importGraphOutputSchema>;

// --- Directory walking -----------------------------------------------------

const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.mastra',
  'coverage',
  '.turbo',
  'out',
]);

/**
 * Repo-relative, forward-slash paths of every TypeScript or JavaScript
 * Exported for reuse by test-inventory-tool.ts, so the excluded-directories
 * list and the walking logic itself live in exactly one place.
 */
export function walkTypeScriptFiles(repoRoot: string, cacheDirName: string): string[] {
  const excluded = new Set([...DEFAULT_EXCLUDE_DIRS, cacheDirName]);
  const results: string[] = [];

  function walk(absDir: string, relDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable directory (permissions, race with a concurrent delete) — skip rather than fail the whole scan
    }
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (excluded.has(entry.name)) continue;
        walk(path.join(absDir, entry.name), relPath);
      } else if (entry.isFile() && SOURCE_FILE_RE.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        results.push(relPath);
      }
    }
  }

  walk(repoRoot, '');
  return results;
}

// --- tsconfig path aliases ---------------------------------------------

export interface AliasEntry {
  prefix: string;
  hasWildcard: boolean;
  targets: string[]; // relative to baseUrl; wildcard '*' already stripped
}

export interface AliasConfig {
  baseUrl: string; // relative to repoRoot
  entries: AliasEntry[];
}

/**
 * Reads `paths`/`baseUrl` out of the target repo's tsconfig.json — using
 * TypeScript's own config reader rather than `JSON.parse`, since tsconfig
 * files routinely contain comments and trailing commas that a strict JSON
 * parser rejects.
 */
export function loadTsconfigAliases(repoRoot: string): AliasConfig | undefined {
  const configPath = path.join(repoRoot, 'tsconfig.json');
  if (!fs.existsSync(configPath)) return undefined;

  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  if (error || !config) return undefined;

  const compilerOptions = config.compilerOptions as Record<string, unknown> | undefined;
  const rawPaths = compilerOptions?.paths as Record<string, string[]> | undefined;
  if (!rawPaths) return undefined;

  const baseUrl = typeof compilerOptions?.baseUrl === 'string' ? compilerOptions.baseUrl : '.';
  const entries: AliasEntry[] = Object.entries(rawPaths).map(([key, targets]) => {
    const hasWildcard = key.endsWith('*');
    return {
      prefix: hasWildcard ? key.slice(0, -1) : key,
      hasWildcard,
      targets: targets.map((t) => (t.endsWith('*') ? t.slice(0, -1) : t)),
    };
  });

  return { baseUrl, entries };
}

function matchAlias(specifier: string, alias: AliasConfig): string[] {
  for (const entry of alias.entries) {
    if (entry.hasWildcard) {
      if (specifier.startsWith(entry.prefix)) {
        const rest = specifier.slice(entry.prefix.length);
        return entry.targets.map((t) => `${t}${rest}`);
      }
    } else if (specifier === entry.prefix) {
      return entry.targets;
    }
  }
  return [];
}

// --- Module resolution ---------------------------------------------------

/**
 * Extensions the graph indexes, in resolution-preference order.
 *
 * JavaScript is included deliberately: TypeScript's parser handles `.js`
 * and `.jsx` natively, so supporting them costs nothing but the list, and
 * excluding them would mean a plain JavaScript repository — by far the
 * larger ecosystem — got an empty graph and no reachability signal at all.
 */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;

/** Matches any file the graph will index. */
export const SOURCE_FILE_RE = /\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/;

function extensionCandidates(basePosixNoExt: string): string[] {
  return [
    ...SOURCE_EXTENSIONS.map((ext) => `${basePosixNoExt}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => `${basePosixNoExt}/index${ext}`),
  ];
}

/**
 * Resolves one import specifier to a repo-relative path, or `undefined` if it
 * points outside the repo (an npm package) or can't be found.
 *
 * Relative specifiers (`./x`, `../x`) resolve against the importing file's
 * directory. Bare specifiers (`zod`, `@lib/x`) are checked against tsconfig
 * path aliases, if any are configured; anything left over is treated as an
 * external package — correctly, most of the time, but a specifier that isn't
 * relative and doesn't match an alias is assumed external even if it *would*
 * have resolved under a resolution strategy this tool doesn't implement
 * (Node's package-exports resolution, for one). That gap only affects
 * confidence in the graph reach, not correctness of what it does resolve.
 */
export function resolveModuleSpecifier(
  fromFile: string,
  specifier: string,
  alias: AliasConfig | undefined,
  existingFiles: Set<string>,
): string | undefined {
  let baseCandidates: string[];

  if (specifier.startsWith('.')) {
    const fromDir = path.posix.dirname(fromFile);
    baseCandidates = [path.posix.normalize(path.posix.join(fromDir, specifier))];
  } else if (alias) {
    const aliasTargets = matchAlias(specifier, alias);
    if (aliasTargets.length === 0) return undefined;
    baseCandidates = aliasTargets.map((t) => path.posix.normalize(path.posix.join(alias.baseUrl, t)));
  } else {
    return undefined;
  }

  for (const base of baseCandidates) {
    if (SOURCE_FILE_RE.test(base)) {
      // The literal path wins when it exists — in a JavaScript repo, `./x.js`
      // really is `x.js`.
      if (existingFiles.has(base)) return base;

      // Otherwise, Node16/NodeNext-style ESM: the source imports the
      // *compiled* ".js" path while the file on disk is still ".ts". Both
      // conventions exist in the wild, so try the TypeScript twin before
      // giving up.
      const swapped = base.replace(/\.(jsx?|mjs|cjs)$/, (m) => {
        if (m === '.jsx') return '.tsx';
        if (m === '.mjs') return '.mts';
        if (m === '.cjs') return '.cts';
        return '.ts';
      });
      if (swapped !== base && existingFiles.has(swapped)) return swapped;
      continue;
    }
    for (const candidate of extensionCandidates(base)) {
      if (existingFiles.has(candidate)) return candidate;
    }
  }

  return undefined;
}

// --- On-disk cache ---------------------------------------------------------

const CACHE_VERSION = 2;

interface CacheFileEntry {
  mtimeMs: number;
  hash: string;
  isBarrel: boolean;
  /**
   * Raw, unresolved import/re-export specifiers extracted by the parser —
   * deliberately NOT the resolved `dependsOn` paths. A specifier that
   * couldn't resolve when this file was last parsed (its target didn't
   * exist yet) may resolve on a later run where that target has since been
   * added, without this file itself changing at all. Caching the resolved
   * paths would freeze that miss forever; caching the specifiers lets every
   * run re-resolve against the *current* file set for the cost of a Set
   * lookup, no re-parse required.
   */
  specifiers: string[];
}

interface GraphCacheFile {
  version: number;
  files: Record<string, CacheFileEntry>;
}

function loadCache(cachePath: string): GraphCacheFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as GraphCacheFile;
    if (parsed.version !== CACHE_VERSION) return { version: CACHE_VERSION, files: {} };
    return parsed;
  } catch {
    return { version: CACHE_VERSION, files: {} }; // missing, unreadable, or corrupt — rebuild from scratch
  }
}

function saveCache(cachePath: string, cache: GraphCacheFile): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
}

function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

// --- Graph building --------------------------------------------------------

export interface ImportGraph {
  /** file -> the files it depends on (imports + re-exports). */
  forward: Map<string, string[]>;
  isBarrel: Map<string, boolean>;
  filesScanned: number;
  filesParsed: number;
}

/**
 * Walks the repo, parses every TypeScript file (via {@link parseTypeScriptFile}),
 * resolves its imports and re-exports to real files, and returns the forward
 * dependency graph — reading from and writing back to an on-disk cache so
 * unchanged files aren't re-parsed on the next run.
 *
 * Cache invalidation is two-tier, keyed on **mtime first, content hash
 * second**: if a file's modification time matches the cached entry, the cache
 * is trusted without even reading the file. If the mtime differs — the file
 * was touched, which happens on every fresh `git checkout` whether or not
 * content actually changed — the content is read and hashed; a hash match
 * still reuses the cached parse, and only a genuine content change triggers a
 * re-parse. This keeps a warm cache cheap even after operations that touch
 * mtimes without touching content.
 */
export function buildImportGraph(repoRoot: string, cacheDir?: string): ImportGraph {
  const cachePath = path.join(cacheDir ?? path.join(repoRoot, TESTPILOT_CACHE_DIRNAME), 'import-graph.json');
  const cache = loadCache(cachePath);
  const alias = loadTsconfigAliases(repoRoot);

  const files = walkTypeScriptFiles(repoRoot, TESTPILOT_CACHE_DIRNAME);
  const existingFiles = new Set(files);

  const forward = new Map<string, string[]>();
  const isBarrelMap = new Map<string, boolean>();
  const nextCacheFiles: Record<string, CacheFileEntry> = {};
  let filesParsed = 0;

  for (const relFile of files) {
    const absFile = path.join(repoRoot, ...relFile.split('/'));
    const stat = fs.statSync(absFile);
    const cached = cache.files[relFile];

    let entry: CacheFileEntry;

    if (cached && cached.mtimeMs === stat.mtimeMs) {
      entry = cached;
    } else {
      const content = fs.readFileSync(absFile, 'utf8');
      const hash = hashContent(content);

      if (cached && cached.hash === hash) {
        entry = { ...cached, mtimeMs: stat.mtimeMs };
      } else {
        const parsed = parseTypeScriptFile(relFile, content);
        // A re-export edge is a dependency like any other: the re-exporting
        // file needs the target module's content to exist. Treating them
        // identically to normal imports here — rather than special-casing
        // barrel files into "counts as depth 1 for everything it re-exports"
        // — is what keeps a barrel's fan-out from silently inflating the
        // blast radius. It shows up honestly as one extra hop instead.
        const specifiers = [
          ...parsed.imports.map((i) => i.specifier),
          ...parsed.exports.filter((e) => e.isReExport && e.reExportSource).map((e) => e.reExportSource!),
        ];
        entry = { mtimeMs: stat.mtimeMs, hash, isBarrel: parsed.isBarrel, specifiers };
        filesParsed++;
      }
    }

    nextCacheFiles[relFile] = entry;

    // Re-resolve every run, cache hit or not: a specifier that failed to
    // resolve when this file was last parsed may resolve now if its target
    // was added elsewhere since, without this file changing at all. This is
    // a Set lookup per specifier, not a re-parse — cheap enough to always do.
    const dependsOn = new Set<string>();
    for (const specifier of entry.specifiers) {
      const resolved = resolveModuleSpecifier(relFile, specifier, alias, existingFiles);
      if (resolved) dependsOn.add(resolved);
    }

    forward.set(relFile, [...dependsOn]);
    isBarrelMap.set(relFile, entry.isBarrel);
  }

  saveCache(cachePath, { version: CACHE_VERSION, files: nextCacheFiles });

  return { forward, isBarrel: isBarrelMap, filesScanned: files.length, filesParsed };
}

// --- Querying dependents -----------------------------------------------

/**
 * For each changed file, breadth-first-searches the **reverse** graph (who
 * imports this?) outward, up to `maxDepth` hops, tracking at each hop whether
 * a barrel file sits anywhere on the path back to the changed file.
 *
 * A deleted file can never appear here: resolution only succeeds against
 * files the current tree-walk actually found, so nothing can resolve *to* a
 * path that no longer exists. Querying one correctly returns `found: false`.
 */
export function computeImpactedFiles(graph: ImportGraph, changedFiles: string[], maxDepth: number): ImpactedEntry[] {
  const reverse = new Map<string, string[]>();
  for (const [file, deps] of graph.forward) {
    for (const dep of deps) {
      const importers = reverse.get(dep);
      if (importers) importers.push(file);
      else reverse.set(dep, [file]);
    }
  }

  return changedFiles.map((rawChangedFile) => {
    const changedFile = rawChangedFile.replace(/\\/g, '/');

    if (!graph.forward.has(changedFile)) {
      return { file: changedFile, found: false, isBarrel: false, dependents: [], depthLimitReached: false };
    }

    const dependents: Dependent[] = [];
    const throughBarrelOf = new Map<string, boolean>();
    const visited = new Set<string>([changedFile]);
    let frontier = [changedFile];
    let depth = 0;

    while (frontier.length > 0 && depth < maxDepth) {
      depth++;
      const nextFrontier: string[] = [];

      for (const node of frontier) {
        for (const importer of reverse.get(node) ?? []) {
          if (visited.has(importer)) continue;
          visited.add(importer);

          const nodeIsBarrier = graph.isBarrel.get(node) ?? false;
          const nodeAlreadyThroughBarrel = node === changedFile ? false : (throughBarrelOf.get(node) ?? false);
          const importerIsBarrier = graph.isBarrel.get(importer) ?? false;
          const throughBarrel = nodeIsBarrier || nodeAlreadyThroughBarrel || importerIsBarrier;

          throughBarrelOf.set(importer, throughBarrel);
          dependents.push({ file: importer, depth, throughBarrel });
          nextFrontier.push(importer);
        }
      }

      frontier = nextFrontier;
    }

    return {
      file: changedFile,
      found: true,
      isBarrel: graph.isBarrel.get(changedFile) ?? false,
      dependents,
      // frontier still non-empty means depth was exhausted before the
      // search ran out of graph to explore — the list above is accurate as
      // far as it goes, but may not be complete.
      depthLimitReached: frontier.length > 0,
    };
  });
}

// --- Mastra tool -----------------------------------------------------------

export const importGraphTool = createTool({
  id: 'import-graph-tool',
  description:
    'Given a set of changed files, builds (or loads from cache) the repo-wide reverse import graph and ' +
    'returns each file that depends on them, directly or transitively, with the hop count and whether a ' +
    'barrel file mediates the relationship.',
  inputSchema: importGraphInputSchema,
  outputSchema: importGraphOutputSchema,
  execute: async (inputData) => {
    const graph = buildImportGraph(inputData.repoRoot, inputData.cacheDir);
    const impacted = computeImpactedFiles(graph, inputData.changedFiles, inputData.maxDepth ?? MAX_IMPACT_DEPTH);
    return { impacted, graphStats: { filesScanned: graph.filesScanned, filesParsed: graph.filesParsed } };
  },
});
