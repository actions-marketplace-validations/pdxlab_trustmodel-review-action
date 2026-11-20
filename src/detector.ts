import { execFileSync } from 'child_process';
import { minimatch } from 'minimatch';

export const DEFAULT_PATTERNS = [
  '**/*.prompt', '**/*.prompt.txt', '**/*.jinja', '**/*.jinja2', '**/prompts/**',
  '**/system_prompt*', '**/model_config*', '**/model-config*', '**/llm_config*',
  '**/ai_config*', '**/evals/**', '**/evaluations/**', '**/agents/**',
  '**/*agent*.py', '**/*agent*.ts', '**/*agent*.js', '**/chains/**',
  // Source files only: a tools/ directory also holds build scripts, binaries and data.
  '**/tools/**/*.py', '**/tools/**/*.ts', '**/tools/**/*.js',
  '.trustmodel.yml', 'trustmodel.config.*',
];

// TRUS-2595: known false positives of the default globs, decided from the path
// alone (source content is never read). Applied to the defaults only: a custom
// `detect` list means exactly what it says. Kept narrow on purpose, because an
// excluded path turns a PR into a green "skipped" status.
export const DEFAULT_EXCLUDES = [
  // HTTP user agents, not AI agents: user_agent.py, user-agent.ts, UserAgent.ts, useragent_parser.js
  '**/*user[_-]agent*', '**/*useragent*',
  // Dependencies and build output, never the repository's own AI code.
  '**/node_modules/**', '**/vendor/**', '**/.venv/**', '**/venv/**', '**/site-packages/**', '**/dist/**',
];

export function matchesDetection(file: string, patterns: string[]): boolean {
  if (patterns.length) return patterns.some(p => minimatch(file, p, { matchBase: true }));
  return DEFAULT_PATTERNS.some(p => minimatch(file, p, { matchBase: true }))
    && !DEFAULT_EXCLUDES.some(p => minimatch(file, p, { matchBase: true, nocase: true, dot: true }));
}

export interface DetectOptions { baseSha: string; headSha: string; patterns: string[] }
export async function detectAiChanges({ baseSha, headSha, patterns }: DetectOptions): Promise<string[]> {
  if (![baseSha, headSha].every(sha => /^[a-fA-F0-9]{40}$/.test(sha))) throw new Error('Expected real commit SHAs.');
  // No source file reads, shell interpolation, or fallback to a different diff.
  // --no-renames exposes both old and new paths when a policy file is moved.
  const output = execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', `${baseSha}...${headSha}`],
                              { encoding: 'utf8', maxBuffer: 2_000_000 });
  const files = [...new Set(output.split('\0').filter(Boolean))];
  if (files.length > 3000) throw new Error('Too many changed files for a complete metadata receipt.');
  return files.filter(f => matchesDetection(f, patterns));
}
