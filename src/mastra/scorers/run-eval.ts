#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderMetricsReport, runAllScenarios } from './eval-harness.ts';

/**
 * The reproducible entry point behind `npm run eval`. Runs every seeded
 * scenario for real — a real Groq call per scenario, a real Vitest
 * subprocess run against each one's changed state — and writes the metrics
 * report next to the scenarios it was measured from, so "reproducible by
 * anyone" means what it says: clone the repo, set an API key, run one
 * command, get this file back.
 */

const outputPath = fileURLToPath(new URL('../../../fixtures/sample-repo-scenarios/metrics-report.md', import.meta.url));

console.log('Running all seeded scenarios through the real triage workflow...\n');
const results = await runAllScenarios();

const missed = results.filter((r) => r.regressionScore === 0);
for (const r of results) {
  const flag = r.regressionScore === 0 ? '❌ MISSED REGRESSION' : '✅';
  console.log(`${flag} ${r.scenario.name} — confidence ${r.triage.confidence.toFixed(2)}`);
}

const report = renderMetricsReport(results);
writeFileSync(outputPath, report, 'utf8');
console.log(`\nWrote ${path.basename(outputPath)}\n`);
console.log(report);

if (missed.length > 0) {
  console.error(`\n${missed.length} scenario(s) had a missed regression — see the report above.`);
  process.exitCode = 1;
}
