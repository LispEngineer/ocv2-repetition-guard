import os, json, subprocess, tempfile, time, urllib.request, base64, re
from pathlib import Path
with tempfile.TemporaryDirectory(prefix='guard-probe-') as td:
 p=Path(td); cfg=p/'config'/'opencode'; cfg.mkdir(parents=True); (cfg/'plugins').mkdir()
 (cfg/'plugins'/'probe.js').write_text('''import {writeFileSync} from "node:fs";
export default {id:"guard-probe",async setup(ctx){writeFileSync("'''+td+'''/ctx.json",JSON.stringify({keys:Object.keys(ctx),session:Object.keys(ctx.session||{}),event:Object.keys(ctx.event||{})}));}};''')
 (p/'opencode.json').write_text(json.dumps({'plugins':[str(cfg/'plugins'/'probe.js')]}))
 env=dict(os.environ,XDG_CONFIG_HOME=str(p/'config'),XDG_DATA_HOME=str(p/'data'),XDG_STATE_HOME=str(p/'state'),XDG_CACHE_HOME=str(p/'cache'),OPENCODE_CONFIG_DIR=str(cfg))
 with (p/'server.log').open('w+') as log:
  proc=subprocess.Popen(['opencode','serve','--hostname','127.0.0.1','--port','19483'],cwd=td,env=env,stdout=log,stderr=log)
  try:
   for i in range(60):
    try:
     log.seek(0); output=log.read(); match=re.search(r'server password (\S+)',output)
     if not match: raise Exception('not ready')
     auth=base64.b64encode(('opencode:'+match.group(1)).encode()).decode()
     req=urllib.request.Request('http://127.0.0.1:19483/api/plugin',headers={'Authorization':'Basic '+auth})
     with urllib.request.urlopen(req,timeout=1) as r: print(r.read().decode()[:2000])
     break
    except Exception: time.sleep(.2)
   time.sleep(.5)
   print('ctx', (p/'ctx.json').read_text() if (p/'ctx.json').exists() else 'missing')
   log.seek(0); print(re.sub(r'server password \S+', 'server password [redacted]',log.read())[-2000:])
  finally:
   proc.terminate()
   try:proc.wait(timeout=5)
   except subprocess.TimeoutExpired:proc.kill();proc.wait()
