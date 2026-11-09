import { expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type GitCall = { args: string[]; cwd: string };

function traceGit(bin: string, dir: string): string {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const callsFile = join(dir, 'calls.jsonl');
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  return callsFile;
}

function gitCalls(path: string): GitCall[] {
  return readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

async function gitHttpResponse(request: Request, dir: string, env: NodeJS.ProcessEnv): Promise<Response> {
  const url = new URL(request.url);
  const backend = spawn('git', ['http-backend'], {
    env: { ...env, GIT_PROJECT_ROOT: dir, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname,
      REQUEST_METHOD: request.method, QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: request.headers.get('content-type') ?? '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const chunks: Buffer[] = [];
  backend.stdout.on('data', chunk => chunks.push(chunk));
  backend.stdin.end(Buffer.from(await request.arrayBuffer()));
  await new Promise<void>((resolve, reject) => { backend.on('error', reject); backend.on('close', () => resolve()); });
  const output = Buffer.concat(chunks);
  const split = output.indexOf('\r\n\r\n');
  const headers = new Headers(); let status = 200;
  for (const line of output.subarray(0, split).toString().split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon), value = line.slice(colon + 1).trim();
    if (key.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
    else headers.append(key, value);
  }
  return new Response(output.subarray(split + 4), { status, headers });
}

test.each(['none', 'identity', 'pushInsteadOf'] as const)('R1-1: real Git authenticates pin/init/fetch with %s fetch rewrite; public aliases still work', async (rewrite) => {
  const dir = mkdtempSync(join(tmpdir(), 'cook-git-http-'));
  const token = 'synthetic-loopback-token';
  const header = `Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`;
  const requests: Array<{ path: string; auth: string | null }> = [];
  const home = join(dir, 'home');
  mkdirSync(home);
  const env = {
    PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const git = (args: string[]) => execFileSync('git', args, { env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const repo = join(dir, 'repo');
  git(['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'index.js'), '');
  git(['-C', repo, 'add', 'index.js']);
  git(['-C', repo, 'commit', '-qm', 'fixture']);
  git(['-C', repo, 'update-ref', 'refs/pull/1/head', 'HEAD']);
  const bare = join(dir, 'bare.git');
  git(['clone', '--bare', repo, bare]);
  git(['--git-dir', bare, 'update-ref', 'refs/pull/1/head', 'HEAD']);
  git(['--git-dir', bare, 'update-server-info']);
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const auth = request.headers.get('authorization');
      requests.push({ path, auth });
      if (path.startsWith('/private.git/') && auth !== header) return new Response('', { status: 401 });
      const relative = path.replace(/^\/(?:private|public)\.git\//, '');
      if (relative === path || relative.includes('..')) return new Response('', { status: 404 });
      const file = join(bare, relative);
      return existsSync(file) ? new Response(Bun.file(file)) : new Response('', { status: 404 });
    },
  });
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'bun'), '#!/bin/sh\n/usr/bin/env > install-env.txt\n', { mode: 0o755 });
    const origin = `http://127.0.0.1:${server.port}`;
    const publicAlias = `${origin}/public-alias.git`;
    const privateUrl = `${origin}/private.git`;
    writeFileSync(join(home, '.gitconfig'),
      '[fetch]\n\trecurseSubmodules = true\n[submodule]\n\trecurse = true\n' +
      `[url "${origin}/public.git"]\n\tinsteadOf = ${publicAlias}\n` +
      (rewrite === 'identity' ? `[url "${privateUrl}"]\n\tinsteadOf = ${privateUrl}\n` :
        rewrite === 'pushInsteadOf' ? `[url "${origin}/other.git"]\n\tpushInsteadOf = ${privateUrl}\n` : ''));
    expect(git(['ls-remote', '--get-url', privateUrl]).trim()).toBe(privateUrl);
    expect(git(['ls-remote', '--get-url', publicAlias]).trim()).toBe(`${origin}/public.git`);
    const recipe = join(dir, 'recipe.json');
    writeFileSync(recipe, JSON.stringify({
      name: 'Loopback fixture', agent: { systemPrompt: 'test' },
      mcpServers: { fixture: { command: 'node', source: {
        url: `${origin}/private.git`, ref: 'refs/pull/1/head', authSecret: 'PRIVATE_TOKEN',
        install: { run: '/usr/bin/env > build-env.txt', runtime: 'custom' },
      } }, publicFixture: { command: 'node', source: {
        url: publicAlias, install: { run: 'true', runtime: 'custom' },
      } } },
    }));
    const out = join(dir, 'out');
    const callsFile = traceGit(bin, dir);
    const child = spawn(process.execPath, [resolve(import.meta.dir, '../bin/cook'), 'install', recipe,
      '--out', out, '--yes', '--no-prompts', '--pin-refs', '--ch-repo', publicAlias], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, PRIVATE_TOKEN: token, GIT_CONFIG_NOSYSTEM: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const status = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject); child.on('exit', resolve);
    });
    expect(output).not.toContain(token);
    expect(output).not.toContain(header);
    expect(status).toBe(0);
    const calls = gitCalls(callsFile);
    const target = join(out, 'private');
    expect(calls.some(call => call.args[0] === 'clone' && call.args[1] === privateUrl)).toBe(false);
    const fetches = calls.map((call, index) => ({ ...call, index }))
      .filter(call => call.cwd === target && call.args[0] === 'fetch');
    expect(fetches).toHaveLength(2);
    for (const fetch of fetches) {
      expect(fetch.args).toContain('--no-recurse-submodules');
      expect(calls[fetch.index - 2]).toEqual({ cwd: target, args: ['remote', 'get-url', 'origin'] });
      expect(calls[fetch.index - 1]).toEqual({ cwd: target, args: ['ls-remote', '--get-url', 'origin'] });
    }
    expect(requests.filter(r => r.path.startsWith('/private.git/info/refs')).length).toBeGreaterThanOrEqual(3);
    expect(requests.filter(r => r.path.startsWith('/private.git/')).every(r => r.auth === header)).toBe(true);
    expect(requests.filter(r => r.path.startsWith('/public.git/')).every(r => r.auth === null)).toBe(true);
    const files = (path: string): string[] => readdirSync(path, { withFileTypes: true })
      .flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]);
    for (const path of files(out)) {
      const contents = readFileSync(path, 'utf-8');
      if (path !== join(out, '.env')) expect(contents).not.toContain(token);
      expect(contents).not.toContain(header);
    }
    expect(readFileSync(join(out, '.env'), 'utf-8')).toContain(`PRIVATE_TOKEN='${token}'`);
    expect(readFileSync(join(out, 'private/.git/config'), 'utf-8')).toContain(`${origin}/private.git`);
    const requestCount = requests.length;
    const rerun = spawn(process.execPath, [resolve(import.meta.dir, '../bin/cook'), 'install', recipe,
      '--out', out, '--yes', '--no-prompts', '--ch-repo', publicAlias], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let rerunOutput = '';
    rerun.stdout.on('data', chunk => { rerunOutput += chunk; });
    rerun.stderr.on('data', chunk => { rerunOutput += chunk; });
    expect(await new Promise<number | null>((resolve, reject) => { rerun.on('error', reject); rerun.on('close', resolve); })).toBe(0);
    expect(rerunOutput).toContain('unchanged');
    expect(requests.length).toBe(requestCount);
    console.log(`loopback Git: ${requests.length} requests; private pin/init/fetch authenticated; public requests clean`);
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

// A smart-HTTP destination is essential: Git can strip Authorization on the
// redirected GET, then leak it on subsequent upload-pack POSTs.
test.each(['prefix', 'exact', 'include', 'insteadOf', 'insteadOf-prefix', 'insteadOf-exact', 'insteadOf-exact-pin', 'insteadOf-cross-origin', 'insteadOf-userinfo', 'insteadOf-indexed', 'insteadOf-gitdir', 'insteadOf-hasconfig', 'public-insteadOf-exact'] as const)('R1-1: two-origin redirect with operator %s URL config; inspect EVERY destination request', async (scope) => {
  const dir = mkdtempSync(join(tmpdir(), 'cook-redirect-'));
  const token = 'synthetic-redirect-token';
  const requestsA: Array<{ method: string; path: string; auth: string | null }> = [];
  const requestsB: Array<{ method: string; path: string; auth: string | null }> = [];
  const home = join(dir, 'home'); mkdirSync(home);
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (args: string[]) => execFileSync('git', args, { env, stdio: 'pipe' });
  const repo = join(dir, 'repo.git');
  const source = join(dir, 'source');
  git(['init', '-b', 'main', source]);
  writeFileSync(join(source, 'index.js'), 'fixture');
  git(['-C', source, 'add', '.']);
  git(['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  git(['clone', '--bare', source, repo]);
  const destination = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requestsB.push({ method: request.method, path: new URL(request.url).pathname, auth: request.headers.get('authorization') });
    return gitHttpResponse(request, dir, env);
  } });
  const origin = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const url = new URL(request.url);
    requestsA.push({ method: request.method, path: url.pathname, auth: request.headers.get('authorization') });
    return Response.redirect(`http://127.0.0.1:${destination.port}${url.pathname}${url.search}`, 302);
  } });
  try {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    // Prove B really serves smart HTTP, including upload-pack POSTs.
    const control = spawn('git', ['clone', `http://127.0.0.1:${destination.port}/repo.git`, join(dir, 'control')], { env, stdio: 'ignore' });
    expect(await new Promise<number | null>((resolve, reject) => { control.on('error', reject); control.on('close', resolve); })).toBe(0);
    expect(requestsB.some(r => r.method === 'POST')).toBe(true);
    requestsB.length = 0;
    const sourceOrigin = `http://127.0.0.1:${origin.port}/`;
    const alias = scope.includes('insteadOf');
    const publicSource = scope.startsWith('public-');
    const conditional = scope === 'insteadOf-gitdir' || scope === 'insteadOf-hasconfig';
    const sourceUrl = `${sourceOrigin}${alias ? 'alias.git' : 'repo.git'}`;
    const effectiveUrl = scope === 'insteadOf-cross-origin' ? `http://127.0.0.1:${destination.port}/repo.git`
      : scope === 'insteadOf-userinfo' ? `http://operator:synthetic-rewrite-password@127.0.0.1:${origin.port}/repo.git`
      : alias ? `${sourceOrigin}repo.git` : sourceUrl;
    const operatorUrl = scope === 'prefix' || scope === 'insteadOf-prefix' ? sourceOrigin
      : scope.includes('insteadOf-exact') || conditional ? effectiveUrl : sourceUrl;
    // URL-specific file config (including includes) outranks unkeyed config.
    // insteadOf makes Git match HTTP settings against /repo.git, not /alias.git.
    const httpConfig = `[http "${operatorUrl}"]\n\tfollowRedirects = true\n`;
    const rewriteConfig = alias ? `[url "${effectiveUrl}"]\n\tinsteadOf = ${sourceUrl}\n` : '';
    if (conditional) {
      writeFileSync(join(home, 'redirects.gitconfig'), httpConfig + rewriteConfig);
      const condition = scope === 'insteadOf-gitdir'
        ? `gitdir:${join(dir, 'out')}/**` : `hasconfig:remote.*.url:${sourceUrl}`;
      writeFileSync(join(home, '.gitconfig'), `[includeIf "${condition}"]\n\tpath = redirects.gitconfig\n`);
      // The old cook-cwd check cannot see either conditional rewrite.
      expect(git(['ls-remote', '--get-url', sourceUrl]).toString().trim()).toBe(sourceUrl);
      const probe = join(dir, 'out', 'probe');
      git(['init', probe]);
      git(['-C', probe, 'remote', 'add', 'origin', sourceUrl]);
      for (const args of [['remote', 'get-url', 'origin'], ['ls-remote', '--get-url', 'origin']]) {
        expect(git(['-C', probe, ...args]).toString().trim()).toBe(effectiveUrl);
      }
      expect(git(['-C', probe, 'config', '--get-urlmatch', 'http.followRedirects', effectiveUrl]).toString().trim()).toBe('true');
      rmSync(probe, { recursive: true });
    } else if (scope === 'include') {
      writeFileSync(join(home, 'redirects.gitconfig'), httpConfig);
      writeFileSync(join(home, '.gitconfig'), '[include]\n\tpath = redirects.gitconfig\n');
    } else {
      writeFileSync(join(home, '.gitconfig'), httpConfig + (scope === 'insteadOf-indexed' ? '' : rewriteConfig));
    }
    if (!conditional) expect(execFileSync('git', ['config', '--get-urlmatch', 'http.followRedirects', operatorUrl],
      { env, encoding: 'utf8' }).trim()).toBe('true');
    const recipe = join(dir, 'recipe.json');
    writeFileSync(recipe, JSON.stringify({ name: 'Redirect fixture', agent: { systemPrompt: 'test' },
      mcpServers: { fixture: { command: 'node', source: {
        url: sourceUrl, ...(publicSource ? {} : { authSecret: 'PRIVATE_TOKEN' }),
      } } } }));
    const callsFile = traceGit(bin, dir);
    const child = spawn(process.execPath, [resolve(import.meta.dir, '../bin/cook'), 'install', recipe,
      '--out', join(dir, 'out'), '--yes', '--no-prompts', '--ch-repo', repo,
      ...(scope.endsWith('-pin') ? ['--pin-refs'] : [])], {
      env: { ...env, PATH: `${bin}:${env.PATH}`, PRIVATE_TOKEN: token,
        GIT_CONFIG_COUNT: scope === 'insteadOf-indexed' ? '2' : '1',
        GIT_CONFIG_KEY_0: 'http.followRedirects', GIT_CONFIG_VALUE_0: 'true',
        ...(scope === 'insteadOf-indexed' ? {
          GIT_CONFIG_KEY_1: `url.${effectiveUrl}.insteadOf`, GIT_CONFIG_VALUE_1: sourceUrl,
        } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const status = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    const calls = gitCalls(callsFile);
    if (conditional) console.log(`conditional ${scope}: status=${status}, A=${requestsA.length}, B=${requestsB.length}`);
    if (publicSource) {
      expect(calls.some(call => call.args[0] === 'clone' && call.args[1] === sourceUrl)).toBe(true);
      expect(status).toBe(0);
      expect(requestsA.length).toBeGreaterThan(0);
      expect(requestsB.some(r => r.method === 'POST')).toBe(true);
      expect([...requestsA, ...requestsB].every(r => r.auth === null)).toBe(true);
    } else {
      // Check all methods, not just curl's initially redirected GET.
      expect(requestsB).toEqual([]);
      if (alias) {
        expect(requestsA).toEqual([]);
        if (conditional) {
          const target = join(dir, 'out', 'alias');
          expect(calls.some(call => call.args[0] === 'clone' && call.args[1] === sourceUrl)).toBe(false);
          expect(calls.some(call => call.args.join(' ') === `init ${target}`)).toBe(true);
          expect(calls.some(call => call.cwd === target && call.args.join(' ') === 'remote get-url origin')).toBe(true);
          expect(calls.some(call => call.cwd === target && call.args.join(' ') === 'ls-remote --get-url origin')).toBe(true);
        }
        expect(output).toContain('E_AUTH_SOURCE_URL_REWRITTEN');
        expect(output).toContain('the source URL is rewritten by Git configuration');
        expect(output).toContain(effectiveUrl.replace('operator:synthetic-rewrite-password@', ''));
        expect(output).toContain('put the real URL in the recipe or remove the rewrite');
        expect(output).not.toContain('synthetic-rewrite-password');
        expect(output).not.toContain('operator:');
      } else {
        expect(requestsA.length).toBeGreaterThan(0);
        expect(output).toContain('final URL in the recipe');
      }
      expect(requestsA.every(r => r.path === '/repo.git/info/refs')).toBe(true);
      expect(requestsA.every(r => r.auth === `Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`)).toBe(true);
      expect(status).not.toBe(0);
    }
    expect(output).not.toContain(token);
    expect(output).not.toContain(Buffer.from(token).toString('base64'));
    expect(output).not.toContain(Buffer.from(`oauth2:${token}`).toString('base64'));
  } finally {
    origin.stop(true); destination.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test.each(['default-master', 'default-main', 'branch', 'tag', 'lightweight-tag', 'sha'] as const)(
  'authenticated checkout matches a real clone: %s', async (scenario) => {
    const dir = mkdtempSync(join(tmpdir(), 'cook-clone-equivalence-'));
    const home = join(dir, 'home'); mkdirSync(home);
    const env = {
      PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    };
    const git = (args: string[]) => execFileSync('git', args, { env, encoding: 'utf8', stdio: 'pipe' }).trim();
    const branch = scenario === 'default-main' ? 'main' : 'master';
    const source = join(dir, 'source');
    git(['init', '-b', branch, source]);
    writeFileSync(join(source, 'index.js'), 'first');
    git(['-C', source, 'add', '.']);
    git(['-C', source, 'commit', '-m', 'first']);
    const sha = git(['-C', source, 'rev-parse', 'HEAD']);
    writeFileSync(join(source, 'index.js'), 'default tip');
    git(['-C', source, 'commit', '-am', 'default tip']);
    git(['-C', source, 'checkout', '-b', 'feature']);
    writeFileSync(join(source, 'index.js'), 'feature');
    git(['-C', source, 'commit', '-am', 'feature']);
    git(['-C', source, 'checkout', '--orphan', 'tag-only']);
    writeFileSync(join(source, 'index.js'), 'unreachable from every branch');
    git(['-C', source, 'commit', '-am', 'tag-only']);
    git(['-C', source, 'tag', '-a', 'release', '-m', 'unreachable annotated tag']);
    git(['-C', source, 'tag', 'lightweight']);
    git(['-C', source, 'checkout', branch]);
    git(['-C', source, 'branch', '-D', 'tag-only']);
    git(['clone', '--bare', source, join(dir, 'private.git')]);
    expect(git(['-C', source, 'branch', '--contains', 'release'])).toBe('');
    const token = 'synthetic-clone-equivalence-token';
    const header = `Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`;
    const requests: Array<string | null> = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      requests.push(request.headers.get('authorization'));
      if (request.headers.get('authorization') !== header) return new Response('', { status: 401 });
      return gitHttpResponse(request, dir, env);
    } });
    const run = async (command: string, args: string[], childEnv: NodeJS.ProcessEnv) => {
      const child = spawn(command, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const status = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      expect(output).not.toContain(token);
      expect(output).not.toContain(header);
      expect({ status, output: status === 0 ? '' : output }).toEqual({ status: 0, output: '' });
    };
    try {
      const url = `http://127.0.0.1:${server.port}/private.git`;
      const control = join(dir, 'control');
      await run('git', ['clone', url, control], { ...env,
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${url}.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: ${header}` });
      const ref = scenario === 'branch' ? 'feature' : scenario === 'tag' ? 'release'
        : scenario === 'lightweight-tag' ? 'lightweight' : scenario === 'sha' ? sha : undefined;
      // The public path clones first, then checks out a requested non-main ref.
      if (ref) git(['-C', control, 'checkout', ref]);
      const recipe = join(dir, 'recipe.json');
      writeFileSync(recipe, JSON.stringify({ name: 'Clone equivalence', agent: { systemPrompt: 'test' },
        mcpServers: { fixture: { command: 'node', source: { url, ...(ref ? { ref } : {}), authSecret: 'PRIVATE_TOKEN' } } } }));
      const bin = join(dir, 'bin'); mkdirSync(bin);
      writeFileSync(join(bin, 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const callsFile = traceGit(bin, dir);
      const out = join(dir, 'out');
      await run(process.execPath, [resolve(import.meta.dir, '../bin/cook'), 'install', recipe,
        '--out', out, '--yes', '--no-prompts', '--ch-repo', source], {
        ...env, PATH: `${bin}:${env.PATH}`, PRIVATE_TOKEN: token,
      });
      const target = join(out, 'private');
      const snapshot = (repo: string) => ({
        commit: git(['-C', repo, 'rev-parse', 'HEAD']),
        head: readFileSync(join(repo, '.git/HEAD'), 'utf8'),
        remoteHead: git(['-C', repo, 'symbolic-ref', 'refs/remotes/origin/HEAD']),
        refs: git(['-C', repo, 'show-ref']),
        config: git(['-C', repo, 'config', '--get-regexp', '^(remote\\.origin\\.|branch\\.)']).split('\n').sort(),
        contents: readFileSync(join(repo, 'index.js'), 'utf8'),
      });
      expect(snapshot(target)).toEqual(snapshot(control));
      const calls = gitCalls(callsFile);
      const network = calls.map((call, index) => ({ ...call, index })).filter(call => call.cwd === target
        && (call.args[0] === 'fetch' || (call.args[0] === 'ls-remote' && call.args[1] !== '--get-url')));
      expect(network.map(call => call.args[0])).toEqual(['ls-remote', 'fetch']);
      expect(network[0]!.args).toEqual(['ls-remote', '--symref', 'origin', 'HEAD']);
      expect(network[1]!.args).toContain('--tags');
      for (const call of network) {
        expect(calls[call.index - 2]).toEqual({ cwd: target, args: ['remote', 'get-url', 'origin'] });
        expect(calls[call.index - 1]).toEqual({ cwd: target, args: ['ls-remote', '--get-url', 'origin'] });
      }
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every(auth => auth === header)).toBe(true);
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000,
);
