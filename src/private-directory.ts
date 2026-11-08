/** Private directory provisioning for the effective user, never chmod/chown.
 * Linux descriptor-relative traversal operates on a canonical path.
 * Root-owned and same-uid links are trusted; other owners refuse.
 * Existing ancestors need not be private; the declared root must be 0700.
 * Same-uid processes are trusted. */
import { closeSync, constants as F, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
class PrivateDirectoryError extends Error { constructor(code: string) { super(code); } }
function privatePathParts(path: string): string[] {
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[\\\0]/.test(part))) throw new PrivateDirectoryError('E_PRIVATE_PATH');
  return parts;
}

/** Resolve existing ancestors without trusting links controlled by another user.
 * Missing suffixes are preserved, so preflight never creates directories. */
export function resolvePrivateDirectoryPath(root: string): string {
  if (!root.startsWith('/')) throw new PrivateDirectoryError('E_PRIVATE_PATH');
  let parts = privatePathParts(root.slice(1)), current = '/', links = 0;
  while (parts.length) {
    const part = parts.shift()!;
    if (part === '..') { current = dirname(current); continue; }
    const path = join(current, part);
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return join(realpathSync(current), part, ...parts);
      throw error;
    }
    if (stat.isSymbolicLink()) {
      if (stat.uid !== 0 && stat.uid !== process.geteuid?.()) throw new PrivateDirectoryError('E_PRIVATE_LINK_OWNER');
      if (++links > 40) throw new PrivateDirectoryError('E_PRIVATE_PATH');
      const target = readlinkSync(path);
      // Walk target components before resolving '..': a target may itself
      // traverse a link, whose owner must be checked too.
      parts = [...target.split('/').filter(part => part && part !== '.'), ...parts];
      if (target.startsWith('/')) current = '/';
    } else {
      if (!stat.isDirectory()) throw new PrivateDirectoryError('E_PRIVATE_PATH');
      current = path;
    }
  }
  return realpathSync(current);
}

export function provisionPrivateDirectory(root: string, create = true): void {
  const dirs: number[] = [];
  try {
    if (process.platform !== 'linux' || process.geteuid?.() === undefined) throw new PrivateDirectoryError('E_PRIVATE_UNSUPPORTED');
    if (typeof root !== 'string' || !root.startsWith('/')) throw new PrivateDirectoryError('E_PRIVATE_PATH');
    const parts = privatePathParts(resolvePrivateDirectoryPath(root).slice(1));
    let fd = openSync('/', F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW); dirs.push(fd);
    // Distinguish a missing /proc descriptor bridge from a not-yet-created ancestor.
    const probe = openSync('/proc/self/fd/' + fd, F.O_RDONLY | F.O_DIRECTORY);
    closeSync(probe);
    for (const [index, part] of parts.entries()) {
      const path = '/proc/self/fd/' + fd + '/' + part;
      let next: number;
      try { next = openSync(path, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (!create) return;
        mkdirSync(path, { mode: index === parts.length - 1 ? 0o700 : 0o777 });
        fsyncSync(fd); // persist the new directory entry
        next = openSync(path, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
      }
      fd = next; dirs.push(fd);
    }
    if (create) fsyncSync(fd);
    const s = fstatSync(fd);
    if (s.uid !== process.geteuid!()) throw new PrivateDirectoryError('E_PRIVATE_OWNER');
    if ((s.mode & 0o7777) !== 0o700) throw new PrivateDirectoryError('E_PRIVATE_MODE');
  } catch (error) {
    throw error instanceof PrivateDirectoryError ? error : new PrivateDirectoryError('E_PRIVATE_PATH');
  } finally { for (const fd of dirs.reverse()) closeSync(fd); }
}
