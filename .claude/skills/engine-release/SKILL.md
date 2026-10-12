---
name: engine-release
description: WIP (1/2). Release open-loop-engine — a patch from main, or the next minor, collected on the `next` branch and cut by a fast-forward. Use to cut an engine release, to commit a breaking change, or to rebase `next`. Only for the open-loop-engine repo.
---

# Engine release — WIP (1/2)

**This skill is WIP.** After each use, add what the run taught to this file. Then increment the counter in the title and the description. At (2/2), remove "WIP" from both. Keep the skill thin. Where another file owns a step, point to that file; do not copy it.

Owners of the details:
- `AGENTS.md` § Commits: the bump policy and `pnpm release`; its § Publish surface: what ships;
- `AGENTS.md` § Breaking-change entries: the body of a breaking commit;
- `docs/notes/review-backlog-releases.md` (local): classifying an item, consumers and the changelog check.

## Choose the lane

- **Patch-safe** → `main`. **Breaking** → `next`. Classify from the code, by the playbook's § Classifying an item.
- Ship a break's patch-safe half on `main` first. Commit only the breaking half on `next`.
- Each item on `next` has an entry on the open next-minor umbrella's register.

## Release a patch from main

1. `pnpm release --dry-run`, and read the section.
2. `pnpm release`. CI publishes the pushed tag.
3. Confirm the publish:
   - the Actions tasks endpoint, with the `agent-gitea-read` fnox profile: `$GITEA_URL/api/v1/repos/studio/open-loop-engine/actions/tasks`. The runs are in `workflow_runs`, and the publish run is named `publish`;
   - `pnpm view @open-loop/engine dist-tags`, run from a consumer repo. The engine repo has no studio registry config, so there it asks npmjs.
4. If `next` has commits, rebase it (§ Rebase next).

## Collect a breaking change on next

- Work in the worktree `.claude/worktrees/next`. If it is missing: `git worktree add .claude/worktrees/next next`, then `pnpm install --frozen-lockfile`.
- Never commit `docs/api/` on `next`. The pre-commit hook skips it in a worktree, and CI skips the `docs/api` check on `next`.
- Inside a minor, a mechanical rename batch goes first, in its own commit.

## Rebase next

Rebase after a release, and before you commit on `next`. Another push to `main` needs no rebase, because the cut rebases anyway.

1. In the worktree: `git rebase main`.
2. Run `pnpm typecheck` and `pnpm test`, because a rebase runs no hook.
3. `git push --force-with-lease origin next`, then confirm its CI run passes.

## Cut the minor

1. Adapt and check the consumers first, by the playbook's § Consumers.
2. Rebase `next` (§ Rebase next).
3. In the main checkout: `git merge --ff-only next`.
4. `pnpm build`. The release commit's hook writes `docs/api/` from `dist/`, and `dist/` is still main's build. Without this step the tag's CI check fails, and nothing publishes.
5. `pnpm release --dry-run`, and read every Breaking changes entry.
6. `pnpm release`, then confirm the publish (§ Release a patch, step 3).
7. Close the umbrella, and file the next one when the first breaking item appears.
