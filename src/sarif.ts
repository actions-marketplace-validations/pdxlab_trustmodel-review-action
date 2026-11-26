// TRUS-2596: opt-in SARIF 2.1.0 output for GitHub Code Scanning.
//
// The server scores the PR's AI-related files as a whole: a total TrustScore
// plus one score per dimension. It does not say which file or line caused a
// low score, so every result here is file-level (line 1) on the AI files that
// were scored, and its message says so. Nothing is reported for an unscored,
// errored or unavailable review, and a website score never becomes a finding.
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'fs';
import * as path from 'path';
import { ReviewMode } from './config';
import { matchesDetection } from './detector';
import { DimensionScore, EvalResult, verifiedPass } from './eval';

export const RULE_BELOW_THRESHOLD = 'trustmodel/trust-score-below-threshold';
export const RULE_WEAK_DIMENSION = 'trustmodel/weak-dimension';
// The evaluator reads at most a handful of files; more alerts would be noise.
export const MAX_SARIF_FILES = 10;
const FILE_LEVEL_NOTE = 'The score covers the AI-related files changed in this pull request; it is not tied to a specific line.';

const RULES = [
  { id: RULE_BELOW_THRESHOLD, name: 'TrustScoreBelowThreshold',
    shortDescription: { text: 'Trust Review score below threshold' },
    fullDescription: { text: 'The TrustModel Trust Review score for the AI-related changes in this pull request is below the configured threshold.' },
    defaultConfiguration: { level: 'error' } },
  { id: RULE_WEAK_DIMENSION, name: 'WeakTrustDimension',
    shortDescription: { text: 'Trust Review dimension below threshold' },
    fullDescription: { text: 'The pull request passed Trust Review overall, but one or more trust dimensions scored below the threshold.' },
    defaultConfiguration: { level: 'note' } },
].map(rule => ({ ...rule, helpUri: 'https://github.com/pdxlab/trustmodel-review-action#code-scanning-sarif' }));

/** Validate the sarif_file input: a plain relative .sarif path inside the workspace. */
export function resolveSarifPath(input: string, workspace: string): string {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(input) || !input.endsWith('.sarif') || input.startsWith('/')
      || input.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('sarif_file must be a relative path ending in .sarif, inside the workspace.');
  }
  const root = path.resolve(workspace);
  const target = path.resolve(root, input);
  if (!target.startsWith(root + path.sep)) throw new Error('sarif_file must stay inside the workspace.');
  return target;
}

/**
 * The AI files the server scored: the changed paths its AI-file rules accept
 * (the Action's default rules mirror the gateway's) that still exist at the PR
 * head. Only existence is checked; file content is never read.
 */
export function scoredFiles(changedFiles: string[], workspace: string): string[] {
  return [...new Set(changedFiles)]
    .filter(file => matchesDetection(file, []) && existsSync(path.resolve(workspace, file)))
    .sort()
    .slice(0, MAX_SARIF_FILES);
}

/**
 * Noise rule: a dimension is flagged only when it is clearly below the
 * threshold. If its confidence band reaches the threshold, the gap is within
 * judge noise and is not reported.
 */
export function weakDimensions(dimensions: DimensionScore[], threshold: number): DimensionScore[] {
  return dimensions.filter(d => d.score < threshold && (d.ciHigh === null || d.ciHigh < threshold));
}

const listDimensions = (dims: DimensionScore[]) => dims.map(d => `${d.name} ${Math.round(d.score)}/100`).join(', ');
const uri = (file: string) => file.split('/').map(encodeURIComponent).join('/');

/**
 * Build the SARIF log, or null when there is nothing truthful to report
 * (unscored, errored or unavailable). A skipped review or a clean pass gives an
 * empty result list, so Code Scanning closes earlier alerts.
 */
export function buildSarif(opts: { result: EvalResult; files: string[]; mode: ReviewMode; threshold: number }): object | null {
  const { result, files, mode } = opts;
  let results: object[] = [];
  if (result.status !== 'skipped') {
    const evaluated = result.prDiffEvaluated && result.trustScore !== null && (result.status === 'passed' || result.status === 'failed');
    if (!evaluated) return null;
    const threshold = result.threshold ?? opts.threshold;
    const below = !verifiedPass(result);
    const weak = weakDimensions(result.dimensions ?? [], threshold);
    if (below || weak.length) {
      if (!files.length) return null; // cannot place a finding honestly
      const text = below
        ? [`Trust Review scored this pull request ${result.trustScore}/100, below the threshold of ${threshold}.`,
           weak.length ? `Weakest dimensions: ${listDimensions(weak)}.` : '', FILE_LEVEL_NOTE,
           mode === 'advisory' ? 'Advisory mode: this does not block the merge.' : '']
        : [`Trust Review passed this pull request (${result.trustScore}/100), but these dimensions scored below the threshold of ${threshold}: ${listDimensions(weak)}.`,
           FILE_LEVEL_NOTE];
      const ruleId = below ? RULE_BELOW_THRESHOLD : RULE_WEAK_DIMENSION;
      const level = !below ? 'note' : mode === 'enforce' ? 'error' : 'warning';
      results = files.map(file => ({
        ruleId, ruleIndex: below ? 0 : 1, level,
        message: { text: text.filter(Boolean).join(' ') },
        locations: [{ physicalLocation: { artifactLocation: { uri: uri(file) }, region: { startLine: 1 } } }],
        properties: { trust_score: result.trustScore, threshold, mode },
      }));
    }
  }
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'TrustModel Review', informationUri: 'https://github.com/pdxlab/trustmodel-review-action', rules: RULES } },
      automationDetails: { id: 'trustmodel-review/' },
      results,
    }],
  };
}

/**
 * Write the log. The checkout is PR-controlled, so a symlinked directory or
 * file must not redirect the write outside the workspace.
 */
export function writeSarif(target: string, sarif: object, workspace: string): void {
  const root = realpathSync(path.resolve(workspace));
  const inside = (p: string) => p === root || p.startsWith(root + path.sep);
  let existing = path.dirname(target);
  while (!existsSync(existing)) existing = path.dirname(existing);
  if (!inside(realpathSync(existing))) throw new Error('sarif_file must stay inside the workspace.');
  mkdirSync(path.dirname(target), { recursive: true });
  if (!inside(realpathSync(path.dirname(target)))) throw new Error('sarif_file must stay inside the workspace.');
  // lstat, not existsSync: a dangling symlink must be refused too.
  let current;
  try { current = lstatSync(target); } catch { current = undefined; }
  if (current && !current.isFile()) throw new Error('sarif_file must be a regular file.');
  writeFileSync(target, JSON.stringify(sarif, null, 2) + '\n');
}
