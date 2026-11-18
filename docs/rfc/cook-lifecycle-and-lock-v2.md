# RFC: one-shot materialisation and informational lock v2 inventory

Status: narrowed for PR #14 after R1. This supersedes the earlier RFC's claims
that every added field has a reconcile/deployment reader. README's lock v2
section documents the exact emitted schema and partial-input hash formula.

## Decision

Cook materialises a recipe into a directory and records it. Holding, activation,
health checks, rollback and secret-store policy belong outside cook. This PR
adds no reconcile machinery and assumes no deployment-layer consumer.

The concrete fix is removing **all requirement values** from lock writes,
including ordinary paths and values on v1 incomplete markers. Requirements
retain names, env names and origins. Credential files and `.env` keep their
existing behavior; neither their contents nor hashes belong in the lock.
Previously disclosed v1 values cannot be recalled by rewriting the file.

## Current readers versus inventory

`cook run` reads backend/launch hints. Host reuse uses URL, ref, install command,
optional requested commit and target existence, plus main's existing incomplete,
selected-engine and host-dependency safeguards. Those readers are retained.

The following new fields are **only informational**, with no current comparison
or startup consumer:

| Field | Actual meaning and limits |
|---|---|
| `cook.packageVersion` | package.json version only; not source/generator identity, often still 0.0.1 |
| `recipe.path`, `recipe.sha256` | path and loaded root UTF-8 JSON digest, not a reconcile change detector |
| `build.inputId`, `build.dir` | partial input hash and output directory, not build/content identity or cache key |
| `referencedVariables[]` | names only, including defaulted/nonsecret vars and both alternatives; not required credentials or a startup checklist |
| npm `components[]` | declared spec, exact version only if declared; unresolved tags/ranges; no registry lookup or current integrity data |
| `outputs[]` | generated public bytes' hashes and modes; declared sensitive files mode only; not disk drift checking |

Host records full Git checkout HEADs. Docker commits are optional without
`--pin-refs`; no ref is passed off as a commit. Host sibling-copy records from
main are retained with `kind: "copy"` and no commit. npm host inventory does not
claim global installation. Main's engine records, host dependency edits/pins,
incomplete markers and user-unit launch hint retain their established meaning.

### Partial input identity

`build.inputId` hashes canonical JSON of loaded recipe-tree hashes/relative
paths, sorted Git/copy/npm descriptors (including any known commits), backend,
package version, and the generation options `strict`,
`allowIncompleteTemplates`, plus Docker's optional `imageName`.
See README for the full formula. It does **not** cover local extension or
sibling-copy contents, local package.json presence, unpinned remote HEAD changes,
cook source changes at the same package version, selected engines, host
dependency archives, user-unit selection, answers, or output bytes. Different
builds may share it. Recipe literal secrets can produce guess-verifying hashes;
never put secrets literally in recipe JSON.

### Output sensitivity

Digest eligibility follows declared sensitivity, not searches for answers.
Public generated files have captured byte hashes; `.env`, credential/secret
files and rendered templates have only modes. Sensitive classification wins
on path overlap. Rotating an answer never changes digest omissions. These
records do not verify or protect disk writes against links/races.

## Compatibility and deferred work

Readers accept v1/v2 and refuse unknown versions. Successful materialisation,
including a fresh build/install, writes v2; not merely the "first reconcile".
An interrupted upgrade can leave a v1 incomplete marker without answers.
Writes use atomic same-directory rename. Unreadable host locks fail closed with
restore/fresh-directory recovery guidance, not automatic reinstall.

There are no new `layout`, `units`, `health` or external `state` contracts in
this PR. New consumers, complete build identities and structured required/
optional/alternative credentials require separate designs and review before
any deployment policy depends on them. No consumer should enforce the flat
referenced-variable inventory as a list of secrets it must provide.
