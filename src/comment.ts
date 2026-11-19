import * as github from '@actions/github';
import { EvalResult, verifiedPass, commitState } from './eval';
import { WebsiteResult, websiteComment } from './website';
export const MARKER = '<!-- trustmodel-trust-review -->';
type Octokit = ReturnType<typeof github.getOctokit>;

function prComment(result: EvalResult): string {
  if (!result.prDiffEvaluated) return [
    MARKER, '## Trust Review — not available', '',
    'The PR diff evaluator is not available. **No code was evaluated and no passing gate was issued.**', '',
    'Full PR-diff evaluation must ship before this can be a required merge gate.',
  ].join('\n');
  return [MARKER, `## Trust Review — ${verifiedPass(result) ? 'passed' : 'not passed'}`, '',
          `PR diff evaluated: yes. Score: ${result.trustScore ?? 'unscored'}/100.`,
          result.reportUrl ? `[Report](${result.reportUrl})` : ''].join('\n');
}

export function buildComment(result: EvalResult, website?: WebsiteResult): string {
  return prComment(result) + websiteComment(website);
}

export async function publishResult(opts: { octokit: Octokit; owner: string; repo: string; prNumber: number; headSha: string; result: EvalResult; website?: WebsiteResult }): Promise<void> {
  const { octokit, owner, repo, prNumber, headSha, result } = opts;
  // Publish the gate first. A comment failure can never suppress commit status.
  await octokit.rest.repos.createCommitStatus({ owner, repo, sha: headSha,
    state: commitState(result),
    context: 'trustmodel/trust-review',
    description: result.status === 'skipped' ? 'TR: No AI-related files changed — skipped' :
                 result.status === 'not_available' ? 'TR: Evaluation unavailable; no passing gate issued' :
                 result.status === 'error' ? 'Trust Review service error; no passing gate issued' :
                 verifiedPass(result) ? 'Verified PR diff evaluation passed' : 'PR diff evaluation did not pass',
    ...(result.reportUrl ? { target_url: result.reportUrl } : {}),
  });
  if (result.status === 'skipped') return; // Quiet non-AI skip: no comment or website scan.
  const current = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  if (current.data.head.sha !== headSha) return; // an older push cannot replace the current PR comment
  let commentId: number | undefined;
  for await (const page of octokit.paginate.iterator(octokit.rest.issues.listComments, { owner, repo, issue_number: prNumber, per_page: 100 })) {
    const match = page.data.find(c => c.body?.includes(MARKER) && c.user?.type === 'Bot');
    if (match) { commentId = match.id; break; }
    // Same bounded pagination contract as the local runner.
    if (page.url && new URL(page.url).searchParams.get('page') === '10') throw new Error('Too many comment pages.');
  }
  const body = buildComment(result, opts.website);
  if (commentId) await octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body });
  else await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
}
