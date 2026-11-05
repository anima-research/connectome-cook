import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANARY = 'REVIEW_CANARY';

// Exercise the production catch path with real Git and a synthetic remote
// helper, not a mocked exec error. The helper never opens a socket.
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

const cases: [string, string, number?][] = [
  ['https', `fatal: proxy https://user:${CANARY}@proxy.invalid rejected`],
  ...['ssh', 'git+https', 'socks5'].map((scheme) => [scheme, `fatal: proxy ${scheme}://user:${CANARY}@proxy.invalid rejected`] as [string, string]),
  ['ipv6', `fatal: proxy socks5://user:${CANARY}@[::1]:1080 rejected`],
  ['encoded-user', `fatal: proxy https://user:%52EVIEW_CANARY@proxy.invalid rejected`],
  ['encoded-host', `fatal: proxy https://user:${CANARY}@%65xample.invalid rejected`],
  ['bare-userpass', `fatal: proxy user:${CANARY}@proxy.invalid rejected`],
  ['schemeless', `fatal: proxy //user:${CANARY}@proxy.invalid rejected`],
  ['split-url', `fatal: proxy https://user:\n${CANARY}@proxy.invalid rejected`],
  ['split-three-line-cap', `fatal: proxy https://user:\n${CANARY}@proxy.invalid rejected\nTLS handshake failed\ncheck CA file`],
  ['before-line-cap', `https://user:${CANARY}@proxy.invalid\none\ntwo\nthree`],
  ['after-line-cap', `one\ntwo\nthree\nhttps://user:${CANARY}@proxy.invalid rejected`],
  ['long-userinfo', `fatal: proxy https://user:${CANARY}${'x'.repeat(900)}@proxy.invalid rejected`],
  ['clip-boundary', `${'x'.repeat(900)} https://user:${CANARY}@proxy.invalid rejected`],
  ['long-safe', `old\n${'a'.repeat(300)}\n${'b'.repeat(300)}\n${'c'.repeat(300)}`],
  ['header', `fatal: Authorization: Bearer ${CANARY}`],
  ['token', `fatal: ghp_${CANARY}`],
  ['ordinary', 'fatal: TLS handshake failed\ncheck custom CA file'],
  ['stdout-url', `fatal: proxy https://user:${CANARY}@proxy.invalid rejected`, 1],
  ['stdout-bare', `fatal: proxy user:${CANARY}@proxy.invalid rejected`, 1],
];

for (const [name, payload, fd] of cases) {
  test(`pin failure omits all helper output: ${name}`, () => {
    const message = diagnostic(payload, fd);
    expect(message).not.toContain(CANARY);
    expect(message).toBe('--pin-refs: fixture.source: could not resolve review://example.invalid/repo.git@main: remote unreachable or refused (git ls-remote exit 128); no output written.\n');
  });
}
