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
  { command: '/usr/bin/bun', args: ['--bun', 'run', '--preload=./setup.ts', '/opt/example/server.ts', 'x'] },
  { command: '/usr/bin/deno', args: ['run', '--config', './deno.json', '/opt/example/server.ts', 'x'] },
  { command: '/usr/bin/python3.12', args: ['-W', 'ignore', '-m', 'example.server', 'application/json'] },
  { command: '/usr/bin/uv', args: ['run', '--offline', '/opt/example/server', 'tool', 'run'] },
])('accepts an installed interpreter entry point: %j', (launch) => {
  const declared = validateRecipe(recipe({ server: { ...external, ...launch } }));
  expect(detectSources([{ path: '/fixture/recipe.json', recipe: declared }], { strict: true })).toEqual([]);
});

test.each([
  [{ command: 'npx' }, 'fetches at runtime'],
  [{ command: '/usr/bin/npx' }, 'fetches at runtime'],
  [{ command: '/usr/local/bin/uvx' }, 'fetches at runtime'],
  [{ command: '/usr/bin/npm', args: ['exec', 'server'] }, 'fetches at runtime'],
  [{ command: '/opt/bin/pnpm', args: ['dlx', 'server'] }, 'fetches at runtime'],
  [{ command: '/opt/bin/yarn', args: ['dlx', 'server'] }, 'fetches at runtime'],
  [{ command: '/opt/bin/bunx' }, 'fetches at runtime'],
  [{ command: '/opt/bin/pipx' }, 'fetches at runtime'],
  [{ command: '/opt/bin/bun', args: ['x', 'server'] }, 'fetches at runtime'],
  [{ args: ['/usr/lib/npm/bin/npx-cli.js', 'server'] }, 'fetches at runtime'],
  [{ args: ['--no-warnings', 'npx-cli.js', 'server'] }, 'fetches at runtime'],
  [{ command: '/usr/bin/bun', args: ['--bun', 'x', 'server'] }, 'fetches at runtime'],
  [{ command: '/usr/bin/nodejs', args: ['/usr/lib/npm/bin/npx-cli.js', 'server'] }, 'fetches at runtime'],
  [{ command: '/usr/bin/uv', args: ['tool', 'run', 'server'] }, 'fetches at runtime'],
  [{ command: '/usr/bin/uv', args: ['--directory', '/opt/project', 'tool', 'run', 'server'] }, 'fetches at runtime'],
  [{ command: '/usr/bin/deno', args: ['x', 'server'] }, 'fetches at runtime'],
  [{ command: '/usr/bin/python3', args: ['-I', '-m', 'pipx', 'run', 'server'] }, 'fetches at runtime'],
  [{ command: 'node' }, 'command "node" must be a literal absolute path'],
  [{ command: '/opt/${NODE}/bin/node' }, 'command "/opt/${NODE}/bin/node" must be a literal absolute path'],
  [{ args: ['index.js'] }, 'script "index.js" must be a literal absolute path'],
  [{ command: '/usr/bin/nodejs', args: [] }, "interpreter 'nodejs' needs an installed script"],
  [{ command: '/usr/bin/nodejs', args: ['--require', '/opt/init.cjs', 'server'] }, 'script "server" must be a literal absolute path'],
  [{ args: ['/opt/${APP}/server.js'] }, 'script "/opt/${APP}/server.js" must be a literal absolute path'],
  [{ command: '/usr/bin/deno', args: ['run', '--quiet', 'https://example.test/server.ts'] }, 'must be a literal absolute path'],
  [{ args: [42] }, 'external args must be strings'],
  [{ command: undefined, url: 'ws://example.test/mcp' }, 'requires a stdio command'],
  [{ transport: 'websocket' }, 'requires a stdio command'],
] as const)('rejects invalid external launches: %j', (override, message) => {
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

  test('check reports external servers separately from build sources', () => {
    const result = cook('check');
    expect(result.stderr + result.stdout).toContain('detected 0 MCP sources');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('alpha  (external: /opt/node/bin/node');
  });

  test('Docker refuses external servers without writing output', () => {
    const result = cook('build', '--out', out);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('marked source.external');
    expect(existsSync(out)).toBe(false);
  });

  test('host install keeps external launches unchanged and records only names and commands', () => {
    const repo = join(dir, 'host');
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: env(), stdio: 'pipe' });
    git('init', '-b', 'main');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture');
    // No network package install and no actual external server on disk.
    writeFileSync(join(dir, 'bun'), '#!/bin/sh\ntest "$*" = install\n', { mode: 0o755 });
    const install = cook('install', '--out', out, '--yes', '--ch-repo', repo, '--ch-ref', 'main');
    expect(install.stdout + install.stderr).toContain('External MCP servers used as installed');
    expect(install.status).toBe(0);
    expect(install.stdout).not.toContain('COPY');
    const lock = JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8'));
    expect(lock.version).toBe(1);
    expect(lock.components).toEqual([]);
    expect(lock.external).toEqual(['alpha', 'zebra'].map(name => ({ name, command: external.command })));
    const shipped = JSON.parse(readFileSync(join(out, 'recipes', 'recipe.json'), 'utf8'));
    const { source, ...launch } = external;
    expect(shipped.mcpServers).toEqual({
      zebra: { ...launch, sourceMeta: source }, alpha: { ...launch, sourceMeta: source },
    });
  });
});
