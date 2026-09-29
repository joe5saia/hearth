# Hearth deployment owner

This workflow is authorized by the owner in thread
https://ampcode.com/threads/T-01a0e816-b3ae-712d-8730-ab501f548221.
Authorization covers automatic deployment of main to the existing Cloudflare production
stage, including its D1 migrations; read-only live smoke checks and logs; and creating
separate orbs to investigate and fix observed errors. It does not authorize pushing fixes,
changing Access policies, deleting data, rolling back migrations, or deploying other stages.

Keep this deployment thread unarchived. Only this orb has `.amp/deploy-state/owner.json`.
Never copy its state or webhook URL into another orb or commit them. Other orbs must not
deploy production concurrently. Keep all deployment commands in this one owning thread.

## On a push

Call `hearth_deploy_next`. It reads the actual remote main, not the webhook payload.
Non-main pushes and repeated notifications cause no deployment if main was already
attempted. Bursts coalesce to the latest main tip, rather than deploying every intermediate
commit. One deployment stays active until its checks and log review finish. Failed and
blocked commits are recorded, not retried endlessly; investigate before an explicit retry.

In **dry-run** mode, do not run any cloud write or deployment command. Report the claimed
SHA, record `dry-run`, and drain the queue. This exercises real delivery without touching production.

In **production** mode:

1. Read the active attempt. If `resume` is true, inspect this thread's previous commands,
   their running process state, and Cloudflare's deployed version before doing anything.
   A crash after deployment but before recording a result is ambiguous: resume verification
   of the same deployment, not a blind redeploy. If the outcome cannot be determined, mark
   it blocked and report the uncertainty. Never start a second deployment while one is running.
2. Fetch origin and use a clean, isolated Git worktree at the exact claimed SHA for build and
   deployment. Do not replace the owning checkout (it runs the plugin). Confirm the SHA is
   on origin/main. Do not deploy a force-pushed-away commit. If main has advanced, finish
   the old attempt as blocked/superseded and claim the latest one before deploying.
3. Bootstrap Task with `npm ci`, then run `npx task typecheck` and `npx task test` in that
   worktree. Stop on any failure. Run `npx task deploy -- --yes` (which builds before deploying), capture output
   privately, and follow the process until it exits. Do not put production deploys into
   setup scripts. Missing permissions or bootstrap requirements are blockers, not permission
   to provision unrelated infrastructure or change credentials.
4. Monitor Cloudflare's Worker deployment/version status using its API and the resource
   identity from Alchemy's output/state. Confirm the published version is the deployment
   just created. Record version ID, commit, start/end time and command exit status. Do not
   infer completion solely from an HTTP response from an old version.
5. Start a bounded Cloudflare Worker live log tail **before** the browser check; capture
   request outcomes, exceptions and console errors during the check and briefly afterward.
   Use existing available Cloudflare tooling/API. Do not enable paid logging, broaden token
   permissions or change Access policy without approval. If logs cannot be read, record
   verification as blocked, not clean. Always close/delete the tail session afterward.
6. Load the browser-use skill. Authenticate the owning orb's Desktop Chrome with the
   approved Hearth smoke-test service token stored in private
   `.amp/deploy-state/smoke-credentials.json` (`clientId`, `clientSecret`, `expiresAt`).
   Check expiry first. Pass the two Access headers using agent-browser's origin-scoped
   `--headers` on `open https://hearth.joesaia.trade`, never global `set headers`:

   ```sh
   npx task smoke:open
   ```

   Use that same namespace/session/CDP connection for subsequent browser commands. Never
   print credentials, capture request headers in shared artifacts, invent a JWT, change
   the allowlist, or copy human cookies. The app enforces GET/HEAD-only access for this
   specific signed machine identity. If authentication fails, report it as blocked; do
   not fall back to bypassing Access. Google login is no longer required for smoke tests.
   Once authenticated, click through **Recipes**, **Meal plan**, and **Shopping**. If a
   recipe exists, open and close its detail view. Do not seed, import, save, delete, check
   shopping items or otherwise modify household data. Verify content loads in each view,
   capture screenshots under `.amp/in/artifacts/`, and inspect them with `view_media`.
   Also inspect browser console errors and failed app network requests. Keep this a quick
   smoke test, not a comprehensive test suite. Do not publish private household content.
7. Review deployment output and the captured Worker/browser logs for exceptions, failed
   requests and errors. Record the observation window and which logs were actually available.
   A sampled quiet tail is evidence for that window only, not proof that production has no errors.
8. On an actual build, deploy, smoke-test or log error, use `create_thread` with `executor: orb`
   in joe5saia/Meal-planning to investigate and fix it. Give it the exact deployed/failed SHA,
   URL and route, UTC time, expected versus observed behavior, reproduction clicks/commands,
   error text and stack (redacted), browser/request evidence, and relevant log/version IDs.
   Distinguish observed bugs from missing access. Tell it to reproduce using disposable local
   data, make the smallest fix, verify it, and leave it ready for review without pushing or
   deploying. Do not copy production secrets or household data. Include evidence directly or
   use thread file-transfer tools for sanitized artifacts; a fresh orb cannot read this disk.
   Ask the investigation orb to reply with findings and changes. Save its URL in the result.
   Create one investigation per attempt, reusing its thread after an interruption.
9. Call `hearth_deploy_finish`: `passed` only if deployment, visual smoke and log review all
   succeeded; `failed` for observed errors (with investigation URL); `blocked` for missing
   login, permissions or other unverified steps. Supply concrete evidence and limitations.
   Call `hearth_deploy_next` again until there is no work. Report the production version,
   verification result, any investigation link, and the next action the user needs to take.

## Installation and recovery

In one dedicated owner orb, create a private `.amp/deploy-state/owner.json` containing
`{"thread":"<owning thread ID>","mode":"dry-run"}`. Load `.amp/plugins/hearth-deploy.ts`.
The plugin saves its capability URL to `.amp/deploy-state/webhook-url` (owner-only). Configure
that URL in the Amp project's **Post-receive Webhook** settings without printing it or
recording it in screenshots. Test a POST twice with the same `Idempotency-Key`, confirm the
owner wakes, and confirm the second delivery does not deploy again. Test a push through the
repository hook before declaring the wiring live. Do not overwrite an existing hook silently.

After the user-authorized live test is ready, change mode to `production` and reload the
plugin. Dry-run attempts must not suppress production: archive the dry-run `state.json`
privately before enabling production, with no attempt active. Keep production state thereafter.
If a retry is needed after a failure, review the recorded evidence first; do not erase
production history just to trigger it again. After the user requests the retry, call
`hearth_deploy_next` with `retryAfterReview: true`. This preserves prior evidence and returns
`resume: true` so verification can resume without blindly redeploying. Automatic push
notifications must never set this option. Restore an archived owner to resume delivery.
If a turn fails, inspect persisted active attempts and unacknowledged notifications; manually
resume with `hearth_deploy_next`. Webhook URLs must never appear in repository files or chat.

## Smoke credential lifecycle

Alchemy manages the `SmokeTest` Access service token and its Hearth-only Service Auth policy.
The token expires after 720 hours (30 days); normal no-op deploys do not guarantee renewal.
Before expiry, renew through Cloudflare's service-token API, or rotate through Alchemy's
`clientSecretVersion`, then securely refresh the owner's credential file and verify access.
Do not rotate automatically or widen token permissions as a workaround for an auth failure.
The secret is retained in Alchemy's encrypted Cloudflare state, never in the Worker bindings;
only its public client ID is bound as `SMOKE_CLIENT_ID`. Keep exported credentials mode 0600
under a mode-0700 `.amp/deploy-state/` directory, outside Git and project snapshots. Do not
make them available to unrelated project orbs. Delete temporary state exports after extraction.
Revoking the service token removes machine access; the household Google policy is unchanged.
