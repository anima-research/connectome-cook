# connectome-cook

Recipes in, deployments out. A CLI that takes a [connectome-host](https://github.com/anima-research/connectome-host) recipe (single agent or multi-agent fleet) and materializes it — either as a runnable Docker artifact bundle (`cook build`) or as a direct install onto your machine (`cook install`), with all required MCP servers **and code extensions** baked in.

The pipeline is split in two: a backend-agnostic *resolution* step (walk the recipe tree, detect components, probe host requirements, collect env/credential values) produces an install plan; a backend materializes it. Every materialization writes a `connectome.lock` recording what was resolved, and `cook run` launches from the lock without re-resolving.

> **Status:** alpha. The core pipeline works — `cook init`, `cook check`, `cook build`, `cook install`, and `cook run` all do something useful, end-to-end against the in-repo Triumvirate example. Expect rough edges around `--json` reports and pip-editable arg overlays. Not yet on npm.

## Install

For now, clone + run via Bun:

```bash
git clone https://github.com/Tengro/connectome-cook.git
cd connectome-cook
bun install
./bin/cook --help
```

(npm publish + the standalone `cook` binary are tracked under Phase 4 polish; for now the bin shim runs Bun-on-source directly.)

## Usage

```bash
# Scaffold a starter recipe.
cook init "My Agent" --template minimal --out my-agent.json

# Validate it + see what cook would build.
cook check my-agent.json

# Generate the Docker artifact bundle (Dockerfile, compose, .env.example,
# README, recipes/).  Prompts for any required env vars unless --no-prompts.
cook build my-agent.json --pin-refs --out ./my-agent-cook

# Install directly onto this machine — no docker. Clones + builds every
# component under ~/.connectome/installs/<name>/, resolves host requirements
# (probe + confirm), writes run.sh + connectome.lock. The full action plan
# is printed and confirmed before anything executes on your machine.
cook install my-agent.json

# Launch. Finds an existing materialization (lock in the named dir, then
# ./<name>-cook, then ~/.connectome/installs/<name>) and launches it without
# re-resolving; falls back to build-then-compose-up (pinning is optional).
# --rebuild forces a re-cook.
cook run my-agent.json -- -d            # detached (docker) / launcher args (host)
cook run ~/.connectome/installs/my-agent # launch a materialized dir directly
```

The bin is also installed as **`connectome`** — `connectome cook <recipe>`,
`connectome install <recipe>`, `connectome run <recipe>` are the same commands.

### Extensions

Recipes can carry deployment-specific code — custom context-manager
strategies and agent-framework modules — via the `extensions` block
(connectome-host ≥ the `feat/recipe-extensions` seam):

```jsonc
{
  "agent": { "strategy": { "type": "zk", "floodWindowMs": 250 } },
  "extensions": {
    "zk-strategy": {
      "kind": "strategy",                      // or "module"
      "path": "./extensions/zk/index.ts",      // entry module
      "source": { "url": "https://github.com/you/zk-ext.git", "ref": "main" }
    }
  }
}
```

- **With `source`**: cook clones/builds it into `/app/extensions/<name>`
  (docker) or `<install>/app/extensions/<name>` (host); `path` is relative
  to the repo root. Same install patterns as MCP sources (`npm`,
  `pip-editable`, custom run commands, authSecret, systemPackages).
- **Without `source`, relative path**: cook bundles the entry file's
  directory from your disk (docker) or uses it in place (host).
- Extensions live under the connectome-host tree so they share its
  `node_modules` — `extends AutobiographicalStrategy` resolves against the
  exact versions the host ships.

### Host requirements (discovery)

For code that must link against things already on the machine:

```jsonc
"requirements": {
  "spring-engine": {
    "probe": ["/opt/spring", "~/spring", "$SPRING_HOME"],
    "prompt": "Path to your Spring engine install",
    "exposeAs": "SPRING_HOME"
  }
}
```

Cook probes the candidates, suggests the first hit, lets you confirm or
override, and exposes the answer as `$SPRING_HOME` — usable in recipe
`${VAR}` references and install steps. The lock records requirement names and
origins, never their resolved answers. **Secrets must not be literals in recipes;
supply them through requirements**, not literal defaults or template/environment
strings. `recipe.sha256` and `build.inputId` are computed from the recipe bytes as
written (including any literal secret), not a redacted recipe.

### Source credentials

Source URLs must not embed password/token userinfo. Bare usernames such as
`https://user-name.1@host/repo.git` are allowed for credential-helper account
selection. After percent-decoding, usernames must be non-empty and contain only
ASCII letters, digits, `.`, `_` and `-`. Any password component (even empty)
is refused. Known token prefixes (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`,
`github_pat_`, `glpat-`) are rejected anywhere in the decoded username, case-insensitively,
as are token usernames (`oauth2`, `x-access-token`, `x-token-auth`).
Protocol-relative (`//host/path`) spellings require an explicit scheme.
Query strings and fragments are unsupported and rejected: source path
derivation does not support these suffixes. This validation is not shell quoting
and does not make generated Docker commands safe for arbitrary URLs or refs.
Surrounding whitespace and ASCII control characters are also rejected. Unknown
token formats may not be recognized: never put credentials in a source URL.

### Sidecars in host mode

`cook install` supports recipes with sidecar `services` and
`containerTemplateFiles`: the agent process runs natively, but sidecars
(databases, wikis) run under docker via a generated
`docker-compose.sidecars.yml`. `run.sh` brings them up with
`docker compose up -d --wait` before exec'ing the agent, renders
runtime templates with `envsubst` (needs `gettext-base`), and honors
`COOK_SKIP_SIDECARS=1`. One networking caveat, warned about at install
time: the native agent reaches sidecars via their **published localhost
ports** — compose service names only resolve inside the docker network.

### Pinned builds

Docker `build` works without `--pin-refs`; unresolved commits are omitted,
not guessed. Add `--pin-refs` for immutable Git provenance.
`--pin-refs` (also optional on `install`) resolves every branch/tag ref —
components and connectome-host itself — to its current commit SHA via
`git ls-remote` at cook time. The SHA is baked into clone/checkout steps
(and the `CH_REF` build-arg default) and recorded in `connectome.lock`,
so rebuilding later reproduces the exact trees. Unresolvable refs (offline,
private repos) fail before any files are written or clones/builds start. Private
`authSecret` sources need an explicit full commit SHA when pinning. Only full
40-hex SHA-1 or 64-hex SHA-256 object IDs are trusted without remote lookup;
short hex strings are resolved as symbolic refs, like other branch/tag names.
Abbreviated commit IDs cannot be pinned: use the full 40-hex ID from
`git rev-parse <ref>` with `--pin-refs`.

### `connectome.lock` v2

The fix is removal of **all requirement answers**, secret or not, from the
lock. Requirements contain only `name`, `envName`, and `origin`. Resolution,
install environments and `.env` are unchanged. Old v1 records can already
contain secrets; rewriting cannot undo earlier disclosure.

Both backends write v2 on **successful materialisation**, including a build or
install into a fresh directory. Readers accept v1 and v2 and refuse unknown
versions. Host reconcile may keep matching checkouts and reads their actual
HEADs. Incomplete markers from main remain fail-closed and can still be written
in v1 during a failed upgrade (without requirement answers).

**The new v2 fields are informational inventory, not reconcile inputs.** No
current cook reader compares `cook`, `recipe.sha256`, `build`,
`referencedVariables`, `outputs`, or npm inventory entries. No deployment-layer
consumer is supplied or assumed. Changing these fields does not invalidate a
checkout; editing `run.sh` does not produce a drift refusal and the next install
can overwrite it. Host clone reuse still uses URL, ref, install command, an
optional requested commit, target existence, and main's incomplete/engine/host
dependency safeguards. `cook run` uses the existing backend/launch fields; it
is not output verification. See [the revised RFC](docs/rfc/cook-lifecycle-and-lock-v2.md).

Inventory fields:

- `cook: {packageVersion}` is only `package.json`'s version (currently `0.0.1`),
  **not** a cook source revision or generator fingerprint. No commit is guessed.
- `recipe: {path, sha256}` hashes the exact loaded UTF-8 root JSON, before
  validation/substitution. Programmatic walks without loaded text hash canonical
  recipe JSON. Git commits, when recorded, are full 40/64-hex SHAs. Host Git
  checkouts require actual HEADs; unpinned Docker refs can omit commits.
- `components` includes `kind: "git"` provenance and `kind: "npm"` entries
  (`key, role, name, spec, version?, integrity?`). npm tags/ranges remain
  unresolved; exact versions are recorded when declared. No registry lookup
  is added and **no integrity metadata is currently available**, so integrity
  is omitted. URL specs with embedded credentials are rejected. Host npm
  entries describe declarations, not globally installed packages; existing
  npx behavior is unchanged. Host sibling copies retain main's entries with
  `kind: "copy"`, target path, empty URL/ref and `install: "sibling-copy"`,
  without invented commits. Docker's copy behavior is unchanged.
- `build: {inputId, dir}` gives a **partial input ID**, not a build/content ID,
  and the absolute output directory. Its exact formula and omissions are below.
- `referencedVariables: string[]` is a sorted, deduplicated name inventory,
  **not required credentials**. It includes ordinary/defaulted runtime variables,
  both provider alternatives, requirement env names, build/sidecar secret names,
  and credential-file overrides (or `path#field`). It cannot tell a consumer
  which names are secret, required, optional, or alternatives; do **not** require
  every entry or treat it as a startup checklist. Values are never included.
- `outputs` inventories explicit generated paths, numeric permission bits
  (`mode & 0777`) and SHA-256 for declared public files: launcher, optional
  user unit, lowered recipes, Compose/Dockerfile and documentation. `.env`,
  credential/secret files and rendered templates have **mode only**. Eligibility
  comes from declared sensitivity, never a search for operator answers; rotating
  a value cannot change the pattern of omissions. Sensitive classification wins
  when paths overlap. Digests describe captured generated bytes **before the
  write**, not current disk content. There is no drift checking. Unavailable
  generated bytes get mode only. The lock, copied/cloned trees and operator
  state are not recursively hashed. Links and races can still redirect writes;
  use a fresh output directory, not an untrusted pre-seeded one.

**Input ID formula:**
`build.inputId = hex(SHA256(UTF8(canonicalJSON(input))))`, where `input` is
`{recipe: rootSha256, recipes: [{path, sha256}, ...],
pins: {connectomeHost: {url, ref, commit?}, components},
cook: {packageVersion}, backend, options}`. Canonical JSON sorts object keys
lexically, omits undefined object properties, retains array order, and has no
whitespace. Recipes retain walker order and use root-directory-relative paths
(URL trees use relative pathnames plus query strings); components sort by key.
Git/copy descriptors contain `kind,key,role,url,ref,commit?,install`, npm entries
contain `kind,key,role,name,spec,version?,integrity?`. Options are `strict`,
`allowIncompleteTemplates`, and Docker's optional `imageName`.

**Not hashed:** local extension contents or package.json presence, sibling-copy
contents, unpinned remote commit changes, cook generator/source changes under
the same package version, selected engine binaries, host dependency archives,
user-unit selection, resolved answers, output/check-out directories, timestamps,
other CLI flags, or install-script transitive dependencies. Even builds with
different generated bytes can share an input ID. An identical recipe tree moved
to another output directory keeps it. Never use it as a cache validity check,
unique deployment identity, or proof of reproducibility.

**Secret boundary:** never put secret literals in recipes or source specs; use
requirements/credential inputs instead. Recipe and partial-input hashes include
literal recipe bytes, so they can verify guesses about literal secrets. Public
outputs containing recipe literals are still public; there is no value scanner.

Main's `engines`, `hostDependencies`, incomplete markers and `launch.userUnit`
remain intact with their existing readers and semantics. No new layout, units,
health, activation or rollback machinery is added; `state` is omitted because
cook defines no separate state root outside `build.dir`.

Lock writes use a private same-directory temporary file plus atomic rename.
An unreadable/unknown host lock refuses reconcile with exit 2: restore a
known-good lock, or choose a fresh `--out` directory. Before moving a damaged
lock aside to reinstall in place, back up the install and recover the original
`--host-dependency` inputs: removing it loses their safety record.

### Templates

- `minimal` — single agent, no MCP servers, generic system prompt.
- `zulip-agent` — single agent staffing a Zulip channel.
- `triumvirate` — three-agent fleet (miner + reviewer + clerk) with conductor.

### Build flags

```
--out <dir>            Output directory (default: ./<recipe-name>-cook)
--strict               Fail if any MCP server lacks a `source` block
--image-name <name>    Override the generated image name
--no-prompts           Non-interactive; warn-and-continue on missing values
--env-file <path>      Read variable values from this file before prompting
--pin-refs             Optional: resolve full Git commit SHAs
```

### Anthropic credentials

A recipe tree whose agents all explicitly set `agent.provider` to `openai-codex` needs no implicit Anthropic credential. Trees containing an Anthropic agent, an omitted provider (which defaults to Anthropic), or an unknown provider retain the Anthropic requirement: either `ANTHROPIC_API_KEY` (a standard API key from [console.anthropic.com](https://console.anthropic.com/)) or `ANTHROPIC_AUTH_TOKEN` (a long-lived OAuth bearer token, sent by connectome-host as `Authorization: Bearer` instead of `x-api-key`). Cook's prompts, generated `.env.example`, and missing-value checks accept either — press Enter at the `ANTHROPIC_API_KEY` prompt to be offered the auth-token alternative. If both are set, connectome-host prefers the auth token. For every provider, when a recipe explicitly substitutes `${ANTHROPIC_API_KEY}` (or `${ANTHROPIC_AUTH_TOKEN}`) without a default, that exact name is required — connectome-host errors at startup on a missing `${VAR}` — so the other credential can't stand in for it. Default-valued references remain optional in Codex-only trees. Cook does not configure Codex authentication.

Host installs: [operator-selected engine preflight](docs/host-engines.md) and
[static systemd user-unit export](docs/host-user-unit.md).

## What gets generated

```
<outDir>/                    # cook build (docker backend)
├── Dockerfile               # multi-stage; one builder per source (MCP + extensions) + ch-deps + runtime
├── docker-compose.yml       # single service; bind mounts from workspace mounts
├── .env.example             # template for the Anthropic credential + recipe ${VAR}s
├── .env                     # only when prompts/env-file/process.env supplied values
├── README.md                # operator instructions, data-driven from the recipe
├── connectome.lock          # record of the materialization (components, requirements, launch)
├── extensions/              # local extension bundles (when declared)
└── recipes/
    └── <each-walked-recipe>.json    # lowered configurations (overlays applied, source → sourceMeta)

<installDir>/                # cook install (host backend)
├── app/                     # connectome-host checkout (bun install'd; extensions under app/extensions/)
├── <repo-basename>/         # MCP source checkouts (mirrors the container layout)
├── recipes/                 # lowered configurations with host-absolute paths
├── .env                     # shell-sourceable operator values (mode 0600)
├── run.sh                   # launcher: source .env, cd app, exec bun
└── connectome.lock
```

The build context for `docker build` is `<outDir>` itself — operators don't need to clone connectome-cook to build the resulting image.

## Repo layout

```
connectome-cook/
├── bin/
│   └── cook                     # the CLI shim (defers to src/cli.ts)
├── src/
│   ├── cli.ts                   # subcommand dispatch + flag parsing
│   ├── walker.ts                # load + traverse fleet children
│   ├── source-detector.ts       # collect + dedupe McpSource list
│   ├── env-collector.ts         # scan recipes for ${VAR} references
│   ├── prompts.ts               # interactive collection of missing values
│   ├── init.ts                  # cook init templates
│   ├── slug.ts                  # shared slugify helper
│   ├── runtimes/                # per-install-pattern Dockerfile fragments
│   │   └── {npm,pip,custom,index}.ts
│   ├── generators/              # one file per output artifact
│   │   └── {dockerfile,compose,overlay,env,readme}.ts
│   └── vendor/
│       └── recipe.ts            # vendored from connectome-host (re-sync periodically)
├── examples/
│   └── triumvirate/             # canonical hand-curated reference + cook test target
├── docs/
│   ├── DESIGN-NOTES.md          # lessons from building the hand-curated examples
│   └── BUILD-PLAN.md            # phased implementation plan
└── test/
    └── e2e.test.ts              # cook build → verify artifacts round-trip
```

## Why a separate repo

- **connectome-host** is the framework — code, modules, recipe loader. Stays focused on the runtime.
- **Recipe repos** declare what to run, not how to deploy it.
- **connectome-cook** is the bridge: takes any recipe, emits a deployable artifact bundle. Versioned and released independently.

## Future home

For now this lives in @Tengro's namespace. Once the CLI is meaningfully battle-tested against richer recipe trees (multi-source, BuildKit secrets, mixed install patterns), it'll be handed off to anima-research alongside connectome-host.

Host installs: [hash-pinned local dependency inputs](docs/host-dependency.md).
With `--host-dependency`, nested npm overrides (even unrelated ones) refuse
before install writes; disjoint flat overrides and resolutions remain supported.

## License

Apache 2.0. See [LICENSE](./LICENSE).
