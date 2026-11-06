# Opt-in split host layout

A standalone host installation can use `--layout layout.json` with selected
absolute engines (`--bun-path` and `--node-path`, both required). An empty
`--layout` is an error. The runtime root must equal --out; all five roots must be
absolute, distinct and non-overlapping. Example (nonsecret declarations only):

    {
      "schema": "connectome.host-layout/v1",
      "runtime": "/srv/example/runtime",
      "config": "/srv/example/config",
      "state": "/srv/example/state",
      "workspace": "/srv/example/workspace",
      "credentials": "/srv/example/credentials",
      "connectorState": {
        "heartbeat": {
          "HEARTBEAT_CONFIG_FILE": "settings.json",
          "HEARTBEAT_REMINDERS_FILE": "reminders.json"
        }
      }
    }

Code, run.sh, the optional exported unit, connectome.lock, .cook-layout.json
and a generated bunfig.toml live under runtime. Lowered recipes and .env live
under config. The confirmation preview names these actual destinations.
The launcher sets DATA_DIR to state, WORKSPACE_DIR to workspace, and runs with
**state as CWD** and umask 077. The optional unit declares the same state root
as a bare WorkingDirectory, using the user-unit renderer's percent escaping
and terminal-backslash/trailing-whitespace refusal.

State is intentional: connectome-host (reviewed at anima/main 68548adf) resolves
fleet child stores (`child.dataDir` or `data/NAME`), `mcpl-servers.agent.json`,
`mcpl-servers.json` and `sleep-privileged.json` against process.cwd(). Relative
host paths therefore stay in state, not the agent workspace or code checkout.
Audit explicit absolute host path overrides separately; Cook does not rebase them.
The launcher passes `--no-env-file --config=<runtime>/bunfig.toml` to Bun. This
prevents cwd .env loading and uses runtime-owned configuration without preloads,
rather than trusting bunfig.toml in state or workspace. Config .env is still
explicitly shell-sourced; treat config and runtime as operator-owned inputs.

WORKSPACE_DIR currently has **no connectome-host consumer**: exporting it does
not change the agent's workspace or constrain tool filesystem access. Operators
must configure workspace consumers explicitly. The credentials root is likewise
only provisioned empty (0700) and recorded; **no credential consumer or placement
is implemented in this PR**. It is reserved for explicit future bindings.

Each connectorState entry names an existing stdio consumer (by name throughout
the recipe tree). Its environment mapping is lowered to absolute paths under
state/connectors/NAME/. File parents are provisioned privately; file contents
are not created or copied. Unknown/WebSocket consumers, traversal, unsafe
roots and layout-owned DATA_DIR/WORKSPACE_DIR value overrides refuse.
Other connector-specific paths are not guessed or automatically rebased: declare
each state-file env binding explicitly and audit remaining paths.

Linux provisioning creates 0700 roots and state-file parent directories owned
by the effective user. Existing roots with other ownership/modes, symlink
ancestors and non-directories refuse; Cook never chmods/chowns existing roots.
Generated configuration/control files are private, with a 0700 launcher.
Code inside the private runtime root retains upstream build modes.

This first opt-in supports standalone hosts: sidecars, container template files
and legacy recipe credentialFiles refuse rather than leaving mutable files in
the code tree. Use the default layout for those shapes. Changing or removing a recorded layout on reconcile refuses. The persistent
runtime `.cook-layout.json` marker is written before builds and compared with
both the requested layout and the lock. An unreadable marker, an unreadable
or missing lock on a recognized split install, or a lock overwritten without
layout by an older cook refuses; restore the matching records from backup
or use fresh stopped roots. Original split
launchers without a marker are recognized by their DATA_DIR/WORKSPACE_DIR exports.

**Do not run older cooks on split installations.** They do not know this marker
and cannot be prevented from overwriting the launcher/lock. This version detects
the surviving marker on the next reconcile, but cannot undo an earlier launch
with an old cook's default layout. If both marker and split launcher signature
are removed and the lock is unreadable or lacks layout, the previous split
installation is indistinguishable from a default installation. Keep independent
backups. There is no importer or in-place adoption; use fresh roots for changes.

## Stopped-install manual handoff checklist

1. Stop every writer to the old host, workspace, connector state and credentials;
   verify they remain stopped.
2. Inventory history, model/identity settings, overlays, writable connector
   settings/reminders, workspace files and external credential files. Record
   owners, modes and old absolute/relative paths. Back up independently.
   Place host CWD-relative overlays, operator MCPL config, sleep-privileged.json
   and fleet child data under the new state root (preserving relative paths).
3. Materialize a fresh installation into new, non-overlapping roots. Inspect
   lowered paths and the exported unit without starting it. Keep the same model
   and identity deliberately; Cook does not infer compatibility.
4. With both installations stopped, manually copy the inventoried data to its
   declared destination. Preserve intended ownership and private modes. Do not
   copy stale launchers, locks, layout markers or code over the new runtime.
   Do not treat an empty-state build as evidence of migrated-store compatibility.
5. Audit absolute connector-state bindings, workspace paths and credential
   consumers. Verify application-specific formats and backups independently.
6. Only after operator review, arrange service management and validate the new
   installation separately. Retain a stopped rollback copy; never let both
   installations write the same state. Cook neither starts services nor
   certifies history migration, credential adoption or recovery.
