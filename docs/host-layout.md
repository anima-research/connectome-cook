# Opt-in split host layout

A standalone host installation can use `--layout layout.json` with selected
absolute engines (`--bun-path` and `--node-path`, both required). An empty
`--layout` is an error. The runtime root must equal --out; all five roots must be
absolute, distinct (including device/inode identity) and non-overlapping. Example (nonsecret declarations only):

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

State is intentional: connectome-host (reviewed at commit 1526663c) resolves
fleet child stores (`child.dataDir` or `data/NAME`), `mcpl-servers.agent.json`,
`mcpl-servers.json`, `sleep-privileged.json` and `logs/failures.log` against
process.cwd(). Host-owned relative state paths therefore stay in state, not
the agent workspace or code checkout.
Audit explicit absolute host path overrides separately; Cook does not rebase them.
The launcher passes `--no-env-file --config=<runtime>/bunfig.toml` to Bun. This
prevents cwd .env loading and uses runtime-owned configuration without preloads,
rather than trusting bunfig.toml in state or workspace. It also unsets
BUN_OPTIONS before exec to prevent inherited preloads. Config .env is still
explicitly shell-sourced; treat config and runtime as operator-owned inputs.

Under `--layout`, Cook lowers every recipe's `modules.workspace`: relative
mounts are rebased onto the workspace root, preserving relative structure,
names, modes and other options. Thus recipes sharing `./output` still share
`<workspace>/output`. Unset or `true` writes the host defaults explicitly:
`input` at `<workspace>/input` read-only and `products` at
`<workspace>/output` read-write. `false` stays disabled.
A mount of `.` or `./` maps to the workspace root, never the state root.
Absolute mounts within (or ancestors exposing) state/config/runtime/credentials,
and relative paths escaping to expose these reserved roots, refuse.
External absolute mounts remain unchanged. These mappings are not a filesystem
sandbox; audit mount contents and symlinks separately.

WORKSPACE_DIR itself has **no connectome-host consumer**; the lowered absolute
mounts provide the workspace binding. The credentials root is only provisioned
empty (0700) and recorded; **no credential consumer or placement is implemented
in this PR**. It is reserved for explicit future bindings.

Each connectorState entry names an existing stdio consumer (by name throughout
the recipe tree). Its environment mapping is lowered to absolute paths under
state/connectors/NAME/. File parents are provisioned privately; file contents
are not created or copied. A file mapping cannot also be a parent of another
mapped file for the same consumer. Unknown/WebSocket consumers, traversal, unsafe
roots and layout-owned DATA_DIR/WORKSPACE_DIR value overrides refuse.
Other connector-specific paths are not guessed or automatically rebased: declare
each state-file env binding explicitly and audit remaining paths.

Linux provisioning creates 0700 roots and state-file parent directories owned
by the effective user. Existing roots with other ownership/modes, symlink
ancestors and non-directories refuse. Group/other-writable non-root-owned
ancestors must be sticky; otherwise they refuse. Backslashes in path components
remain accepted (unlike #10's privatePathParts); Cook never chmods/chowns existing roots.
Generated configuration/control files are private, with a 0700 launcher.
Code inside the private runtime root retains upstream build modes.

This first opt-in supports standalone hosts: sidecars, container template files
and legacy recipe credentialFiles refuse rather than leaving mutable files in
the code tree. Use the default layout for those shapes. Changing or removing a recorded layout on reconcile refuses. The persistent
runtime `.cook-layout.json` marker records `installing` after confirmation,
before retiring any stale reuse lock or starting builds; only after the new lock
is durable does it become `installed`. An interrupted `installing` phase can
resume with the exact same layout, even when lock retirement left no lock and
an older launcher remains. No missing lock authorizes clone reuse.
Both marker and lock use same-directory temp files, fsync, atomic rename and
parent-directory fsync. Original raw-layout markers count as installed.

An unreadable marker, an unreadable/downgraded lock, or a missing lock with an
installed marker refuses; restore matching records from backup or use fresh
stopped roots. Original split launchers without a marker are recognized by
their DATA_DIR/WORKSPACE_DIR exports. Without a marker, existing default
`run.sh`, `recipes/` or `data/` refuses split-layout adoption, including when
the lock is unreadable.

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
   owners, modes and old absolute/relative paths, including every workspace mount
   (implicit defaults are ./input read-only and ./output read-write). Separate
   host state/logs from agent workspace contents. Back up independently.
   Place host CWD-relative overlays, operator MCPL config, sleep-privileged.json
   and fleet child data under the new state root (preserving relative paths).
3. Materialize a fresh installation into new, non-overlapping roots. Inspect
   lowered paths and the exported unit without starting it. Keep the same model
   and identity deliberately; Cook does not infer compatibility.
4. With both installations stopped, manually copy the inventoried data to its
   declared destination: copy relative/default workspace mount contents into
   workspace preserving their relative structure (./input → workspace/input,
   ./output → workspace/output, . → workspace); keep host CWD-relative files
   including logs/failures.log under state. Check lowered absolute mounts, not
   WORKSPACE_DIR alone. Preserve intended ownership and private modes. Do not
   copy stale launchers, locks, layout markers or code over the new runtime.
   Do not treat an empty-state build as evidence of migrated-store compatibility.
5. Audit absolute connector-state bindings, workspace paths and credential
   consumers. Verify application-specific formats and backups independently.
6. Only after operator review, arrange service management and validate the new
   installation separately. Retain a stopped rollback copy; never let both
   installations write the same state. Cook neither starts services nor
   certifies history migration, credential adoption or recovery.
