"""Execute both real clients against local HTTP fixtures; never call live services."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def main():
    root = Path(__file__).resolve().parents[1]
    calls, state = [], {'expected_state': 'pending', 'website': True, 'wrong_key': False}

    class Fixture(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def handle_request(self):
            raw = self.rfile.read(int(self.headers.get('Content-Length', 0)))
            body = json.loads(raw) if raw else None
            calls.append((self.command, self.path, body))
            status = 200
            if self.path == '/v1/public/site-score/trustmodel.ai/':
                assert not self.headers.get('Authorization') and not self.headers.get('X-API-Key')
                data = {'domain': 'trustmodel.ai', 'assessed': True, 'trust_score': 100}
            elif self.path == '/v1/pr-trust/review/':
                assert self.headers.get('X-API-Key') in ('tm-fixture-only', 'wrong-key')
                assert not self.headers.get('Authorization')
                assert body['changed_files'] == ['agents/run.py']
                assert 'github_token' not in body and 'changed_assets' not in body
                assert 'SOURCE_SENTINEL' not in raw.decode()
                data = {'status': 'not_available', 'passed': False, 'pr_diff_evaluated': False,
                        'trust_score': None, 'message': 'No code was evaluated. No passing gate was issued.'}
                status = 201
                if state['wrong_key']:
                    status = 401
                    data = {'detail': 'UPSTREAM_SECRET_SENTINEL_NEVER_LOG'}
            else:
                assert self.headers.get('Authorization') == 'token gh-fixture-only' or self.headers.get('Authorization') == 'Bearer gh-fixture-only'
                assert not self.headers.get('X-API-Key')
                if '/statuses/' in self.path:
                    assert body['state'] == state['expected_state']
                    if state.get('expected_desc'):
                        assert body['description'].startswith(state['expected_desc']), body['description']
                    data = {'id': 1}
                elif self.path.endswith('/pulls/1'):
                    data = {'state': 'open', 'head': {'sha': state['head']},
                            'base': {'sha': state['base']}, 'changed_files': 1}
                elif '/pulls/1/files?' in self.path:
                    data = [{'filename': 'agents/run.py'}]
                elif '/comments' in self.path and self.command == 'GET':
                    data = []
                elif '/comments' in self.path:
                    assert 'Trust Review — not available' in body['body']
                    if state['website']:
                        assert 'Website TrustScore — informational' in body['body']
                        assert '**100/100**' in body['body']
                    else:
                        assert 'website assessment below' not in body['body']
                        assert 'Website TrustScore' not in body['body']
                    data = {'id': 42}
                else:
                    raise AssertionError('Unexpected fixture route: ' + self.path)
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())

        do_GET = do_POST = do_PATCH = handle_request

    server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = 'http://127.0.0.1:' + str(server.server_port)
    try:
        with tempfile.TemporaryDirectory(prefix='trust-website-e2e-') as tmp:
            work = Path(tmp)
            def git(*args):
                return subprocess.check_output(['git', *args], cwd=work, text=True).strip()
            git('init', '-q')
            git('config', 'user.name', 'Fixture')
            git('config', 'user.email', 'fixture@example.invalid')
            (work / 'agents').mkdir()
            source = work / 'agents/run.py'
            source.write_text('# SOURCE_SENTINEL base\n')
            git('add', '.')
            git('commit', '-qm', 'base')
            state['base'] = git('rev-parse', 'HEAD')
            source.write_text('# SOURCE_SENTINEL head\n')
            git('commit', '-qam', 'head')
            state['head'] = git('rev-parse', 'HEAD')
            event = work / 'event.json'
            event.write_text(json.dumps({'pull_request': {'number': 1, 'head': {'sha': state['head']},
                                                         'base': {'sha': state['base']}}}))
            env = {**os.environ, 'GITHUB_EVENT_NAME': 'pull_request', 'GITHUB_REPOSITORY': 'acme/app',
                   'GITHUB_EVENT_PATH': str(event), 'GITHUB_API_URL': origin,
                   'INPUT_API_KEY': 'tm-fixture-only', 'INPUT_GITHUB_TOKEN': 'gh-fixture-only',
                   'INPUT_BASE_URL': origin, 'INPUT_WEBSITE_DOMAIN': 'trustmodel.ai',
                   'INPUT_DETECT': 'agents/**', 'INPUT_THRESHOLD': '65',
                   # The existing matrix pins enforce; the advisory default is checked below.
                   'INPUT_MODE': 'enforce'}
            action = subprocess.run(['node', str(root / 'dist/index.js')], cwd=work, env=env,
                                    capture_output=True, text=True, timeout=40)
            assert action.returncode == 0, action.stdout + action.stderr
            assert sum('/comments' in path and method == 'POST' for method, path, _ in calls) == 1

            shim = work / 'shim'
            shim.mkdir()
            (shim / 'sitecustomize.py').write_text(
                'import urllib.request\n_original=urllib.request.urlopen\n'
                'def _open(req,*args,**kwargs):\n'
                '    if isinstance(req,urllib.request.Request) and req.full_url.startswith("https://api.github.com/"):\n'
                '        req=urllib.request.Request(' + repr(origin) + '+req.full_url[len("https://api.github.com"):],'
                'data=req.data,headers=dict(req.header_items()),method=req.get_method())\n'
                '    return _original(req,*args,**kwargs)\n'
                'urllib.request.urlopen=_open\n')
            settings = work / 'runner.env'
            settings.write_text(f'TRUSTMODEL_BASE_URL={origin}\nTRUSTMODEL_API_KEY=tm-fixture-only\n'
                                'GITHUB_TOKEN=gh-fixture-only\nTRUSTREVIEW_POST_GITHUB=true\nTRUSTREVIEW_DETECT=agents/**\n')
            runner = subprocess.run([str(root / 'scripts/run-trust-review.sh'), '--repo', 'acme/app', '--pr', '1',
                                     '--env-file', str(settings), '--website-domain', 'trustmodel.ai', '--json'],
                                    cwd=work, env={**os.environ, 'PYTHONPATH': str(shim)},
                                    capture_output=True, text=True, timeout=40)
            assert runner.returncode == 2, runner.stdout + runner.stderr
            result = json.loads(runner.stdout)
            assert result['trust_score'] is None and result['passed'] is False
            assert result['website_scan']['trust_score'] == 100
            assert sum('/comments' in path and method == 'POST' for method, path, _ in calls) == 2
            assert sum('site-score' in path for _, path, _ in calls) == 2
            assert 'Trust Review response:' in action.stdout
            assert 'UPSTREAM_SECRET_SENTINEL_NEVER_LOG' not in action.stdout
            # Missing key: no metadata request or false dashboard-record claim.
            state['website'] = False
            env['INPUT_WEBSITE_DOMAIN'] = ''
            env['INPUT_API_KEY'] = ''
            before = len(calls)
            missing = subprocess.run(['node', str(root / 'dist/index.js')], cwd=work, env=env,
                                     capture_output=True, text=True, timeout=40)
            assert missing.returncode == 0, missing.stdout + missing.stderr
            assert not any('/v1/' in path for _, path, _ in calls[before:])
            # Wrong key: a single error status, job remains green after publishing.
            env['INPUT_API_KEY'] = 'wrong-key'
            state.update(wrong_key=True, expected_state='error')
            wrong = subprocess.run(['node', str(root / 'dist/index.js')], cwd=work, env=env,
                                   capture_output=True, text=True, timeout=40)
            assert wrong.returncode == 0, wrong.stdout + wrong.stderr
            assert '"http_status":401' in wrong.stdout
            assert 'UPSTREAM_SECRET_SENTINEL_NEVER_LOG' not in wrong.stdout
            # A docs-only comparison must skip before backend or website requests.
            git('checkout', '-q', state['base'])
            (work / 'README.md').write_text('Docs only\n')
            git('add', '.')
            git('commit', '-qm', 'docs')
            state['head'] = git('rev-parse', 'HEAD')
            event.write_text(json.dumps({'pull_request': {'number': 1, 'head': {'sha': state['head']},
                                                         'base': {'sha': state['base']}}}))
            state['expected_state'] = 'success'
            env['INPUT_WEBSITE_DOMAIN'] = 'trustmodel.ai'
            before = len(calls)
            quiet = subprocess.run(['node', str(root / 'dist/index.js')], cwd=work, env=env,
                                   capture_output=True, text=True, timeout=40)
            assert quiet.returncode == 0, quiet.stdout + quiet.stderr
            assert len(calls[before:]) == 1 and '/statuses/' in calls[-1][1]
            assert '"status":"skipped","passed":false' in quiet.stdout
            # TRUS-2595: with no mode set (advisory default), an unavailable AI
            # change publishes a non-blocking success that says it is advisory,
            # and the passed output stays false.
            (work / 'agents' / 'run.py').write_text('print("advisory")\n')
            git('add', '.')
            git('commit', '-qm', 'advisory')
            state['head'] = git('rev-parse', 'HEAD')
            event.write_text(json.dumps({'pull_request': {'number': 1, 'head': {'sha': state['head']},
                                                         'base': {'sha': state['base']}}}))
            state.update(wrong_key=False, website=False, expected_state='success',
                         expected_desc='Advisory, not enforced: ')
            env.pop('INPUT_MODE')
            env['INPUT_API_KEY'] = 'tm-fixture-only'
            env['INPUT_WEBSITE_DOMAIN'] = ''
            advisory = subprocess.run(['node', str(root / 'dist/index.js')], cwd=work, env=env,
                                      capture_output=True, text=True, timeout=40)
            assert advisory.returncode == 0, advisory.stdout + advisory.stderr
            assert 'Trust Review mode: advisory.' in advisory.stdout
            assert '"status":"not_available","passed":false' in advisory.stdout
            print('PASS: built Action matrix: AI/no key/wrong key/non-AI skip; no false passed or duplicate failed job.')
            print('PASS: advisory default publishes a labelled non-blocking status; passed stays false.')
            print('PASS: built Action and actual runner show website score 100 as informational; unavailable PR gates remain pending, never passed.')
            print('PASS: website requests carry no credentials; PR requests contain paths only; GitHub receives no TrustModel key.')
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


if __name__ == '__main__':
    main()
