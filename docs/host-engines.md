# Selected host engines

Host installs can opt into engine preflight:

    cook install recipe.json --out /srv/example/install --no-prompts --yes \
      --bun-path /opt/bun/bin/bun --node-path /opt/node/bin/node \
      --ch-ref FULL_HOST_COMMIT

Both paths must be absolute executable files. Cook temporarily fetches the
selected host source, reads its package.json engines.bun and engines.node, and
checks each executable's --version against those semver ranges, with
`includePrerelease: true` (npm engines parity). Missing or invalid requirements,
inaccessible source/binaries, and mismatches refuse before creating or changing
the installation. No builds run during inspection. Materialization clones
locally from that same scratch fetch, with no second host network fetch, even
with --pin-refs; scratch is removed on success, cancellation or failure. A moving
host ref is bound to the inspected commit, which is recorded in the lock.

With these flags, --ch-ref accepts advertised branch names, tag names, full
refs (for example refs/pull/123/head), or full commit object IDs that the remote
permits fetching. Abbreviated commit IDs and revision expressions such as
HEAD~1 are not supported by the shallow preflight fetch; use the full ID or an
advertised ref instead. A hex-looking name can still be an advertised branch.
Without engine flags, the existing clone/checkout ref behavior is unchanged.

connectome.lock records each operator-supplied absolute `path`, canonical
`realPath`, and observed `version`. --version, host dependency installation,
run.sh and lowered stdio commands named exactly node or bun use the operator's
path, preserving multi-call shim dispatch. Build PATH prepends only the
cook-owned `.cook-engines/bin` directory containing bun/node symlinks, not the
engines' entire directories; unrelated executables keep their precedence.
Empty inherited PATH segments are removed for selected-engine builds. The
reserved `.cook-engines` directory is refreshed after confirmation and removed
when returning to legacy engines. Git acquisition retains the operator's PATH.
Arbitrary custom commands, npx, scripts' shebangs, and connector-specific
runtime requirements are not rewritten or independently qualified. No engines
are downloaded. Host build commands remain trusted operator-side code.

Refusals use distinct E_HOST_ENGINE_PATH, _EXEC, _VERSION, _REQUIREMENT and
_RANGE errors (the latter reports engine, observed version and required range).
Git failures identify the step using _INIT, _FETCH, _COMMIT, _PACKAGE, _CLONE or
_CHECKOUT. Raw subprocess output, URLs and executable paths are not included in
engine refusal diagnostics. Invalid output/requirements are not echoed.

Omitting both flags preserves legacy PATH-based behavior and does not load
host-engines or semver, including for cook --version from a source checkout
with pre-PR node_modules. Entering, changing, or leaving selected engines
invalidates all clone/build reuse; legacy-to-legacy reuse is unchanged. This is
not a frozen dependency closure or protection against replacing a binary or
retargeting a shim after installation. This feature is based on main and has
no held-candidate, private-file, manifest-export or env-allowlist dependency.
