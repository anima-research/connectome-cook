import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectSources } from './source-detector.js';
import { validateRecipe, type Recipe } from './vendor/recipe.js';

const external = {
  source: { external: true },
  command: '/opt/node/bin/node',
  args: ['/opt/example/server.js', 'x', '--env-file=/opt/example/server.env', '--stdio', 'https://example.test/api'],
  env: { EXAMPLE_TOKEN: 'fixture-value' },
};

function recipe(mcpServers: Record<string, unknown>) {
  return { name: 'External server fixture', agent: { systemPrompt: 'Test' }, mcpServers };
}

test('external servers are not build sources, even under strict checking', () => {
  const path = '/fixture/recipe.json';
  const { source: _, ...unmarked } = external;
  const marked = [{ path, recipe: validateRecipe(recipe({ marked: external })) }];
  const mixed = [{ path, recipe: validateRecipe(recipe({ marked: external, unmarked })) }];
  for (const strict of [true, false]) expect(detectSources(marked, { strict })).toEqual([]);
  expect(() => detectSources(mixed, { strict: true })).toThrow(':: unmarked');
  expect(detectSources(mixed, { strict: false }).map(s => s.key)).toEqual(['sibling:unmarked']);
});

test('the marker must be the entire source block', () => {
  for (const source of [
    { external: false }, { external: 'true' }, { external: true, ref: 'main' },
    { external: true, url: 'https://example.test/server.git' }, { external: true, npm: 'server@1' },
  ]) {
    expect(() => validateRecipe(recipe({ server: { ...external, source } })))
      .toThrow('source.external must be exactly { "external": true }');
  }
});

test.each(['--repo=acme/widgets', 'application/json', '1/2', '.default'])(
  'accepts ordinary external server argument %s', (arg) => {
    const declared = validateRecipe(recipe({
      binary: { ...external, command: '/opt/example/server', args: [arg] },
      script: { ...external, args: ['--no-warnings', '/opt/example/server.js', arg] },
    }));
    for (const strict of [true, false]) {
      expect(detectSources([{ path: '/fixture/recipe.json', recipe: declared }], { strict })).toEqual([]);
    }
  },
);

test.each([
  { command: '/usr/bin/nodejs', args: ['--require', './preload.js', '--', '/opt/example/server.js', '--config=./config.json'] },
  { command: '/usr/bin/node', args: ['--disable-warning', 'ExperimentalWarning', '/opt/example/server.js'] },
  { command: '/usr/bin/bun', args: ['--bun', 'run', '--preload=./setup.ts', '/opt/example/server.ts', 'x'] },
  { command: '/usr/bin/deno', args: ['run', '--config', './deno.json', '/opt/example/server.ts', 'x'] },
  { command: '/usr/bin/python3.12', args: ['-W', 'ignore', '-m', 'example.server', 'application/json'] },
  { command: '/usr/bin/uv', args: ['run', '--offline', '/opt/example/server', 'tool', 'run'] },
])('accepts an installed interpreter entry point: %j', (launch) => {
  const declared = validateRecipe(recipe({ server: { ...external, ...launch } }));
  expect(detectSources([{ path: '/fixture/recipe.json', recipe: declared }], { strict: true })).toEqual([]);
});

test.each([
  [{ command: 'npx' }, 'matches a common fetch-runner command'],
  [{ command: '/usr/bin/npx' }, 'matches a common fetch-runner command'],
  [{ command: '/usr/local/bin/uvx' }, 'matches a common fetch-runner command'],
  [{ command: '/usr/bin/npm', args: ['exec', 'server'] }, 'matches a common fetch-runner command'],
  [{ command: '/opt/bin/pnpm', args: ['dlx', 'server'] }, 'matches a common fetch-runner command'],
  [{ command: '/opt/bin/yarn', args: ['dlx', 'server'] }, 'matches a common fetch-runner command'],
  [{ command: '/opt/bin/bunx' }, 'matches a common fetch-runner command'],
  [{ command: '/opt/bin/pipx' }, 'matches a common fetch-runner command'],
  [{ command: '/opt/bin/bun', args: ['x', 'server'] }, 'matches a common fetch-runner command'],
  [{ args: ['/usr/lib/npm/bin/npx-cli.js', 'server'] }, 'matches a common fetch-runner command'],
  [{ args: ['--no-warnings', 'npx-cli.js', 'server'] }, 'matches a common fetch-runner command'],
  [{ command: '/usr/bin/bun', args: ['--bun', 'x', 'server'] }, 'matches a common fetch-runner command'],
  [{ command: '/usr/bin/nodejs', args: ['/usr/lib/npm/bin/npx-cli.js', 'server'] }, 'matches a common fetch-runner command'],
  [{ command: '/usr/bin/uv', args: ['tool', 'run', 'server'] }, 'matches a common fetch-runner command'],
  [{ command: '/usr/bin/uv', args: ['--directory', '/opt/project', 'tool', 'run', 'server'] }, 'matches a common fetch-runner command'],
  [{ command: '/usr/bin/deno', args: ['x', 'server'] }, 'matches a common fetch-runner command'],
  [{ command: '/usr/bin/python3', args: ['-I', '-m', 'pipx', 'run', 'server'] }, 'matches a common fetch-runner command'],
  [{ command: 'node' }, 'command "node" must be a literal absolute path'],
  [{ command: '/opt/${NODE}/bin/node' }, 'command "/opt/${NODE}/bin/node" must be a literal absolute path'],
  [{ args: ['index.js'] }, 'script "index.js" must be a literal absolute path'],
  [{ command: '/usr/bin/node22', args: ['index.js'] }, 'script "index.js" must be a literal absolute path'],
  [{ command: '/usr/bin/nodejs', args: [] }, "interpreter 'nodejs' needs an installed script"],
  [{ command: '/usr/bin/nodejs', args: ['--require', '/opt/init.cjs', 'server'] }, 'script "server" must be a literal absolute path'],
  [{ args: ['/opt/${APP}/server.js'] }, 'script "/opt/${APP}/server.js" must be a literal absolute path'],
  [{ command: '/usr/bin/deno', args: ['run', '--quiet', 'https://example.test/server.ts'] }, 'must be a literal absolute path'],
  [{ args: [42] }, 'external args must be strings'],
  [{ command: undefined, url: 'ws://example.test/mcp' }, 'requires a stdio command'],
  [{ transport: 'websocket' }, 'requires a stdio command'],
] as const)('external operator-mistake check rejects %j', (override, message) => {
  const declared = recipe({ server: { ...external, ...override } }) as Recipe;
  for (const strict of [true, false]) {
    expect(() => detectSources([{ path: '/fixture/recipe.json', recipe: declared }], { strict })).toThrow(message);
  }
});

describe('external servers on the CLI', () => {
  let dir: string, path: string, out: string;
  const servers = { zebra: external, alpha: external };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cook-external-'));
    path = join(dir, 'recipe.json');
    out = join(dir, 'install');
    writeFileSync(path, JSON.stringify(recipe(servers)));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const env = () => ({
    PATH: dir + ':' + process.env.PATH, HOME: dir,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  });
  const cook = (verb: string, ...args: string[]) => spawnSync(
    process.execPath, [resolve('bin/cook'), verb, path, '--strict', '--no-prompts', ...args],
    { env: env(), encoding: 'utf8' },
  );

  test('check reports external declarations separately and describes the operator-mistake check', () => {
    const result = cook('check');
    expect(result.stderr + result.stdout).toContain('detected 0 MCP sources');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('alpha  (external: /opt/node/bin/node');
    expect(result.stdout).toContain('rejects common fetch-runner commands and relative entry points');
    expect(result.stdout).toContain('not a safety gate; unusual option orders can pass');
    expect(result.stdout + result.stderr).not.toContain('missing or not executable');
  });

  test('Docker refuses external servers without writing output', () => {
    const result = cook('build', '--out', out);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('marked source.external');
    expect(existsSync(out)).toBe(false);
  });

  test('Docker refuses a fleet child external server before prompting for a missing value', () => {
    writeFileSync(join(dir, 'child.json'), JSON.stringify(recipe({
      tools: { ...external, env: { EXAMPLE_TOKEN: '${COOK_TEST_MISSING_TOKEN}' } },
    })));
    writeFileSync(path, JSON.stringify({
      ...recipe({}), modules: { fleet: { children: [{ name: 'child', recipe: 'child.json' }] } },
    }));
    const result = spawnSync(process.execPath, [resolve('bin/cook'), 'build', path, '--out', out], {
      env: { ...env(), ANTHROPIC_API_KEY: 'fixture-key' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000,
    });
    expect(result.stdout + result.stderr).not.toContain('COOK_TEST_MISSING_TOKEN');
    expect(result.stderr).toContain('marked source.external (tools)');
    expect(result.status).toBe(2);
    expect(existsSync(out)).toBe(false);
  });

  test('Docker refuses external servers before --pin-refs invokes git', () => {
    const gitCalled = join(dir, 'git-called');
    writeFileSync(join(dir, 'git'), '#!/bin/sh\ntouch "$HOME/git-called"\nexit 1\n', { mode: 0o755 });
    const result = cook('build', '--pin-refs', '--out', out);
    expect(existsSync(gitCalled)).toBe(false);
    expect(result.stderr).toContain('marked source.external');
    expect(result.status).toBe(2);
    expect(existsSync(out)).toBe(false);
  });

  function installFixture() {
    const repo = join(dir, 'host');
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: env(), stdio: 'pipe' });
    git('init', '-b', 'main');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture');
    // No network package install.
    writeFileSync(join(dir, 'bun'), '#!/bin/sh\ntest "$*" = install\n', { mode: 0o755 });
    return cook('install', '--out', out, '--yes', '--ch-repo', repo, '--ch-ref', 'main');
  }

  test('host install keeps external launches unchanged and records each recipe filename', () => {
    writeFileSync(join(dir, 'child.json'), JSON.stringify(recipe({ alpha: external })));
    writeFileSync(path, JSON.stringify({
      ...recipe(servers), modules: { fleet: { children: [{ name: 'child', recipe: 'child.json' }] } },
    }));
    const install = installFixture();
    expect(install.stdout).toContain('External MCP servers');
    expect(install.status).toBe(0);
    expect(install.stdout).not.toContain('COPY');
    const lock = JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8'));
    expect(lock.version).toBe(1);
    expect(lock.components).toEqual([]);
    expect(lock.external).toEqual([
      { name: 'alpha', command: external.command, recipe: 'child.json' },
      { name: 'alpha', command: external.command, recipe: 'recipe.json' },
      { name: 'zebra', command: external.command, recipe: 'recipe.json' },
    ]);
    const shipped = JSON.parse(readFileSync(join(out, 'recipes', 'recipe.json'), 'utf8'));
    const { source, ...launch } = external;
    expect(shipped.mcpServers).toEqual({
      zebra: { ...launch, sourceMeta: source }, alpha: { ...launch, sourceMeta: source },
    });
  });

  test('host preview warns without failing for missing or non-executable commands and detected scripts', () => {
    const node = join(dir, 'node');
    const executable = join(dir, 'executable.js');
    const nonExecutable = join(dir, 'non-executable.js');
    const missing = join(dir, 'missing');
    for (const file of [node, executable]) writeFileSync(file, '', { mode: 0o755 });
    writeFileSync(nonExecutable, '', { mode: 0o644 });
    writeFileSync(path, JSON.stringify(recipe({
      missingCommand: { ...external, command: missing },
      nonExecutableCommand: { ...external, command: nonExecutable },
      missingScript: { ...external, command: node, args: ['--no-warnings', '--', missing] },
      nonExecutableScript: { ...external, command: node, args: [nonExecutable] },
      noWarning: { ...external, command: node, args: [executable, missing] },
    })));
    const install = installFixture();
    expect(install.status).toBe(0);
    expect(install.stdout).toContain(`warning: command "${missing}" is missing or not executable`);
    expect(install.stdout).toContain(`warning: command "${nonExecutable}" is missing or not executable`);
    expect(install.stdout).toContain(`warning: detected script "${missing}" is missing or not executable`);
    expect(install.stdout).toContain(`warning: detected script "${nonExecutable}" is missing or not executable`);
    expect(install.stdout.match(/is missing or not executable/g)).toHaveLength(4);
    expect(install.stdout).toContain('not a safety gate; unusual option orders can pass');
  });
});
