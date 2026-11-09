import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { sourceGitEnvironment, gitEnvironment } from './process-env.js';
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
    expect(env.GIT_CONFIG_COUNT).toBe('5');
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
