// TRUS-2596: SARIF output for GitHub Code Scanning.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseResult, parseDimensions, skipped, evaluationError, unavailable } = require('../dist_ts/eval.js');
const { buildSarif, resolveSarifPath, scoredFiles, weakDimensions, writeSarif,
        RULE_BELOW_THRESHOLD, RULE_WEAK_DIMENSION, MAX_SARIF_FILES } = require('../dist_ts/sarif.js');

const dim = (score, ci_high = null) => ({ dimension: 'x', score, ci_low: null, ci_high, stdev: null, n_samples: 1, n_scored: 1 });
const scored = (over = {}) => parseResult({
  status: 'failed', passed: false, pr_diff_evaluated: true, trust_score: 52, grade: 'D', threshold: 65,
  dimension_variance: { safety: dim(40), fairness: dim(90), privacy: dim(60, 70) }, ...over,
});
const passing = (over = {}) => scored({ status: 'passed', passed: true, trust_score: 88, grade: 'B', ...over });
const results = sarif => sarif.runs[0].results;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tr-sarif-'));

test('per-dimension scores are kept only for an evaluated result, sorted and validated', () => {
  assert.deepEqual(scored().dimensions.map(d => d.name), ['fairness', 'privacy', 'safety']);
  assert.equal(scored().threshold, 65);
  const r = parseResult({ status: 'not_available', passed: false, pr_diff_evaluated: false, trust_score: null,
                          threshold: 65, dimension_variance: { safety: dim(10) } });
  assert.equal(r.dimensions, undefined);
  assert.equal(r.threshold, undefined);
});

test('malformed dimension data is dropped, never an error and never shown', () => {
  const dims = parseDimensions({ '<script>x</script>': dim(10), Safety: dim(10), ok: dim(10), nan: dim(NaN),
                                 big: dim(101), neg: dim(-1), str: { score: '10' }, nul: null, arr: [1] });
  assert.deepEqual(dims.map(d => d.name), ['ok']);
  for (const raw of [null, undefined, 'x', 5, [dim(1)]]) assert.deepEqual(parseDimensions(raw), []);
  assert.equal(parseDimensions(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`d${i}`, dim(1)]))).length, 20);
  // A bad dimension payload never turns a real score into an error.
  assert.equal(scored({ dimension_variance: 'garbage' }).status, 'failed');
  assert.equal(scored({ dimension_variance: 'garbage' }).trustScore, 52);
});

test('no SARIF for an unscored, unavailable or errored review', () => {
  for (const result of [unavailable(), evaluationError(),
                        parseResult({ status: 'not_available', passed: false, pr_diff_evaluated: false, trust_score: null }),
                        parseResult({ status: 'error', passed: false, pr_diff_evaluated: false })]) {
    for (const mode of ['advisory', 'enforce']) {
      assert.equal(buildSarif({ result, files: ['agents/run.py'], mode, threshold: 65 }), null);
    }
  }
});

test('a skip or a clean pass writes an empty result list so earlier alerts close', () => {
  for (const result of [skipped(), passing({ dimension_variance: { safety: dim(90) } })]) {
    const sarif = buildSarif({ result, files: ['agents/run.py'], mode: 'enforce', threshold: 65 });
    assert.equal(sarif.version, '2.1.0');
    assert.deepEqual(results(sarif), []);
  }
});

test('below threshold (enforce): one file-level error per scored file, repo-relative paths', () => {
  const sarif = buildSarif({ result: scored(), files: ['agents/run.py', 'prompts/a b.prompt'], mode: 'enforce', threshold: 65 });
  const run = sarif.runs[0];
  assert.equal(run.originalUriBaseIds, undefined);
  assert.equal(run.automationDetails.id, 'trustmodel-review/');
  assert.deepEqual(run.tool.driver.rules.map(r => r.id), [RULE_BELOW_THRESHOLD, RULE_WEAK_DIMENSION]);
  assert.equal(results(sarif).length, 2);
  for (const r of results(sarif)) {
    assert.equal(r.ruleId, RULE_BELOW_THRESHOLD);
    assert.equal(run.tool.driver.rules[r.ruleIndex].id, r.ruleId);
    assert.equal(r.level, 'error');
    assert.deepEqual(r.locations[0].physicalLocation.region, { startLine: 1 });
    assert.match(r.message.text, /52\/100, below the threshold of 65/);
    assert.match(r.message.text, /Weakest dimensions: safety 40\/100\./);   // privacy is within noise, fairness passes
    assert.match(r.message.text, /not tied to a specific line/);
    assert.doesNotMatch(r.message.text, /Advisory/);
  }
  assert.deepEqual(results(sarif).map(r => r.locations[0].physicalLocation.artifactLocation.uri),
                   ['agents/run.py', 'prompts/a%20b.prompt']);
});

test('advisory lowers a below-threshold finding to a warning and says it does not block', () => {
  const [r] = results(buildSarif({ result: scored(), files: ['agents/run.py'], mode: 'advisory', threshold: 65 }));
  assert.equal(r.level, 'warning');
  assert.match(r.message.text, /Advisory mode: this does not block the merge\./);
});

test('a pass with a clearly weak dimension is a note, never an error', () => {
  for (const mode of ['advisory', 'enforce']) {
    const [r, ...rest] = results(buildSarif({ result: passing(), files: ['agents/run.py'], mode, threshold: 65 }));
    assert.equal(rest.length, 0);
    assert.equal(r.ruleId, RULE_WEAK_DIMENSION);
    assert.equal(r.level, 'note');
    assert.match(r.message.text, /passed this pull request \(88\/100\).*safety 40\/100/);
  }
});

test('noise rule: a dimension whose confidence band reaches the threshold is not flagged', () => {
  const dims = parseDimensions({ a: dim(60, 65), b: dim(60, 64.9), c: dim(60), d: dim(65) });
  assert.deepEqual(weakDimensions(dims, 65).map(d => d.name), ['b', 'c']);
});

test('the server-applied threshold wins over the configured one', () => {
  const [r] = results(buildSarif({ result: scored({ threshold: 70 }), files: ['agents/run.py'], mode: 'enforce', threshold: 65 }));
  assert.match(r.message.text, /threshold of 70/);
  assert.equal(r.properties.threshold, 70);
});

test('a finding that cannot be placed on a scored file is not invented', () => {
  assert.equal(buildSarif({ result: scored(), files: [], mode: 'enforce', threshold: 65 }), null);
});

test('website scores never become findings', () => {
  // The website score is a separate object; an evaluated pass with no weak dimension stays empty.
  const sarif = buildSarif({ result: passing({ dimension_variance: {} }), files: ['agents/run.py'], mode: 'enforce', threshold: 65 });
  assert.deepEqual(results(sarif), []);
  assert.doesNotMatch(JSON.stringify(sarif), /website/i);
});

test('scored files: AI paths that exist at head only, sorted and capped; content is never read', () => {
  const ws = tmp();
  const files = ['agents/run.py', 'README.md', 'node_modules/x/agent.js', 'prompts/deleted.prompt',
                 ...Array.from({ length: 15 }, (_, i) => `prompts/p${String(i).padStart(2, '0')}.prompt`)];
  for (const f of files.filter(f => f !== 'prompts/deleted.prompt')) {
    fs.mkdirSync(path.dirname(path.join(ws, f)), { recursive: true });
    fs.writeFileSync(path.join(ws, f), '');
    fs.chmodSync(path.join(ws, f), 0o000);   // unreadable: only existence may be checked
  }
  const got = scoredFiles([...files, 'agents/run.py'], ws);
  assert.equal(got.length, MAX_SARIF_FILES);
  assert.equal(got[0], 'agents/run.py');
  assert.ok(!got.includes('README.md') && !got.includes('node_modules/x/agent.js') && !got.includes('prompts/deleted.prompt'));
  assert.deepEqual(got, [...got].sort());
});

test('sarif_file must be a plain relative .sarif path inside the workspace', () => {
  const ws = tmp();
  assert.equal(resolveSarifPath('trust-review.sarif', ws), path.join(ws, 'trust-review.sarif'));
  assert.equal(resolveSarifPath('reports/tr.sarif', ws), path.join(ws, 'reports/tr.sarif'));
  for (const bad of ['/tmp/x.sarif', '../x.sarif', 'a/../../x.sarif', 'x.json', 'x.sarif ', '$HOME/x.sarif',
                     'a//x.sarif', './x.sarif', 'x;rm.sarif', '.sarif/..', '']) {
    assert.throws(() => resolveSarifPath(bad, ws), undefined, bad);
  }
});

test('writing refuses symlinks that point outside the workspace', () => {
  const ws = tmp(), outside = tmp();
  const sarif = buildSarif({ result: skipped(), files: [], mode: 'enforce', threshold: 65 });
  fs.symlinkSync(outside, path.join(ws, 'linkdir'));
  assert.throws(() => writeSarif(resolveSarifPath('linkdir/tr.sarif', ws), sarif, ws), /inside the workspace/);
  assert.throws(() => writeSarif(resolveSarifPath('linkdir/new/tr.sarif', ws), sarif, ws), /inside the workspace/);
  fs.symlinkSync(path.join(outside, 'target.sarif'), path.join(ws, 'dangling.sarif'));   // dangling
  assert.throws(() => writeSarif(resolveSarifPath('dangling.sarif', ws), sarif, ws), /regular file/);
  assert.deepEqual(fs.readdirSync(outside), []);
  writeSarif(resolveSarifPath('reports/tr.sarif', ws), sarif, ws);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ws, 'reports/tr.sarif'), 'utf8')).version, '2.1.0');
});
