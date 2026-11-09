# Cook-launched Git environment audit

Base: upstream main `71523662707317aaa4d4fe3ab38348d908140a7b`
(includes #6, #7, #10), merged into PR head `260f6da5` without rebasing.
The newer supplied main supersedes the earlier merge target; #10 is already
integrated, so no separate follow-up merge for #10 is outstanding.

Production launch sites on this revision (test-fixture subprocesses and Git
commands generated for Docker/container execution are not cook-launched Git):

| Site | Purpose and environment |
| --- | --- |
| `src/pin-refs.ts:45` | ls-remote; sourceGitEnvironment |
| `src/backends/host.ts:309` | async clone/fetch/checkout via PinnedCommands; sourceGitEnvironment |
| `src/backends/host.ts:310` | synchronous clone/fetch/checkout; same source environment |
| `src/backends/host.ts:330` | inspected-source clone and set-url; same source environment |
| `src/backends/host.ts:347` | inspected commit checkout; same source environment |
| `src/backends/host.ts:363` | remove synthetic branch; same source environment |
| `src/backends/host.ts:364` | remove synthetic remote ref; same source environment |
| `src/backends/host.ts:370` | async rev-parse HEAD via PinnedCommands; same source environment |
| `src/backends/host.ts:371` | synchronous rev-parse HEAD; same source environment |
| `src/host-engines.ts:70` | init/fetch/ls-remote/rev-parse/show/update-ref; gitEnvironment, plus LC_ALL=C |
| `src/host-dependency.ts:249` | init/remote/fetch/rev-parse/show through PinnedCommands; gitEnvironment |
| `src/process-env.ts:127` | authSecret Git-version preflight; curated Git environment before injecting auth |
| `src/pinned-commands.ts:12` | underlying generic spawn; Git callers above supply curated env; default Git env is gitEnvironment, other commands default to processAllowlistEnv |

`repositoryIndependentGitEnv` is now a pure environment transformation: it strips
the GIT_ namespace before the supported operator Git channels are restored, and
before source auth is injected. It no longer launches an introspection command.
No post-injection stripping can remove COUNT/KEY/VALUE. A real-Git regression
reads the injected header and verifies that the final redirect setting wins over
forwarded indexed configuration.

#10 integration: PinnedCommands no longer defaults to process.env. Dependency
and engine preflight receive the Git model with recipe-secret exclusions. Pinned
builds receive processAllowlistEnv, preserving the selected-engine PATH prefix.
The engine version probes also use the build allowlist. Integration tests inspect
all Git launches for each path and verify both build environments.

#14 integration requirement (not implemented here): pass gitEnvironment with
knownSecretEnvironmentNames(plan) to its new reconcile rev-parse. If using a
source-specific environment, do not run repositoryIndependentGitEnv afterward.
The lock/runtime persistence changes in that PR are deliberately not included.

Focused mutation gates can be repeated serially with:

```
python3 test/pr11-mutations.py R1-1
python3 test/pr11-mutations.py R1-2-public
python3 test/pr11-mutations.py R1-2-redaction
python3 test/pr11-mutations.py R1-4
```

Each restores the original source bytes in a finally block and succeeds only
when an assertion kills the mutation. Never run mutations alongside other tests.
