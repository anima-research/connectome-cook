import fs from 'node:fs';
import { shellQuote } from './shell-quote.js';

function isAbsoluteLocalSource(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//');
}

/** Strip trailing separators only; never resolve symlinks or rewrite URLs. */
export function normalizeLocalSourceUrl(url: string): string {
  return isAbsoluteLocalSource(url) ? url.replace(/\/+$/, '') || '/' : url;
}

/** Select an exact-path exception only for an explicitly absolute, foreign
 * bare repository or checkout with a .git directory. Gitfiles (linked
 * worktrees/submodules) don't use this exception. */
export function localSourceUploadPack(url: string, location: string): string | undefined {
  if (!isAbsoluteLocalSource(url)) return;
  const uid = process.geteuid?.();
  if (uid === undefined) return;
  const path = normalizeLocalSourceUrl(url);
  const gitDir = path === '/' ? '/.git' : path + '/.git';
  let owner;
  try {
    owner = fs.statSync(gitDir, { throwIfNoEntry: false }) ?? fs.statSync(path, { throwIfNoEntry: false });
  } catch {
    // Let Git diagnose missing/inaccessible sources without granting trust.
    return;
  }
  if (!owner?.isDirectory() || owner.uid === uid) return;
  if (/[*\p{Cc}]/u.test(path)) {
    throw new Error(`E_LOCAL_SOURCE_PATH: ${location}: foreign local source paths must not contain '*' or control characters.`);
  }
  return `git -c ${shellQuote('safe.directory=' + path)} -c ${shellQuote('safe.directory=' + gitDir)} upload-pack`;
}
