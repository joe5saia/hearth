# Hearth

A meal planner for one household: saved recipes, a weekly calendar, and a shopping list calculated from the meals you actually planned. React + TypeScript, Effect 4 RC, Cloudflare Workers + D1 (SQLite), and Alchemy 2. Earth colors, restrained transitions, and responsive layouts.

## Run everything locally

Use Node 26.10 or newer (version in `.node-version`). No Cloudflare account, API key, remote database, Docker, or paid service is required.

```sh
npm ci
npx task dev
```

Open http://localhost:5173 on your own machine. `task dev` builds the initial static assets, then starts Vite with React HMR and Alchemy's local Worker on port 8787. Vite proxies `/api` to that Worker. Alchemy applies the SQL migrations and persists the local SQLite database beneath `.alchemy/`. Restarting the app preserves your local household. **Deleting `.alchemy/` deletes local data and development infrastructure state.** Production data and deployment state are stored in Cloudflare. Keep the local directory private and backed up.

The empty app offers **Try a sample week**. This adds six editable recipes and five meals in the browser's current week. It never runs automatically in production. You can also start with your own recipe. Example recipes are original demonstration content; source links point to related recipe collections, and bundled photos are illustrative.

Taskfile.yml is the entry point for repository development commands, for people and agents.
Task is installed as a pinned npm development dependency, so bootstrap a fresh checkout with
`npm ci`, then use `npx task` to list available tasks and `npx task install` to reinstall dependencies.
Package scripts are implementation primitives, not the documented workflow. Pass arguments after
`--`, for example `npx task test -- tests/api.test.ts`.

`dev:web` enables Vite's experimental bundled dev mode to avoid module-request waterfalls over orb portals.
It uses the `vite-dev` alias with Rolldown 1.2.9, matching Vite 8.3.1's embedded HMR runtime; Rolldown
1.2.10+ changed that runtime interface. Production keeps the original Vite and Rolldown versions.
Use `npx task build`: both Vite packages export the same CLI name, so its underlying build
script explicitly selects the production package.

Alchemy beta.79 resolves cloud credential configuration even for local resources. `dev:worker` supplies deliberately invalid local-only credential placeholders to satisfy that configuration check. Both resources run in **local** mode; these placeholders cannot access a Cloudflare account and are not used by the deployment task. Development uses Vite's standard HTTP proxy. Production uses one Worker serving both assets and API, with D1 provisioned and bound by Alchemy.

In an Amp orb, `.agents/setup` installs the pinned Node version and dependencies. Use `amp orb services ensure` to start both local processes and create the Hearth portal. Setup never authenticates, deploys, or applies remote migrations. Do not expose either unauthenticated development port directly to the public internet.

Setup reuses snapshot dependencies when the setup script, manifests, lockfiles, Node/npm versions,
and effective npm configuration are unchanged and `npm ls --all --offline` validates the installed tree.
Otherwise it runs `npm ci --prefer-offline`, preserving lockfile enforcement and install scripts.
Use `npx task orb:setup` to rerun setup and `npx task install` to force a clean dependency reinstall.
The reuse marker lives inside `node_modules`, so a clean install also clears it.

## Daily use

- **Import:** the **Import recipe** button is available on every page. Paste an HTTPS NYT Cooking recipe URL (including unlocked share links), review the filled-out draft, then save. Imports retain the original URL, description, photo, servings, timing, ingredients, and instructions. Fractions and common units become editable shopping quantities; ambiguous ingredient wording is preserved with a review warning. Choose a collection before saving. Timing follows NYT's structured data, so marinating/resting may be additional. Blocked pages or missing recipe data show an error rather than saving a partial recipe. Other recipe sites are not yet supported.
- **Recipes:** create, edit, search by title or ingredient, filter collections, and delete unplanned recipes. Store a source URL, instructions, servings, cooking time, and a photo URL or upload. Uploaded JPG, PNG, and WebP photos up to 1.2 MB are stored in SQLite; no external object storage is needed. Bundled photos and fonts also work offline. External photo URLs naturally require a network connection.
- **Meal plan:** Monday–Sunday calendar on desktop and a vertical agenda on narrow screens. Navigate weeks or jump directly to a date. “Add a meal” suggests the next open dinner in the selected week, starting today for the current week; if no dinner is open, it keeps you within that week. Breakfast/lunch/dinner display in order, with multiple meals per day, decimal scales, and notes. Edit a meal to move or remove it. Opening its recipe preserves unsaved meal edits and previews its scale; “Back to meal” returns to the draft. Recipe-detail scaling is a preview; the calendar meal's scale controls shopping quantities.
- **Shopping:** inclusive start/end dates; linked grocery products combine quantities across recipes and meal scales, then round up to whole packages. **Shopping mode** gives a larger aisle checklist and sticky progress controls. Numeric aisles sort before labels such as Bakery; **Arrange route** saves aisle order and within-aisle product order for future trips, including products not needed this week. Reset restores numeric/alphabetical order. Missing links remain in **Needs linking**; incompatible units and purchases at least twice the required quantity show warnings. The remaining count includes household extras, and “Hide checked items” applies to both sections. Add/remove extras or export the ordered checklist with purchase counts and warnings. Extras persist independently of the selected date range. A changed total, package size, or date range gets a new checkmark identity; changing the route does not.
- **Grocery items:** one household catalog for your preferred store. Save each store product’s name, URL, aisle (number or label), and the quantity/unit in one package, using the same units as recipes. URLs and aisles can be filled in later; the catalog reports setup gaps. Product pages are not fetched, and prices/availability are not tracked. Add alternate ingredient names, one per line, for exact matching on recipe saves and broader AI search. **Recipe coverage** identifies missing links; **Match ingredients** uses Cloudflare AI to retry ingredients still set to automatic matching, preserving existing links and manual exclusions. Its result reports linked, review-needed, failed, and concurrently changed ingredients. Recipe editors let you select, create, or edit a product without losing the recipe draft; save the recipe to persist its links. Catalog edits are shared across all recipes immediately. Linked products cannot be deleted until their recipe links are removed or changed.
- **Kitchen timers:** tap the header timer to expand/collapse a left drawer. Names default to the open recipe’s title (first 25 characters), or the first unused **Timer I**, **Timer II**, **Timer III**, etc. when no recipe is open. Names remain editable; the 25-character limit applies only to recipe defaults. Set whole hours (0–99) and minutes (0–59), totaling at least one minute. Each timer shows its local start/end date and time and an hours:minutes:seconds countdown. The header always shows the earliest deadline, including a finished timer until dismissed. Finished timers gently pulse amber and play a quiet two-note chime every 12 seconds until **Done**; reduced-motion settings use a static highlight. Cancel removes a running timer. Timers survive reloads in this browser and synchronize between its same-origin tabs, but are not shared across devices. After reloading, tap the header to re-enable sound. **Test chime** lets you check your volume. Keep Hearth open and the device awake: browsers/iPadOS may suspend audio and background execution when locked or inactive. On returning, timers catch up from their saved deadlines; this is not a system alarm. Landscape iPad layouts use 44-pixel timer controls and leave the header visible above the drawer.

When a timer is active, the header has **×**, **+1m**, and **+5m** controls for the timer it displays. Dismiss removes that timer and promotes the next one; adding time updates its deadline without opening the drawer. A finished timer restarts with one or five minutes from now and stops flashing. Extensions preserve the original start time, persist across reloads, and can change which timer is due next. These controls also appear in recipe/dialog headers and have accessible labels and 44-pixel touch targets.

Ingredient names and grocery aliases match after trimming, whitespace normalization, and case folding. Only a single unambiguous catalog match links automatically when saving recipes (including reviewed imports and MCP writes); ambiguous or absent matches remain unlinked. Choosing **Leave unlinked** disables automatic matching for that ingredient until you choose **Auto-match** or a product again. Existing recipes are preserved by the catalog migration; use **Match ingredients** after building the catalog to link them.

### AI ingredient matching

The bulk button follows four stages in `src/ingredient-matching.ts`:

1. **Normalize:** Workers AI's `@cf/meta/llama-3.2-3b-instruct` removes amounts and preparation words,
   corrects obvious spelling errors, and retains variety, dietary qualifiers, and essential product form.
   For example, “Chopped White Onions” becomes “White Onion”.
2. **Retrieve broadly:** search both the original name and the cleaned phrase against all saved product
   names and aliases. Unicode/accent normalization, plural variants, shared words, and up to two edits
   on words at least four letters long collect possible matches. There is **no top-N candidate cap**.
   This is indexed lexical search, not embeddings; unrelated synonyms need aliases in the catalog.
3. **Choose:** `typesafe/jev` receives every candidate plus the original ingredient line, parsed amount,
   recipe title/description/collection, and **all instructions**. It selects a product or explicitly chooses none.
   Only valid selections with confidence at least 0.7 are linked. This threshold is a conservative
   starting point, not a calibrated guarantee of accuracy. Quantities and instructions are unchanged.
4. **Resolve close choices:** A low-confidence result retains up to three products with Jev probability
   at least 0.1, unless Jev assigns `none` probability at least 0.7. With two or more potential matches,
   a second Jev pass receives up to ten distinct other recipes per shortlisted product: recipe title
   and linked ingredient name. These examples come only from links saved before the run, never from
   matches just generated by it. Household usage can distinguish products for baby meals versus adult
   dinners, but never overrides dietary requirements or essential form. No extra call is made when
   there are no examples. Unresolved choices remain unlinked.

Potential matches are saved as ingredient `grocerySuggestions` IDs, not shopping links. Recipe details
show selectable product suggestions; the editor groups them above the rest of the grocery list.
Choosing a product or explicitly leaving an ingredient unlinked clears its suggestions. Renaming an
ingredient in the editor clears stale suggestions too. Confident history-assisted matches retain their
shortlist for review until saved. Deleted products are hidden and removed from suggestions on recipe save.

Imported recipes retain the original ingredient line, including preparation notes; older or manually
entered recipes fall back to their saved ingredient names. Editing the name clears stale original text.
Oversized candidate sets are compared in batches and their winners and ambiguous finalists compared again, rather than dropping
candidates. Recipe context is never silently truncated; context that cannot fit is reported as failed.

The implementation indexes catalog words once per run, keeps candidate prompts compact, and runs up to
three independent ingredients concurrently. Identical in-flight work is shared. Normalization and Jev
decisions are cached in D1 for seven days; selection keys include the complete recipe context and candidate
data, so relevant edits invalidate them. The history pass has a separate cache keyed by the shortlist
and the actual reverse-lookup examples, so saved link/title/ingredient changes refresh that decision.
The new selection cache version does not reuse old cached failures that lack suggestions.
Model failures are not persisted in the cache; a failed history pass still saves its initial suggestions.
Saving uses an
atomic recipe/context and catalog-revision check: changes made during inference are preserved, and stale
links are reported as skipped. A retry processes the latest saved data.

Bulk AI matching requires a Cloudflare deployment with the `AI` binding and sufficient **AI Gateway
credits for Jev**. The production website/MCP configuration and their disposable Previews provide that binding.
Local development remains network-independent: recipe saves use exact matching, and the AI button
explains that a Cloudflare deployment is required. Recipe saves, including MCP recipe writes, never
invoke the models; the explicit `match_groceries` MCP tool does.

An exploratory nine-case live evaluation covered typos, 65 onion candidates, aliases, dietary qualifiers,
fresh/canned context, and unsuitable substitutions. The final pipeline made **9/9 correct decisions**.
The cheaper 3B normalizer retained the right ingredient identities but produced singular phrases in only
7/9 cases; retrieval handles the remaining plurals. A 1B alternative rejected JSON-schema output, and
an 8B alternative dropped “toasted”, so neither replaced the 3B model. This small fixture is not proof of
general accuracy; review saved links, especially dietary restrictions.

Compact Jev candidates reduced observed input tokens from 10,610 to 7,585 (about 28%). A sequential
uncached direct-model pass took 3.93 s; concurrent optimized passes took 1.89–2.40 s. The final fresh Preview
recorded 4.15 s uncached and 0.80 s on a repeated, cached pass with **zero model calls**, including D1
reads/writes but excluding HTTP/Access transit. These are small same-orb observations, not latency guarantees.
API reports include model-call/cache-hit counts, candidates, stage times, and total matching time;
stage times sum overlapping calls and can exceed elapsed total time.

Matching also emits structured Cloudflare Worker logs with an `ingredient_matching_` event prefix and
a shared `runId`. `started` includes model names and a validated Cloudflare Ray ID; `batch_started`
records recipe/catalog/ingredient counts and the eligible backlog. `progress` records completed,
remaining, in-flight, proposed-match, failure, and model/cache counts every 25 completed ingredients,
at the end, or on the next ingredient completion after 15 seconds. It is not a heartbeat during a stall.
`persisting` records proposed writes; only `completed` reports the final saved `matched` count,
concurrent-edit `conflicts`, full timings, and a `complete` or `partial` outcome. `complete` means the
run finished without failures/conflicts, not that every ingredient found a product. `ingredient_failed`
includes snapshot-relative recipe/ingredient indexes, stage, candidate count, elapsed time, and a fixed
failure category. `failed` marks a request-level failure, including snapshot/persistence errors.
Logs exclude recipe/product text, raw exceptions/model responses, cache keys, and credentials.
An HTTP 200 alone does not establish matching success; inspect `completed`. A start without a terminal
event is inconclusive (the request may still be running, interrupted, or missing logs). These logs do
not detect page navigation or turn the request into a durable background job.

Compatible shopping units convert within physical families: kg/g/lb/oz for mass, and l/ml/cup/tbsp/tsp for volume (US customary measures). `oz` means weight, not fluid ounces. Counts such as each, can, clove, bunch, or slice only convert to the same unit. For example, a recipe requiring two limes cannot be converted to a 2 lb bag without knowing their weight; the list says **Check amount**, shows the recipe needs, and does not invent a purchase count. If any requirement for a product is incompatible, its entire purchase count needs review. Counts assume no pantry stock and one chosen package size per product, not price optimization. Notes such as “add chicken” are shown but **do not invent quantities**; add that chicken as an extra or recipe ingredient. Instruction text stays as written when scaling.

The app uses one shared household, with no per-person app accounts or roles. Household changes are saved to the server; kitchen timers are the device-local exception. Reload to see another household member's latest edits; simultaneous edits use last-write-wins. Browser calendar dates are used without UTC conversion. Local development is network-independent after dependencies are installed; this is not an offline-sync PWA.

## Logo and device assets

Hearth's Roman mosaic ember identity uses outlined lettering and true vector artwork, not generated
image crops. Review and download the kit at `/brand/` in production (household sign-in required),
or `/brand/index.html` in Vite development. `src/brand.ts` owns the vector masters shared with MCP consent.
Run `npx task branding:generate` after editing the masters, and commit the generated assets.
Generation uses pinned resvg and needs no system fonts, Python, or ImageMagick.

- `public/brand/`: transparent SVG and high-resolution PNG logos/icons; full-color, olive-only, and
  cream-reversed treatments; detailed, small, and micro symbols; a 1200 × 630 sharing card and lettering license.
- Browser tabs: SVG favicon, 16/32/48 px PNGs and multi-frame ICO; a single-color Safari pinned-tab mask.
- Apple home screens: opaque 120/152/167/180 px PNGs, including the conventional `/apple-touch-icon.png`.
- Web-app shortcuts: 192/512 px standard and separately padded maskable PNGs referenced by
  `/site.webmanifest`. Maskable artwork fits within the central safe circle; no pre-rounded outer container.

The manifest uses same-origin credentials so Cloudflare Access still protects the assets.
It adds home-screen identity, not a service worker or offline support. Installation and icon refresh
depend on the browser; actual iPhone/iPad/Android installation requires physical-device verification.
Open Graph/Twitter metadata references the sharing card, but public crawlers cannot fetch the private
website; distribute the downloadable card directly rather than bypassing Access for link previews.
`npx task test` includes real Worker/Static Assets smoke coverage for metadata, MIME types, dimensions,
ICO frames, vector delivery, and anonymous denial, alongside the MCP consent flow.

## Check the app

```sh
npx task check  # TypeScript, Oxlint + vendored rules, Oxfmt, and integration smoke tests
npx task build
```

We do not use unit tests. Every change must be validated with smoke tests or end-to-end testing of the affected behavior; static checks and builds alone are not sufficient.

With an **empty disposable local household**, running local services, and `agent-browser`, use `npx task groceries:smoke` to exercise recipe-side product creation, draft preservation, central coverage, package rounding/warnings, saved route ordering across reloads, checking/hiding products, export, and narrow layouts. It creates and removes its own fixtures and restores the previous route; it refuses remote hosts and nonempty households. Review screenshots are written to `.amp/in/artifacts/`. Chromium narrow-layout checks are not a physical-device or Safari test.

With local development running and `agent-browser` installed, `npx task timers:smoke` exercises the actual timer UI, browser storage, and native Web Audio. It checks validation, hour/minute conversion, deadline ordering, start/end times, landscape/narrow layouts, touch-target sizing, collapse/focus, navigation, reload recovery, a real one-minute expiry, audible-tone scheduling, flashing/reduced motion, dismissal, and cancellation. It uses an isolated browser session and closes it afterward. Chromium layout checks do not replace testing sound, touch, and background behavior on a physical iPad in Safari.

`npx task test` runs integration smoke tests that bundle the actual Workers with Rolldown and exercise disposable local D1/KV via Miniflare. They cover API CRUD, SQL persistence, validation, delete protection, seeding, signed Access tokens, CSRF rejection, and MCP OAuth and recipe operations. Authentication tests verify valid tokens and reject forged signatures, incorrect issuers or audiences, expired or not-yet-valid tokens, and missing expiry or audience configuration. Tests do not use the development household database. Use browser or isolated Preview end-to-end testing for changes needing UI or real Cloudflare coverage.

Matching integration smoke coverage exercises actual Worker/D1 persistence with upstream wire fixtures,
including broad retrieval, original context, uncertain/malformed/outage responses, concurrent edits,
in-flight deduplication, bounded concurrency, cache expiry/invalidation, and oversized inputs. For live
model accuracy and complete Preview/browser coverage, use:

```sh
npx task matching:eval -- models .amp/in/artifacts/matching-models.json
npx task preview -- up
npx task matching:eval -- preview-ui .amp/in/artifacts/matching-browser.json
npx task preview -- down
npx task preview -- list
```

Live evaluation consumes real Cloudflare credits. Preview modes require an **empty owning thread Preview**,
create and remove their own fixtures, and never use production. They perform two persisted matching passes
to measure cache reuse; existing seven-day cache entries may make the first pass warm. `models` is uncached.
Use `normalization` instead of `models` to enforce strict singular-phrase quality independently, optionally
passing a normalizer model as the third argument. This stricter exploratory check currently fails 2/9 cases
on plural wording; the complete pipeline handles those cases correctly. Reports include raw model outputs
for diagnosis. Browser mode also checks loading, persisted coverage refresh, and narrow layouts, and saves
screenshots to `.amp/in/artifacts/`. Always tear down the Preview when testing ends, including after failure.

All generic [anti-slop](https://github.com/dmmulroy/anti-slop) rules are enabled in `oxlint.config.ts`. Their source, CLI integration test, license, and upstream revision are vendored under `tools/oxlint/anti-slop`; unit tests are omitted. Do not modify the vendored snapshot during formatting.

**Known sandbox limitation:** Oxlint 1.85's JS plugin allocator can crash on small E2B instances before linting ([upstream issue](https://github.com/oxc-project/oxc/issues/20331)). The check task reports that failure rather than bypassing rules. If affected, run `npx task check` on a machine that supports the plugin allocator before deployment.

Use `npx task audit:production` to check production dependencies and `npx task audit` to include the development toolchain.
Individual checks are available as `typecheck`, `lint`, `format:check`, and `test`; use
`npx task format` to apply formatting.

## Repeatable performance benchmark

```sh
npx task benchmark                         # Build production assets and print measurements
npx task benchmark -- /tmp/hearth-perf.json # Also save a machine-readable report
```

Run before and after changes on the same idle machine and Node version. The benchmark uses the actual
Worker and disposable Miniflare D1, never the development household or Cloudflare. It validates seeded
data and shopping totals before timing. No additional dependencies or running dev server are required.

The fixed fixtures cover 50 recipes / 100 meals, 500 recipes / 2,000 meals, and 50 recipes / 100 meals
with 32 KiB of synthetic base64 photo data per recipe. Every recipe has 12 ingredients; meal scales
vary and dates span September 2026. Synthetic photo bytes approximate transfer size, not image decoding.
Each workload gets five warmups and 25 timed samples. CPU samples average ten calls; API samples cover
one request through JSON body consumption. Output includes median and p95 milliseconds per operation,
raw/gzipped response and production JS/CSS sizes, and Node/CPU metadata. Gzip sizes use Node's default
compression settings, which can differ from Vite's size report. Setup, migration, and build time are excluded.

Initial September 2026 pass, same orb (warm-run medians, milliseconds):

| Workload                               | Before | After |
| -------------------------------------- | -----: | ----: |
| Large household, weekly shopping       |  12.28 |  2.72 |
| Large household, monthly shopping      |  98.36 | 10.81 |
| Large household, formatting 60 amounts |  1.179 | 0.021 |
| Large household, household API         |  34.37 | 32.52 |
| Household with photos, household API   |  56.77 | 58.69 |

The main improvements are indexed recipe lookup, one mutable accumulation set per ingredient instead
of repeatedly copying provenance, and reused number formatters/decoders. React also retains shopping
totals until recipes, meals, or dates change; the CPU benchmark measures recomputation, not this cache benefit.
Small weekly workloads and API timings are noisy; repeat runs rather than treating these figures as thresholds.
Production JS is essentially unchanged (102,200 → 102,210 gzip bytes).

**Remaining costs:** every mutation reloads the whole household, including inline photos. The photo
fixture still transfers 1,691,051 bytes (1,252,227 gzipped). Separating image delivery is a future API/storage
change, not addressed by these CPU optimizations. These are local warm-process measurements, not production
latency, cold starts, Access authentication, browser rendering, Core Web Vitals, or mobile-device results.
There are no hardware-dependent pass/fail timing thresholds; correctness failures still fail the command.

## Deploy to Cloudflare

Deployment is **not performed** as part of local setup. Review it before running: this provisions shared infrastructure and applies migrations.

Production is served at **https://hearth.joesaia.trade**. Alchemy manages the Worker's custom domain, with DNS and TLS provisioned by Cloudflare. The `workers.dev` address is also enabled; both addresses use the same Worker-level Access policy and household database.

Production is protected by Cloudflare Access for the `saiaai` team. Alchemy manages the Google identity provider and Worker-level Access application, including preview URLs. Only `joe5saia@gmail.com` and `shannonnitroy@gmail.com` may sign in, using Google, with seven-day sessions. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the deployment environment; mark the client secret as a secret in Amp. The Google OAuth callback is `https://saiaai.cloudflareaccess.com/cdn-cgi/access/callback`. The Cloudflare token also needs permission to manage Access applications/policies and identity providers. Local development does not provision or require Access.

The Worker verifies `Cf-Access-Jwt-Assertion` using the team's public signing keys. It requires an RS256 signature, the exact team issuer, the application's audience tag (bound by Alchemy as `ACCESS_AUD`), a subject, and a valid expiry. Missing or forged assertions fail closed; an email header alone never grants access. This works with Cloudflare's Static Assets router, which does not forward `ctx.access` to the app Worker.

Alchemy also manages a 30-day **Hearth deployment smoke test** service token and a Hearth-only
Service Auth policy. Provisioning it requires **Access: Service Tokens Write**. Its signed
`common_name` must match the `SMOKE_CLIENT_ID` binding; the Worker permits only GET/HEAD for this
identity and rejects mutations. Cloudflare uses an empty `sub` for service tokens. Other service
identities fail closed. This does not change the household Google policy or expose an Access bypass.

1. In the Amp project's Secrets & Env Vars, set `CLOUDFLARE_ACCOUNT_ID` as an environment variable and `CLOUDFLARE_API_TOKEN` as a secret. Scope the token to the intended account with **Workers Scripts: Edit**, **D1: Edit**, and **Secrets Store: Edit**. No interactive profile is needed. Outside Amp, export these variables in your private environment.
2. Set the Google client credentials described above. Never commit credentials or copy them into orb setup scripts or snapshots. Refresh an existing orb with `amp orb restart-processes` after changing Amp secrets.
3. Run `npx task cloud:check` to validate credential configuration. This checks presence and format, not live authorization or all required permissions.
4. The current account has Alchemy's shared state store provisioned. When setting up a new account, obtain approval and run `npx task cloud:bootstrap` to provision its state Worker, Durable Objects, and Secrets Store secrets. Do not delete the state store's encryption key.
5. Run `npx task plan` to build assets and preview the `production` stage against the bootstrapped state store. Cloud tasks use `CI=true`, so missing credentials or a missing/outdated state store fail instead of prompting to set them up. Do not run a plan with an unfinished local bootstrap: Alchemy may resume it during state initialization.
6. After reviewing the plan and approving deployment, run `npx task deploy -- --yes`. This builds assets, updates the Worker, binds D1, and applies pending SQL migrations. Serialize deployments to the same stage across orbs. Production access is account-scoped: stage names are not an authorization boundary.
7. Open the returned HTTPS Worker URL and sign in with one of the two allowed Google accounts.

All production website requests, including assets and API, pass through Cloudflare Access. Keep the Worker-level allowlist in place; do not add bypass or account-wide policies as a workaround. The separate MCP Worker protects only consent with Access and uses OAuth for its API (see below). Credential configuration and read access do not establish deployment permissions; verify cloud writes only during an approved bootstrap or deployment.

`alchemy.run.ts` is the production infrastructure source of truth. Its inferred environment types are used directly by `src/server.ts`. `cloudflare.config.ts` shares the entrypoint, compatibility date, and asset routing with the on-demand Preview workflow below. Its default export configures **cf Preview builds only**; Alchemy still owns production infrastructure and local development. `alchemy dev` keeps its state and SQLite data locally in `.alchemy/`; cloud operations use `Cloudflare.state()` so separate orbs share deployment state. Never run destructive infrastructure commands casually. Keep production bootstrap, deployment, and migrations out of orb setup, resume, and preview services.

The Cloudflare CLI is pinned as a project dependency. Use `npx task cf -- --help` or
`npx task cf -- cli search "<task>"` for resource commands. These operate on remote resources by default;
credential access does not authorize writes. Do not use `cf deploy` to bypass Alchemy's production ownership.

## On-demand Cloudflare Previews

Use these when testing real Workers, Static Assets, D1, Access, or network latency matters. Keep using
Amp portals for local iteration and their review tools; a Cloudflare Preview is a complementary remote
environment, not an Amp portal. This uses Cloudflare's **native Worker Previews**, not Alchemy stages,
legacy version URLs, or a second production Worker. Uses the pinned `cf` CLI and Cloudflare Vite plugin
2 beta; no direct Wrangler dependency is required.

From the thread's working branch, with `AMP_THREAD_ID` set to its full thread ID:

```sh
npx task preview -- up                # Build, provision/update, migrate isolated D1, deploy, smoke-test
npx task preview -- test              # Recheck Access/assets/API and D1 persistence; print latency samples
npx task preview -- list              # Account-side inventory, including partially provisioned resources
npx task preview -- down              # Delete this thread's Preview and ALL its supporting resources
npx task preview -- gc                # Delete managed previews past their cleanup deadline
```

The website and MCP workflows call `cf d1 migrations apply <database-id>` with the existing
`d1_migrations` history table, then `cf previews deploy <name>` in their respective `cf-preview` and
`cf-mcp-preview` modes. Vite builds the Worker and website assets into `.cloudflare/output/v0/`;
MCP builds omit client assets. Serialize website and MCP builds within one checkout because they share
that output directory. Normal production asset builds and local dev do not enable the Cloudflare plugin.
Provisioning writes the isolated bindings to private `worker.json` files and passes their path only to
the Preview build. The config rejects non-Preview Worker builds. Keep API precreation with
`ignore_base_config=true`: `cf` currently has no matching flag, and inheriting production bindings is unsafe.

`up` prints the stable HTTPS URL, deployment ID, and UTC cleanup deadline. Sign in with the same Google
accounts allowed in production. Share **only this stable URL**: immutable deployment URLs retain the
parent Worker's Access policy, whose audience the Preview intentionally does not accept. Each thread
gets an empty D1 database; **Try a sample week** supplies disposable data. Production data is never copied.
Repeated `up` preserves the Preview URL/database and applies new migrations. Serialize commands for a
given thread across orbs. Separate threads use separate databases and credentials.

The Cloudflare API token needs account-scoped **Workers Scripts: Edit**, **D1: Edit**,
**Access: Apps and Policies: Edit**, and **Access: Service Tokens: Edit**. It must be able to read the
existing Hearth Worker and Access policy. No Google client secret or Alchemy bootstrap is needed.
The workflow discovers the production Worker through its Alchemy tags and refuses ambiguous targets.
Its preview URL setting must already be enabled; the script never changes production settings or runs
`cf deploy`. Permissions to create previews do not authorize production deployment.

Each Preview has a hostname-specific Access application, copied household allow policy, and a seven-day
service token restricted to that application. `LOCAL_DEV` remains `false`; the normal signed Access JWT
checks run in the Worker. `PREVIEW_CLIENT_ID` binds that Preview's service identity for reads and writes
to its isolated D1. Production leaves this binding unset and keeps its smoke identity read-only.
No public bypass is installed. Automation credentials are saved mode `0600`
under the gitignored `.wrangler/hearth-previews/<name>/` directory; never print, commit, or share them.
The legacy `.wrangler` state paths remain unchanged so existing Previews and credentials stay recoverable.
A new orb running `up` rotates only that Preview's token if its one-time secret is unavailable locally.
For additional API validation or performance fixtures, use the authenticated request helper:

```sh
npx task preview -- request <name-from-list> GET /api/household
npx task preview -- request <name-from-list> POST '/api/demo?today=2026-09-28' '{}'
```

The built-in smoke test checks anonymous denial, authenticated HTML/JavaScript/API, and a disposable
D1 write/read/delete cycle without clearing existing fixtures. Its ten warm API timings include Access
and network latency from the orb, not Worker CPU or a load test. For performance comparisons use the
same fixtures, client location, and multiple runs. Preview logs are enabled in Cloudflare's Preview
Observability tab; `cf` does not yet stream native Preview logs.

**Cleanup is mandatory when testing/review ends.** `down` removes the Preview first, verifies its absence,
then deletes its D1 database, Access application, service token, and local credential files. It refuses
non-managed names and never deletes the parent Worker or production resources. It is safe to retry after
a partial failure. A failed first `up` attempts rollback; a failed update preserves existing resources
and data for diagnosis. If rollback fails, the error prints the exact cleanup command.

Resources carry a UTC cleanup deadline in their names (six to seven days after creation). `up` runs
`gc`, and `gc` discovers expired resources from Cloudflare, even after an orb is lost or Cloudflare evicts
a Preview. **The deadline is not a Cloudflare TTL: no background janitor runs.** Do not rely on inactivity,
orb deletion, or Cloudflare's Preview limits to remove D1/Access resources. For recovery from any orb:

```sh
npx task preview -- list
npx task preview -- down <name-from-list>
```

References: [Previews](https://developers.cloudflare.com/workers/previews/),
[configuration](https://developers.cloudflare.com/workers/previews/configuration/),
[resource isolation](https://developers.cloudflare.com/workers/previews/resources/), and
[Access precedence](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#understand-access-hierarchy).

### GitHub push-to-deploy automation

`.github/workflows/deploy.yml` runs on every push to GitHub's `main` branch. It installs the
Node version from `.node-version` and pinned dependencies, runs `npx task typecheck` and
`npx task test`, then runs `npx task deploy -- --yes` and the read-only `npx task mcp:smoke`.
Deployment builds assets and updates both production Workers and pending D1 migrations using
the existing Cloudflare-hosted Alchemy state. It does not bootstrap shared infrastructure.
A push containing multiple commits deploys the pushed tip once, not each intermediate commit.
The production concurrency group queues up to 100 pending runs without interrupting an active
deployment; GitHub processes them in queue-entry order, not guaranteed commit order.

Before enabling this workflow on `main`:

1. Disable the previous Amp post-receive deployment hook and wait for any active deployment
   to finish. GitHub concurrency cannot lock deployments running in an Amp orb; use only one
   deployment owner at a time.
2. Create a GitHub Actions environment named `production`. Add environment variables
   `CLOUDFLARE_ACCOUNT_ID` and `GOOGLE_CLIENT_ID`, and environment secrets
   `CLOUDFLARE_API_TOKEN` and `GOOGLE_CLIENT_SECRET`. Amp project credentials are not copied
   to GitHub automatically. Use the existing production credentials and Cloudflare permissions
   described above, including Workers KV and Access service-token management for this stack.
3. Restrict the environment to `main`. Leave required reviewers off if deployments should run
   without manual approval, and ensure Actions is enabled for the repository.

Failures stop the run and appear in GitHub Actions; there is no automatic rollback or retry.
The workflow does not perform the Amp owner's authenticated website browser check, Worker log
review, or automatic investigation-orb creation. A successful run verifies deployment command
completion and public MCP health, not those additional checks. Review the first GitHub run
after shipping to confirm credentials and real Cloudflare deployment work.

### Legacy Amp push-to-deploy automation

The project-local `hearth-deploy` plugin can connect this Amp-hosted repository's **Post-receive
Webhook** to one persistent deployment orb. It is disabled in ordinary coding orbs. Installation,
authorization boundaries, live verification, and recovery are documented in
[`tools/deploy/WORKFLOW.md`](tools/deploy/WORKFLOW.md).

The owner reads the real `origin/main`, deduplicates commits, and serializes deployment, browser
smoke testing, and Worker log review. Push bursts deploy the newest main tip; intermediate commits
may be superseded. An observed failure starts a separate investigation orb with reproduction
evidence; fixes require review before shipping. Missing credentials or log access is reported as
blocked, never successful. The browser supplies the read-only service token only to Hearth's exact
HTTPS origin; Google sign-in is not required. Renew or rotate the token before its 30-day expiry
and securely refresh the owner's private credential file. See the workflow for lifecycle details.

Keep the owner thread unarchived and do not deploy production concurrently from another orb.
Its webhook URL and deployment ledger live in private, gitignored `.amp/deploy-state/` files.
`npx task test -- tests/deploy.test.ts` smoke-tests dispatch against a disposable Git repository and
disk-backed interruption recovery and deduplication. It does not deploy production or replace live validation.
Validate deployment changes with the required live end-to-end test described in the workflow.

## ChatGPT plugin archives

Use **ChatGPT** in Hearth's header for download and manual installation instructions.
The [latest GitHub release](https://github.com/joe5saia/hearth/releases/latest) provides:

- `hearth-chatgpt.zip`: web-compatible metadata, icons, three workflow skills, and a
  required reference to the household's registered ChatGPT app.
- `hearth-plugin.zip`: the portable Agent Plugins package with the hosted MCP URL,
  the same skills and icons, and skill MCP dependencies for desktop/Codex. A raw MCP
  declaration makes a workspace plugin desktop-only; this is not the web install ZIP.
- `SHA256SUMS`: SHA-256 checksums for both archives. Each ZIP includes its version,
  source commit, and dirty-worktree flag in `BUILD.json`.

Full [installation, updating, permissions, and privacy notes](plugins/hearth/README.md)
are bundled in both ZIPs. These are household plugins, not an approved public directory
listing. The MCP server implementation runs on Cloudflare, not inside ChatGPT.

### Maintainer setup and publication

The registered Hearth app ID is public metadata checked into `plugins/hearth/.app.json`.
No GitHub Actions variable or secret is needed for plugin packaging. The app must be
available in the installing user's ChatGPT workspace; the ZIP never grants household
access. To use a different registration, update that file or override the build with
`--app-id` / `CHATGPT_APP_ID` (both accept the `plugin_asdk_app_…` URL identifier too).
An explicitly empty override builds only the portable archive; `--require-web` rejects it.

```sh
npx task plugin:build                          # Web and portable ZIPs for the registered Hearth app
npx task plugin:build -- --require-web --version 1.0.1
npx task test -- tests/plugin.test.ts tests/mcp.test.ts
npx task plugin:smoke                          # Local browser UI; requires running dev services
```

Outputs go to gitignored `.amp/plugin-dist/`. Use `--output directory` to change that.
The builder uses an explicit file allowlist, deterministic ordering and ZIP timestamps;
it does not bundle source trees, environment files, OAuth tokens, or household exports.
Tests execute the real build task, inspect ZIPs with an independent reader, compare
checksums, check web/desktop separation and stale-output cleanup, and verify skill tool
names against the authenticated Worker. ChatGPT model-behavior acceptance scenarios
are in [EVALUATION.md](plugins/hearth/EVALUATION.md); runtime tests do not prove those pass.

After successful production deployment and the public MCP smoke check, the existing
GitHub workflow builds version `1.0.<workflow run number>` and runs `npx task plugin:release`.
It uploads both ZIPs and checksums to a draft, then publishes that complete release as
latest. The stable web download is
`https://github.com/joe5saia/hearth/releases/latest/download/hearth-chatgpt.zip`.
Failed deployments/builds leave the previous release in place. Superseded main revisions
skip publication. An interrupted draft upload can be retried; a published version is
verified rather than overwritten. Do not reuse a published version for changed bytes.

`plugin:release` is a **GitHub write**, requires release authorization and `gh` credentials,
and refuses dirty or stale builds. It does not deploy or push source. In CI, only the
deployment job receives `contents: write`, and its GitHub token is passed to the release
step. Manual publication requires the intended commit already on current GitHub main,
successful deployment/validation, and a new version. Do not rerun production deployment
solely to retry a release without deployment authorization.

GitHub releases are distribution, not automatic ChatGPT updates. Upload a new ZIP to
the existing manual plugin with **Upload new version**, or use the configured source
for a GitHub-managed plugin. Account/workspace upload permissions are required.

## Household MCP server

`src/mcp-worker.ts` is a separate OAuth-protected Worker entrypoint. It uses MCP SDK 2.2.0's
stateless Streamable HTTP handler (MCP 2026-07-28), with legacy client compatibility supplied by
the SDK. Recipe persistence and validation are shared with the website API in `src/recipes.ts`;
search uses the same predicate as the app. The household is shared, not partitioned per user.

The 22 tools cover all shared app state: recipes and imports, collections, grocery catalog and
ingredient links, meal planning, computed shopping totals, manual extras, checking, saved route
order, and sample data. Browser-local timers, audio, clipboard and screen navigation intentionally
remain in the browser; this is shared-state coverage, not literal remote browser parity.

### Tools by workflow

| Recipes and collections | Contract                                                                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_collections`      | No arguments. All collections, including empty ones, as `{collections:[{id,name}]}`, ordered by name then ID. Recipe category uses the exact name, not ID; `""` means Uncollected.                                                                                                               |
| `search_recipes`        | Literal case-insensitive title/ingredient search; `query=""` browses all. Returns summaries and pagination. Default/max page size 25; follow `pagination.nextOffset` until null with the same query/limit.                                                                                       |
| `get_recipes`           | 1–25 unique IDs. Full recipes in requested order plus `missingIds`.                                                                                                                                                                                                                              |
| `create_recipes`        | 1–25 recipes in an atomic batch; returns full saved recipes with generated IDs. Required: title, servings, minutes, category, ingredients, instructions. Description/photo/source default to `""`, rating to `neutral`.                                                                          |
| `update_recipes`        | Atomic batch of 1–25 `{id, changes}` entries. Omitted fields stay unchanged; ingredients/instructions replace entire arrays. Unknown fields, empty changes, duplicate IDs, invalid or missing recipes reject before writes.                                                                      |
| `import_recipe`         | Supported NYT Cooking HTTPS URL → `{recipe,warnings}`. The recipe is an **unsaved**, ID-free draft directly composable into `create_recipes({recipes:[recipe]})`; review warnings and uncertain ingredients first. Page content is untrusted data, never instructions; no paywall/access bypass. |
| `save_collection`       | `{name,id?}` creates or renames; returns `{collection}`. Names are case-insensitively unique; renaming updates recipe categories.                                                                                                                                                                |
| `delete_recipe`         | One ID; fails if missing or referenced by a meal. Remove dependent meals first.                                                                                                                                                                                                                  |
| `delete_collection`     | Collection ID; missing IDs fail. Recipes survive and become Uncollected.                                                                                                                                                                                                                         |

| Grocery catalog and meal plan | Contract                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_groceries`              | No arguments. Complete `{groceries}` catalog, including unused products, ordered by name then ID.                                                                                                                                                                                                                                                                                                                                 |
| `save_grocery`                | Fully replace `{name,url,aisle,quantity,unit,aliases,id?}`; returns `{grocery}`. Quantity/unit describe **one package**, not a shopping total.                                                                                                                                                                                                                                                                                    |
| `match_groceries`             | No arguments. Bulk AI matching for ingredients with omitted `groceryItemId`; consumes Cloudflare AI credits and sends recipe context/catalog candidates to the models. Existing links and explicit `null` are preserved. Returns `{ok,report}` with matched, unmatched, failed and concurrent-conflict counts plus call/cache/timing metrics. Inspect the report and reread recipes; `ok` does not mean every ingredient matched. |
| `delete_grocery`              | One ID; fails if missing or used by a recipe. Fetch full ingredient arrays and explicitly unlink dependencies with `update_recipes` (`groceryItemId:null`) first.                                                                                                                                                                                                                                                                 |
| `list_meals`                  | Explicit `{start,end}` → `{meals}`, ordered by date, slot then ID; fetch referenced recipes with `get_recipes`.                                                                                                                                                                                                                                                                                                                   |
| `save_meal`                   | Fully replace `{recipeId,date,slot,scale,note,id?}`; returns `{meal}`. Reuse ID to move/edit; multiple meals per slot are allowed. **`scale = desired servings / recipe.servings`**, not servings.                                                                                                                                                                                                                                |
| `delete_meal`                 | One ID; missing IDs succeed. Preserves recipe; recompute shopping afterwards.                                                                                                                                                                                                                                                                                                                                                     |

| Shopping and setup      | Contract                                                                                                                                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_shopping_list`     | Explicit `{start,end}` → scaled totals, conversions, package counts, warnings, checked state, saved order and global extras. `packages:null` means review needed, not zero. Structured results can be used for exports without browser clipboard access. |
| `save_shopping_extra`   | Fully replace `{name,checked,id?}`; `checked` is 0 or 1. Returns `{extra}`; extras are shared across all date ranges.                                                                                                                                    |
| `delete_shopping_extra` | One ID; removes the global extra. Missing IDs succeed.                                                                                                                                                                                                   |
| `set_shopping_checked`  | `{key,checked:boolean}` uses the exact returned **`item.checkKey`**, not `item.key`. Applies to that range/quantity; changed totals become unchecked. Use `save_shopping_extra` for manual extras.                                                       |
| `set_shopping_order`    | `{aisles,items}` replaces both complete arrays globally. Use exact aisle strings and **`item.key`**, not `checkKey`; values must be unique. Omitted entries follow default order; empty arrays reset it. Linked products precede unlinked items.         |
| `add_demo_data`         | Explicit `{today}` local date; creates real shared sample recipes, meals and an extra only when no recipes exist. Use only on user request.                                                                                                              |

### Composition and write safety

Ranges are **inclusive**, explicit local calendar dates in `YYYY-MM-DD` form, with `start <= end`,
not UTC timestamps or implicit “this week.” `today` follows the same local-date convention.
Read before editing: `save_*` tools require all non-ID fields and fully replace the saved entity,
whereas `update_recipes` patches only supplied fields (but replaces supplied arrays wholesale).
Omit ID to create with `save_*`; preserve the returned ID for later edits. Recipe creation also
generates IDs. Do not blindly retry creates after ambiguous network/storage failures: inspect
current state first to avoid duplicates. Recheck state after any ambiguous write failure.
Recipe batches are atomic, but separate tool calls are **not a transaction**; dependent writes
must be awaited and can partially complete. Guard dependencies before deletion, and reread the
plan/shopping list after edits rather than inventing IDs or shopping keys.

To arrange the whole catalog before planning meals, call `list_groceries` and construct each
product's route key with `JSON.stringify(["grocery", grocery.id])`. Pass those keys in the desired
order to `set_shopping_order.items`; they match future shopping items' `key` values. This construction
is only for route ordering. Always obtain quantity- and date-specific `checkKey` values from
`get_shopping_list` before checking items off.

Every tool advertises JSON input/output schemas and returns `structuredContent` plus equivalent
JSON text for code-mode and older clients. The existing single `recipes` OAuth scope and grant
remain unchanged and expose all 22 tools; clients may need to refresh their tool inventory,
but this expansion does not require reconnecting or reconsenting.
Call `list_collections` before assigning a recipe category; it discovers collections even when no
recipes use them. Use `save_collection` and `delete_collection` for collection editing.
Search pagination is a live view, not a snapshot across concurrent edits.
Search currently reads recipe summaries into memory to preserve JavaScript's exact Unicode and
substring behavior; this is intended for the household collection, not a large public catalog.

For code-mode clients that return structured objects directly (the module alias is client-specific):

```js
import { list_collections, list_groceries, get_recipes, save_meal, get_shopping_list } from "hearth";

const [collections, groceries] = await Promise.all([list_collections({}), list_groceries({})]);
// Independent reads can run concurrently; use a recipe ID discovered earlier.
const { recipes } = await get_recipes({ ids: [recipeId] });
if (recipes.length !== 1) throw new Error("Recipe no longer exists");
const { meal } = await save_meal({
  recipeId: recipes[0].id,
  date: "2026-10-05",
  slot: "Dinner",
  scale: 6 / recipes[0].servings,
  note: "Six servings",
});
// This read depends on the completed write; do not run it alongside save_meal.
const shopping = await get_shopping_list({ start: "2026-10-05", end: "2026-10-11" });
```

Cloudflare's OAuth provider handles CIMD, discovery, PKCE, tokens and consent transactions.
Only `/authorize` sits behind Cloudflare Access; discovery, token and `/mcp` endpoints must not
receive Access login redirects. The Worker validates Access JWTs for consent and OAuth bearer
tokens for MCP. Both discovery documents advertise the required `recipes` scope; consent grants
read, create, edit and delete access across recipes, collections, planning, groceries and shopping
together. This coverage expansion keeps that scope and grant unchanged, including existing tokens.
Production must omit `PREVIEW_CLIENT_ID`, which exists solely for isolated-preview automation.

### Production MCP

The stable endpoint is **https://hearth-mcp.joesaia.trade/mcp**. `alchemy.run.ts` provisions
the separate `Mcp` Worker, dedicated `McpOAuth` KV, and `McpAccess` application scoped to
`hearth-mcp.joesaia.trade/authorize`. It reuses the existing production `Database` and Google
identity provider. Worker-wide Access enrollment is deliberately absent; workers.dev is disabled.
The website's Access application and deployment smoke identity are not changed or reused for MCP.

Use the existing `npx task plan` and authorized `npx task deploy -- --yes` for both Workers.
`npx task mcp:smoke` checks public discovery, exact OAuth origin metadata, anonymous MCP 401,
and the Access consent redirect without credentials or household writes. Household Google login
is required to verify consent, token exchange, and authenticated recipe reads. Do not grant a
machine identity or run the write-capable preview test against production to bypass that requirement.

### Isolated MCP preview

```sh
npx task mcp:preview -- up
npx task mcp:preview:test
npx task mcp:preview -- down
```

Run on the owning thread's branch with `AMP_THREAD_ID` and Cloudflare credentials configured.
In addition to the website-preview permissions above, the API token needs account-scoped
**Workers KV Storage: Edit**. This creates a disposable parent Worker and native Preview with
isolated D1 and OAuth KV, and an Access application protecting only `/authorize`. The separate
parent avoids inheriting the website's blanket Access gate on public OAuth discovery. It never
deploys production. Private state
and preview credentials live under `.wrangler/mcp-preview/`; preserve that directory to resume
a partial deployment or tear it down. `up` preserves its URL and data on subsequent runs.
Run `down` when review ends; the name's date is a cleanup reminder, not an automatic TTL.
`down` also removes the disposable parent, Access app/service token, D1 and KV.
The live test exercises CIMD/PKCE consent and all 22 tools against disposable data, including
real AI matching (consuming model credits), returned matching reports, meal scaling, package rounding,
check invalidation, route/extras, collection propagation and deletion guards.
Import's successful parsing is covered locally with a saved NYT fixture; the live
test checks unsupported-URL rejection, not third-party availability. It writes
non-secret fixture metadata to `.wrangler/mcp-preview/evaluation.json`, not bearer-token settings.
The preview-only entrypoint serves a CIMD fixture at `/test-client.json`; the production entrypoint
does not. The preview Access service identity is restricted to its own token.

### Automatic MCP access for eval orbs

`mcp:preview up` prints a separate `/eval/mcp` URL. This endpoint exists only in the disposable
Preview entrypoint; production `/mcp` continues to require OAuth. Preview provisioning verifies
the current orb's Amp identity and binds its exact project and owner user IDs. Eval orbs for that
same project and owner can access that Preview with their own short-lived Amp identities. Other
projects/users, forged or expired tokens, missing policy bindings, and tokens for another origin
are rejected. Access lasts only while the Preview exists.

In each eval orb, run the owner-authorized bootstrap with the assigned URL:

```sh
npx task mcp:eval -- connect <Preview /eval/mcp URL>
npx task mcp:eval -- check <Preview /eval/mcp URL>
# After evaluation, before the owning thread tears down the Preview:
npx task mcp:eval -- disconnect <Preview /eval/mcp URL>
```

Then use Amp's `reload_mcp` tool to connect/discover tools (or unload them after disconnect).
`connect` refuses production URLs and preflights authenticated tool discovery before changing
settings. It merges a `hearth_eval` entry into the orb's **user** configuration
(`~/.config/amp/settings.json`, honoring `XDG_CONFIG_HOME`), preserving unrelated settings.
This trusted bootstrap is explicitly authorized by the owner; it does not approve or weaken
repository workspace MCP trust rules. A conflicting workspace `hearth_eval` entry is rejected.

The entry uses `Authorization: Bearer ${amp:id-token}`. Amp mints an origin-bound token and
replaces it before expiry; no bearer token is saved, transferred, or printed. The Worker verifies
the Amp issuer's RS256 signature, exact origin audience, expiry, project, owner, thread identity,
and `token_use=exchanged`. See [Amp ID tokens](https://ampcode.com/docs/customize/mcp#amp-id-tokens).
OAuth Preview smoke tests remain separate, so successful eval identity access does not substitute
for validating production's consent/token flow.

For new eval threads, give them the assigned `/eval/mcp` URL and the bootstrap task, not OAuth
settings or Cloudflare credentials. Before these changes are shipped, transfer the current
`Taskfile.yml` and `tools/mcp-eval.ts` to their checkouts; a separate orb's `origin/main` does not
contain the source thread's unpushed files. Do not provision a separate Preview from the eval orb.
Reload and check access before beginning the user task. Connection outages still fail closed;
fix reachability or authorization rather than extending token lifetimes or disabling Access.

`npx task test` includes real workerd/D1/KV integration tests with a synthetic Access signer and
CIMD document, plus preview Amp identity allow/deny checks and production isolation. Live preview
deployment and agent usability evaluation are separate checks. Disconnect eval orbs and run
`npx task mcp:preview -- down` in the owning thread when testing finishes.

## Photo credits

Illustrative sample images are bundled for network-independent development:

- Chicken: [Unsplash image 1532550907401-a500c9a57435](https://images.unsplash.com/photo-1532550907401-a500c9a57435)
- Pasta: [Unsplash image 1473093295043-cdd812d0e601](https://images.unsplash.com/photo-1473093295043-cdd812d0e601)
- Grain bowl: [Unsplash image 1512621776951-a57141f2eefd](https://images.unsplash.com/photo-1512621776951-a57141f2eefd)
- Salmon: [Unsplash image 1467003909585-2f8a72700288](https://images.unsplash.com/photo-1467003909585-2f8a72700288)
- Tacos: [Unsplash image 1551504734-5ee1c4a1479b](https://images.unsplash.com/photo-1551504734-5ee1c4a1479b)
- Soup: [Pexels image 539451](https://www.pexels.com/photo/539451/)

Fonts: DM Sans and Lora, self-hosted through Fontsource under the SIL Open Font License.
