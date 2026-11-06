# Exporting a systemd user unit

Add `--user-unit example.service` to an install with both `--bun-path` and
`--node-path` (see [engine preflight](host-engines.md)). Cook writes the unit
inside the installation, not in systemd's search path. The lock records its
absolute location as an operator hint; `cook run` still uses `run.sh`, not
systemd. Names must be plain non-template `.service` names, at most 255 bytes,
without paths or control characters. Invalid names or missing engine options
refuse before recipe resolution or prompts.

The unit invokes /bin/bash with the absolute run.sh and --headless. Literal
node/bun stdio commands use the validated absolute engine paths. With selected
engines, run.sh also prepends the cook-owned `.cook-engines/bin` to its runtime
PATH, so commands using `#!/usr/bin/env node` or bun find the selected engines.
It does not import the engines' sibling executables: custom commands such as
npx must themselves be installed and available on the user manager's inherited
PATH (or use an absolute command path). Those tools are not independently
validated, and explicit absolute shebangs/engine paths are not rewritten.

WorkingDirectory is the installation root, emitted as a bare path with only
systemd's percent specifiers escaped. Unit export refuses paths containing
ASCII control characters or ending in whitespace or a literal backslash (which can
continue the line onto ExecStart); explicit `--out` paths are checked before
recipe resolution, prompts or install writes. Quotes are not added.
Restart is on-failure with a five-second delay; UMask is 0077. The unit orders
after network-online.target but does not pull it in or prove network readiness.
Output streams are connected to the journal, but connectome-host's --headless
mode redirects its own stdout/stderr to `$DATA_DIR/headless.log`, so journalctl
may show little application output. Neither destination should contain secrets.

Only static export is performed: no enable, start, reload, account creation or
linger configuration occurs. After reviewing the generated files, the operator
may manually copy the unit to their user-unit directory and manage it themselves.
Keep the installation at its recorded absolute path and arrange a user
session/linger policy as needed. Export is not readiness or a handshake proof.

For operator-managed environment files, attach a systemd drop-in rather than a
new cook flag. For example, in `example.service.d/environment.conf` beside the
operator's installed unit:

```ini
[Service]
EnvironmentFile=/absolute/operator-managed/host.env
```

This is systemd environment-file syntax, not cook's `--env-file` or a shell
script. Cook does not read, copy, or manage that file. It must be readable by
the user manager; a root-only file cannot be read by an ordinary user manager.
A user unit is not a credential isolation boundary from an agent running under
the same UID. Do not assume this drop-in hides credentials from the agent.

Re-export restores the named unit's mode to 0600. A differently named earlier
export is deliberately retained: cook never removes units or changes installed
copies. Operators must review/remove obsolete exports and installed copies;
the lock's `launch.userUnit` hint records only the latest named export.
