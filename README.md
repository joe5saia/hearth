# Hearth

A meal planner for one household: saved recipes, a weekly calendar, and a shopping list calculated from the meals you actually planned. React + TypeScript, Effect 4 RC, Cloudflare Workers + D1 (SQLite), and Alchemy 2. Earth colors, restrained transitions, and responsive layouts.

## Run everything locally

Use Node 26.10 or newer (version in `.node-version`). No Cloudflare account, API key, remote database, Docker, or paid service is required.

```sh
npm ci
npx task dev
```

Open http://localhost:5173 on your own machine. `task dev` builds the initial static assets, then starts Vite with React HMR and Alchemy's local Worker on port 8787. Vite proxies `/api` to that Worker. Alchemy applies the SQL migrations and persists the local SQLite database beneath `.alchemy/`. Restarting the app preserves your household. **Deleting `.alchemy/` deletes local data and infrastructure state.** Keep that directory private and backed up.

The empty app offers **Try a sample week**. This adds six editable recipes and five meals in the browser's current week. It never runs automatically in production. You can also start with your own recipe. Example recipes are original demonstration content; source links point to related recipe collections, and bundled photos are illustrative.

Task is installed as a pinned npm development dependency, so `npx task` works without a global install. `npm run dev` is an alias.

Alchemy beta.79 currently resolves a cloud profile even for local resources. `dev:worker` supplies deliberately invalid local-only credential placeholders to satisfy that configuration check. Both resources run in **local** mode; these placeholders cannot access a Cloudflare account and are not used by the deployment task. Alchemy's native Vite bridge has a local WebSocket startup problem in this environment, so development uses Vite's standard HTTP proxy. Deployment still uses one Worker serving both assets and API, with D1 provisioned and bound by Alchemy.

In an Amp orb, `.agents/setup` installs the pinned Node version and dependencies. Use `amp orb services ensure` to start both local processes and create the Hearth portal. Setup never authenticates, deploys, or applies remote migrations. Do not expose either unauthenticated development port directly to the public internet.

## Daily use

- **Recipes:** create, edit, search by title or ingredient, filter collections, and delete unplanned recipes. Store a source URL, instructions, servings, cooking time, and a photo URL or upload. Uploaded JPG, PNG, and WebP photos up to 1.2 MB are stored in SQLite; no external object storage is needed. Bundled photos and fonts also work offline. External photo URLs naturally require a network connection.
- **Meal plan:** Monday–Sunday calendar on desktop and a vertical agenda on narrow screens. Navigate weeks or jump directly to a date. “Add a meal” suggests the next open dinner in the selected week, starting today for the current week; if no dinner is open, it keeps you within that week. Breakfast/lunch/dinner display in order, with multiple meals per day, decimal scales, and notes. Edit a meal to move or remove it. Opening its recipe preserves unsaved meal edits and previews its scale; “Back to meal” returns to the draft. Recipe-detail scaling is a preview; the calendar meal's scale controls shopping quantities.
- **Shopping:** inclusive start/end dates; ingredient totals update immediately from recipes and meal scales. The remaining count includes household extras, and “Hide checked items” applies to both sections. Completed sections show a confirmation instead of an unexplained blank list. Add/remove extras or export a plain-text checklist. Extras persist independently of the selected date range. A changed total or date range gets a new checkmark identity so a previous purchase does not hide an increased quantity.

Ingredient names match after trimming, whitespace normalization, and case folding. Use consistent names (`Cherry tomatoes`, not sometimes `Tomatoes`). Compatible units convert within their families: kg/g, l/ml, lb/oz, and cup/tbsp/tsp (US measures). Different families stay separate; a can, clove, or bunch cannot be converted to weight without information the app doesn't have. Notes such as “add chicken” are shown on the shopping page but **do not invent ingredient quantities**; add that chicken as a manual item or recipe ingredient. Instruction text stays as written when scaling.

This version uses one shared household, no user roles. Changes are saved to the server, not browser local storage. Reload to see another household member's latest edits; simultaneous edits use last-write-wins. Browser calendar dates are used without UTC conversion. Local development is network-independent after dependencies are installed; this is not an offline-sync PWA.

## Check the app

```sh
npx task check  # TypeScript, Oxlint + vendored rules, Oxfmt, and tests
npx task build
```

Tests bundle the actual Worker with Rolldown and exercise disposable local D1 via Miniflare. They cover CRUD, SQL persistence, validation, delete protection, seeding, production authentication, CSRF rejection, fractional scaling, date boundaries, compatible-unit conversion, and checkmark invalidation. They do not use the development household database.

All generic [anti-slop](https://github.com/dmmulroy/anti-slop) rules are enabled in `oxlint.config.ts`. Their source, tests, license, and upstream revision are vendored under `tools/oxlint/anti-slop`. Do not modify the vendored snapshot during formatting.

**Known sandbox limitation:** Oxlint 1.85's JS plugin allocator crashes on small E2B instances before linting ([upstream issue](https://github.com/oxc-project/oxc/issues/20331)). The normal check task deliberately reports that failure rather than bypassing rules. During development here, native Oxlint checks and all anti-slop rules were checked separately, the latter using their official ESLint-compatible interface. Run `task check` on a machine that supports the plugin allocator before deployment. Oxfmt, TypeScript, tests, and builds run in this orb.

`npm audit --omit=dev` reports no production dependency vulnerabilities at implementation time. Full audit reports 10 advisories in Alchemy's development-only transitive dependencies; no unsafe forced downgrade or experimental package substitution was applied.

## Deploy to Cloudflare

Deployment is **not performed** as part of local setup. Review it before running: this provisions shared infrastructure and applies migrations.

1. In the Amp project's Secrets & Env Vars, set `CLOUDFLARE_ACCOUNT_ID` as an environment variable and `CLOUDFLARE_API_TOKEN` as a secret. Scope the token to the intended account with **Workers Scripts: Edit**, **D1: Edit**, and **Secrets Store: Edit**. No interactive profile is needed. Outside Amp, export these variables in your private environment.
2. Set `HOUSEHOLD_PASSWORD` as a secret: use a strong, unique password of at least 16 characters. The stack reads it from `process.env` and publishes it as a Worker secret, not a plain-text binding. Never commit credentials or copy them into orb setup scripts or snapshots. Refresh an existing orb with `amp orb restart-processes` after changing Amp secrets.
3. Run `npx task cloud:check` to validate credential configuration. This checks presence and format, not live authorization or all required permissions.
4. After explicit approval, run `npx task cloud:bootstrap` once per Cloudflare account to provision Alchemy's shared state Worker, Durable Objects, and Secrets Store secrets. Do not delete its encryption key. If an older version of this project has already deployed from local state, preserve that `.alchemy/` directory and migrate its production state before switching backends; do not assume existing resources will be adopted safely.
5. Run `npx task plan` to build assets and preview the `production` stage against the bootstrapped state store. Cloud tasks use `CI=true`, so missing credentials or a missing/outdated state store fail instead of prompting to set them up. Do not run a plan with an unfinished local bootstrap: Alchemy may resume it during state initialization.
6. After reviewing the plan and approving deployment, run `npx task deploy`. It builds React, then deploys the Worker, binds D1, and applies pending SQL migrations. Serialize deployments to the same stage across orbs. Production access is account-scoped: stage names are not an authorization boundary.
7. Open the returned HTTPS Worker URL. Sign in through the browser's authentication prompt with username **hearth** and your household password.

All production requests, including assets and API, pass through the password gate. Missing/short passwords fail closed. Keep the HTTPS endpoint, use a high-entropy password, and use Cloudflare Access if you later want per-person identity and access policies. Basic authentication intentionally has no in-app sign-out or password recovery. Credential configuration and read access do not establish deployment permissions; verify cloud writes only during an approved bootstrap or deployment.

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
