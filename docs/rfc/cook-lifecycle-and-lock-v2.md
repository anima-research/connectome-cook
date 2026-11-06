# RFC: cook as a one-shot materialiser plus a build manifest, with the deployment lifecycle kept outside cook

Status: proposal, for discussion in its pull request.

Following review R1 on #3 and #5, we're closing both PRs. They implemented a held/seed/verify lifecycle and a deployment manifest ahead of any agreed design. The PRs with users today are rebuilt on main and don't depend on them: #6, #7, #8, #10 and #11. #9 (which absorbs #4) is on hold until question 3 below is settled.

## Proposal
- cook keeps doing one thing: deterministically materialise one pinned runtime into its own directory. It is fail-closed, keeps credentials out of argv, and leaves existing installs untouched unless asked.
- cook records exactly what it built, in `connectome.lock` v2 (below). Each field it adds is written by cook and read by its own reconcile, so none of it is a schema without a consumer.
- cook may generate install-time files: the launcher, an optional systemd unit file (#7) and private directory layouts (#8). It doesn't enable or start anything.
- Holding, seeding state, health checks, activation, rollback and storing secrets stay outside cook, in the operator's deployment layer (config-management repo, systemd and so on). Rollback means keeping the previous materialised directory and switching the path.

## Proposed: the build manifest is `connectome.lock` version 2

`connectome.lock` already records what was materialised: the backend, the recipe path, the connectome-host url, ref, commit and path, the components (url, ref, commit, path, install), local extensions, requirements, and how to launch. `cook run` and reconcile read it. Adding the missing facts to the lock keeps one source of truth. A second file would describe the same build and could drift from it.

v2 adds the following. Each field is written by cook and read by reconcile, so none of it is a schema without a consumer.

| Field | Content | Why |
|---|---|---|
| `cook` | `{ version, commit? }` | which cook produced it |
| `recipe` | `{ path, sha256 }` | detect a changed recipe on reconcile |
| `connectomeHost.commit`, `components[].commit` | required (full SHA) on both backends | a pin is a commit, not a ref |
| `components[]` npm-global entries | `{ kind: "npm", name, version, integrity }` | today they go to `skipped` and are invisible (#5 R1-1) |
| `engines` | `{ bun, node: { path, version, sha256 } }` when chosen (#6/#7) | what actually runs |
| `layout` | the roots when `--layout` is used (#8) | reconcile refuses silent layout changes |
| `outputs[]` | `{ path, sha256, mode }` for files cook generated (launcher, unit, recipes, `.env` mode only, no `.env` hash) | detect drift and hand-edits |

What it doesn't contain: credential values and the hash of `.env`. Requirement values stay where `main` already puts them. The lock carries no lifecycle state (held, seeded or active).

A v1 lock is still read. The first reconcile after the upgrade rewrites it as v2. An older cook refuses to read a v2 lock, which is the existing behaviour for any unknown version, so it doesn't silently misread it.

## Questions
1. Is the split acceptable: cook materialises and records, and the lifecycle lives outside it?
2. Any fields to add or drop in lock v2?
3. Should cook provision credential files and bind them to consumers (#9), or should that stay with the deployment layer (for example systemd `LoadCredential`), with cook only refusing credentials in argv and URLs?
4. Two small refactors from #3 also stand on their own: inspectPlan/validatePlanWalks in plan.ts, and parent-recipe reuse in walkRecipe. Do you want them as a separate PR?