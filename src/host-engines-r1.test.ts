import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as selected from './host-engines.js';

let dir: string, repo: string, bun: string, node: string, out: string, recipe: string;
const cleanups: Array<() => void> = [];
function script(path: string, body: string) { writeFileSync(path, '#!/bin/sh\n' + body + '\n'); chmodSync(path, 0o755); }
function git(...args: string[]) { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim(); }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cook-r1-')); repo = join(dir, 'repo'); mkdirSync(repo);
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ engines: { bun: '>=1.4.3', node: '>=22.12.0' } }));
  git('add', '.'); git('commit', '-m', 'fixture');
  bun = join(dir, 'bun'); node = join(dir, 'node'); out = join(dir, 'install'); recipe = join(dir, 'recipe.json');
  script(bun, 'if [ "$1" = --version ]; then echo 1.4.4; else echo built >> "$PWD/builds"; fi');
  script(node, 'echo v22.23.3');
  writeFileSync(recipe, JSON.stringify({ name: 'Fixture', agent: { systemPrompt: 'Test' } }));
});
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); rmSync(dir, { recursive: true, force: true }); });
function preflight(ref = 'main') {
  const checked = selected.preflightHostEngines(repo, ref, bun, node);
  cleanups.push(checked.cleanup);
  return checked;
}
function install(flags = true, env = process.env) {
  return spawnSync(process.execPath, [resolve('bin/cook'), 'install', recipe, '--out', out, '--ch-repo', repo, '--ch-ref', 'main', '--no-prompts', '--yes', ...(flags ? ['--bun-path', bun, '--node-path', node] : [])], { encoding: 'utf8', env });
}

test('R1 diagnostics: distinct safe path, execution, version and range errors', () => {
  expect(() => selected.checkEngine('relative', '*')).toThrow('E_HOST_ENGINE_PATH');
  expect(() => selected.checkEngine(join(dir, 'missing'), '*')).toThrow('not a readable executable file');
  expect(() => selected.checkEngine(dir, '*')).toThrow('E_HOST_ENGINE_PATH');
  chmodSync(bun, 0o600); expect(() => selected.checkEngine(bun, '*')).toThrow('E_HOST_ENGINE_PATH'); chmodSync(bun, 0o755);
  script(bun, 'echo SECRET_EXEC_OUTPUT >&2; exit 1');
  expect(() => selected.checkEngine(bun, '*')).toThrow('E_HOST_ENGINE_EXEC');
  expect(install().stderr).not.toContain('SECRET_EXEC_OUTPUT');
  script(bun, 'echo SECRET_VERSION_OUTPUT');
  expect(() => selected.checkEngine(bun, '*')).toThrow('E_HOST_ENGINE_VERSION: engine returned an invalid version');
  expect(install().stderr).not.toContain('SECRET_VERSION_OUTPUT');
  script(bun, 'echo 1.3.10');
  expect(() => selected.checkEngine(bun, '>=1.4.3')).toThrow('observed 1.3.10; required >=1.4.3');
  expect(() => selected.checkEngine(bun, 'SECRET_INVALID_RANGE')).toThrow('E_HOST_ENGINE_REQUIREMENT');
  const failed = install();
  expect(failed.stderr).toContain('bun observed 1.3.10; required >=1.4.3');
  expect(existsSync(out)).toBe(false);
  script(bun, 'echo 1.4.4'); script(node, 'echo v20.0.0');
  expect(install().stderr).toContain('E_HOST_ENGINE_RANGE: node observed 20.0.0; required >=22.12.0');
});

test('R1 git diagnostics: fetch, package and parse steps are safe and distinct', () => {
  expect(() => preflight('missing')).toThrow('E_HOST_ENGINE_FETCH: git fetch failed');
  const original = repo; repo = join(dir, 'SECRET_REPO');
  expect(() => preflight()).toThrow('E_HOST_ENGINE_FETCH: git fetch failed');
  expect(install().stderr).not.toContain('SECRET_REPO'); repo = original;
  rmSync(join(repo, 'package.json')); git('commit', '-am', 'missing');
  expect(() => preflight()).toThrow('E_HOST_ENGINE_PACKAGE: git show package.json failed');
  writeFileSync(join(repo, 'package.json'), 'SECRET_JSON'); git('add', '.'); git('commit', '-m', 'invalid');
  expect(() => preflight()).toThrow('E_HOST_ENGINE_PACKAGE: invalid package.json');
  writeFileSync(join(repo, 'package.json'), '{}'); git('commit', '-am', 'no ranges');
  expect(() => preflight()).toThrow('E_HOST_ENGINE_REQUIREMENT: bun requires a valid engines range');
});

test('R1 operator path: argv0-sensitive symlink is executed and both paths recorded', () => {
  const canonical = join(dir, 'dispatcher');
  script(canonical, 'case "$0" in */bun) echo 1.4.4;; *) exit 8;; esac');
  rmSync(bun); symlinkSync(canonical, bun);
  const checked = preflight();
  expect(checked.engines.bun).toEqual({ path: bun, realPath: canonical, version: '1.4.4' });
});

test('R1 prerelease: engines use npm includePrerelease semantics', () => {
  script(bun, 'echo 1.5.0-canary.1'); script(node, 'echo v23.0.0-rc.1');
  expect(preflight().engines.bun.version).toBe('1.5.0-canary.1');
});

test('R1 lazy loading: source CLI works with pre-PR node_modules and no semver', () => {
  const checkout = join(dir, 'checkout'); mkdirSync(checkout);
  // Copy current source (including fixes under test), but only legacy dependencies.
  execFileSync('cp', ['-r', resolve('bin'), resolve('src'), resolve('package.json'), checkout]);
  const modules = join(checkout, 'node_modules'); mkdirSync(modules);
  for (const dep of ['mri', 'picocolors', 'prompts', 'kleur', 'sisteransi']) {
    symlinkSync(resolve('node_modules', dep), join(modules, dep));
  }
  const result = spawnSync(process.execPath, [join(checkout, 'bin/cook'), '--version'], { encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
  expect(result.status).toBe(0); expect(result.stdout).toContain('connectome-cook 0.0.1');
});

for (const initial of [false, true]) test(`R1 reuse: transition ${initial ? 'selected to legacy' : 'legacy to selected'} rebuilds host and MCP`, () => {
  const mcp = join(dir, 'mcp'); mkdirSync(mcp); const mcpGit = (...args: string[]) => execFileSync('git', args, { cwd: mcp, stdio: 'pipe' });
  mcpGit('init', '-b', 'main'); mcpGit('config', 'user.name', 'Fixture'); mcpGit('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(mcp, 'file'), 'fixture'); mcpGit('add', '.'); mcpGit('commit', '-m', 'fixture');
  writeFileSync(recipe, JSON.stringify({ name: 'Fixture', agent: { systemPrompt: 'x' }, mcpServers: { fixture: { command: 'node', args: ['main.js'], source: { url: mcp, install: { kind: 'custom', run: 'echo built > build-marker', runtime: 'custom' } } } } }));
  const env = { ...process.env, PATH: dir + ':' + process.env.PATH };
  const first = install(initial, env); expect(first.status).toBe(0);
  writeFileSync(join(out, 'app', 'stale'), 'stale');
  const mcpTarget = join(out, 'mcp'); expect(existsSync(join(mcpTarget, 'build-marker'))).toBe(true); writeFileSync(join(mcpTarget, 'stale'), 'stale');
  const second = install(!initial, env); expect(second.status).toBe(0);
  expect(existsSync(join(out, 'app', 'stale'))).toBe(false); expect(existsSync(join(mcpTarget, 'stale'))).toBe(false);
  expect(existsSync(join(mcpTarget, 'build-marker'))).toBe(true);
  const third = install(!initial, env); expect(third.status).toBe(0); expect(third.stdout).toContain('unchanged');
});

test('R1 scratch reuse: exactly one source fetch and local materialization', () => {
  const tools = join(dir, 'tools'); mkdirSync(tools); const trace = join(dir, 'git.trace');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  script(join(tools, 'git'), `printf '%s\\n' "$*" >> '${trace}'\nexec '${realGit}' "$@"`);
  const result = install(true, { ...process.env, PATH: tools + ':' + process.env.PATH });
  expect(result.status).toBe(0);
  const lines = readFileSync(trace, 'utf8').split('\n').filter(line => line.includes(repo) && /^(fetch|clone|ls-remote) /.test(line));
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain('fetch');
});

test('R1 PATH: only bun and node exposed, unrelated tools retain precedence', () => {
  const tools = join(dir, 'tools'); mkdirSync(tools); script(join(tools, 'python3'), 'echo original');
  script(join(dir, 'python3'), 'echo shadow');
  // Ask the selected Bun build to inspect the real production build environment.
  script(bun, 'if [ "$1" = --version ]; then echo 1.4.4; else command -v bun > bun-path; command -v node > node-path; python3 > python-result; fi');
  const result = install(true, { ...process.env, PATH: tools + ':' + process.env.PATH }); expect(result.status).toBe(0);
  expect(readFileSync(join(out, 'app/python-result'), 'utf8').trim()).toBe('original');
  const bin = join(out, '.cook-engines/bin');
  expect(readdirSync(bin).sort()).toEqual(['bun', 'node']);
  expect(readFileSync(join(out, 'app/node-path'), 'utf8').trim()).toBe(join(bin, 'node'));
  expect(readFileSync(join(out, 'app/bun-path'), 'utf8').trim()).toBe(join(bin, 'bun'));
});

test('R1 role lookup: engine binding ignores clone array order', async () => {
  const host = await import('./backends/host.js');
  const actions = { clones: [
    { key: 'mcp', role: 'mcp' as const, url: repo, ref: 'main', target: '/mcp', buildCommand: 'make' },
    { key: 'host', role: 'connectome-host' as const, url: repo, ref: 'main', target: '/host', buildCommand: 'bun install' },
  ], copies: [], skipped: [], localExtensionPaths: new Map<string, string>() };
  host.bindHostEngine(actions, bun);
  expect(actions.clones[0]!.buildCommand).toBe('make');
  expect(actions.clones[1]!.buildCommand).toBe(`'${bun}' install`);
});

test('R1 pinned acquisition: --pin-refs does not look up the host twice', () => {
  const tools = join(dir, 'tools'); mkdirSync(tools); const trace = join(dir, 'git.trace');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  script(join(tools, 'git'), `printf '%s\\n' "$*" >> '${trace}'\nexec '${realGit}' "$@"`);
  const result = spawnSync(process.execPath, [resolve('bin/cook'), 'install', recipe, '--out', out, '--ch-repo', repo, '--ch-ref', 'main', '--pin-refs', '--no-prompts', '--yes', '--bun-path', bun, '--node-path', node], { encoding: 'utf8', env: { ...process.env, PATH: tools + ':' + process.env.PATH } });
  expect(result.status).toBe(0);
  const lines = readFileSync(trace, 'utf8').split('\n').filter(line => line.includes(repo) && /^(fetch|clone|ls-remote) /.test(line));
  expect(lines.length).toBe(1); expect(lines[0]).toContain('fetch');
});

for (const initial of [false, true]) test(`failed engine transition ${initial ? 'selected to legacy' : 'legacy to selected'} cannot reuse an old lock`, () => {
  const mcp = join(dir, 'mcp'); mkdirSync(mcp);
  execFileSync('git', ['init', '-b', 'main', mcp], { stdio: 'pipe' });
  execFileSync('git', ['-C', mcp, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'pipe' });
  const fail = join(dir, 'fail');
  writeFileSync(recipe, JSON.stringify({ name: 'Fixture', agent: { systemPrompt: 'x' }, mcpServers: { fixture: { command: 'node', source: { url: mcp, install: { kind: 'custom', run: `test ! -e '${fail}' && echo built > build-marker`, runtime: 'custom' } } } } }));
  // Distinguish the engines' installed dependency trees, not merely the launcher.
  const tools = join(dir, 'legacy-tools'); mkdirSync(tools);
  script(join(tools, 'bun'), 'echo legacy > engine-built');
  script(bun, 'if [ "$1" = --version ]; then echo 1.4.4; else echo selected > engine-built; fi');
  const env = { ...process.env, PATH: tools + ':' + process.env.PATH };
  expect(install(initial, env).status).toBe(0);
  writeFileSync(fail, 'fail');
  expect(install(!initial, env).status).toBe(3);
  expect(existsSync(join(out, 'connectome.lock'))).toBe(false);
  rmSync(fail);
  const retry = install(initial, env); expect(retry.status).toBe(0);
  expect(retry.stdout).not.toContain('unchanged');
  expect(readFileSync(join(out, 'app/engine-built'), 'utf8').trim()).toBe(initial ? 'selected' : 'legacy');
  expect(existsSync(join(out, '.cook-engines'))).toBe(initial);
});

