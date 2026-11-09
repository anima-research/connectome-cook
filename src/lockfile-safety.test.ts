import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import golden from './fixtures/lockfile-v1-artifacts.json' with { type: 'json' };
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LOCKFILE_NAME, readLockfile, writeLockfile, type Lockfile } from './lockfile.js';

const CLI = resolve(import.meta.dir, '../bin/cook');
const ANSWER = 'synthetic-requirement-answer';
const TOKEN = 'synthetic-requirement-auth-secret';
let dir: string;
let out: string;
let recipe: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), 'cook-lock-safety-'));
  out = join(dir, 'out');
  recipe = join(dir, 'recipe.json');
  const bin = join(dir, 'bin');
  fs.mkdirSync(bin);
  // Entirely offline acquisition/build stand-ins. Record any attempted work.
  fs.writeFileSync(join(bin, 'git'), `#!${process.execPath}
import { appendFileSync, mkdirSync } from 'node:fs';
appendFileSync(${JSON.stringify(join(dir, 'commands'))}, 'git\\n');
const args = process.argv.slice(2);
if (args[0] === 'clone') mkdirSync(args[2], { recursive: true });
if (args[0] === 'rev-parse') console.log('${'a'.repeat(40)}');
`, { mode: 0o755 });
  fs.writeFileSync(join(bin, 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(recipe, JSON.stringify({
    name: 'Lock safety', agent: { provider: 'openai-codex', systemPrompt: 'Test' },
    requirements: {
      sdk: { exposeAs: 'SDK_ROOT' },
      token: { exposeAs: 'GIT_TOKEN' },
      optional: { required: false },
    },
    mcpServers: { fixture: { command: 'node', args: ['index.js'], source: {
      url: 'https://example.invalid/component.git', authSecret: 'GIT_TOKEN',
      install: { kind: 'custom', run: '', runtime: 'custom' },
    } } },
  }));
  fs.writeFileSync(join(dir, 'values.env'), `SDK_ROOT=${ANSWER}\nGIT_TOKEN=${TOKEN}\n`);
  env = { PATH: `${bin}:${process.env.PATH}`, HOME: dir };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function run(command: string, target = recipe) {
  return spawnSync(process.execPath, [CLI, command, target,
    '--out', out, '--no-prompts', '--yes', '--env-file', join(dir, 'values.env'),
  ], { env, encoding: 'utf8' });
}

for (const command of ['build', 'install']) {
  test(`${command}: answers including authSecret stay out of v1 locks and legacy values are rewritten`, () => {
    const result = run(command);
    expect(result.status).toBe(0);
    const lockPath = join(out, LOCKFILE_NAME);
    const text = fs.readFileSync(lockPath, 'utf8');
    expect(text).not.toContain(ANSWER);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('"value"');
    const lock = JSON.parse(text) as Lockfile;
    expect(lock.version).toBe(1);
    expect(lock.requirements).toEqual([
      { name: 'sdk', envName: 'SDK_ROOT', origin: 'env-file' },
      { name: 'token', envName: 'GIT_TOKEN', origin: 'env-file' },
      { name: 'optional', envName: 'OPTIONAL', origin: 'unresolved' },
    ]);
    expect(fs.readFileSync(join(out, '.env'), 'utf8')).toContain(TOKEN);
    if (command === 'build') expect(fs.readFileSync(join(out, 'GIT_TOKEN'), 'utf8')).toBe(TOKEN);
    lock.requirements[0]!.value = ANSWER;
    lock.requirements[1]!.value = TOKEN;
    fs.writeFileSync(lockPath, JSON.stringify(lock));
    if (command === 'install') fs.writeFileSync(join(out, 'app', 'workspace'), 'agent state');
    expect(run(command).status).toBe(0);
    expect(fs.readFileSync(lockPath, 'utf8')).not.toContain('"value"');
    if (command === 'install') expect(fs.readFileSync(join(out, 'app', 'workspace'), 'utf8')).toBe('agent state');
  });
}

for (const [label, content] of [
  ['unknown version', '{"version":99}'],
  ['truncated', '{"version":1,"backend":"host",'],
  ['unreadable directory', null],
] as const) {
  test(`install and run refuse ${label} locks without removing the agent workspace`, () => {
    fs.mkdirSync(join(out, 'app', 'workspace'), { recursive: true });
    const sentinel = join(out, 'app', 'workspace', 'agent-state');
    fs.writeFileSync(sentinel, 'must survive');
    const lockPath = join(out, LOCKFILE_NAME);
    if (content === null) fs.mkdirSync(lockPath);
    else fs.writeFileSync(lockPath, content);
    const result = run('install');
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('must survive');
    expect(fs.existsSync(join(dir, 'commands'))).toBe(false);
    expect(result.status).toBe(2);
    const message = result.stdout + result.stderr;
    for (const hint of [lockPath, 'Inspect', 'move it aside', 'fresh install', 'cook that wrote it']) {
      expect(message).toContain(hint);
    }
    const launch = run('run', out);
    expect(launch.status).not.toBe(0);
    expect(launch.stdout + launch.stderr).toContain('unreadable');
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('must survive');
    if (content !== null) expect(fs.readFileSync(lockPath, 'utf8')).toBe(content);
  });
}

function oldLock(): Lockfile {
  return {
    version: 1, backend: 'host', recipePath: recipe, createdAt: '2026-01-01T00:00:00.000Z',
    connectomeHost: { url: 'https://example.invalid/host.git', ref: 'main' },
    components: [], localExtensions: [],
    requirements: [{ name: 'sdk', envName: 'SDK_ROOT', origin: 'env-file', value: ANSWER }],
    launch: { kind: 'script', script: join(dir, 'run.sh') },
  };
}

test('writer strips legacy values without mutating input; other v1 bytes are unchanged', () => {
  const lock = oldLock();
  writeLockfile(dir, lock);
  const sanitized = { ...lock, requirements: [{ name: 'sdk', envName: 'SDK_ROOT', origin: 'env-file' }] };
  expect(fs.readFileSync(join(dir, LOCKFILE_NAME), 'utf8')).toBe(JSON.stringify(sanitized, null, 2) + '\n');
  expect(lock.requirements[0]!.value).toBe(ANSWER);
  // Exercise the existing-lock rewrite, including the incomplete marker path.
  fs.writeFileSync(join(dir, LOCKFILE_NAME), JSON.stringify(lock));
  writeLockfile(dir, { ...readLockfile(dir)!, incomplete: true });
  expect(readLockfile(dir)).toEqual({ ...sanitized, incomplete: true });
});

for (const failure of ['mid-write', 'fsync', 'rename'] as const) {
  test(`atomic lock ${failure} failure preserves the old bytes and cleans the temporary file`, () => {
    const path = join(dir, LOCKFILE_NAME);
    const old = JSON.stringify(oldLock());
    fs.writeFileSync(path, old);
    const originalWrite = fs.writeFileSync;
    const injected = failure === 'mid-write'
      ? spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
        originalWrite(file, String(data).slice(0, 12), options);
        throw new Error('simulated mid-write failure');
      })
      : spyOn(fs, failure === 'fsync' ? 'fsyncSync' : 'renameSync').mockImplementation(() => {
        throw new Error(`simulated ${failure} failure`);
      });
    try {
      expect(() => writeLockfile(dir, oldLock())).toThrow(`simulated ${failure} failure`);
    } finally {
      injected.mockRestore();
    }
    expect(fs.readFileSync(path, 'utf8')).toBe(old);
    expect(fs.readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
}

test('atomic lock syncs the complete same-directory temporary file before rename', () => {
  const path = join(dir, LOCKFILE_NAME);
  fs.writeFileSync(path, 'old lock');
  const events: string[] = [];
  const originalSync = fs.fsyncSync;
  const originalRename = fs.renameSync;
  const sync = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    expect(fs.readFileSync(path, 'utf8')).toBe('old lock');
    const temporary = fs.readdirSync(dir).find(name => name.endsWith('.tmp'))!;
    expect(JSON.parse(fs.readFileSync(join(dir, temporary), 'utf8')).version).toBe(1);
    events.push('sync');
    originalSync(fd);
  });
  const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    expect(String(from).startsWith(join(dir, '.connectome.lock.'))).toBe(true);
    expect(to).toBe(path);
    expect(events).toEqual(['sync']);
    events.push('rename');
    originalRename(from, to);
  });
  try { writeLockfile(dir, oldLock()); }
  finally { sync.mockRestore(); rename.mockRestore(); }
  expect(events).toEqual(['sync', 'rename']);
});

// Captured from upstream 7152366 with the same offline fixture. Only the
// fixture root, createdAt and legacy requirement values are normalized.
for (const command of ['build', 'install'] as const) {
  test(`${command}: flagless artifact bytes match upstream v1`, () => {
    expect(run(command).status).toBe(0);
    const manifest: Record<string, string> = {};
    function collect(relative = '') {
      for (const name of fs.readdirSync(join(out, relative)).sort()) {
        const file = join(relative, name);
        if (fs.statSync(join(out, file)).isDirectory()) { collect(file); continue; }
        let content = fs.readFileSync(join(out, file), 'utf8');
        if (file === LOCKFILE_NAME) {
          const lock = JSON.parse(content) as Lockfile;
          lock.createdAt = '<createdAt>';
          for (const requirement of lock.requirements) delete requirement.value;
          content = JSON.stringify(lock, null, 2) + '\n';
        }
        manifest[file] = createHash('sha256').update(content.replaceAll(dir, '<fixture>')).digest('hex');
      }
    }
    collect();
    expect(manifest).toEqual(golden[command]);
  });
}
