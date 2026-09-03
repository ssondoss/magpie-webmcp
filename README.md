# Magpie

**Your agent can only see the page it is on. Magpie remembers what every site you visit can do, and
lets your agent use all of it together.**

| | |
|---|---|
| 🔗 **Live site** | <https://www.magpie.help> — or <https://magpie-webmcp.vercel.app> if that is blocked ([why two](#if-a-link-does-not-load)) |
| 🎬 **Demo video** | *(add the YouTube link here)* |
| 🧩 **Extension** | `magpie-extension.zip` from Releases, or `npm run release` |
| 📄 **License** | [MIT](LICENSE) |

Built from scratch for the WebMCP Challenge, starting 26 August 2026.

### If a link does not load

Two hosts serve the same deployment, because neither is universally reachable — `magpie.help` is
sinkholed by Palo Alto DNS filtering (which flags recently-registered domains), and `*.vercel.app`
subdomains get connection-reset by some ISPs. Both verified, from different networks.

Try the other one. If both are filtered, [Quick start](#quick-start) runs everything locally and
needs no network beyond `npm install` — which is also the only reliable way to see the cross-site
part, since the demo sites are deployed only on `*.magpie.help`.

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

### Install the extension — this is the part that matters

The site alone only shows that a page *can* expose WebMCP tools. The extension is the idea: tools
from **other** sites, remembered and composed together.

1. Download **`magpie-extension.zip`** from [Releases](../../releases) and unzip it.
2. At `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, select the
   unzipped folder (the one containing `manifest.json`).
3. Open the live site and the two demo sites. The **Sites** tab is where the registry fills up.

Chrome 116+. Nothing to configure, no key, no sign-in. To build from source see
[Quick start](#quick-start).

> **If you reload the extension, refresh any tabs that were already open** — Chrome orphans their
> content scripts, so those pages announce nothing until reloaded.

**Full path — the cross-site part.** With the extension loaded, open
[Northwind Orders](https://orders.magpie.help) and [Helpdesk Support](https://support.magpie.help),
and ask your agent to *"find delayed orders over $5,000 on Northwind Orders and open a Helpdesk
ticket for each, then email me a summary"*. That workflow spans two different origins plus the
extension's own tools — three providers no single page could reach. This is what the video shows.

**Nothing to prepare.** The demo sites hold their own seeded data and need no sign-in, and Magpie
records every run it executes, so the Runs tab is the evidence of what actually happened — per step,
with the capability each one used.

### Try it on sites we did not write

The two demo sites above are ours, which is the obvious objection. So:
[webmcp.com](https://webmcp.com) lists real sites shipping `document.modelContext` tools, and Magpie
discovers any of them by visiting the page — no allowlist, no per-site work. Four that compose well:

| Site | Tools | Why it is useful here |
|---|---|---|
| [flatwrite.md](https://flatwrite.md) | 12 — `create_document`, `update_document_content`, `create_share_link`, `export_document_pdf` | somewhere to *put* a result |
| [coinvela.com](https://coinvela.com) | 7 — `find_best_price`, `compare_exchanges`, `get_crypto_price` | returns data rather than moving the browser |
| [airportloungelist.com](https://airportloungelist.com) | 4 — `search_lounges`, `get_airport_lounges`, `get_lounge_details` | 2,300+ lounges of real data |
| [aloyoga.com](https://www.aloyoga.com) | 10 — `search_catalog`, `get_cart`, `search_shop_policies_and_faqs` | a real store, with a real cart |

With the extension loaded, open two of them and ask for something that needs both:

> *"Find the lounges at Dubai airport, write them up as a FlatWrite document, and WhatsApp me the
> share link."*

Three origins, two of them nobody here wrote.

**They are other people's sites, so they change.** A renamed or withdrawn tool reports `TOOL_CHANGED`
or `TOOL_MISSING` with the site's current tools listed, rather than guessing — the drift handling in
[resolver.ts](src/background/resolver.ts) doing its job. Two caveats: many commerce tools *navigate*
rather than return values, so prefer the ones that return data; and tools registered inside an iframe
are not seen at all, since only top-level frames are scanned.

**Where the WebMCP work is:**

| | |
|---|---|
| Exposing tools | [web/app/tools.ts](web/app/tools.ts), [demo/orders/app.js](demo/orders/app.js), [demo/support/app.js](demo/support/app.js) |
| Discovering tools | [src/content/main-world.ts](src/content/main-world.ts) — polyfill + observer, MAIN world |
| One registry across sites | [src/background/registry.ts](src/background/registry.ts) |
| Executing across origins | [src/background/engine.ts](src/background/engine.ts), [resolver.ts](src/background/resolver.ts) |
| Refusing to invent | `assertToolsExist()` in [web/app/tools.ts](web/app/tools.ts) |

---

## What it is

A site exposes `search_orders()`, `create_ticket()`. Magpie adds `export_csv()`, `compose_email()`,
`send_slack_message()` and more. Your agent asks what is reachable, composes steps from capabilities
that **actually exist**, and Magpie runs them across tabs and sites — including sites not currently
open.

Two halves, either usable alone:

- **The site** ([web/](web/)) — a workflow library that *exposes* WebMCP tools. Any agent can list
  what is reachable, run steps, save workflows and read the history. No install, no key.
- **The extension** ([src/](src/)) — *discovers* WebMCP tools on every site you visit, remembers
  them, and executes them in your browser with your own sessions. This is the part a web page cannot
  do for itself.

The division is deliberate. `document.modelContext` is per-document: no page can see another page's
tools, however capable the agent driving it. A tool is not an endpoint either — `registerTool()` hands
over a *function*, which lives in that page's heap and can only be called from inside it. So there is
nothing for another origin to fetch even if it knew the name. That gap is browser-shaped, and an
extension is the only place to close it without a backend.

### Why not just use an agentic browser?

Worth answering with the harder version of the question first: **this is not a new capability, and
neither was WebMCP.** Agents operated websites long before the spec — scraping the DOM, reading
accessibility trees, driving a mouse. What WebMCP added was a *contract*: the site declares what it
supports, with types, instead of the agent inferring intent from markup and breaking on the next
redesign. Magpie does the same thing one layer up — a contract *across* pages rather than within one.

So the answer is not that an agentic browser cannot reach across origins. It can. An in-app browser is
not a page; it hosts pages, so the same-origin policy does not apply to it. It sits at the same
privilege level this extension does.

It can also open a closed tab, and a model with memory may well recall that a site had a useful tool.
So the difference is not reach, and not whether memory exists — it is whether any of it is
**structured and guaranteed**:

| | In-app browser | This extension |
|---|---|---|
| Reach across origins | yes | yes |
| Open a site that is not currently open | yes | yes |
| Knows *which* closed site provides a named capability | only if the model happens to recall it | an indexed registry, by design |
| Stored input schemas, and drift detected against them | no | schema hash, order-insensitive |
| Explicit capability status before running | no | `AVAILABLE`, `SITE_CLOSED`, `AUTH_REQUIRED`, `TOOL_CHANGED`, `TOOL_MISSING` |
| A hallucinated capability is refused | no guarantee | `assertToolsExist()`, with the real names listed |
| The same request runs the same steps twice | regenerated each time | a saved workflow replays its references |
| What ran is recorded by the engine, not narrated by the agent | no | run history, per step |

The last three are the ones that matter. An agent can do all of this on a good day; Magpie is what
makes it the same on a bad one. A saved workflow is a set of stored references resolved against what
is live right now — not a plan re-derived, and possibly re-derived differently, on every request. And
because the engine writes the run record rather than the agent reporting on itself, a step marked `ok`
genuinely ran.

## Quick start

```bash
npm install
npm run build          # extension → dist/
npm run web:dev        # the site   → http://localhost:4173
npm run demos          # the demo sites → :4321 :4322
```

1. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, select `dist/`.
2. Open `http://localhost:4173` and the demo sites you want to compose across.
3. Drive it with whatever agent you use, or press **Run** on a saved workflow.

Nothing to configure. The extension's Settings tab holds only what its own action tools need — a
Slack webhook, a mail client, a calendar target, and whether to reopen a closed site mid-run.

## Architecture

Two deployables sharing one core. [transform.ts](src/background/transform.ts),
[schema.ts](src/shared/schema.ts) and [util.ts](src/shared/util.ts) touch no extension API, so the
site imports them directly — a workflow behaves identically in both, rather than being reimplemented
and drifting.

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

`content-main.js` runs in the page's **MAIN world** at `document_start`, installing a `modelContext`
polyfill or wrapping a native implementation in place. Registrations are mirrored to
`content-bridge.js` (ISOLATED world) and relayed to the service worker. **Tool handlers never leave
the page** — to run one, the worker asks the bridge, which asks the page.

The API moved from `navigator.modelContext` to `document.modelContext`, and some sites keep the old
name as a getter that warns on access. Discovery checks `document` first and uses `in` to test for
the property without invoking such a getter.

### Namespacing

Tools are addressed as `<providerKey>.<toolName>` (`northwind_orders.search_orders`). The key comes
from `<meta name="webmcp-provider">` or the hostname, and is **permanent once assigned** — saved
workflows hold nothing but that name, so re-deriving it would orphan every reference with no way
back.

### The page API

The site reaches the extension over `window.postMessage`, through a deliberately narrow surface
([protocol.ts](src/shared/protocol.ts)): ping, list capabilities, run a plan, open a site, forget a
site. No way to read a setting; a write still requires approval. The origin check uses
`sender.origin`, which the browser sets and a page cannot forge — only `TRUSTED_PAGE_ORIGINS` are
answered at all.

### Step contract

Steps are JSON only — never JavaScript — validated with Zod ([schema.ts](src/shared/schema.ts)) and
then checked against the registry: every `tool` must exist. Anything invented is rejected with the
names that do exist, so a hallucinated capability never reaches the engine.

Five step types. The three that move data:

```jsonc
{ "id": "s1", "type": "tool",      "tool": "northwind_orders.search_orders", "arguments": {...}, "output": "orders" }
{ "id": "s2", "type": "transform", "operation": "filter", "input": "orders", "output": "high",
  "condition": { "field": "amount", "operator": ">", "value": 5000 } }
{ "id": "s3", "type": "gate",      "condition": { "all": [
    { "field": "orders.count", "operator": ">", "value": 0 },
    { "field": "high.length",  "operator": ">", "value": 0 } ] } }
```

Two more carry no data: `reason` hands a judgement back to the agent, `missing` records a capability
no site provides.

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

The last four are outward-facing, so they trip the approval prompt — including the three that only
draft, because each addresses a real person. The gate is about what a capability *does*, not who
provides it. A tool awaiting setup reports `AUTH_REQUIRED` with a hint, exactly like a site awaiting
sign-in.

### Reason steps

A step type for judgement the transform DSL cannot express — classification, extraction, "the most
urgent". Having no model of its own, Magpie stops and hands the question back with the data attached,
because guessing would be worse. The agent driving the workflow can answer it and continue.

### Gates

A `filter` narrows a list; a **gate** decides whether the rest of the workflow happens at all. It
produces no data and reuses `filter`'s condition grammar, evaluated against the run's variables
rather than one row — which is what lets one site's reading gate another site's action.

Stopping is a **success**: the run ends as `conditions_not_met`, later steps are marked *not reached*,
and the answer says what the check found. A watch job that finds nothing to do must not look broken.

A gate **fails closed**. If the data it checks never arrived, the run stops rather than comparing
against nothing — `price < 3500` against *no price* would otherwise pass.

### Tool operations vs agent operations

Sites do what only they can (search orders, create a ticket). Everything else — filter, sort, map,
pick, group, summarize, limit, unique, flatten, count, concat — is deterministic local code in
[transform.ts](src/background/transform.ts). The Orders demo deliberately exposes **no** amount
filter, so "over $5,000" *must* become a local transform step.

### Execution

One step at a time, variables passed by reference (`{{orders}}`, `{{item.id}}`, `{{orders.length}}`);
`forEach` runs a step once per array element. Per-step status, duration, preview and errors are
recorded by the engine — not reported by the agent — so an `ok` step genuinely ran. A closed site
mid-run **pauses** the run as `blocked` with variables intact, to resume rather than restart.

### Capability states and resolution

`AVAILABLE`, `SITE_CLOSED`, `AUTH_REQUIRED`, `TOOL_CHANGED`, `TOOL_MISSING`.

Saved workflows store capability *references* — name, schema, origin, schema hash — never page code.
Each is resolved against what is live now: reopen the provider if closed, wait for rediscovery, match
the stored reference. If the site needs a login you sign in normally — **Magpie never stores,
autofills or handles credentials**.

Drift is compared by schema hash, order-insensitive so key reordering is not a false positive. A
renamed tool reports `TOOL_MISSING` with the site's current tools as candidates.

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

Two static sites, each on its own origin, each exposing real WebMCP tools:

| Site | Port | Deployed | Namespace | Tools |
|---|---|---|---|---|
| **Northwind Orders** | 4321 | <https://orders.magpie.help> | `northwind_orders` | `search_orders`, `find_orders`, `get_order`, `get_customer` |
| **Helpdesk Support** | 4322 | <https://support.magpie.help> | `helpdesk_support` | `create_ticket`, `list_tickets` |

Separate origins — different ports locally, different subdomains deployed — so composing across them
is genuinely cross-site rather than staged. Two paths on one host would be *one* origin, and the
registry would merge them. Namespaces come from the `webmcp-provider` meta tag, not the hostname, so
they are identical locally and deployed.

Support can be signed out, which is how `AUTH_REQUIRED` is demonstrated.

## Tests

`npm test` runs three suites — **57 tests**, no browser required:

- **Extension core** (37, `tests/core.test.ts`) — reference resolution, every transform operation,
  the step contract, namespacing, schema-hash stability. The engine runs end to end against a
  `chrome.*` stub: a gate stops the steps below it and **fails closed when its data never arrived**,
  and a declined `reason` step is a stop rather than a failure.
- **The site** (20, `tests/web.test.ts`) — the tool surface, real execution of the seeded workflows,
  cross-site delegation, invented capabilities refused with the real ones named, and the approval
  prompt an agent cannot answer for itself. The extension is stubbed at the `window.postMessage`
  seam, so the real client is exercised rather than a mock.
- **Demo apps** (`scripts/check-demos.mjs`) — each demo's real script against a DOM stub: descriptors,
  results, drift toggle, sign-out, and that no two demos slug to the same namespace.

Not covered: the Chrome-only surfaces (content-script bridge, worker messaging, panel rendering).
Exercised by hand.

---

## Planned

**Watch jobs.** A gate already makes an unattended workflow possible; only a `chrome.alarms` trigger
is missing. The hard part is not the timer but the approval — a write asks the person at the keyboard,
and at 3 AM nobody is there. It needs approving once in advance with limits validated in `startRun`,
plus run state that outlives the service worker. Note `send_slack_message` is the only delivery tool
that could finish such a job; the other three stage something for a person to confirm.

**Workflows calling workflows.** Names already resolve, so a step could name another saved workflow.
The work is a loop guard, and making the approval prompt look inside a nested one.

[TODO.md](TODO.md) sketches remote MCP servers as a further capability source, plugging into the same
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
