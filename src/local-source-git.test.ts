import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REAL_GIT, foreignGitTest, markForeign, originUploadPack } from './test-support/foreign-git.js';

let dir: string, bin: string, host: string, component: string, recipe: string, out: string;
let env: NodeJS.ProcessEnv;
let bunArgs: string[];
function git(cwd: string, ...args: string[]) {
  return execFileSync(REAL_GIT, args, { cwd, encoding: 'utf8', stdio: 'pipe', env }).trim();
}
function commit(cwd: string, file: string, body: string) {
  writeFileSync(join(cwd, file), body);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-qm', file);
}
function writeRecipe(url = component, ref = 'main') {
  writeFileSync(recipe, JSON.stringify({ name: 'Fixture', agent: { systemPrompt: 'Test' }, mcpServers: { comp: {
    command: 'node', args: ['index.js'], source: { url, ref, install: { runtime: 'custom', run: 'touch component-built' } },
  } } }));
}
function install(chRef = 'main', extra: string[] = [], hostUrl = host) {
  return spawnSync(process.execPath, [...bunArgs, resolve('bin/cook'), 'install', recipe, '--out', out,
    '--ch-repo', hostUrl, '--ch-ref', chRef, '--no-prompts', '--yes', ...extra], { encoding: 'utf8', env });
}

beforeEach(() => {
  bunArgs = [];
  dir = mkdtempSync(join(tmpdir(), 'cook-local-source-'));
  bin = join(dir, 'bin'); mkdirSync(bin);
  host = join(dir, 'host-src'); component = join(dir, 'component-src');
  recipe = join(dir, 'recipe.json'); out = join(dir, 'install');
  env = { PATH: bin + ':' + process.env.PATH, HOME: dir, TMPDIR: dir,
    GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    BUN_INSTALL_CACHE_DIR: join(dir, 'cache'), GIT_ALLOW_PROTOCOL: 'file' };
  for (const path of [host, component]) {
    mkdirSync(path);
    git(path, 'init', '-qb', 'main');
    git(path, 'config', 'user.name', 'Fixture');
    git(path, 'config', 'user.email', 'fixture@example.invalid');
  }
  commit(host, 'package.json', JSON.stringify({
    name: 'host-fixture', engines: { bun: '>=1.4.3', node: '>=22.12.0' },
  }));
  commit(component, 'index.js', '// fixture');
  writeFileSync(join(bin, 'bun'), `#!/bin/sh\nif [ "$1" = --version ]; then echo 1.4.4; exit 0; fi\nexec '${process.execPath}' "$@" --offline\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'node'), '#!/bin/sh\necho v22.23.3\n', { mode: 0o755 });
  writeRecipe();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function foreign(sources = [host, component]) {
  const marked = markForeign(dir, bin, sources, env);
  env = marked.gitEnv;
  bunArgs = marked.bunArgs;
}
function checkOrigin(target: string, source: string, uploadPack: boolean) {
  const checkout = join(out, target);
  expect(git(checkout, 'config', '--get', 'remote.origin.url')).toBe(source);
  if (uploadPack) {
    const command = originUploadPack(checkout, env);
    expect(command).toBeDefined();
    expect(command!.split('\n')).toHaveLength(1);
    expect(command).toStartWith("git -c 'safe.directory=");
    execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: checkout, env, stdio: 'pipe' });
  } else {
    expect(originUploadPack(checkout, env)).toBeUndefined();
  }
}
function checkLock() {
  const lock = JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8'));
  expect(lock.connectomeHost.url).toBe(host);
  expect(lock.components[0].url).toBe(component);
}
function hiddenCommit(source: string) {
  git(source, 'checkout', '-qb', 'topic');
  commit(source, 'topic', 'topic');
  const sha = git(source, 'rev-parse', 'HEAD');
  git(source, 'update-ref', 'refs/keep/topic', sha);
  git(source, 'checkout', '-q', 'main');
  git(source, 'branch', '-qD', 'topic');
  return sha;
}

for (const mode of ['quoted paths', 'file URL rewrite', 'bare host']) foreignGitTest(`foreign local sources clone, pin and fetch by name (${mode})`, () => {
  if (mode === 'quoted paths') {
    const quoted = join(dir, "host with 'quote % \\");
    renameSync(host, quoted);
    host = quoted;
  } else if (mode === 'bare host') {
    const bare = join(dir, 'host.git');
    git(dir, 'clone', '-q', '--bare', host, bare);
    host = bare;
  }
  foreign();
  const sha = hiddenCommit(component);
  writeRecipe(component + '/', 'refs/keep/topic');
  if (mode === 'file URL rewrite') writeFileSync(join(dir, 'gitconfig'), [host, component].map(p => `[url "file://${p}"]\n\tinsteadOf = ${p}\n`).join(''));
  const result = install('main', ['--pin-refs'], host + '/');
  if (result.status) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
  checkOrigin('app', host, true);
  if (mode === 'quoted paths') {
    expect(originUploadPack(join(out, 'app'), env)).toBe(
      String.raw`git -c 'safe.directory=${dir}/host with '\''quote % \' -c 'safe.directory=${dir}/host with '\''quote % \/.git' upload-pack`,
    );
  }
  checkOrigin('component-src', component, true);
  checkLock();
  expect(git(join(out, 'component-src'), 'rev-parse', 'HEAD')).toBe(sha);
});

foreignGitTest('foreign local host engine preflight can fetch and probe missing refs', () => {
  foreign();
  const engines = ['--bun-path', join(bin, 'bun'), '--node-path', join(bin, 'node')];
  expect(install('missing', engines, host + '/').stderr).toContain('E_HOST_ENGINE_REF:');
  const result = install('main', engines, host + '/');
  expect(result.status).toBe(0);
  checkOrigin('app', host, true);
  checkLock();
});

for (const character of ['*', '\u0085']) foreignGitTest(`foreign local source refuses ${character === '*' ? 'wildcards' : 'controls'} before creating the install`, () => {
  const bad = join(dir, 'private' + character + 'path');
  renameSync(component, bad);
  foreign([host, bad]);
  writeRecipe(bad);
  const result = install();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('E_LOCAL_SOURCE_PATH:');
  expect(result.stderr + result.stdout).not.toContain(bad);
  expect(existsSync(out)).toBe(false);
});

for (const character of ['*', '\u0085']) foreignGitTest(`--pin-refs does not echo a foreign host path with ${character === '*' ? 'wildcards' : 'controls'}`, () => {
  const bad = join(dir, 'private' + character + 'path');
  renameSync(host, bad);
  foreign([bad]);
  for (const ref of ['main', 'f'.repeat(40)]) {
    const result = install(ref, ['--pin-refs'], bad);
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).not.toContain(bad);
    expect(result.stderr).toContain('E_LOCAL_SOURCE_PATH: --ch-repo:');
    expect(existsSync(out)).toBe(false);
  }
});

test('owned local source keeps plain clone semantics for unusual paths and hidden commits', () => {
  const quoted = join(dir, "host with 'quote * % \\");
  renameSync(host, quoted);
  host = quoted;
  const sha = hiddenCommit(host);
  const result = install(sha);
  expect(result.status).toBe(0);
  checkOrigin('app', host, false);
  expect(git(join(out, 'app'), 'rev-parse', 'HEAD')).toBe(sha);
});

foreignGitTest('foreign local source fetches a SHA only reachable from a custom ref', () => {
  foreign();
  const sha = hiddenCommit(host);
  const result = install(sha);
  expect(result.status).toBe(0);
  expect(git(join(out, 'app'), 'rev-parse', 'HEAD')).toBe(sha);
  checkOrigin('app', host, true);
});

foreignGitTest('foreign local source still gives guidance for an unavailable SHA', () => {
  foreign();
  const result = install('f'.repeat(40));
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('specify the full ref name');
  expect(existsSync(join(out, 'app'))).toBe(false);
});

for (const startsForeign of [false, true]) foreignGitTest(`reused checkouts refresh upload-pack (${startsForeign ? 'foreign to owned' : 'owned to foreign'})`, () => {
  if (startsForeign) foreign();
  expect(install().status).toBe(0);
  checkOrigin('app', host, startsForeign);
  checkOrigin('component-src', component, startsForeign);

  if (startsForeign) {
    bunArgs = [];
    rmSync(join(bin, 'git'));
  } else {
    foreign();
  }
  const next = install();
  expect(next.status).toBe(0);
  expect(next.stdout.match(/unchanged /g)).toHaveLength(2);
  checkOrigin('app', host, !startsForeign);
  checkOrigin('component-src', component, !startsForeign);
});

foreignGitTest('reuse does not set upload-pack on a repointed origin', () => {
  expect(install().status).toBe(0);
  const checkout = join(out, 'app');
  git(checkout, 'remote', 'set-url', 'origin', component);

  foreign([host]);
  const next = install();
  expect(next.status).toBe(0);
  expect(next.stdout.match(/unchanged /g)).toHaveLength(2);
  checkOrigin('app', component, false);
});

for (const withEngines of [false, true]) test(`owned absolute URLs agree in preview, lock and origin (selected engines: ${withEngines})`, () => {
  writeRecipe(component + '///');
  const engines = withEngines ? ['--bun-path', join(bin, 'bun'), '--node-path', join(bin, 'node')] : [];
  const first = install('main', engines, host + '///');
  expect(first.status).toBe(0);
  expect(first.stdout).not.toContain(host + '///');
  expect(first.stdout).not.toContain(component + '///');
  checkLock();
  checkOrigin('app', host, false);
  checkOrigin('component-src', component, false);

  writeRecipe();
  const next = install('main', engines);
  expect(next.status).toBe(0);
  expect(next.stdout.match(/unchanged /g)).toHaveLength(2);
});

test('an HTTPS source rewritten by Git does not get a local exception', () => {
  const url = 'https://example.invalid/component.git';
  writeRecipe(url);
  writeFileSync(join(dir, 'gitconfig'), `[url "${component}"]\n\tinsteadOf = ${url}\n`);
  expect(install().status).toBe(0);
  checkOrigin('component', url, false);
});
