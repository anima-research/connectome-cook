# Isolate acquisition and host build environments

Host builds now receive an exact base environment allowlist plus parent values
explicitly named by `COOK_PASS_ENV`. Recipe values and resolved requirements are
not injected into build subprocesses. Git receives a separate curated channel
for existing authentication helpers, TLS, keyrings and indexed configuration.

Private HTTP(S) sources use an environment-only, origin-scoped Authorization
header with Git >= 2.31, never a credentialed URL or argv. Authenticated redirects
are disabled: use the final canonical repository URL in the recipe. URL-origin
normalization can differ from Git's matching and fails closed. Private Git error
diagnostics redact the known token and both base64 representations; public host
Git stderr is preserved. Unchanged private checkouts need no token on rerun.
GH_TOKEN/GITHUB_TOKEN exclusion collisions are reported with explicit opt-in or
rename guidance, rather than silently breaking helpers.

Merged current main, including engine selection and pinned host dependencies.
Their preflight Git calls, PinnedCommands and builds now use these same models.
The future reconcile Git probe must also use the curated Git environment.

Runtime artifacts deliberately retain main's semantics: `.env` may include
resolved authSecret values, and requirement values remain in the lock even when
the name is also an authSecret. COOK_PASS_ENV itself adds no persisted values.
This is accidental-exposure prevention, not a sandbox: builds can read local
files, tool configuration and, on Linux, the parent's environment through /proc.
Only opt credentials into trusted builds. Corporate TLS/keyrings and real
package installs remain operator validation risks.

Validation covers real loopback pin/clone/fetch, a two-origin smart-HTTP redirect,
unchanged private reruns, environment integration across upstream Git paths,
Git-version rejection, collision diagnostics, public errors and private redaction.
