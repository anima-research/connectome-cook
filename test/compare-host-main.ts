/** Offline differential gate: bun test/compare-host-main.ts <main-checkout>.
 * Compare fresh and reconciled flagless artifacts at identical absolute paths.
 * Only connectome.lock's createdAt value is normalized; bytes/modes otherwise
 * remain untouched. Git's internal acquisition metadata is not an artifact.
 */
import { deepStrictEqual, strictEqual } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const main = resolve(process.argv[2]!);
const candidate = resolve(import.meta.dir, '..');
const dir = mkdtempSync('/tmp/cook-main-compat-');
try {
  const repo = join(dir, 'source'); mkdirSync(repo);
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.org']);
  writeFileSync(join(repo, 'package.json'), '{"name":"offline-fixture"}\n');
  git(['add', '.']); git(['commit', '-m', 'Fixture']);
  const tools = join(dir, 'tools'); mkdirSync(tools);
  writeFileSync(join(tools, 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const sibling = join(dir, 'local'); mkdirSync(sibling);
  writeFileSync(join(sibling, 'fixture.js'), '// sibling fixture\n');
  const envFile = join(dir, 'operator.env'); writeFileSync(envFile, "SECRET=compat-value\n");
  const recipe = join(dir, 'recipe.json'), out = join(dir, 'install');
  let comparisons = 0;
  const snapshot = () => {
    const files: Record<string, { mode: number; bytes?: string }> = {};
    const visit = (rel: string) => {
      const path = join(out, rel), stat = statSync(path);
      files[rel] = { mode: stat.mode & 0o7777 };
      if (stat.isDirectory()) for (const child of readdirSync(path).sort()) {
        if (child !== '.git') visit(join(rel, child));
      }
      else {
        let bytes = readFileSync(path);
        if (rel === 'connectome.lock') bytes = Buffer.from(bytes.toString().replace(/("createdAt": ")[^"]+/, '$1<TIMESTAMP>'));
        files[rel]!.bytes = bytes.toString('base64');
      }
    };
    visit(''); return files;
  };
  for (const rich of [false, true]) {
    writeFileSync(recipe, JSON.stringify({ name: 'Compatibility', agent: { systemPrompt: 'Test' },
      ...(rich ? {
        mcpServers: { local: { command: 'node', args: ['fixture.js'], env: { SECRET: '${SECRET}' } } },
        containerTemplateFiles: [
          { hostPath: './full.json', inContainer: '/app/full.json', template: 'v=${SECRET}' },
          { hostPath: './runtime.json', inContainer: '/app/runtime.json', template: 'v=${LATER}', runtimeRender: true },
        ],
        services: [{ name: 'sidecar', image: 'fixture:1', volumes: [{ source: './sidecar.conf', target: '/config' }], templateFiles: [{ path: './sidecar.conf', template: 'v=${SECRET}' }] }],
      } : {}),
    }));
    const results: Array<Array<{ files: ReturnType<typeof snapshot>; stdout: string }>> = [];
    for (const checkout of [main, candidate]) {
      rmSync(out, { recursive: true, force: true });
      const installs = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = spawnSync(process.execPath, [join(checkout, 'bin/cook'), 'install', recipe,
          '--out', out, '--ch-repo', repo, '--ch-ref', 'main', '--no-prompts', '--yes', '--env-file', envFile],
          { encoding: 'utf8', env: { ...process.env, PATH: tools + ':' + process.env.PATH } });
        strictEqual(result.status, 0, result.stdout + result.stderr);
        installs.push({ files: snapshot(), stdout: result.stdout });
      }
      results.push(installs);
    }
    deepStrictEqual(results[1], results[0]); comparisons += 2;
  }
  console.log(`${comparisons} flagless fresh/reconcile comparisons: all artifact bytes, modes and stdout identical except createdAt`);
} finally { rmSync(dir, { recursive: true, force: true }); }
