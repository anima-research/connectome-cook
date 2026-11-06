import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANARY = 'REVIEW_CANARY';

// Exercise the production catch path with real Git and the synthetic remote
// helper git-remote-review, not a credential helper or a mocked exec error.
// Credential-helper output reaches the same suppressed stdio. No sockets open.
function diagnostic(payload: string, fd = 2): string {
  const dir = mkdtempSync(join(tmpdir(), 'cook-pin-diagnostic-'));
  try {
    const quoted = `'${payload.replaceAll("'", "'\\''")}'`;
    writeFileSync(join(dir, 'git-remote-review'),
      `#!/bin/sh\nprintf '%s\\n' ${quoted} >&${fd}\nexit 1\n`, { mode: 0o700 });
    const result = spawnSync(process.execPath, ['-e', `
      import { resolveRemoteRef } from ${JSON.stringify(join(import.meta.dir, 'pin-refs.ts'))};
      try { resolveRemoteRef('review://example.invalid/repo.git', 'main', false, 'fixture.source'); }
      catch (err) { console.error(err.message); process.exit(1); }
    `], {
      encoding: 'utf-8',
      env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, XDG_CONFIG_HOME: dir,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    return result.stderr;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cases: [string, string, number][] = [
  ['stderr', `fatal: proxy https://user:${CANARY}@proxy.invalid rejected`, 2],
  ['stdout', `fatal: proxy https://user:${CANARY}@proxy.invalid rejected`, 1],
];

for (const [name, payload, fd] of cases) {
  test(`pin failure omits all helper output: ${name}`, () => {
    const message = diagnostic(payload, fd);
    expect(message).not.toContain(CANARY);
    expect(message).toBe('--pin-refs: fixture.source: could not resolve review://example.invalid/repo.git@main: remote unreachable or refused (git ls-remote exit 128); no output written. run `git ls-remote review://example.invalid/repo.git refs/heads/main` to see Git\'s diagnostics.\n');
  });
}
