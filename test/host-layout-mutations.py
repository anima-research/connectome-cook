"""Offline, one-at-a-time R3 and merge-interaction mutations; always restore source."""
import os
from pathlib import Path
import subprocess

cases = [
    ('R3-1-variable-mount', 'src/host-layout.ts',
     r'if (/\$\{[^}]*\}/.test(mount.path))', 'if (false)',
     ['src/host-layout.test.ts', '--test-name-pattern', 'R3-1']),
    ('R3-2-relative-stdio', 'src/host-layout.ts',
     "if (value.startsWith('./') || value.startsWith('../'))", 'if (false)',
     ['src/host-layout.test.ts', '--test-name-pattern', 'R3-2']),
    ('R3-3-build-run-layout', 'src/cli.ts',
     "if (Object.hasOwn(flags, 'layout'))", 'if (false)',
     ['src/managed-host.test.ts', '--test-name-pattern', 'R3-3']),
    ('R3-4-foreign-owner', 'src/private-directory.ts',
     'const trustedOwner = ancestor.uid === 0 || ancestor.uid === process.geteuid!();', 'const trustedOwner = true;',
     ['src/host-layout.test.ts', '--test-name-pattern', 'R3-4']),
    ('R3-4-writable-ancestor', 'src/private-directory.ts',
     '((ancestor.mode & 0o022) && !(ancestor.mode & 0o1000))', 'false',
     ['src/host-layout.test.ts', '--test-name-pattern', 'R3-4']),
    ('R3-8-engine-reservation', 'src/backends/host.ts',
     r'|\.cook-engines|host-inputs', '|host-inputs',
     ['src/managed-host.test.ts', '--test-name-pattern', 'R3-8 refuses reserved code target .cook-engines']),
    ('R3-8-requested-unit', 'src/backends/host.ts',
     '...(options.userUnit !== undefined ? [resolve(installDir, options.userUnit)] : []),', '',
     ['src/managed-host.test.ts', '--test-name-pattern', 'R3-8 refuses reserved code target example.service']),
    ('R3-8-retained-unit', 'src/backends/host.ts',
     '...(previousUserUnit !== undefined ? [resolve(installDir, previousUserUnit)] : []),', '',
     ['src/managed-host.test.ts', '--test-name-pattern', 'R3-8 retained unit']),
    ('R3-8-action-boundary-alias', 'src/backends/host.ts',
     'function assertRuntimeCodeTarget(installDir: string, target: string, unitPaths: string[]): void {',
     'function assertRuntimeCodeTarget(installDir: string, target: string, unitPaths: string[]): void { return;',
     ['src/managed-host.test.ts', '--test-name-pattern', 'R3-8 real-path']),
    ('R3-9-raw-marker', 'src/backends/host.ts',
     "if (value?.phase !== 'installing' && value?.phase !== 'installed') throw new Error('invalid marker phase');", '',
     ['src/managed-host.test.ts', '--test-name-pattern', 'R3-9 refuses unreleased']),
    ('merge-private-incomplete', 'src/backends/host.ts',
     "if (layout) writeOutput(join(installDir, LOCKFILE_NAME), JSON.stringify({ ...existingLockOnDisk, incomplete: true }, null, 2) + '\\n');",
     'if (layout) writeLockfile(installDir, { ...existingLockOnDisk, incomplete: true });',
     ['src/managed-host.test.ts', '--test-name-pattern', 'merge interaction: reusable split']),
    ('merge-dependency-provision-order', 'src/backends/host.ts',
     '    provisionLayout(layout);', '    dependencies?.materialize();\n    provisionLayout(layout);',
     ['src/host-dependency.test.ts', '--test-name-pattern', 'merge dependency interaction: split roots']),
    ('merge-retained-input-reservation', 'src/backends/host.ts',
     r'|host-inputs)(?:', ')(?:',
     ['src/managed-host.test.ts', '--test-name-pattern', 'merge dependency interaction: split reserves']),
]
logs = Path(os.environ.get('ORGASMIC_EVIDENCE_DIR', '.cache')) / 'mutations'
logs.mkdir(parents=True, exist_ok=True)
for name, filename, before, after, args in cases:
    path = Path(filename)
    original = path.read_text()
    assert original.count(before) == 1, (name, original.count(before))
    mutated = original.replace(before, after)
    if name == 'R3-3-build-run-layout':
        mutated = mutated.replace("if (Object.hasOwn(runFlags, 'layout'))", 'if (false)')
    try:
        path.write_text(mutated)
        result = subprocess.run(['bun', 'test', *args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
        (logs / (name + '.log')).write_bytes(result.stdout)
        if result.returncode == 0 or b'(fail)' not in result.stdout:
            raise AssertionError(f'{name}: not killed by test assertions (exit {result.returncode})')
        print(f'{name}: KILLED', flush=True)
    finally:
        path.write_text(original)
print(f'{len(cases)}/{len(cases)} applicable R3/interaction mutations killed; source restored')
