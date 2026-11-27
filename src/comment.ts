import * as github from '@actions/github';
import { EvalResult, NotRunReason, verifiedPass, commitState } from './eval';
import { ReviewMode } from './config';
import { WebsiteResult, websiteComment } from './website';
export const MARKER = '<!-- trustmodel-trust-review -->';
type Octokit = ReturnType<typeof github.getOctokit>;

// TRUS-2595: said on every advisory result that did not verifiably pass, so a
// green advisory status is never read as a passed review.
export const ADVISORY_NOTE = '_Advisory mode: this result does not block the merge. Set `mode: enforce` to gate merges on it._';

// Why Trust Review did not score this PR, in fixed text: the heading, what
// happened, what the user can do, and the short commit-status form.
const NOT_RUN: Record<NotRunReason, { title: string; what: string; next: string; status: string }> = {
  insufficient_credits: {
    title: 'not run: out of credits',
    what: 'Your TrustModel organization has used today\'s free Trust Review runs and does not have enough credits for another review.',
    next: 'Add credits in the TrustModel console (Billing), then re-run this workflow. Free runs reset daily at 00:00 UTC.',
    status: 'TR: Not run, out of credits. Add credits in the TrustModel console',
  },
  daily_limit: {
    title: 'not run: daily limit reached',
    what: 'Your TrustModel organization reached today\'s Trust Review limit.',
    next: 'Reviews resume at 00:00 UTC; re-run this workflow then.',
    status: 'TR: Not run, daily review limit reached. Resumes 00:00 UTC',
  },
  rate_limited: {
    title: 'not run: too many requests',
    what: 'Trust Review received too many requests in a short time.',
    next: 'Re-run this workflow in a minute.',
    status: 'TR: Not run, too many requests. Re-run shortly',
  },
  api_key_rejected: {
    title: 'not run: API key rejected',
    what: 'TrustModel did not accept the API key passed to the `api_key` input.',
    next: 'Check that the repository secret (for example `TRUSTMODEL_API_KEY`) holds a current key that is not disabled or expired.',
    status: 'TR: Not run, API key rejected. Check the api_key secret',
  },
  service_error: {
    title: 'not run: service error',
    what: 'The Trust Review service could not complete the request.',
    next: 'Re-run this workflow to try again.',
    status: 'Trust Review service error; no passing gate issued',
  },
  evaluation_error: {
    title: 'not run: evaluation failed',
    what: 'Trust Review started but could not finish scoring this PR.',
    next: 'Re-run this workflow to try again.',
    status: 'Trust Review service error; no passing gate issued',
  },
};

function prComment(result: EvalResult, mode: ReviewMode): string {
  const advisory = mode === 'advisory' && !verifiedPass(result) ? ['', ADVISORY_NOTE] : [];
  const notRun = !result.prDiffEvaluated && result.reason ? NOT_RUN[result.reason] : undefined;
  if (notRun) return [
    MARKER, `## Trust Review — ${notRun.title}`, '',
    `${notRun.what} **No code was evaluated and no passing gate was issued.**`, '',
    notRun.next,
    ...advisory,
  ].join('\n');
  if (!result.prDiffEvaluated) return [
    MARKER, '## Trust Review — not available', '',
    'The PR diff evaluator is not available. **No code was evaluated and no passing gate was issued.**', '',
    'Full PR-diff evaluation must ship before this can be a required merge gate.',
    ...advisory,
  ].join('\n');
  return [MARKER, `## Trust Review — ${verifiedPass(result) ? 'passed' : 'not passed'}`, '',
          `PR diff evaluated: yes. Score: ${result.trustScore ?? 'unscored'}/100.`,
          result.reportUrl ? `[Report](${result.reportUrl})` : '', ...advisory].join('\n');
}

export function buildComment(result: EvalResult, website?: WebsiteResult, mode: ReviewMode = 'enforce'): string {
  return prComment(result, mode) + websiteComment(website);
}

export function statusDescription(result: EvalResult, mode: ReviewMode = 'enforce'): string {
  const base = result.status === 'skipped' ? 'TR: No AI-related files changed — skipped' :
               !result.prDiffEvaluated && result.reason ? NOT_RUN[result.reason].status :
               result.status === 'not_available' ? 'TR: Evaluation unavailable; no passing gate issued' :
               result.status === 'error' ? 'Trust Review service error; no passing gate issued' :
               verifiedPass(result) ? 'Verified PR diff evaluation passed' : 'PR diff evaluation did not pass';
  if (mode !== 'advisory' || result.status === 'skipped' || verifiedPass(result)) return base;
  const score = result.prDiffEvaluated && result.trustScore !== null ? ` (${result.trustScore}/100)` : '';
  // GitHub caps status descriptions at 140 characters.
  return `Advisory, not enforced: ${base}${score}`.slice(0, 140);
}

export async function publishResult(opts: { octokit: Octokit; owner: string; repo: string; prNumber: number; headSha: string; result: EvalResult; website?: WebsiteResult; mode?: ReviewMode }): Promise<void> {
  const { octokit, owner, repo, prNumber, headSha, result } = opts;
  const mode = opts.mode ?? 'enforce';
  // Publish the gate first. A comment failure can never suppress commit status.
  await octokit.rest.repos.createCommitStatus({ owner, repo, sha: headSha,
    state: commitState(result, mode),
    context: 'trustmodel/trust-review',
    description: statusDescription(result, mode),
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
  const body = buildComment(result, opts.website, mode);
  if (commentId) await octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body });
  else await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
}
