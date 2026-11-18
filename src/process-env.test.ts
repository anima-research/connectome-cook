import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { sourceGitEnvironment, gitEnvironment, processAllowlistEnv, privateGitFailureOutput } from './process-env.js';
import { PinnedCommands } from './pinned-commands.js';

function withEnvironment(values: NodeJS.ProcessEnv, body: () => void) {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, values);
    body();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test('R1-3: real Git retains injected COUNT/KEY/VALUE after repository stripping', () => {
  withEnvironment({ GIT_DIR: '/not/a/repository', COOK_PASS_ENV: 'GIT_DIR',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://example.invalid/repo.git.followRedirects', GIT_CONFIG_VALUE_0: 'true' }, () => {
    const token = 'synthetic-config-survival-token';
    const env = sourceGitEnvironment('https://example.invalid/repo.git', 'PRIVATE_TOKEN', { PRIVATE_TOKEN: token });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBe('7');
    const config = (key: string) => execFileSync('git', ['config', '--get', key], { env, encoding: 'utf8' }).trim();
    expect(config('http.https://example.invalid/.extraHeader')).toBe(`Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`);
    expect(config('http.followRedirects')).toBe('false');
    expect(config('http.https://example.invalid/.followRedirects')).toBe('false');
    expect(config('http.https://example.invalid/repo.git.followRedirects')).toBe('false');
    for (const url of ['https://example.invalid/repo.git', 'https://example.invalid/rewritten.git', 'https://other.invalid/repo.git']) {
      expect(execFileSync('git', ['config', '--get-urlmatch', 'http.followRedirects', url],
        { env, encoding: 'utf8' }).trim()).toBe('false');
    }
  });
});

test('R1-3: PinnedCommands defaults to the build allowlist, not process.env', async () => {
  const name = 'COOK_TEST_UNSELECTED_RUNTIME_SECRET';
  const saved = process.env[name];
  process.env[name] = 'synthetic-pinned-secret';
  try {
    const output = await new PinnedCommands().run(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], process.cwd());
    expect(JSON.parse(output)[name]).toBeUndefined();
    expect(gitEnvironment()[name]).toBeUndefined();
  } finally {
    if (saved === undefined) delete process.env[name]; else process.env[name] = saved;
  }
});


test('R2-1: private actions reset helpers after operator config and disable every prompt', () => {
  withEnvironment({ GIT_ASKPASS: '/operator/askpass', SSH_ASKPASS: '/operator/ssh-askpass',
    GIT_TERMINAL_PROMPT: '1', GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'store',
    GIT_CONFIG_KEY_1: 'core.askPass', GIT_CONFIG_VALUE_1: '/operator/config-askpass' }, () => {
    const env = sourceGitEnvironment('https://example.invalid/private.git', 'TOKEN', { TOKEN: 'synthetic' });
    expect(env.GIT_CONFIG_COUNT).toBe('8');
    expect(env.GIT_CONFIG_KEY_6).toBe('credential.helper');
    expect(env.GIT_CONFIG_VALUE_6).toBe('');
    const config = (env: NodeJS.ProcessEnv) => execFileSync('git', ['config', '--get', 'core.askPass'], { env, encoding: 'utf8' });
    expect(config(env)).toBe('\n');
    expect(config(gitEnvironment())).toBe('/operator/config-askpass\n');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.SSH_ASKPASS).toBeUndefined();
    expect(gitEnvironment().GIT_ASKPASS).toBe('/operator/askpass');
    expect(gitEnvironment().GIT_TERMINAL_PROMPT).toBe('1');
  });
});

test('R2-3: Git ignores build selection entirely, including invalid selectors', () => {
  withEnvironment({ COOK_PASS_ENV: 'PRIVATE_SDK', PRIVATE_SDK: 'build-only', GITHUB_TOKEN: 'helper-token' }, () => {
    expect(processAllowlistEnv().PRIVATE_SDK).toBe('build-only');
    expect(gitEnvironment().PRIVATE_SDK).toBeUndefined();
    expect(gitEnvironment().GITHUB_TOKEN).toBe('helper-token');
    process.env.COOK_PASS_ENV = 'TOKEN=not-a-name';
    expect(() => gitEnvironment()).not.toThrow();
  });
});

test('R2-5: preserve non-routing Git settings and enforce the operator protocol restriction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cook-protocol-'));
  try {
    execFileSync('git', ['init', '--bare', dir], { stdio: 'ignore' });
    const settings = { GIT_ALLOW_PROTOCOL: 'ssh', GIT_PROTOCOL_FROM_USER: '0',
      GIT_EXEC_PATH: execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(),
      GIT_SSL_NO_VERIFY: '1', GIT_PROXY_COMMAND: '/operator/proxy', GIT_HTTP_LOW_SPEED_LIMIT: '1',
      GIT_HTTP_LOW_SPEED_TIME: '60', GIT_DIR: '/wrong/repo', GIT_CONFIG_KEY_999: 'unused' };
    withEnvironment(settings, () => {
      const env = gitEnvironment();
      for (const [name, value] of Object.entries(settings)) {
        expect(env[name]).toBe(['GIT_DIR', 'GIT_CONFIG_KEY_999'].includes(name) ? undefined : value);
      }
      let diagnostic = '';
      try { execFileSync('git', ['ls-remote', dir], { env, stdio: 'pipe' }); }
      catch (error) { diagnostic = String((error as { stderr?: unknown }).stderr); }
      expect(diagnostic).toContain("transport 'file' not allowed");
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R2-6: private hints distinguish a rejected token, redirects and unrelated errors', () => {
  const rejected = privateGitFailureOutput({ stderr: "fatal: could not read Username for 'http://example.invalid': terminal prompts disabled" });
  expect(rejected).toContain('token rejected (HTTP 401)');
  expect(rejected).not.toContain('final URL');
  expect(privateGitFailureOutput({ stderr: 'fatal: unable to update url base from redirection' })).toContain('final URL in the recipe');
  for (const stderr of ['fatal: mismatched algorithms: client sha1; server sha256', 'fatal: missing ref', 'fatal: TLS failure']) {
    expect(privateGitFailureOutput({ stderr })).toBe(stderr);
  }
});

test('README compatibility wording matches the actual scope', () => {
  const readme = readFileSync(join(import.meta.dir, '../README.md'), 'utf8');
  expect(readme).toContain('instead of refusing them and requiring a full commit SHA');
  expect(readme).not.toContain('instead of warning and continuing unpinned');
});
