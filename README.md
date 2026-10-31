# OpenCode v2 repetition guard

Detects a phrase repeating in streamed assistant text or reasoning, interrupts that
session, and supplies a corrective synthetic message. Defaults to **two automatic
recoveries per user turn**. A third loop is interrupted and left stopped with a
message asking for operator input. A new user prompt resets the budget; the guard's
own synthetic messages do not.

Implemented as a native v2 `setup(ctx)` plugin with no runtime dependencies or
build step. Tested with OpenCode **v2.0.24**, Node **v26.10.0**, and Python's standard
library. OpenCode loads the JavaScript itself; Node is needed only for unit tests.

## Enable

Merge this entry into the existing `plugins` array in your OpenCode configuration:

```json
{
  "plugins": [
    {
      "package": "/path/to/opencode-v2-repetition-guard",
      "options": {
        "maxRetries": 2,
        "graceMs": 500,
        "minSpan": 240,
        "minRepeats": 4,
        "maxPhrase": 256,
        "window": 4096
      }
    }
  ]
}
```

Preserve your other entries. Use the **directory path**, not `src/index.js`.
This version's local loader uses the root `index.js`. Restart OpenCode after
changing its configuration. Remove the entry and restart to disable the guard.
The development and test runs have not changed your live configuration.

Options are optional. `maxRetries: 0` interrupts the first detected loop and asks
for operator input. `graceMs` is the pause between interruption and correction.
The detector requires a contiguous repeated span of at least `minSpan` normalized
characters and `minRepeats` copies, with a period no longer than `maxPhrase`.
It normalizes whitespace and letter case, supports Unicode, and keeps a bounded
`window` per stream. Increase `minSpan` to reduce sensitivity to intentional
repetition. It skips triple-backtick and triple-tilde fenced content, including
code and pixel art.

## Behavior and limits

- Only incoming text/reasoning deltas are inspected. No idle timer, slow-prefill
  timeout, GPU queue handling, context compaction, or tool-output scanning.
- Text and reasoning parts and sessions have separate detector buffers. Events
  from other project locations are ignored.
- User interruption prevents automatic continuation when its interruption event
  is observed. Recovery stays asynchronous so events can be processed during the
  grace period; a further interrupt cancels a pending correction. OpenCode labels
  the guard's interruption as `reason: "user"` too. Simultaneous cancellations
  coalesced by the host, or cancellation while already idle that emits no event,
  cannot reliably be distinguished with this event API. Use `maxRetries: 0` if
  automatic continuation is undesirable.
- A new prompt or plugin unload invalidates a pending correction. API/subscription
  failures stop automatic recovery and write a warning to the server log.
- Retry budgets are held in memory and reset on plugin/server restart. Running
  separate OpenCode servers gives each its own guard and budget; this plugin does
  not coordinate Strata capacity across processes.
- Exact repeated phrases are detected; paraphrasing loops can escape detection.
  Intentional repetition outside fences can trigger it. It does not delete the
  already-generated loop from model context, so recovery is not guaranteed.
- Interrupting a session uses OpenCode's session-wide interrupt; any concurrent
  activity in that session is subject to the host's cancellation semantics.

## Tests

From the repository directory:

```sh
node --test test/*.test.js
python3 test/runtime-probe.py
```

The unit suite covers chunk boundaries, partial phrases, Unicode, ordinary prose,
fenced code, bounded detector memory, budgets, independent sessions, cancellation,
unload, new prompts, synthetic messages, API failure and invalid options.

The integration suite starts a temporary, authenticated OpenCode server and a
local fake OpenAI-compatible streaming provider. Configuration, data, state and
cache are redirected to a temporary directory. It verifies normal output,
successful first recovery, exhaustion of two recoveries, repeated reasoning, and
manual cancellation. It asserts generation counts and actual interruption events,
then shuts down both servers. It uses no Strata model or production sessions.
It requires `opencode`, Python 3.8+, and permission to bind localhost ports.

`test/probe.py` is an earlier API-discovery helper; `test/runtime-events.jsonl` is
an earlier synthetic runtime capture, not a production transcript. Timestamped
backups are excluded from Git.

The upstream [v2 plugin documentation](https://opencode.ai/v2/docs/build/plugins)
describes the event subscription and session APIs used here.

## License

Apache License 2.0 — see [LICENSE](LICENSE). Copyright 2026
Douglas P. Fields, Jr. <symbolics@lisp.engineer>; attribution notice in
[NOTICE](NOTICE).
