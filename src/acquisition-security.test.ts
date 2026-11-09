import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertCredentialFreeSourceUrl } from './source-url.js';

const CLI = resolve(import.meta.dir, '../bin/cook');
const SECRET = 'synthetic-acquisition-secret';
const SHA = 'a'.repeat(40);
let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cook-acquisition-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // Record argv and persist clone URLs just as git would. No network access.
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, 'git-argv'))}, JSON.stringify(args) + '\\n');
appendFileSync(${JSON.stringify(join(dir, 'git-env'))}, JSON.stringify({ args, env: process.env }) + '\\n');
const behavior = JSON.parse(readFileSync(${JSON.stringify(join(dir, 'git-behavior.json'))}, 'utf-8'));
const sslBypass = args[0] === '-c' && args[1] === 'http.sslVerify=false';
if (sslBypass) args.splice(0, 2);
if (args[0] === 'ls-remote') {
  if (behavior.requireSsl && args[1] === behavior.requireSsl && !sslBypass) process.exit(1);
  if (args[1] === behavior.missing) { console.error('old diagnostic 1\\nold diagnostic 2\\nfatal: TLS handshake failed\\ncheck the custom CA\\nremote unavailable'); process.exit(1); }
  if (args[1] === behavior.empty) process.exit(0);
  console.log('${SHA}\\t' + args[2]);
} else if (args[0] === 'clone') {
  mkdirSync(join(args[2], '.git'), { recursive: true });
  writeFileSync(join(args[2], '.git/config'), '[remote "origin"]\\nurl = ' + args[1]);
} else if (args[0] === 'rev-parse') {
  console.log('${SHA}');
}
`, { mode: 0o755 });
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\n/usr/bin/env > install-env.txt\n', { mode: 0o755 });
  env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    TMPDIR: dir,
    COOK_TEST_SECRET: SECRET,
    ANTHROPIC_API_KEY: SECRET,
    GIT_TOKEN: SECRET,
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(command: string, source: Record<string, unknown> | undefined, flags: string[] = [], extension = false) {
  writeFileSync(join(dir, 'git-behavior.json'), JSON.stringify({
    missing: env.FAKE_MISSING_URL, empty: env.FAKE_EMPTY_URL, requireSsl: env.FAKE_REQUIRE_SSL,
  }));
  const recipe = join(dir, 'recipe.json');
  writeFileSync(recipe, JSON.stringify({
    name: 'Security fixture',
    agent: { systemPrompt: 'test' },
    requirements: { sdk: { exposeAs: 'SDK_ROOT', probe: [dir] } },
    ...(source ? extension
      ? { extensions: { fixture: { kind: 'module', path: './index.ts', source } } }
      : { mcpServers: { fixture: { command: 'node', args: ['index.js'], source } } }
      : {}),
  }));
  return spawnSync(process.execPath, [CLI, command, recipe, '--no-prompts', '--yes', '--out', join(dir, 'out'), ...flags], {
    env, encoding: 'utf-8',
  });
}

function gitCalls(): string {
  const path = join(dir, 'git-argv');
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

for (const command of ['build', 'install']) {
  for (const missing of ['component', 'host']) {
    test(`${command}: unresolved ${missing} pin refuses before materialization`, () => {
      env.FAKE_MISSING_URL = missing === 'component'
        ? 'https://example.invalid/component.git'
        : 'https://github.com/anima-research/connectome-host.git';
      const result = run(command, { url: 'https://example.invalid/component.git' }, ['--pin-refs']);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('could not resolve');
      expect(existsSync(join(dir, 'out'))).toBe(false);
      expect(gitCalls()).not.toContain('clone');
    });
  }

  for (const extension of [false, true]) {
    test(`${command}: credentialed ${extension ? 'extension' : 'MCP'} URLs never reach git or artifacts`, () => {
      const result = run(command, { url: `https://user:${SECRET}@example.invalid/repo.git` }, ['--pin-refs'], extension);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).not.toContain(SECRET);
      expect(result.stdout + result.stderr).toContain('credentials');
      expect(result.stdout + result.stderr).toContain(
        `${join(dir, 'recipe.json')} :: ${extension ? 'extensions' : 'mcpServers'}.fixture.source.url`,
      );
      expect(gitCalls()).toBe('');
      expect(existsSync(join(dir, 'out'))).toBe(false);
    });
  }
}

test('credentialed connectome-host URL is rejected before pinning', () => {
  const result = run('install', undefined, ['--pin-refs', '--ch-repo', `https://user:${SECRET}@example.invalid/host.git`]);
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).not.toContain(SECRET);
  expect(gitCalls()).toBe('');
  expect(result.stdout + result.stderr).toContain('--ch-repo');
  expect(existsSync(join(dir, 'out'))).toBe(false);
});

test('private symbolic pins cannot silently fall back to unpinned builds', () => {
  const result = run('build', { url: 'https://example.invalid/private.git', authSecret: 'GIT_TOKEN' }, ['--pin-refs']);
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).not.toContain(SECRET);
  expect(existsSync(join(dir, 'out'))).toBe(false);
  expect(gitCalls()).toBe('');
});

test('URL checks allow public transports and reject credential-bearing forms without echoing them', () => {
  for (const url of [
    'https://example.invalid/repo.git', 'http://example.invalid/repo.git',
    'ssh://git@example.invalid/repo.git', 'git@example.invalid:repo.git',
    'file:///tmp/repo', '/tmp/repo',
    'https://user@example.invalid/repo.git',
  ]) {
    expect(() => assertCredentialFreeSourceUrl(url)).not.toThrow();
  }
  for (const url of [
    `https://${SECRET}:@example.invalid/repo.git`,
    `https://user%3A${SECRET}@example.invalid/repo.git`,
    `oauth2:${SECRET}@example.invalid:repo.git`,
    `ssh://git:${SECRET}@example.invalid/repo.git`,
    `https://${SECRET}@`,
  ]) {
    expect(() => assertCredentialFreeSourceUrl(url)).toThrow('credentials');
    try {
      assertCredentialFreeSourceUrl(url);
    } catch (err) {
      expect(String(err)).not.toContain(SECRET);
    }
  }
});

for (const command of ['build', 'install']) {
  test(`${command}: an unknown ref leaves existing output untouched`, () => {
    env.FAKE_EMPTY_URL = 'https://example.invalid/component.git';
    const out = join(dir, 'out');
    mkdirSync(out);
    writeFileSync(join(out, 'connectome.lock'), 'existing lock');
    const result = run(command, { url: env.FAKE_EMPTY_URL, ref: 'missing' }, ['--pin-refs']);
    expect(result.status).not.toBe(0);
    expect(gitCalls()).not.toContain('clone');
    expect(readFileSync(join(out, 'connectome.lock'), 'utf-8')).toBe('existing lock');
    expect(existsSync(join(out, 'recipes'))).toBe(false);
  });
}

for (const extension of [false, true]) {
  test(`credential-like query parameters report the ${extension ? 'extension' : 'MCP'} location safely`, () => {
    const result = run('build', { url: `https://user@example.invalid/repo.git?access_token=${SECRET}` }, [], extension);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      `${join(dir, 'recipe.json')} :: ${extension ? 'extensions' : 'mcpServers'}.fixture.source.url`,
    );
    expect(result.stdout + result.stderr).not.toContain(SECRET);
    expect(result.stdout + result.stderr).not.toContain('https://');
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });
}

test('bare HTTPS usernames survive a host install with the expected path', () => {
  const url = 'https://user@example.invalid/component.git';
  const result = run('install', { url });
  expect(result.status).toBe(0);
  expect(gitCalls()).toContain(url);
  expect(readFileSync(join(dir, 'out/component/.git/config'), 'utf-8')).toContain(url);
});

test('all query strings and fragments are rejected before path derivation', () => {
  for (const name of ['token', 'access_token', 'password', 'secret', 'key', 'auth', 'sig',
    'apiKey', 'Authorization', 'x-amz-signature', 'client_secret', '%74oken', 'pat', 'ref', 'depth']) {
    expect(() => assertCredentialFreeSourceUrl(`https://example.invalid/repo.git?${name}=${SECRET}`))
      .toThrow('query strings and fragments');
  }
  for (const url of ['https://example.invalid/repo.git', 'git@example.invalid:repo.git', '/tmp/repo', './repo']) {
    for (const suffix of ['?', '?x', '#', '#readme']) {
      expect(() => assertCredentialFreeSourceUrl(`${url}${suffix}`))
        .toThrow('query strings and fragments');
    }
  }
});

test('malformed percent-encoding in userinfo reports an invalid source URL', () => {
  expect(() => assertCredentialFreeSourceUrl('https://user%name@host/repo.git'))
    .toThrow('Source URL: invalid source URL; use a URL without embedded credentials.');
});

const TOKEN_USERNAMES = [
  ...['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'glpat-'].map((prefix) => `${prefix}${SECRET}`),
  'oauth2', 'x-access-token', 'x-token-auth',
];

test('known token-shaped usernames are rejected, including percent-encoded forms', () => {
  for (const username of TOKEN_USERNAMES) {
    for (const encoded of [username, `%${username.charCodeAt(0).toString(16)}${username.slice(1)}`]) {
      expect(() => assertCredentialFreeSourceUrl(`https://${encoded}@example.invalid/repo.git`))
        .toThrow('credentials');
    }
  }
});

for (const command of ['build', 'install']) {
  test(`${command}: token-shaped usernames never reach logs, git or artifacts`, () => {
    const result = run(command, { url: `https://ghp_${SECRET}@example.invalid/repo.git` }, ['--pin-refs']);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain(SECRET);
    expect(result.stdout + result.stderr).toContain('mcpServers.fixture.source.url');
    expect(gitCalls()).toBe('');
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });

  test(`${command}: query and fragment URLs cannot materialize malformed paths`, () => {
    for (const url of ['https://example.invalid/repo.git', 'git@example.invalid:repo.git', '/tmp/repo', './repo']) {
      for (const suffix of ['?ref=main&depth=1', '#readme']) {
        const result = run(command, { url: `${url}${suffix}` });
        expect(result.status).not.toBe(0);
        expect(result.stdout + result.stderr).toContain('query strings and fragments');
        expect(gitCalls()).toBe('');
        expect(existsSync(join(dir, 'out'))).toBe(false);
      }
    }
  });
}

for (const command of ['build', 'install', 'check']) {
  for (const prefix of [' ', '\t']) {
    for (const pin of [false, true]) {
      test(`${command}: whitespace-token URLs are rejected before use (prefix=${JSON.stringify(prefix)}, pin=${pin})`, () => {
        const result = run(command, { url: `${prefix}https://ghp_${SECRET}@example.invalid/repo.git` }, pin ? ['--pin-refs'] : []);
        expect(result.status).not.toBe(0);
        expect(result.stdout + result.stderr).not.toContain(SECRET);
        expect(result.stdout + result.stderr).toContain('mcpServers.fixture.source.url');
        expect(gitCalls()).toBe('');
        expect(existsSync(join(dir, 'out'))).toBe(false);
      });
    }
  }
}

test('source URL whitespace, ASCII controls and normalized token usernames are rejected safely', () => {
  for (const url of [
    'https://example.invalid/repo.git ', '\thttps://example.invalid/repo.git',
    ...Array.from({ length: 33 }, (_, i) => `https://example.invalid/repo${String.fromCharCode(i === 32 ? 127 : i)}.git`),
    `https:\\\\ghp_${SECRET}@example.invalid/repo.git`,
  ]) {
    expect(() => assertCredentialFreeSourceUrl(url, 'fixture source')).toThrow('fixture source');
    try { assertCredentialFreeSourceUrl(url); } catch (err) {
      expect(String(err)).not.toContain(SECRET);
      expect(String(err)).not.toContain('https:');
    }
  }
});

for (const command of ['build', 'install']) {
  test(`${command}: pin resolution honors sslBypass`, () => {
    env.FAKE_REQUIRE_SSL = 'https://example.invalid/component.git';
    const result = run(command, { url: env.FAKE_REQUIRE_SSL, sslBypass: true }, ['--pin-refs']);
    expect(result.status).toBe(0);
    expect(gitCalls()).toContain('["-c","http.sslVerify=false","ls-remote"');
    expect(readFileSync(join(dir, 'out/connectome.lock'), 'utf-8')).toContain(SHA);
  });
}

for (const extension of [false, true]) {
  test(`pin failures name the ${extension ? 'extension' : 'MCP'} source and omit git helper output`, () => {
    env.FAKE_MISSING_URL = 'https://example.invalid/component.git';
    const result = run('build', { url: env.FAKE_MISSING_URL }, ['--pin-refs'], extension);
    const output = result.stdout + result.stderr;
    expect(result.status).not.toBe(0);
    expect(output).toContain(`${join(dir, 'recipe.json')} :: ${extension ? 'extensions' : 'mcpServers'}.fixture.source`);
    expect(output).toContain('remote unreachable or refused (git ls-remote exit 1)');
    expect(output).not.toContain('TLS handshake failed');
    expect(output).not.toContain('check the custom CA');
    expect(output).not.toContain('remote unavailable');
    expect(output).not.toContain('old diagnostic');
    expect(output).not.toContain('ref not found');
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });
  test(`private symbolic pin errors name the ${extension ? 'extension' : 'MCP'} source`, () => {
    const result = run('build', { url: 'https://example.invalid/private.git', authSecret: 'GIT_TOKEN' }, ['--pin-refs'], extension);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(`${join(dir, 'recipe.json')} :: ${extension ? 'extensions' : 'mcpServers'}.fixture.source`);
    expect(result.stdout + result.stderr).toContain('authSecret');
    expect(gitCalls()).toBe('');
  });
}

test('a missing ref is distinguished from a failed remote and names the source', () => {
  env.FAKE_EMPTY_URL = 'https://example.invalid/component.git';
  const result = run('build', { url: env.FAKE_EMPTY_URL, ref: 'missing' }, ['--pin-refs']);
  const output = result.stdout + result.stderr;
  expect(result.status).not.toBe(0);
  expect(output).toContain('ref not found');
  expect(output).toContain('mcpServers.fixture.source');
  expect(output).not.toContain('remote unreachable or refused');
  expect(existsSync(join(dir, 'out'))).toBe(false);
});

for (const ref of ['dead', 'deadb', 'deadbe', 'deadbee', '20241105', 'a'.repeat(39)]) {
  test(`hex-looking symbolic ref ${ref} is resolved, not trusted`, () => {
    const result = run('build', { url: 'https://example.invalid/component.git', ref }, ['--pin-refs']);
    expect(result.status).toBe(0);
    expect(gitCalls()).toContain(`refs/heads/${ref}`);
    expect(readFileSync(join(dir, 'out/connectome.lock'), 'utf-8')).toContain(SHA);
  });
  test(`unresolvable hex-looking ref ${ref} fails closed`, () => {
    env.FAKE_EMPTY_URL = 'https://example.invalid/component.git';
    const result = run('build', { url: env.FAKE_EMPTY_URL, ref }, ['--pin-refs']);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(`'${ref}' looks like an abbreviated commit ID`);
    expect(result.stdout + result.stderr).toContain(`--pin-refs needs the full 40-hex ID (git rev-parse ${ref})`);
    expect(gitCalls()).toContain(`refs/heads/${ref}`);
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });
}

for (const ref of ['b'.repeat(40), 'B'.repeat(40), 'c'.repeat(64)]) {
  test(`full object ID (${ref.length} chars) can be trusted without remote resolution`, () => {
    const url = 'https://example.invalid/component.git';
    const result = run('build', { url, ref, authSecret: 'GIT_TOKEN' }, ['--pin-refs']);
    expect(result.status).toBe(0);
    expect(gitCalls()).not.toContain(url);
    expect(readFileSync(join(dir, 'out/connectome.lock'), 'utf-8')).toContain(ref.toLowerCase());
  });
}

for (const url of [
  'https://%20ghp_CANARY123@example.invalid/x.git',
  'https:// ghp_CANARY123@example.invalid/x.git',
  ...['\u00a0', '\u2028', '\ufeff'].map(space => `https://${space}ghp_CANARY123@example.invalid/x.git`),
  'https://%C2%A0ghp_CANARY123@example.invalid/x.git',
  '//ghp_CANARY123@example.invalid/x.git',
  'https:/\\ghp_CANARY123@example.invalid/x.git',
  'https:\\ghp_CANARY123@example.invalid/x.git',
  '//example.invalid/x.git',
]) {
  test(`R2-1: URL-shaped or whitespace userinfo input is rejected: ${JSON.stringify(url)}`, () => {
    expect(() => assertCredentialFreeSourceUrl(url, 'fixture source')).toThrow('fixture source');
    try { assertCredentialFreeSourceUrl(url); } catch (err) {
      expect(String(err)).not.toContain('CANARY123');
    }
  });
}

test('R2-1: cook build rejects encoded-space token canary without writing any output', () => {
  const result = run('build', { url: 'https://%20ghp_CANARY123@example.invalid/x.git' });
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).not.toContain('CANARY123');
  expect(gitCalls()).toBe('');
  expect(existsSync(join(dir, 'out'))).toBe(false);
});

test('R2-3: --ch-ref abbreviated commit failure explains the full-ID requirement', () => {
  env.FAKE_EMPTY_URL = 'https://example.invalid/host.git';
  const result = run('install', undefined, ['--pin-refs', '--ch-repo', env.FAKE_EMPTY_URL, '--ch-ref', 'deadbee']);
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("'deadbee' looks like an abbreviated commit ID");
  expect(result.stdout + result.stderr).toContain('--pin-refs needs the full 40-hex ID (git rev-parse deadbee)');
  expect(existsSync(join(dir, 'out'))).toBe(false);
});

for (const [command, customRepo] of [['build', false], ['install', false], ['install', true]] as const) {
  for (const failure of ['remote', 'ref']) {
    test(`R2-5: ${command} ${customRepo ? 'custom' : 'default'} host ${failure} error uses the repository label`, () => {
      const url = customRepo ? 'https://example.invalid/host.git'
        : 'https://github.com/anima-research/connectome-host.git';
      if (failure === 'remote') env.FAKE_MISSING_URL = url;
      else env.FAKE_EMPTY_URL = url;
      const result = run(command, undefined, ['--pin-refs', ...(customRepo ? ['--ch-repo', url] : [])]);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(`connectome-host (${url}):`);
      expect(result.stdout + result.stderr).not.toContain('--ch-repo (connectome-host)');
      expect(result.stdout + result.stderr).not.toContain('ref not found: connectome-host@');
      expect(existsSync(join(dir, 'out'))).toBe(false);
    });
  }
}

// Regressions for invisible characters, in literal and encoded userinfo.
for (const char of ['\u200b', '\u200c', '\u200d', '\u2060', '\ufeff', '\u180e', '\u00ad', '\u034f', '\u0085', '\u2029', '\u3000']) {
  for (const spelling of [char, encodeURIComponent(char)]) {
    for (const part of ['username', 'password']) {
      test(`R2-1: invisible userinfo ${char.codePointAt(0)!.toString(16)} ${spelling === char ? 'literal' : 'encoded'} ${part}`, () => {
        const userinfo = part === 'username' ? `${spelling}ghp_CANARY123` : `git:${spelling}ghp_CANARY123`;
        expect(() => assertCredentialFreeSourceUrl(`https://${userinfo}@example.invalid/x.git`)).toThrow('embedded credentials');
      });
    }
  }
}

for (const url of ['git@host:org/repo.git', 'ssh://git@host:22/x', 'ssh://git@[::1]:22/x', 'https://user@[::1]/x', 'user@host:org/repo.git', 'user@', 'file:///tmp/repo', '/tmp/repo', './local repo', 'https://user-name.1@host/x', 'https://host/x']) {
  test(`R2-1: legitimate source remains accepted: ${url}`, () => {
    expect(() => assertCredentialFreeSourceUrl(url)).not.toThrow();
  });
}

test('R2-1: cook build rejects encoded invisible token canary without any output', () => {
  const result = run('build', { url: 'https://%E2%80%8Bghp_CANARY123@example.invalid/x.git' });
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).not.toContain('CANARY123');
  expect(gitCalls()).toBe('');
  expect(existsSync(join(dir, 'out'))).toBe(false);
});

// Production CLI probe: start with a real artifact bundle, then ensure rejected
// URLs neither overwrite any artifact nor leave the canary in any output file.
test('R3 production probe: all reviewed bypasses leave every generated file canary-free and unchanged', () => {
  const out = join(dir, 'out');
  const files = (path: string): string[] => readdirSync(path, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]);
  const control = run('build', { url: 'https://user-name.1@example.invalid/x.git' });
  expect(control.status).toBe(0);
  const before = new Map(files(out).map(path => [path, readFileSync(path, 'utf-8')]));
  for (const name of ['Dockerfile', 'README.md', 'connectome.lock']) {
    expect(before.has(join(out, name))).toBe(true);
  }
  expect([...before.keys()].some(path => path.includes('/recipes/'))).toBe(true);
  const usernames = [
    ...['\u200b', '\u200c', '\u200d', '\u180e', '\ufeff', '\u0301', '\u0300', '\u20dd', 'ｇ', ' ', '\t']
      .flatMap(char => [char, encodeURIComponent(char)]).map(char => `${char}ghp_CANARY123`),
    'user-GhP_CANARY123', 'user-%67hp_CANARY123', 'ｇｈｐ_CANARY123', '%25ghp_CANARY123',
  ];
  for (const extension of [false, true]) {
    for (const username of usernames) {
      const result = run('build', { url: `https://${username}@example.invalid/x.git` }, [], extension);
      expect(result.stdout + result.stderr).not.toContain('CANARY123');
      expect(files(out).sort()).toEqual([...before.keys()].sort());
      for (const path of files(out)) {
        const contents = readFileSync(path, 'utf-8');
        expect(contents).not.toContain('CANARY123');
        expect(contents).toBe(before.get(path)!);
      }
      expect(result.status).not.toBe(0);
    }
  }
  expect(gitCalls()).toBe('');
  console.log(`R3 production probe: ${usernames.length * 2} refused builds; ${before.size} files checked per build; no canary or writes`);
});
