# TODO — post-MVP capability sources

None of these is needed for the 14 success criteria in [README.md](README.md). B and C are
implemented as *additional sources for the same capability registry*, so nothing downstream
(planner, engine, resolver, UI) has to change shape. A is the one that adds a new axis: *when* a
workflow runs.

---

## A. Watch jobs — a schedule plus a pre-approval

**Idea.** A saved workflow on a `chrome.alarms` interval is a watcher: every tick runs the whole
workflow, and the `gate` step decides whether anything actually happens. No new "watcher" concept —
schedule + gate is enough.

### Design sketch

- `alarms` permission in [public/manifest.json](public/manifest.json); one alarm per armed workflow.
- Arm/disarm on a saved workflow in [storage.ts](src/background/storage.ts), with fire history.
- A tick resolves capabilities exactly as a manual run does — [resolver.ts](src/background/resolver.ts)
  already reopens closed providers and waits for rediscovery, so a headless run works today.
- Run state must live in `chrome.storage.local`: the MV3 worker dies between ticks.

### The actual problem — approval

A non-local write needs an explicit checkbox today, enforced in `startRun`. An unattended run has
nobody to tick it. So arming stores a **pre-approval with limits** beside the schedule, and `startRun`
validates against that instead:

| Limit | Example | What it stops |
|---|---|---|
| max spend per fire | $1,000 | a plan that quotes for far more |
| max fires | 1 | it disarms itself after firing |
| expiry | 2026-09-30 | a forgotten job running forever |
| allowed tools | `wallet.execute_quote` only | any other write sneaking in |

Shown to the user as one sentence before they arm it — *"this may spend up to $1,000, once, before
30 September"* — with a notification on every fire and on self-disarm, and a `blocked` park rather
than adaptation if a plan drifts outside the limits.

The Wallet demo's own $1,500 ceiling is the second, independent limit: one in the extension, one at
the resource, so neither is the single point of failure.

### Testing focus

Envelope rejection over notional, over expiry, and on a tool not in the allow-list; disarm after the
last permitted fire; a tick whose gate does not open recording `conditions_not_met` without touching
the fire count.

---

For B and C the registry is the extension point.
[`buildCapabilities()`](src/background/registry.ts) merges live page tools + remembered site tools +
extension tools into one `Capability[]`. Each adds a fourth and fifth source to that merge. The planner
never learns where a capability came from.

## B. Remote MCP server integrations

**Idea.** Let the user connect a real MCP server (HTTP/SSE) and register its tools as another
provider. Completes the story: **WebMCP for pages, MCP for services, one registry.** This is the
principled way to add Slack/Jira/email rather than special-casing each.

### Design sketch

- New settings screen: a list of servers — `{ id, name, url, transport, auth, enabled }`.
- New module `src/background/mcp-client.ts`:
  - `initialize` handshake, then `tools/list` → `ToolDescriptor[]` (already our internal shape —
    MCP tool descriptors and WebMCP registrations are the same object).
  - `tools/call` for execution.
  - Reconnect + backoff; cache the last-seen tool list so a disconnected server behaves like
    `SITE_CLOSED` rather than vanishing.
- `Capability.source` gains `'mcp'`; ids namespaced `mcp_<serverKey>.<toolName>`.
- [`registry.ts`](src/background/registry.ts): push MCP capabilities in `buildCapabilities()`.
- [`engine.ts`](src/background/engine.ts) `callCapability()`: third branch → `mcp-client.callTool()`.
- [`resolver.ts`](src/background/resolver.ts) `resolveRequirement()`: an unreachable server maps to
  `SITE_CLOSED` with a "Reconnect" action instead of "Open site".

### Open questions

- **Auth.** OAuth flows need `chrome.identity` (new permission). Start with a static bearer token
  in settings and treat OAuth as a follow-up.
- **CORS.** Extension `fetch` from the service worker is not subject to page CORS, but the server
  still has to accept the request. Document which servers work.
- **Risk inference.** MCP annotations (`readOnlyHint`, `destructiveHint`) already feed
  [`inferRisk()`](src/shared/capability.ts) — verify real servers actually set them, since the
  approval gate depends on it.
- **Trust.** A remote server is a much larger blast radius than a page tool. Probably needs an
  explicit "this server can write" acknowledgement at connect time.

**Effort:** ~300+ lines plus a settings UI. The transport and auth are the bulk of it.

---

## C. Saved workflows as capabilities

**Idea.** A saved workflow already *is* a user-defined capability. Expose each one in the registry
so the planner can call it as a single step. The user teaches the agent a new capability by using it
once — no code, no config.

```
"Run my high-value follow-up process, then copy the ticket numbers to my clipboard."

workflow.high_value_delayed_order_process → tickets
                 ↓
        global.copy_to_clipboard({{tickets}})
```

### Design sketch

- `Capability.source` gains `'workflow'`; ids namespaced `workflow.<workflowId>`;
  `provider: 'My workflows'`; description from the workflow's `summary`.
- [`registry.ts`](src/background/registry.ts): `capabilities.push(...workflowCapabilities(await getWorkflows()))`.
- [`engine.ts`](src/background/engine.ts) `callCapability()`: load the workflow, rebuild its plan via
  `planFromWorkflow()`, run it as a nested run, return `finalValue()`.
- **Recursion guard.** The run record carries a stack of workflow ids; re-entry fails with a clear
  error rather than hanging.
- **Requirements must flatten.** [`requirementsFromPlan()`](src/background/resolver.ts) has to expand
  `workflow.*` into the workflow's own `requiredCapabilities`, so "⚠ Support not open" appears in the
  outer plan *before* the user presses Run. Without this, the run blocks mid-flight as a surprise.
- **Risk inherits.** A workflow containing a write capability is itself a write capability, so
  [`riskyCapabilities()`](src/background/engine.ts) keeps triggering the approval checkbox.

### Known limitation — no parameters

Saved workflows freeze their arguments at save time (`{status: 'delayed'}` is baked in), so
`workflow.*` capabilities are **zero-argument**: "run this exact process." Good for composition and
reuse; useless for *"run my process for customer Acme."*

Parameterising is a separate, larger feature: let the user mark argument literals as inputs when
saving, derive an `inputSchema` from them, and re-bind at call time. ~200 extra lines plus UI.

**Effort:** ~80–120 lines for the zero-argument version.

### Testing focus

Nested runs work in the happy path and break at the edges. Cover:
- inner workflow blocks on a closed site → outer run parks as `blocked` and resumes correctly
- inner workflow has a `missing` step → outer run reports it rather than silently skipping
- recursion guard fires
- inner failure surfaces with the inner step's message, not a generic one

---

## Related, considered, not planned

**User-authored JavaScript tools.** Manifest V3 forbids `eval`/`new Function`/remote code
(`script-src 'self'`, Web Store rejects `unsafe-eval`), and it contradicts planner rule #8 — the
agent never generates or runs JS. Any user-defined tool must be declarative.

**Declarative HTTP tools.** A middle ground: the user describes a request
(`{method, url, headers, body}` with `{{arg}}` templates) and the engine performs it. ~150 lines,
reuses the existing template resolver, and covers the "integrations such as email" the original spec
deferred. Rejected for now in favour of B, which solves the same problem with a real protocol. If B
proves too heavy, revisit this — but note the agent decides *when* these fire, so it needs
`local: false`, a mandatory approval gate, and probably a host allowlist.

**AI-generated DOM tools.** Explicitly out of scope for V1–V4 per the original spec.
