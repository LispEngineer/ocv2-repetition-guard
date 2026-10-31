import test from 'node:test';
import assert from 'node:assert/strict';
import { Detector } from '../src/detector.js';
import { createGuard } from '../src/guard.js';

test('detects a phrase across single-character chunks, with a partial last copy', () => {
  const d = new Detector(); let found;
  for (const c of 'Let me check this again. '.repeat(30) + 'Let me') found ||= d.push(c);
  assert.ok(found);
});
test('normal prose, whitespace and fenced repeated code are ignored', () => {
  for (const text of ['One two three four. A different sentence follows. '.repeat(3), ' '.repeat(500), '```\n' + 'print(1)\n'.repeat(100) + '```\n']) {
    assert.equal(new Detector().push(text), null);
  }
});
test('memory remains bounded and Unicode loops are detected', () => {
  const d = new Detector(); assert.ok(d.push('重新检查这一步。'.repeat(1000)));
  assert.ok(d.buffer.length <= 4096);
});
const delay = () => new Promise(resolve => setTimeout(resolve, 15));
function fixture(options = {}) {
  const calls = [];
  const g = createGuard({location:{directory:'/test'},session:{
    interrupt: async x => calls.push(['interrupt',x]),
    synthetic: async x => calls.push(['synthetic',x]),
  }}, { graceMs: 1, ...options });
  const event = (type, sessionID = 'a', more = {}) => g.handle({type,location:{directory:'/test'},data:{sessionID,...more}});
  const loop = (id='a') => { event('session.step.started',id);event('session.text.delta',id,{delta:'check again please. '.repeat(30)}); };
  return {g,calls,event,loop};
}
test('two recoveries then a non-resuming operator handoff; user resets budget', async () => {
  const f = fixture();
  for(let i=0;i<3;i++){f.loop();await delay();}
  assert.deepEqual(f.calls.filter(x=>x[0]==='synthetic').map(x=>x[1].resume),[true,true,false]);
  f.loop();await delay();assert.equal(f.calls.length,6);
  f.event('session.inbox.enqueued','a',{item:{type:'user'}});f.loop();await delay();
  assert.equal(f.calls.at(-1)[1].resume,true);
});
test('manual cancellation and disposal suppress pending continuation',async()=>{
  const f=fixture({graceMs:5});f.loop();
  f.event('session.execution.interrupted'); // own interruption
  f.event('session.execution.interrupted'); // operator interruption
  await delay();assert.equal(f.calls.length,1);
  const other=fixture();other.loop();other.g.dispose();await delay();assert.equal(other.calls.length,1);
});
test('sessions have separate budgets and foreign locations are ignored',async()=>{
  const f=fixture({maxRetries:0});f.loop('a');await delay();f.loop('b');await delay();
  assert.equal(f.calls.length,4);
  f.g.handle({type:'session.text.delta',location:{directory:'/other'},data:{sessionID:'b',delta:'check again please. '.repeat(30)}});
  assert.equal(f.calls.length,4);
});
test('synthetic messages do not reset the recovery budget',async()=>{
  const f=fixture({maxRetries:1});f.loop();await delay();
  f.event('session.inbox.enqueued','a',{item:{type:'synthetic'}});
  f.loop();await delay();assert.equal(f.calls.at(-1)[1].resume,false);
});
test('a new user prompt invalidates an older pending correction',async()=>{
  const f=fixture({graceMs:5});f.loop();
  f.event('session.inbox.enqueued','a',{item:{type:'user'}});
  await delay();assert.equal(f.calls.length,1);
});
test('interrupt failure stops recovery without sending a correction',async()=>{
  let calls=0;
  const ctx={location:{directory:'/test'},session:{interrupt:async()=>{throw Error('fixture failure');},synthetic:async()=>calls++}};
  const g=createGuard(ctx,{graceMs:0});
  const warn=console.warn;console.warn=()=>{};
  try {
    g.handle({type:'session.step.started',location:{directory:'/test'},data:{sessionID:'a'}});
    g.handle({type:'session.reasoning.delta',data:{sessionID:'a',delta:'check this again. '.repeat(30)}});
    await delay();assert.equal(calls,0);
  } finally {console.warn=warn;g.dispose();}
});
test('invalid settings fail during setup, and silence never triggers a retry',async()=>{
  assert.throws(()=>fixture({maxRetries:-1}));
  assert.throws(()=>fixture({window:1}));
  const f=fixture();f.event('session.step.started');await delay();assert.equal(f.calls.length,0);
});
