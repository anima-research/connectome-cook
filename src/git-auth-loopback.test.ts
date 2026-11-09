import { expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('R1-1: real Git sends the private header on loopback pin/clone/fetch, keeps credentials out of Git artifacts', async () => {
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
    const recipe = join(dir, 'recipe.json');
    writeFileSync(recipe, JSON.stringify({
      name: 'Loopback fixture', agent: { systemPrompt: 'test' },
      mcpServers: { fixture: { command: 'node', source: {
        url: `${origin}/private.git`, ref: 'refs/pull/1/head', authSecret: 'PRIVATE_TOKEN',
        install: { run: '/usr/bin/env > build-env.txt', runtime: 'custom' },
      } } },
    }));
    const out = join(dir, 'out');
    const child = spawn(process.execPath, [resolve(import.meta.dir, '../bin/cook'), 'install', recipe,
      '--out', out, '--yes', '--no-prompts', '--pin-refs', '--ch-repo', `${origin}/public.git`], {
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
      '--out', out, '--yes', '--no-prompts', '--ch-repo', `${origin}/public.git`], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let rerunOutput = '';
    rerun.stdout.on('data', chunk => { rerunOutput += chunk; });
    rerun.stderr.on('data', chunk => { rerunOutput += chunk; });
    expect(await new Promise<number | null>((resolve, reject) => { rerun.on('error', reject); rerun.on('close', resolve); })).toBe(0);
    expect(rerunOutput).toContain('unchanged');
    expect(requests.length).toBe(requestCount);
    console.log(`loopback Git: ${requests.length} requests; private pin/clone/fetch authenticated; public requests clean`);
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

// A smart-HTTP destination is essential: Git can strip Authorization on the
// redirected GET, then leak it on subsequent upload-pack POSTs.
test('R1-1: cross-origin redirect fails closed; inspect EVERY destination request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cook-redirect-'));
  const token = 'synthetic-redirect-token';
  const requestsA: Array<{ method: string; auth: string | null }> = [];
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
    const url = new URL(request.url);
    requestsB.push({ method: request.method, path: url.pathname, auth: request.headers.get('authorization') });
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
  } });
  const origin = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    requestsA.push({ method: request.method, auth: request.headers.get('authorization') });
    const url = new URL(request.url);
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
    const recipe = join(dir, 'recipe.json');
    writeFileSync(recipe, JSON.stringify({ name: 'Redirect fixture', agent: { systemPrompt: 'test' },
      mcpServers: { fixture: { command: 'node', source: {
        url: `http://127.0.0.1:${origin.port}/repo.git`, authSecret: 'PRIVATE_TOKEN',
      } } } }));
    const child = spawn(process.execPath, [resolve(import.meta.dir, '../bin/cook'), 'install', recipe,
      '--out', join(dir, 'out'), '--yes', '--no-prompts', '--ch-repo', repo], {
      env: { ...env, PATH: `${bin}:${env.PATH}`, PRIVATE_TOKEN: token,
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.followRedirects', GIT_CONFIG_VALUE_0: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const status = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    expect(requestsA.length).toBeGreaterThan(0);
    expect(requestsA.every(r => r.auth === `Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`)).toBe(true);
    // Check all methods, not just curl's initially redirected GET.
    expect(requestsB.filter(r => r.auth !== null)).toEqual([]);
    expect(requestsB).toEqual([]);
    expect(status).not.toBe(0);
    expect(output).toContain('final URL in the recipe');
    expect(output).not.toContain(token);
    expect(output).not.toContain(Buffer.from(`oauth2:${token}`).toString('base64'));
  } finally {
    origin.stop(true); destination.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
