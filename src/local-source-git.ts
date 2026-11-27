import fs from 'node:fs';
import { log } from './log.js';
import { shellQuote } from './shell-quote.js';

function isAbsoluteLocalSource(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//');
}

/** Strip trailing separators only; never resolve symlinks or rewrite URLs. */
export function normalizeLocalSourceUrl(url: string): string {
  return isAbsoluteLocalSource(url) ? url.replace(/\/+$/, '') || '/' : url;
}

/** Return undefined if ownership is unknown or out of scope. A result with no
 * override leaves trust to Git. Gitfiles (linked worktrees/submodules) are
 * out of scope; only bare directories and checkouts with a .git directory
 * qualify. */
export function inspectLocalSource(url: string, location: string): { uploadPack?: string } | undefined {
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
  if (!owner?.isDirectory()) return;
  if (owner.uid === uid) return {};
  if (/[*\p{Cc}]/u.test(path)) {
    log.warn(`${location}: no exact-path exception for a foreign local source with '*' or control characters; leaving trust to Git.`);
    return {};
  }
  return { uploadPack: `git -c ${shellQuote('safe.directory=' + path)} -c ${shellQuote('safe.directory=' + gitDir)} upload-pack` };
}

export function localSourceUploadPack(url: string, location: string): string | undefined {
  return inspectLocalSource(url, location)?.uploadPack;
}
