# Workflow command ledger and token display

The `/workflows` monitor consumes the bounded command ledger projected by `thread-phase-visualizer`. It presents observed command lifecycle evidence; it does not infer command outcomes from a workflow status, tool name, arguments, output text, or words such as “finished.”

## Command rows

Expand a phase to see its direct commands. For fanout phases, expand an item lane to see only commands attributed to that item; the same command is not repeated in an unattributed parent-phase log.

The default view shows every active command plus the three most recent non-active commands for each phase or item. Select the `hidden:N retained` row and press Enter to show all commands still retained by the projection. Ledgers remain available after a phase or item becomes terminal.

Each command has one stable row, keyed internally by the backend's opaque `row.key`, and updates through these observed states:

| State | Meaning |
|---|---|
| `preparing args` | Argument generation was observed starting. |
| `args ready · outcome unobserved` | Arguments completed, but execution has not been observed. This is not success. |
| `executing` | Execution start or update was observed, with no execution end. |
| `finished · outcome unobserved` | Execution end was observed, but `isError` was absent or malformed. |
| `succeeded` | Execution end was observed with `isError:false`. |
| `failed` | Execution end was observed with `isError:true`. |
| `interrupted` | Execution was observed without an end before its agent, item, or phase became terminal. |

Elapsed command time appears only when an execution start and `startedAt` were observed. It is never an ETA or percentage. Historical argument-only records remain `args ready · outcome unobserved`; missing, synthetic, reused, legacy, and out-of-order identities are displayed as projected rather than correlated by tool name or row order.

Press Enter on a command to expand its retained arguments, output, error, and observed lifecycle history. Output and errors remain inspectable in terminal phases/items. The UI explicitly marks omitted, redacted, truncated, and dropped information. Optional bounded assistant prose and thinking appear only inside an expanded running phase/item and have distinct labels; neither is presented as generic “live reasoning.”

## Keyboard controls

Open the monitor with `/workflows` or `Ctrl+Shift+T`.

- `Up`/`Down` or `k`/`j`: move selection; in artifact view, move by line.
- `Enter` or `Right`: open run detail; expand/collapse a phase, item, command, or retained-command history row; open an artifact.
- `Left`, `b`, or `Esc`: go back. In a filtered list, this clears filters first.
- `Ctrl+U`/`Ctrl+D`: page command details, bounded agent text, artifacts, or the current list/detail selection as appropriate.
- `/`: search runs; type to filter, Backspace deletes, Enter leaves search-entry mode.
- `f`: cycle status filter. `h`: toggle stale-run hiding. `s`: cycle sort order.
- `x`: request cooperative cancellation for the selected live workflow.
- `c`: in artifact view, send a file path or URL target to the editor when one exists.
- `v`: toggle viewer/store build diagnostics in the title.
- `q` or `Ctrl+C`: close the monitor.

The built-in footer is unchanged: each genuinely live workflow contributes one text-free animated glyph in stable order, with no count, name, or extra widget row.

## Token labels

Compact views lead with model output and then show the inclusive **cumulative processed tokens** total. Expanded details show:

- uncached input;
- cumulative cache-read input;
- cumulative cache-write input;
- output, with provider-reported reasoning identified as an included subset; and
- cumulative processed tokens (`uncached input + cache read + cache write + output`).

These are sums across observed model requests, not a context-window size, unique prompt size, response count, or billing estimate. Cache-heavy workflows can legitimately process millions of cached input tokens. Reasoning is already part of output and is not added again. Run, phase, and fanout-item values are hierarchical views of the same usage events and must not be added across levels.

When a usage record has no total, canonical Pi fields (`input`, `output`, `cacheRead`, `cacheWrite`) use the inclusive formula above. Ambiguous legacy provider aliases retain the conservative `input + output` fallback because their input value may already include cache traffic.

## Retention and privacy limits

This display is diagnostic and bounded:

- at most 64 command rows are projected per phase or fanout item, with 12 lifecycle history records per command;
- correlation metadata and unmatched execution keys share a 512-record per-turn budget; overflow is represented with unknown/synthetic identity rather than retaining more keys;
- tool IDs and names must fit within 256 UTF-8 bytes before correlation; overlong values are omitted, never shortened into potentially colliding ID prefixes;
- collector argument previews are capped at 1,024 UTF-8 bytes and result previews at 4,096 bytes; projected previews are capped at 4,096 bytes;
- successful `read` bodies are omitted by default, while read errors remain available;
- raw result details, images, and base64/blob fields are not retained;
- assistant prose and thinking are retained separately and bounded to 4,096 bytes each;
- the collector trace window is 256 records, and bounded run-log reads can omit older commands before projection;
- oversized execution events preserve scalar lifecycle evidence with omission metadata instead of retaining the full payload;
- credential redaction is best effort, not complete secret detection. Workflows should not put secrets in tool arguments or output.

A `dropped:N`, `hidden:N`, `[truncated]`, `[omitted: ...]`, or `[redacted]` marker is evidence that the display is incomplete, not evidence about command success or failure.
