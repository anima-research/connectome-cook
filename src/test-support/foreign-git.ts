import { expect } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

/** Simulates repositories owned by another uid (no sudo in tests). A `git`
 * wrapper in `bin` runs clone/fetch/ls-remote that touch a
 * listed path (directly, as file://, or via the checkout's origin) with
 * Git's ownership test hook, so the owner check fails exactly where a
 * foreign-owned repository's would. The local side (a checkout or scratch
 * cook owns) is granted by exact path; the listed sources never are. */
function writeForeignGit(bin: string, foreignList: string): void {
  writeFileSync(join(bin, 'git'), `#!/bin/sh
[ -e '${foreignList}' ] || exec '${REAL_GIT}' "$@"
sub=; skip=; repo=$PWD
for a in "$@"; do
  if [ -n "$skip" ]; then [ "$skip" = C ] && repo=$a; skip=; continue; fi
  case $a in -c) skip=c;; -C) skip=C;; -*) ;; *) sub=$a; break;; esac
done
case $sub in clone|fetch|ls-remote) ;; *) exec '${REAL_GIT}' "$@";; esac
foreign() { while IFS= read -r p; do case $1 in "$p"|"file://$p") return 0;; esac; done < '${foreignList}'; return 1; }
hit=
for a in "$@"; do foreign "$a" && hit=1; done
[ -z "$hit" ] && [ "$sub" != clone ] && foreign "$('${REAL_GIT}' -C "$repo" config --get remote.origin.url 2>/dev/null)" && hit=1
[ -n "$hit" ] || exec '${REAL_GIT}' "$@"
phys=$(cd "$repo" 2>/dev/null && pwd -P || echo "$repo")
GIT_TEST_ASSUME_DIFFERENT_OWNER=1 exec '${REAL_GIT}' -c "safe.directory=$repo" -c "safe.directory=$repo/.git" -c "safe.directory=$phys" -c "safe.directory=$phys/.git" "$@"
`, { mode: 0o755 });
}

// Stub stat only for the selected gitdirs in the CLI subprocess. Separately
// exercise Git's own checks with its test hook.
export function markForeign(dir: string, bin: string, sources: string[], env: NodeJS.ProcessEnv) {
  const list = join(dir, 'foreign');
  writeFileSync(list, sources.flatMap(path => [path, path + '/']).join('\n') + '\n');
  writeForeignGit(bin, list);
  const gitEnv = { ...env, PATH: bin + ':' + env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), LC_ALL: 'C' };
  // Git >=2.48 allows ls-remote from a foreign source. A plain local clone
  // still rejects it, both before and after the upload-pack behavior change.
  const rejected = spawnSync('git', ['clone', '--', sources[0]!, join(dir, 'plain-clone')], {
    cwd: dir, env: gitEnv, encoding: 'utf8',
  });
  expect(rejected.status).not.toBe(0);
  expect(rejected.stderr).toContain('dubious ownership');
  const preload = join(dir, 'foreign.ts');
  const gitDirs = sources.map(path => existsSync(path + '/.git') ? path + '/.git' : path);
  writeFileSync(preload, `
import fs from 'node:fs';
const paths = new Set(${JSON.stringify(gitDirs)});
const { statSync } = fs;
fs.statSync = (...args) => {
  const stat = statSync(...args);
  if (stat && paths.has(args[0])) stat.uid = process.geteuid() + 1;
  return stat;
};
`);
  return { gitEnv, bunArgs: ['--preload', preload] };
}

export function originUploadPack(cwd: string, env?: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync(REAL_GIT, ['config', '--get-all', 'remote.origin.uploadpack'], { cwd, env, encoding: 'utf8' });
  if (result.status === 1) return undefined;
  expect(result.status).toBe(0);
  return result.stdout.trim();
}
