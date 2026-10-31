// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Douglas P. Fields, Jr. <symbolics@lisp.engineer>
import { Detector } from './detector.js';

export function createGuard(ctx, options = {}) {
  const maxRetries = options.maxRetries ?? 2;
  const graceMs = options.graceMs ?? 500;
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) throw new Error('maxRetries must be 0–10');
  if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > 10000) throw new Error('graceMs must be 0–10000');
  new Detector(options); // Validate before accepting any events.
  const states = new Map();
  let disposed = false;
  const state = id => {
    if (!states.has(id)) states.set(id, { attempts: 0, epoch: 0, cancelled: false, busy: false, streams: new Map() });
    return states.get(id);
  };
  const reset = id => {
    const s = state(id);
    s.epoch++; s.attempts = 0; s.cancelled = false; s.streams.clear();
  };
  async function recover(id, s) {
    s.busy = true;
    s.ownInterrupt = true;
    const epoch = s.epoch;
    const retry = s.attempts < maxRetries;
    if (retry) s.attempts++;
    else s.cancelled = true;
    try {
      await ctx.session.interrupt({ sessionID: id, continue: false });
      await new Promise(resolve => setTimeout(resolve, graceMs));
      s.ownInterrupt = false;
      if (disposed || s.epoch !== epoch || (retry && s.cancelled)) return;
      s.streams.clear();
      await ctx.session.synthetic({ sessionID: id, resume: retry,
        description: 'Repetition guard', metadata: { repetitionGuard: true },
        text: retry
          ? `Repetition guard interrupted a repeated phrase loop. Recovery ${s.attempts}/${maxRetries}. Continue the user's task from the last useful point. Do not repeat the stuck phrase or restart the same explanation. Take a concrete next step, or briefly report what is blocking progress.`
          : `Repetition guard stopped this turn after ${maxRetries} automatic recoveries. Operator input is required. Review the transcript and send a new instruction or change the model before continuing.` });
    } catch (error) {
      s.cancelled = true;
      console.warn(`[repetition-guard] Recovery failed for ${id}; no further automatic continuation: ${String(error)}`);
    } finally { s.ownInterrupt = false; s.busy = false; }
  }
  function handle(event) {
    const d = event.data ?? {};
    const id = d.sessionID;
    if (!id || disposed) return;
    const location = event.location ?? d.location;
    if (location && location.directory !== ctx.location.directory) return;
    if (event.type === 'session.created' || event.type === 'session.step.started') state(id);
    if (!states.has(id)) return;
    const s = state(id);
    if (event.type === 'session.inbox.enqueued' && d.item?.type === 'user') reset(id);
    if (event.type === 'session.execution.interrupted') {
      if (s.ownInterrupt) s.ownInterrupt = false;
      else { s.cancelled = true; s.epoch++; }
    }
    if (event.type === 'session.removed' || event.type === 'session.deleted') {
      s.epoch++; states.delete(id); return;
    }
    if (event.type === 'session.step.started') s.streams.clear();
    if (event.type === 'session.step.ended') s.streams.clear();
    if (!/^session\.(text|reasoning)\.delta$/.test(event.type) || s.cancelled || s.busy) return;
    const key = `${d.assistantMessageID}:${event.type.split('.')[1]}:${d.ordinal}`;
    if (!s.streams.has(key)) s.streams.set(key, new Detector(options));
    if (s.streams.get(key).push(d.delta ?? '')) void recover(id, s);
  }
  return { handle, reset, dispose() { disposed = true; states.clear(); } };
}
