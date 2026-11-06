import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkEngine, preflightHostEngines } from './host-engines.js';

let dir: string, repo: string, bun: string, node: string, recipe: string, out: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cook-managed-'));
  repo = join(dir, 'source'); mkdirSync(repo);
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.org']);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'host-fixture', engines: { bun: '>=1.4.3', node: '>=22.12.0' } }));
  git(['add', 'package.json']); git(['commit', '-m', 'Fixture host']);
  bun = join(dir, 'bun'); node = join(dir, 'node');
  writeFileSync(bun, '#!/bin/sh\nif [ "$1" = --version ]; then echo 1.4.4; fi\n'); chmodSync(bun, 0o755);
  writeFileSync(node, '#!/bin/sh\necho v22.23.3\n'); chmodSync(node, 0o755);
  mkdirSync(join(dir, 'local')); writeFileSync(join(dir, 'local/fixture.js'), '// build-only fixture');
  recipe = join(dir, 'recipe.json'); out = join(dir, 'install');
  writeFileSync(recipe, JSON.stringify({ name: 'Fixture', agent: { systemPrompt: 'Test' }, mcpServers: { local: { command: 'node', args: ['fixture.js'] } } }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function install(extra: string[] = []) {
  return spawnSync(process.execPath, [resolve('bin/cook'), 'install', recipe, '--out', out, '--ch-repo', repo, '--ch-ref', 'main', '--no-prompts', '--yes', ...extra], { encoding: 'utf8' });
}
test('engine preflight checks selected source, pins commit, and records absolute engines through CLI', () => {
  const checked = preflightHostEngines(repo, 'main', bun, node);
  checked.cleanup();
  expect(checked.commit).toMatch(/^[a-f0-9]{40}$/);
  const result = install(['--bun-path', bun, '--node-path', node]);
  if (result.status) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
  const lock = JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8'));
  expect(lock.engines).toEqual(checked.engines);
  expect(lock.connectomeHost.commit).toBe(checked.commit);
  expect(readFileSync(join(out, 'run.sh'), 'utf8')).toContain("exec '" + bun + "'");
  const config = JSON.parse(readFileSync(join(out, 'recipes/recipe.json'), 'utf8'));
  expect(config.mcpServers.local.command).toBe(node);
});
test('engine refusals precede install directory creation', () => {
  for (const extra of [
    ['--bun-path', bun], ['--node-path', node],
    ['--bun-path', 'bun', '--node-path', node],
    ['--bun-path', bun, '--node-path', '/nonexistent/node'],
  ]) {
    expect(install(extra).status).not.toBe(0);
    expect(existsSync(out)).toBe(false);
  }
  writeFileSync(node, '#!/bin/sh\necho v20.0.0\n');
  expect(install(['--bun-path', bun, '--node-path', node]).status).not.toBe(0);
  expect(existsSync(out)).toBe(false);
});
test('invalid versions, ranges, permissions and missing engines fail closed', () => {
  for (const range of [undefined, '', 'not-a-range', '>=99']) expect(() => checkEngine(bun, range)).toThrow('E_HOST_ENGINE');
  writeFileSync(bun, '#!/bin/sh\necho bad\n');
  expect(() => checkEngine(bun, '*')).toThrow('E_HOST_ENGINE');
  chmodSync(bun, 0o600);
  expect(() => checkEngine(bun, '*')).toThrow('E_HOST_ENGINE');
  expect(() => preflightHostEngines(repo, 'missing', bun, node)).toThrow('E_HOST_ENGINE');
  writeFileSync(join(repo, 'package.json'), '{}');
  execFileSync('git', ['commit', '-am', 'Missing engines'], { cwd: repo, stdio: 'pipe' });
  expect(() => preflightHostEngines(repo, 'main', node, node)).toThrow('E_HOST_ENGINE');
});
test('CLI exports a headless private journal user unit without service calls', () => {
  const result = install(['--bun-path', bun, '--node-path', node, '--user-unit', 'example.service']);
  expect(result.status).toBe(0);
  const unit = readFileSync(join(out, 'example.service'), 'utf8');
  expect(unit).toContain('ExecStart=/bin/bash "' + join(out, 'run.sh') + '" --headless');
  expect(unit).toContain('WorkingDirectory=' + out);
  for (const required of ['Restart=on-failure', 'UMask=0077', 'StandardOutput=journal', 'StandardError=journal']) expect(unit).toContain(required);
  const lock = JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8'));
  expect(lock.launch.userUnit).toBe(join(out, 'example.service'));
});
test('unit export refuses unsafe names and missing selected engines without materializing', () => {
  expect(install(['--user-unit', 'example.service']).status).not.toBe(0);
  for (const name of ['../bad.service', 'bad\n.service', 'bad@.service', 'run.sh', '']) {
    expect(install(['--bun-path', bun, '--node-path', node, '--user-unit', name]).status).not.toBe(0);
    expect(existsSync(out)).toBe(false);
  }
});


test('R1-3/R1-6: invalid unit options fail before recipe loading or engine fetch', () => {
  rmSync(recipe);
  for (const extra of [
    ['--user-unit', 'example.service'],
    ['--bun-path', bun, '--node-path', node, '--user-unit', 'a'.repeat(248) + '.service'],
  ]) {
    const result = install(extra);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E_HOST_UNIT');
    expect(result.stderr).not.toContain('ENOENT');
    expect(existsSync(out)).toBe(false);
  }
  const missing = install(['--user-unit', 'example.service']);
  expect(missing.stderr).toContain('--bun-path');
  expect(missing.stderr).toContain('--node-path');
});

test('R1-2: CLI launcher binds env-node scripts via private engine PATH without importing engine siblings', () => {
  const tools = join(dir, 'tools'); mkdirSync(tools);
  const unselected = join(dir, 'unselected'); mkdirSync(unselected);
  // A non-literal stdio command found on the inherited PATH.
  writeFileSync(join(tools, 'npx'), '#!/usr/bin/env node\n', { mode: 0o755 });
  // Sibling executables of selected engines must not be imported into PATH.
  writeFileSync(join(dir, 'npx'), '#!/bin/sh\necho WRONG_SIBLING\n', { mode: 0o755 });
  writeFileSync(join(unselected, 'node'), '#!/bin/sh\necho WRONG_NODE\n', { mode: 0o755 });
  writeFileSync(node, '#!/bin/sh\nif [ "$1" = --version ]; then echo v22.23.3; else echo SELECTED_NODE; fi\n');
  writeFileSync(bun, '#!/bin/sh\nif [ "$1" = --version ]; then echo 1.4.4; elif [ "$1" = src/index.ts ]; then exec npx; fi\n');
  writeFileSync(recipe, JSON.stringify({ name: 'Fixture', agent: { systemPrompt: 'Test' }, mcpServers: { local: { command: 'npx', args: [] } } }));
  expect(install(['--bun-path', bun, '--node-path', node, '--user-unit', 'example.service']).status).toBe(0);
  const config = JSON.parse(readFileSync(join(out, 'recipes/recipe.json'), 'utf8'));
  expect(config.mcpServers.local.command).toBe('npx');
  const result = spawnSync('/bin/bash', [join(out, 'run.sh'), '--headless'], {
    encoding: 'utf8', env: { PATH: tools + ':' + unselected + ':/usr/bin:/bin' },
  });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('SELECTED_NODE');
});

test('R1 nits: repeated CLI export restores mode 0600 and retains differently named units', () => {
  const args = ['--bun-path', bun, '--node-path', node, '--user-unit', 'example.service'];
  expect(install(args).status).toBe(0);
  const unit = join(out, 'example.service');
  expect(statSync(unit).mode & 0o777).toBe(0o600);
  chmodSync(unit, 0o644);
  expect(install(args).status).toBe(0);
  expect(statSync(unit).mode & 0o777).toBe(0o600);
  args[args.length - 1] = 'renamed.service';
  expect(install(args).status).toBe(0);
  expect(existsSync(unit)).toBe(true);
  const lock = JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8'));
  expect(lock.launch.userUnit).toBe(join(out, 'renamed.service'));
});
