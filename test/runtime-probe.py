"""Isolated real-OpenCode integration tests; no production config or model access."""
import base64
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
requests = []
lock = threading.Lock()

class Model(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with lock:
            requests.append(body)
        messages = str(body.get('messages', []))
        reasoning = 'CASE_REASONING' in messages
        healthy = 'CASE_NORMAL' in messages or ('CASE_RECOVER' in messages and 'Recovery 1/2' in messages)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for i in range(200 if not healthy else 3):
            delta = {'reasoning_content' if reasoning else 'content':
                     'Let me check this again. ' if not healthy else ['A useful result. ', 'The issue is resolved. ', 'Done.'][i]}
            chunk = {'id': 'chatcmpl-test', 'object': 'chat.completion.chunk', 'created': 1,
                     'model': 'test', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]}
            try:
                self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
                self.wfile.flush()
                time.sleep(.03)
            except (BrokenPipeError, ConnectionResetError):
                return
        chunk['choices'][0].update(delta={}, finish_reason='stop')
        try:
            self.wfile.write(('data: ' + json.dumps(chunk) + '\n\ndata: [DONE]\n\n').encode())
        except (BrokenPipeError, ConnectionResetError):
            pass


def run():
    model = ThreadingHTTPServer(('127.0.0.1', 0), Model)
    threading.Thread(target=model.serve_forever, daemon=True).start()
    proc = None
    try:
        with tempfile.TemporaryDirectory(prefix='guard-runtime-') as td:
            p = Path(td)
            cfg = p / 'config' / 'opencode'
            cfg.mkdir(parents=True)
            probe = p / 'probe'
            probe.mkdir()
            (probe / 'index.js').write_text('''import {appendFileSync} from 'node:fs';
export default {id:'probe',async setup(ctx){const c=new AbortController();
void(async()=>{for await(const e of await ctx.event.subscribe({signal:c.signal}))
appendFileSync(''' + json.dumps(str(p / 'events.jsonl')) + ''',JSON.stringify(e)+'\\n');})().catch(()=>{});
return()=>c.abort();}};''')
            (p / 'opencode.json').write_text(json.dumps({
                'plugins': [str(ROOT), str(probe)], 'model': 'fake/test',
                'providers': {'fake': {'package': '@opencode/ai/providers/openai-compatible',
                    'settings': {'baseURL': f'http://127.0.0.1:{model.server_port}/v1'},
                    'models': {'test': {'modelID': 'test', 'limit': {'context': 262144, 'output': 16384},
                                       'capabilities': {'tools': True, 'reasoning': True, 'input': ['text'], 'output': ['text']}}}}}}))
            env = dict(os.environ, XDG_CONFIG_HOME=str(p/'config'), XDG_DATA_HOME=str(p/'data'),
                       XDG_STATE_HOME=str(p/'state'), XDG_CACHE_HOME=str(p/'cache'), OPENCODE_CONFIG_DIR=str(cfg))
            # Select an unused port; a competing bind fails explicitly rather than reaching a live server.
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            with (p/'server.log').open('w+') as log:
                proc = subprocess.Popen(['opencode', 'serve', '--hostname', '127.0.0.1', '--port', str(port)],
                                        cwd=td, env=env, stdout=log, stderr=log)
                auth = None
                for _ in range(100):
                    log.seek(0)
                    match = re.search(r'server password (\S+)', log.read())
                    if match:
                        auth = base64.b64encode(('opencode:' + match.group(1)).encode()).decode()
                        break
                    if proc.poll() is not None:
                        raise RuntimeError('Isolated OpenCode failed to start')
                    time.sleep(.1)
                assert auth, 'Server startup timed out'

                def api(path, body=None):
                    req = urllib.request.Request(f'http://127.0.0.1:{port}/api/{path}',
                        data=json.dumps(body).encode() if body is not None else None,
                        headers={'Authorization': 'Basic '+auth, 'Content-Type': 'application/json'})
                    with urllib.request.urlopen(req, timeout=10) as response:
                        return json.loads(response.read() or 'null')

                def events(sid):
                    f = p/'events.jsonl'
                    return [e for line in (f.read_text().splitlines() if f.exists() else [])
                            if (e := json.loads(line)).get('data', {}).get('sessionID') == sid]

                def wait(predicate, timeout=12):
                    deadline = time.monotonic()+timeout
                    while time.monotonic() < deadline:
                        if predicate():
                            return
                        time.sleep(.05)
                    raise AssertionError('Runtime expectation timed out')

                api('plugin')
                wait(lambda: any(x['id']=='repetition-guard' and x['state']['status']=='active' for x in api('plugin')['data']))
                for case, expected in [('CASE_NORMAL', 1), ('CASE_RECOVER', 2), ('CASE_LOOP', 3), ('CASE_REASONING', 3)]:
                    sid = api('session', {'title': case, 'model': {'providerID': 'fake', 'id': 'test'}})['data']['id']
                    api('session/'+sid+'/prompt', {'text': case})
                    if expected == 3:
                        wait(lambda: any(e.get('data',{}).get('item',{}).get('payload',{}).get('text','').startswith('Repetition guard stopped') for e in events(sid)))
                    else:
                        wait(lambda: sum(e['type']=='session.execution.succeeded' for e in events(sid)) == 1)
                    time.sleep(.7)
                    es = events(sid)
                    starts = sum(e['type']=='session.step.started' for e in es)
                    assert starts == expected, (case, starts, expected)
                    if case == 'CASE_REASONING':
                        assert any(e['type']=='session.reasoning.delta' for e in es), 'No reasoning stream observed'
                    if expected == 3:
                        assert sum(e['type']=='session.execution.interrupted' for e in es)==3
                    print(f'PASS {case}: {starts} generation(s)', flush=True)
                # User cancellation during streaming, before detector threshold, never resumes.
                sid = api('session', {'title':'cancel','model':{'providerID':'fake','id':'test'}})['data']['id']
                api('session/'+sid+'/prompt', {'text':'CASE_CANCEL'})
                wait(lambda: any(e['type']=='session.text.delta' for e in events(sid)))
                api('session/'+sid+'/interrupt', {})
                time.sleep(1)
                es = events(sid)
                assert sum(e['type']=='session.step.started' for e in es)==1
                assert not any(e.get('data',{}).get('item',{}).get('type')=='synthetic' for e in es)
                print('PASS CASE_CANCEL: no automatic continuation', flush=True)
    finally:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        model.shutdown()
        model.server_close()

if __name__ == '__main__':
    run()
