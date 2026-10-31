// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Douglas P. Fields, Jr. <symbolics@lisp.engineer>
import { createGuard } from './guard.js';

export default {
  id: 'repetition-guard',
  async setup(ctx) {
    const controller = new AbortController();
    const guard = createGuard(ctx, ctx.options ?? {});
    const subscription = await ctx.event.subscribe({ signal: controller.signal });
    void (async () => {
      for await (const event of subscription) guard.handle(event);
    })().catch(error => {
      guard.dispose();
      if (!controller.signal.aborted) console.warn(`[repetition-guard] Event subscription stopped: ${String(error)}`);
    });
    return () => { guard.dispose(); controller.abort(); };
  },
};
