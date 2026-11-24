# RFC: one-shot materialization and lock v2

## Decision

Cook materializes a recipe into a directory and records the result in
`connectome.lock`. Activation policy, health checks, rollback and secret-store
policy belong outside cook. The lock is a record of materialization, not a
desired-state specification or a cache key.

`cook run` uses the backend and launch hints. Host installs reuse matching
checkouts based on URL, ref, install command, any requested commit and target
existence. Incomplete installs, selected engines and host dependencies have
their own safeguards. The new inventory fields do not control these decisions.

| Inventory | Purpose |
|---|---|
| `cook.packageVersion`, `recipe`, `build.dir` | Identify the package version, root recipe and its input digest, and the output directory. |
| `connectomeHost`, `components` | Record known Git commits, host sibling copies and declared npm sources. Unpinned Docker refs may have no commit; npm declarations are not resolved against a registry. |
| `referencedVariables` | List referenced names, including defaults and alternatives. It is not a startup checklist. |
| `outputs` | List generated paths, modes and digests of declared public bytes as generated, not as read back from disk. |

The [README](../../README.md#connectomelock-v2) describes the emitted fields.
Neither the inventory nor the output digests verify current disk contents or
establish a complete build identity.

## Secret handling

Locks record requirement names, environment variable names and origins, never
answers. This also applies to v1 incomplete markers. Sensitive outputs such as
`.env`, credential files and rendered templates are recorded by path and mode,
without digests; sensitivity is declared, not inferred by inspecting values.
Supply secrets through requirement and credential inputs, not as literals in
recipes or source specs. Rewriting an old lock cannot undo past disclosure.

## Compatibility

A successful build or install writes v2. Current readers accept v1 and v2;
an unreadable or unsupported host lock stops reconciliation rather than
triggering a reinstall. Older cooks can treat v2 as a fresh install and replace
the checkouts; do not point them at a v2 installation.
