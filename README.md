# Magpie

**Your agent can only see the page it is on. Magpie remembers what every site you visit can do, and
lets your agent use all of it together.**

| | |
|---|---|
| 🔗 **Live site** | <https://magpie.help> |
| 🎬 **Demo video** | *(add the YouTube link here)* |
| 🧩 **Extension** | `magpie-extension.zip` from Releases, or `npm run release` |
| 📄 **License** | [MIT](LICENSE) |

Built from scratch for the WebMCP Challenge, starting 26 August 2026.

---

## For evaluators

**Magpie has no AI of its own, and needs no API key.** It is a capability bridge. Whichever agent you
are already using does the thinking; Magpie gives it a registry that spans websites, an engine that
can execute across them, and a memory that outlives the tab.

**Fastest path — no install.** Open the live site and ask your agent:

> *"What can you reach through Magpie? Then run the workflow that exports my library."*

The page registers **13 capabilities** with `document.modelContext.registerTool()`
([web/app/tools.ts](web/app/tools.ts)) and genuinely executes what it is asked to — list, filter,
sort, download. Nothing is mocked.

**Full path — the cross-site part.** Install the extension, open the demo sites, and ask your agent
to *"find delayed orders over $5,000 on Northwind Orders and open a Helpdesk ticket for each"*. That
workflow spans two different origins plus the extension's own tools. This is what the video shows.

**The one that needs no explaining.** Open Bullion Desk (`:4323`) and Crypto Desk (`:4324`) and ask
for *"if gold is above $3,500 and I have at least $1,000 free, buy $1,000 of BTC"*. One site's price
decides whether another site's purchase happens — a decision neither site could ever have shipped,
because neither can see the other.

**Where the WebMCP work is:**

| | |
|---|---|
| Exposing tools | [web/app/tools.ts](web/app/tools.ts), [demo/orders/app.js](demo/orders/app.js), [demo/support/app.js](demo/support/app.js), [demo/metals/app.js](demo/metals/app.js), [demo/crypto/app.js](demo/crypto/app.js) |
| Discovering tools | [src/content/main-world.ts](src/content/main-world.ts) — polyfill + observer, MAIN world |
| One registry across sites | [src/background/registry.ts](src/background/registry.ts) |
| Executing across origins | [src/background/engine.ts](src/background/engine.ts), [resolver.ts](src/background/resolver.ts) |
| Refusing to invent | `assertToolsExist()` in [web/app/tools.ts](web/app/tools.ts) |

---

## What it is

A site exposes `search_orders()`, `get_customer()`, `create_ticket()`. Magpie adds `export_csv()`,
`compose_email()`, `send_slack_message()`, `notify()` and more. Your agent asks what is reachable,
composes steps from capabilities that **actually exist**, and Magpie runs them — across tabs, across
sites, including sites that are not open at the moment.

Two halves, either usable alone:

- **The site** ([web/](web/)) — a workflow library that *exposes* WebMCP tools. Any agent can list
  what is reachable, run steps, save workflows and read the history. No install, no key.
- **The extension** ([src/](src/)) — *discovers* WebMCP tools on every site you visit, remembers
  them, and executes them in your browser with your own sessions. This is the part a web page cannot
  do for itself.

The division is deliberate. `document.modelContext` is per-document: no page can see another page's
tools, however capable the agent driving it. That gap is browser-shaped, so an extension is the only
place to close it without a backend.

## Quick start

```bash
npm install
npm run build          # extension → dist/
npm run web:dev        # the site   → http://localhost:4173
npm run demos          # four demo sites → :4321 :4322 :4323 :4324
```

1. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, select `dist/`.
2. Open `http://localhost:4173` and the demo sites you want to compose across.
3. Drive it with whatever agent you use, or press **Run** on a saved workflow.

Nothing to configure. The extension's Settings tab holds only what its own action tools need — a
Slack webhook, a mail client, a calendar target, and whether to reopen a closed site mid-run.

## The four versions

| | | |
|---|---|---|
| **V1** | Discover WebMCP tools, compose, execute | [main-world.ts](src/content/main-world.ts), [registry.ts](src/background/registry.ts), [engine.ts](src/background/engine.ts) |
| **V2** | Save workflows; re-resolve tools across sessions, including drift | [resolver.ts](src/background/resolver.ts), [store.ts](web/app/store.ts) |
| **V3** | Extension-provided tools, so a workflow can span sites and act | [global-tools.ts](src/background/global-tools.ts) |
| **V4** | Detect missing capabilities and say what cannot be done | `assertToolsExist()` in [tools.ts](web/app/tools.ts), `missing` steps in [engine.ts](src/background/engine.ts) |

---

## Architecture

Two deployables sharing one core. [transform.ts](src/background/transform.ts),
[schema.ts](src/shared/schema.ts) and [util.ts](src/shared/util.ts) touch no extension API, so the
site imports them directly — a workflow behaves identically in both, rather than being reimplemented
and drifting.

```text
The site (web/)                        The extension (src/)
├── WebMCP tools it exposes            ├── Discovery (MAIN world polyfill)
├── Workflow library + run history     ├── Registry across tabs + remembered sites
└── Executes what it can alone         ├── Extension's own action tools
         ╲                             └── Engine — cross-site, your sessions
          ╲___ shared engine ______
                                   ╲
                          transform.ts · schema.ts · util.ts
```

```text
Your agent
    │  document.modelContext
    ▼
The Magpie site ──── page API ────▶ Extension
    │                                  ├── Capability Registry
    │                                  │     ├── Live WebMCP tools ..... per tab
    │                                  │     ├── Remembered sites ...... names + schemas, never code
    │                                  │     └── Extension tools ........ global-tools.ts
    │                                  ├── Resolver ..... reopens closed sites, matches drifted tools
    │                                  └── Engine ....... runs each step in the tab that owns it
    ▼
Workflows + run history (this browser only)
```

### Discovery

`content-main.js` runs in the page's **MAIN world** at `document_start`. It installs a
`modelContext` polyfill (`registerTool`, `unregisterTool`, `provideContext`, `listTools`,
`callTool`) or, if a native implementation is already present, wraps it in place. Every registration
is mirrored to `content-bridge.js` (ISOLATED world) over `window.postMessage`, which relays it to the
service worker. Tool handlers never leave the page: to run a tool, the worker asks the bridge, which
asks the page, which calls the handler.

Because the polyfill is installed on every http(s) page, sites feature-detecting `modelContext` will
see it as supported. That is intentional for this project.

**API location.** The WebMCP surface moved from `navigator.modelContext` to `document.modelContext`;
some sites keep the old name as a deprecated alias that warns on every access. Discovery therefore
checks `document` first, uses `in` to test for the property without invoking such a getter, and
captures the resolved object once instead of re-reading the global on each publish.

### Namespacing

Tools are addressed as `<providerKey>.<toolName>` (`northwind_orders.search_orders`), where
`providerKey` comes from `<meta name="webmcp-provider">` or the hostname, is de-duplicated against
other origins, and is persisted — so a namespace keeps pointing at the same origin across sessions.
The four demo apps on different localhost ports get distinct namespaces, which
`scripts/check-demos.mjs` asserts, since a collision would silently merge two sites.

### The page API

The site reaches the extension over `window.postMessage`, through a deliberately narrow surface
([protocol.ts](src/shared/protocol.ts)): ping, list capabilities, run a plan, open a site, forget a
site. There is no way to read a setting, and a write still requires approval.

The origin check uses `sender.origin`, which the browser sets and a page cannot forge. Only origins
in `TRUSTED_PAGE_ORIGINS` are answered at all.

### Step contract

Steps are JSON only — never JavaScript — validated with Zod ([schema.ts](src/shared/schema.ts)) and
then checked against the registry: every `tool` must exist. Anything invented is rejected with the
names that do exist, so a hallucinated capability never reaches the engine.

Five step types:

```jsonc
{ "id": "s1", "type": "tool",      "tool": "northwind_orders.search_orders", "arguments": {...}, "output": "orders" }
{ "id": "s2", "type": "transform", "operation": "filter", "input": "orders", "output": "high",
  "condition": { "field": "amount", "operator": ">", "value": 5000 } }
{ "id": "s3", "type": "reason",    "input": "high", "mode": "select", "output": "supplierDelays",
  "instruction": "Keep the ones that look like supplier problems" }
{ "id": "s4", "type": "gate",      "condition": { "all": [
    { "field": "spot.quotes.0.price", "operator": ">",  "value": 3500 },
    { "field": "balances.available.USD", "operator": ">=", "value": 1000 } ] } }
{ "id": "s5", "type": "missing",   "capability": "refund_order", "reason": "..." }
```

### Extension tools

Nine, in the same registry shape as page tools ([global-tools.ts](src/background/global-tools.ts)):

| Tool | Setup | Side effect |
|---|---|---|
| `export_csv`, `download_file` | none | writes a file locally |
| `copy_to_clipboard` | none | writes the clipboard |
| `notify` | none | desktop notification |
| `open_url` | none | opens a tab |
| `compose_email` | choose Gmail or your mail app | opens a **draft** — never sends by itself |
| `create_calendar_event` | choose Google Calendar or `.ics` | opens a **pre-filled event** — never books by itself |
| `send_whatsapp_message` | none | opens WhatsApp **pre-filled** — never sends by itself |
| `send_slack_message` | paste an incoming-webhook URL | posts immediately |

`compose_email`, `create_calendar_event`, `send_whatsapp_message` and `send_slack_message` are
outward-facing, so they trip the approval prompt. The gate is about what a capability *does*, not
whether a site or the extension provides it — and it applies to the three drafting tools even though
none of them transmits anything, because each one addresses a real person.

WhatsApp has no equivalent of a Slack incoming webhook, so `send_whatsapp_message` opens a `wa.me`
deep link rather than calling an API. That keeps it setup-free, and it is the honest shape for this
project: the Business Cloud API would need a Meta account and a bearer token, and it only permits
free-form text within 24 hours of the recipient messaging you — outside that window it demands a
pre-approved template, which an unattended watch job could not satisfy.

A tool awaiting one-time setup reports `AUTH_REQUIRED` with a hint, exactly like a site awaiting
sign-in, so a run parks with an actionable message instead of failing halfway.

### Reason steps

The schema keeps a step type for judgement the transform DSL cannot express — classification,
extraction, "the most urgent". Magpie does not perform it. Having no model of its own, it stops and
hands the question back with the data attached, because guessing would be worse than saying so. The
agent driving the workflow is perfectly able to make the call and continue.

### Gates

A `filter` narrows a list. A **gate** decides whether the rest of the workflow happens at all — *"only
buy if gold is above $3,500 and I have the cash"*. It produces no data, takes no input, and reuses the
same condition grammar as `filter`, evaluated against the run's variables rather than one row. That is
what lets one site's price gate another site's purchase:

```text
Gold price (Bullion Desk) → Cash balance (Crypto Desk) → ✓ gold > 3500 and USD ≥ 1000 → Quote → Buy
```

Stopping is a **success**, not a failure. The run ends as `conditions_not_met`, the steps below are
marked *not reached*, and the answer says what the check found — a watch job that finds nothing to do
must not look broken.

A gate **fails closed**. If the data it checks never arrived — the site was shut, or the step that
would have fetched the price was dropped — the run stops rather than comparing against nothing,
because `price < 3500` against *no price* would otherwise pass.

### Tool operations vs agent operations

External capabilities do the things only a site can do (search orders, create a ticket). Everything
else — `filter`, `sort`, `map`, `pick`, `group`, `summarize`, `limit`, `unique`, `flatten`, `count`,
`concat` — is local work, executed as deterministic code in
[transform.ts](src/background/transform.ts). The Orders demo deliberately exposes **no** amount
filter on `search_orders`, so "over $5,000" *must* become a local transform step.

### Execution

One step at a time, with variables passed by reference (`{{orders}}`, `{{item.id}}`,
`{{orders.length}}`). A tool step with `forEach` runs once per array element. Per-step status,
duration, result preview and errors are recorded, and the run is saved to the library so an ad-hoc
request still leaves a trail.

If a required site is closed mid-run, the run **pauses** as `blocked` with its variables intact —
resolve the capability, then resume instead of starting over.

### Capability states and resolution

`AVAILABLE`, `SITE_CLOSED`, `AUTH_REQUIRED`, `TOOL_CHANGED`, `TOOL_MISSING`.

Saved workflows store capability *references* — name, description, input schema, origin/provider,
schema hash, last-seen metadata — never page code. On every run each reference is resolved against
what is live right now: open the provider if it is closed, wait for rediscovery, and match the stored
reference to the live tool. If the site now needs a login, you sign in normally — **Magpie never
stores, autofills, or handles credentials**; it uses your ordinary browser session.

Tool drift is compared by schema hash, order-insensitive so key reordering is not a false positive.
An exact match runs; a renamed tool is reported as `TOOL_MISSING` with the site's current tools listed
as candidates.

### Safety

- JSON steps only; no generated JavaScript, ever.
- Invented tool names are rejected with the real ones listed, never silently accepted.
- Write and destructive capabilities are flagged from MCP annotations first, then name heuristics.
- A gate fails closed, so a condition guarding a write cannot silently vanish.
- Anything that writes asks the person at the keyboard. The prompt takes no `approved` argument an
  agent could set for itself, and fails closed where it cannot ask.
- The page API answers only origins the browser confirms are on the allowlist.
- No DOM automation.

---

## Demo applications

Four static sites, each on its own origin, each exposing real WebMCP tools:

| Site | Port | Deployed | Namespace | Tools |
|---|---|---|---|---|
| **Northwind Orders** | 4321 | <https://northwind-orders.vercel.app> | `northwind_orders` | `search_orders`, `find_orders`, `get_order`, `get_customer` |
| **Helpdesk Support** | 4322 | <https://helpdesk-support.vercel.app> | `helpdesk_support` | `create_ticket`, `list_tickets` |
| **Bullion Desk** | 4323 | <https://bullion-desk-eight.vercel.app> | `bullion_desk` | `get_spot`, `get_history`, `list_instruments` |
| **Crypto Desk** | 4324 | <https://crypto-desk.vercel.app> | `crypto_desk` | `get_balances`, `get_quote`, `execute_quote`, `list_trades` |

Separate ports mean separate origins, so composing across them is genuinely cross-site rather than
staged. The namespaces come from each page's `<meta name="webmcp-provider">` rather than its hostname,
so they are identical whether a demo is served on localhost or on Vercel — a workflow saved against
one resolves against the other.

Support can be signed out, which is how `AUTH_REQUIRED` is demonstrated. Crypto Desk enforces its own
$1,500 per-trade ceiling, refuses replayed idempotency keys, and expires quotes — a second,
independent limit that holds regardless of what a workflow asks for.

## Tests

`npm test` runs three suites — **56 tests**, no browser required:

- **Extension core** (37 tests, `tests/core.test.ts`) — reference resolution, every transform
  operation, the Zod step contract, CSV quoting, risk inference, provider namespacing, schema-hash
  stability, result previews, and the trusted-origin check. The engine runs end to end against a
  `chrome.*` stub, including proof that a gate stops the steps below it, fails closed when its data
  never arrived, and survives sanitisation. A declined `reason` step is pinned as a *stop* rather than a
  failure, while a `reason` implementation that genuinely breaks still fails the run.
- **The site** (19 tests, `tests/web.test.ts`) — the registered tool surface, real execution of the
  seeded workflows, cross-site delegation to the extension, invented capabilities refused with the
  real ones named, the approval prompt an agent cannot answer for itself, workflow naming and
  uniqueness, run history, and the store invariant `useSyncExternalStore` depends on. The extension
  is stubbed at the `window.postMessage` seam, so the real client is exercised rather than a mock.
- **Demo apps** (`scripts/check-demos.mjs`) — executes each demo's real script against a DOM stub and
  asserts the registered descriptors, results, drift toggle and sign-out behaviour, plus that no two
  demos slug to the same namespace. For Crypto Desk, against a controllable clock: that quoting moves no
  money, a replayed `idempotencyKey` adds no second trade, and an expired or over-cap trade is refused.

Not covered: the Chrome-only surfaces (content-script bridge, service-worker messaging, panel
rendering). Those were exercised by hand.

---

## Planned

**Watch jobs.** A gate makes an unattended workflow possible; the trigger is what is missing. A saved
workflow on a `chrome.alarms` interval becomes a watcher for free — each tick runs the whole thing and
the gate decides whether anything happens. The real design work is not the timer but the approval:
today a write asks the person at the keyboard, and at 3 AM nobody is there. The answer is to approve
once, in advance, with limits stored beside the schedule — *at most $1,000, once, before 30 September,
using only `crypto_desk.execute_quote`* — validated in `startRun` rather than at a prompt. It also
needs run state that survives the service worker being evicted, which today it does not.

**Workflows calling workflows.** Names are already unique and already resolve, so a step could refer
to another saved workflow. The work is a loop guard and making the approval prompt look inside a
nested workflow, so a write cannot hide in there.

[TODO.md](TODO.md) sketches remote MCP servers as a further capability source. It plugs into the same
registry.

## Known limits

- No backend anywhere. The extension uses `chrome.storage.local`; the site uses `localStorage`, so a
  visitor's workflows stay in their browser and do not sync.
- The site cannot reach other origins; that is the same-origin policy, and it is precisely the gap
  the extension fills.
- `reason` steps stop and hand the judgement back, so a saved workflow replays deterministically only.
- Blocked runs are resumable only while the service worker stays alive; run state is held in memory.
- Only top-level frames are scanned for WebMCP tools.
- The registry is uncapped, so it grows with every remembered site. Fine at demo scale; **forget this
  site** is the manual escape hatch.
