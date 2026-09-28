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

Task is installed as a pinned npm development dependency, so `npx task` works without a global install. `npm run dev` is an alias.

`dev:web` enables Vite's experimental bundled dev mode to avoid module-request waterfalls over orb portals.
It uses the `vite-dev` alias with Rolldown 1.2.9, matching Vite 8.3.1's embedded HMR runtime; Rolldown
1.2.10+ changed that runtime interface. Production keeps the original Vite and Rolldown versions.
Use `npm run build` or `npx task build`, not `npx vite build`: both Vite packages export the same CLI
name, so the build script explicitly selects the production package.

Alchemy beta.79 resolves cloud credential configuration even for local resources. `dev:worker` supplies deliberately invalid local-only credential placeholders to satisfy that configuration check. Both resources run in **local** mode; these placeholders cannot access a Cloudflare account and are not used by the deployment task. Development uses Vite's standard HTTP proxy. Production uses one Worker serving both assets and API, with D1 provisioned and bound by Alchemy.

In an Amp orb, `.agents/setup` installs the pinned Node version and dependencies. Use `amp orb services ensure` to start both local processes and create the Hearth portal. Setup never authenticates, deploys, or applies remote migrations. Do not expose either unauthenticated development port directly to the public internet.

## Daily use

- **Import:** the **Import recipe** button is available on every page. Paste an HTTPS NYT Cooking recipe URL (including unlocked share links), review the filled-out draft, then save. Imports retain the original URL, description, photo, servings, timing, ingredients, and instructions. Fractions and common units become editable shopping quantities; ambiguous ingredient wording is preserved with a review warning. Choose a collection before saving. Timing follows NYT's structured data, so marinating/resting may be additional. Blocked pages or missing recipe data show an error rather than saving a partial recipe. Other recipe sites are not yet supported.
- **Recipes:** create, edit, search by title or ingredient, filter collections, and delete unplanned recipes. Store a source URL, instructions, servings, cooking time, and a photo URL or upload. Uploaded JPG, PNG, and WebP photos up to 1.2 MB are stored in SQLite; no external object storage is needed. Bundled photos and fonts also work offline. External photo URLs naturally require a network connection.
- **Meal plan:** Monday–Sunday calendar on desktop and a vertical agenda on narrow screens. Navigate weeks or jump directly to a date. “Add a meal” suggests the next open dinner in the selected week, starting today for the current week; if no dinner is open, it keeps you within that week. Breakfast/lunch/dinner display in order, with multiple meals per day, decimal scales, and notes. Edit a meal to move or remove it. Opening its recipe preserves unsaved meal edits and previews its scale; “Back to meal” returns to the draft. Recipe-detail scaling is a preview; the calendar meal's scale controls shopping quantities.
- **Shopping:** inclusive start/end dates; ingredient totals update immediately from recipes and meal scales. The remaining count includes household extras, and “Hide checked items” applies to both sections. Completed sections show a confirmation instead of an unexplained blank list. Add/remove extras or export a plain-text checklist. Extras persist independently of the selected date range. A changed total or date range gets a new checkmark identity so a previous purchase does not hide an increased quantity.

Ingredient names match after trimming, whitespace normalization, and case folding. Use consistent names (`Cherry tomatoes`, not sometimes `Tomatoes`). Compatible units convert within their families: kg/g, l/ml, lb/oz, and cup/tbsp/tsp (US measures). Different families stay separate; a can, clove, or bunch cannot be converted to weight without information the app doesn't have. Notes such as “add chicken” are shown on the shopping page but **do not invent ingredient quantities**; add that chicken as a manual item or recipe ingredient. Instruction text stays as written when scaling.

The app uses one shared household, with no per-person app accounts or roles. Changes are saved to the server, not browser local storage. Reload to see another household member's latest edits; simultaneous edits use last-write-wins. Browser calendar dates are used without UTC conversion. Local development is network-independent after dependencies are installed; this is not an offline-sync PWA.

## Check the app

```sh
npx task check  # TypeScript, Oxlint + vendored rules, Oxfmt, and tests
npx task build
```

Tests bundle the actual Worker with Rolldown and exercise disposable local D1 via Miniflare. They cover CRUD, SQL persistence, validation, delete protection, seeding, signed Access tokens, CSRF rejection, fractional scaling, date boundaries, compatible-unit conversion, and checkmark invalidation. Authentication tests verify valid tokens and reject forged signatures, incorrect issuers or audiences, expired or not-yet-valid tokens, and missing expiry or audience configuration. Tests do not use the development household database.

All generic [anti-slop](https://github.com/dmmulroy/anti-slop) rules are enabled in `oxlint.config.ts`. Their source, tests, license, and upstream revision are vendored under `tools/oxlint/anti-slop`. Do not modify the vendored snapshot during formatting.

**Known sandbox limitation:** Oxlint 1.85's JS plugin allocator can crash on small E2B instances before linting ([upstream issue](https://github.com/oxc-project/oxc/issues/20331)). The check task reports that failure rather than bypassing rules. If affected, run `npx task check` on a machine that supports the plugin allocator before deployment.

Use `npm audit --omit=dev` to check production dependencies and `npm audit` to include the development toolchain.

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

1. In the Amp project's Secrets & Env Vars, set `CLOUDFLARE_ACCOUNT_ID` as an environment variable and `CLOUDFLARE_API_TOKEN` as a secret. Scope the token to the intended account with **Workers Scripts: Edit**, **D1: Edit**, and **Secrets Store: Edit**. No interactive profile is needed. Outside Amp, export these variables in your private environment.
2. Set the Google client credentials described above. Never commit credentials or copy them into orb setup scripts or snapshots. Refresh an existing orb with `amp orb restart-processes` after changing Amp secrets.
3. Run `npx task cloud:check` to validate credential configuration. This checks presence and format, not live authorization or all required permissions.
4. The current account has Alchemy's shared state store provisioned. When setting up a new account, obtain approval and run `npx task cloud:bootstrap` to provision its state Worker, Durable Objects, and Secrets Store secrets. Do not delete the state store's encryption key.
5. Run `npx task plan` to build assets and preview the `production` stage against the bootstrapped state store. Cloud tasks use `CI=true`, so missing credentials or a missing/outdated state store fail instead of prompting to set them up. Do not run a plan with an unfinished local bootstrap: Alchemy may resume it during state initialization.
6. After reviewing the plan and approving deployment, run `npx task build` followed by `CI=true npx alchemy deploy --stage production --yes`. Deployment updates the Worker, binds D1, and applies pending SQL migrations. Serialize deployments to the same stage across orbs. Production access is account-scoped: stage names are not an authorization boundary.
7. Open the returned HTTPS Worker URL and sign in with one of the two allowed Google accounts.

All production requests, including assets and API, pass through Cloudflare Access. Keep the Worker-level allowlist in place; do not add bypass or account-wide policies as a workaround. Credential configuration and read access do not establish deployment permissions; verify cloud writes only during an approved bootstrap or deployment.

`alchemy.run.ts` is the infrastructure source of truth. Its inferred environment types are used directly by `src/server.ts`; there is no parallel Wrangler binding configuration to drift. `alchemy dev` keeps its state and SQLite data locally in `.alchemy/`; cloud operations use `Cloudflare.state()` so separate orbs share deployment state. Never run destructive infrastructure commands casually. Keep production bootstrap, deployment, and migrations out of orb setup, resume, and preview services.

## Photo credits

Illustrative sample images are bundled for network-independent development:

- Chicken: [Unsplash image 1532550907401-a500c9a57435](https://images.unsplash.com/photo-1532550907401-a500c9a57435)
- Pasta: [Unsplash image 1473093295043-cdd812d0e601](https://images.unsplash.com/photo-1473093295043-cdd812d0e601)
- Grain bowl: [Unsplash image 1512621776951-a57141f2eefd](https://images.unsplash.com/photo-1512621776951-a57141f2eefd)
- Salmon: [Unsplash image 1467003909585-2f8a72700288](https://images.unsplash.com/photo-1467003909585-2f8a72700288)
- Tacos: [Unsplash image 1551504734-5ee1c4a1479b](https://images.unsplash.com/photo-1551504734-5ee1c4a1479b)
- Soup: [Pexels image 539451](https://www.pexels.com/photo/539451/)

Fonts: DM Sans and Lora, self-hosted through Fontsource under the SIL Open Font License.
