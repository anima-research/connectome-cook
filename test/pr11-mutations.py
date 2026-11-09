#!/usr/bin/env python3
"""Focused regression mutations. Run serially, never alongside other tests.

Each mutation must make its regression fail with an assertion, not a syntax or
startup error. Source bytes are restored even if the subprocess fails.
"""
import pathlib
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parent.parent
mutations = {
    'R1-1': ('src/process-env.ts', [
        ("env[`GIT_CONFIG_VALUE_${count + 1}`] = 'false';", "env[`GIT_CONFIG_VALUE_${count + 1}`] = 'true';"),
    ], ['src/git-auth-loopback.test.ts', '--test-name-pattern', 'cross-origin redirect']),
    'R1-2-public': ('src/backends/host.ts', [
        ("!action.authSecret, env)", "false, env)"),
        ("stdio: action.authSecret ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit']", "stdio: ['ignore', 'pipe', 'pipe']"),
        ("const output = gitFailureOutput(err, action.authSecret ? values[action.authSecret] : undefined);", "const output = '';"),
    ], ['src/acquisition-security.test.ts', '--test-name-pattern', 'public Git stderr remains visible']),
    'R1-2-redaction': ('src/process-env.ts', [
        ('if (token) {', 'if (false && token) {'),
    ], ['src/acquisition-security.test.ts', '--test-name-pattern', 'private clone errors']),
    'R1-4': ('src/backends/host.ts', [
        ('if (!canReuse(action)) {', 'if (true) {'),
    ], ['src/acquisition-security.test.ts', 'src/git-auth-loopback.test.ts', '--test-name-pattern', 'unchanged private checkout|real Git sends']),
}
name = sys.argv[1]
file, replacements, args = mutations[name]
path = root / file
original = path.read_bytes()
source = original.decode()
for old, new in replacements:
    assert source.count(old) == 1, (name, old, source.count(old))
    source = source.replace(old, new)
try:
    path.write_text(source)
    result = subprocess.run(['bun', 'test', *args], cwd=root, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    print(result.stdout)
    killed = result.returncode != 0 and '(fail)' in result.stdout and 'expect(' in result.stdout
    print(f'{name}: {"KILLED" if killed else "SURVIVED OR INVALID"}')
    sys.exit(0 if killed else 1)
finally:
    path.write_bytes(original)
