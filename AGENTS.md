# Development commands

Use `npx task` to discover repository tasks and `npx task <name> -- <args>` to run them.
All repeatable commands intended for people or agents belong in `Taskfile.yml`.
Package scripts and TypeScript tools may supply implementation primitives; do not direct
people or agents to invoke those primitives instead of tasks. The bootstrap exception is
`npm ci` in a fresh checkout or orb setup, which installs the pinned Task executable itself.
Git, Amp lifecycle/tool calls, and interactive browser inspection remain native operations.

# Validation

We do not use unit tests. Do not add or restore unit tests, including isolated tests with mocked dependencies.
Every change must be validated with smoke tests or end-to-end testing that exercises the affected behavior.
Use `npx task test` for the local integration smoke suite (Worker/D1/KV and deployment Git/persistence);
use browser or isolated Preview
end-to-end testing when the change requires UI or real Cloudflare coverage. Report what was exercised
and the result. Type checking, linting, formatting checks, and builds supplement runtime validation;
they do not replace it.

# Git workflow

## Before making changes

- Before editing repository files, inspect `git status --short` and `git branch --show-current`. Validate that the checkout is on a new working branch for this thread, never `main` or a detached HEAD.
- Name branches `<thread-id>-<suffix>`, using the full Amp thread ID and consecutive uppercase suffixes: `T-<uuid>-A`, `T-<uuid>-B`, `T-<uuid>-C`, and so on (after Z, use AA, AB, etc.). Use the first unused suffix, checking local and remote branches after fetching `origin`.
- Create the branch with `git switch -c <branch>`. For a clean checkout starting new work, branch from the latest `origin/main`. Preserve existing uncommitted work and local commits; do not reset, discard, or overwrite someone else's changes.
- Continue using the same branch while its work is unshipped. After shipping, create the next suffixed branch before making further changes in this thread.

## Shipping

Follow this workflow when the user asks to ship. These instructions do not themselves authorize a push during an ordinary editing task.

1. Review the diff and commit the changes being shipped on the thread's working branch. Leave unrelated work untouched and ensure the worktree is clean before rebasing; ask if unrelated changes prevent this.
2. Fetch `origin`, then run `git rebase origin/main` on the current working branch. This replays the thread's commits on top of the latest main; do not rebase main onto the working branch or create a merge commit. If the clone is shallow, run `git fetch --quiet --unshallow origin` before rebasing.
3. Resolve mechanical conflicts. For substantive conflicts that change behavior, propose a resolution and get the user's approval before continuing.
4. Run the full test suite (`npx task test`) after rebasing. Fix regressions before pushing. Treat a failure as pre-existing only after reproducing the same failure on `origin/main` without the thread's changes, and report that evidence rather than claiming all tests passed.
5. Push the rebased commits directly to main with `git push origin HEAD:main`. Never force-push main. If the push is rejected because main advanced, fetch, rebase onto the updated `origin/main`, resolve conflicts, rerun the tests, and retry the push. Stop and report other push failures rather than bypassing protections.
6. After a successful push, synchronize this local checkout: run `git fetch origin`, `git switch main`, and `git merge --ff-only origin/main`. Confirm that `HEAD` equals `origin/main` and the worktree is clean. If local main has diverged or is checked out in another worktree, stop and report the blocker; do not reset or overwrite it.
7. Report what shipped, test results, and whether local main is synchronized. If the active Ship prompt requests archiving or runner-worktree cleanup, do that only after shipping and synchronization succeed, with worktree removal last. Do not archive threads that are still needed or running.

This workflow incorporates Amp's [default Ship flow](https://ampcode.com/docs/orbs/shipping): commit, fetch and rebase, run the full test suite, push, and retry if the base branch moves. Thread-specific branches and synchronizing local main are repository requirements in addition to that flow.

## Cloudflare Previews

- Use `npx task preview -- up` on the thread's working branch when real Cloudflare behavior needs testing or the user wants a remote preview. This project authorizes creating/updating the thread's disposable Preview resources for that purpose. Keep Amp portals for local iteration and review features.
- Read the README's Preview section first. Never deploy production, reuse production D1, disable Access, or expose credentials to make a Preview work. Do not run preview commands in orb setup/resume or portal services.
- `up` builds the current checkout, applies migrations to isolated D1, deploys a native Worker Preview, and smoke-tests it. Share its stable URL and cleanup deadline. Use `test` or `request` for authenticated checks without printing credentials. Only sample/test data belongs in Previews.
- Serialize commands for one thread across orbs. Do not edit or delete another thread's unexpired Preview unless asked. `gc` is authorized to reclaim this workflow's resources past their seven-day cleanup deadline.
- Run `npx task preview -- down` when the Preview is no longer needed, including before shipping/archiving unless the user explicitly asks to keep it for ongoing review. Do not remove a Preview while awaiting requested user testing. Verify cleanup with `npx task preview -- list` and report any failure.
- For agent-only remote validation, use teardown in a `finally` block or shell trap. New provisioning failures attempt rollback; failed updates preserve the existing Preview for diagnosis. Cleanup must still be completed before concluding the task.
- If an orb is lost, use `list` then `down <name>` from another orb. `up` and explicit `gc` collect expired resources, but no background timer runs. Orb deletion and Cloudflare Preview eviction do not clean up D1 or Access resources.

## MCP agent evaluations

- Use the isolated `/eval/mcp` URL printed by `npx task mcp:preview -- up`. In each same-project, same-owner eval orb, run the owner-authorized `npx task mcp:eval -- connect <URL>`, then `reload_mcp` before evaluating tools. This trusted user-settings bootstrap uses automatically refreshed Amp identity; do not copy OAuth bearer settings or ask for workspace approval for this connection.
- `npx task mcp:eval -- check <URL>` preflights identity and tool discovery without changing settings. Never substitute a production URL or disable authentication. Keep OAuth coverage separate with `npx task mcp:preview:test`.
- Disconnect with `npx task mcp:eval -- disconnect <URL>` and reload MCP when evaluation ends. The owning thread then runs `npx task mcp:preview -- down` to remove the isolated Preview and supporting resources. See the README for authorization boundaries and unpushed-code transfer between orbs.
