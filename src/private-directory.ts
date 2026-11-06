/** Private directory provisioning for the effective user, never chmod/chown.
 * Linux descriptor-relative traversal rejects symlinks even in ancestors.
 * Existing ancestors need not be private; the declared root must be 0700.
 * Same-uid processes are trusted. */
import { dirname } from 'node:path';
import { closeSync, constants as F, fchmodSync, fstatSync, ftruncateSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
class PrivateDirectoryError extends Error {}
export function privatePathParts(path: string): string[] {
  const parts = path.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[\0-\x1f\x7f]/.test(p))) throw new PrivateDirectoryError('E_PRIVATE_PATH');
  return parts;
}

export function provisionPrivateDirectory(root: string, create = true): void {
  const dirs: number[] = [];
  try {
    if (process.platform !== 'linux' || process.geteuid?.() === undefined) throw new PrivateDirectoryError('E_PRIVATE_UNSUPPORTED');
    if (typeof root !== 'string' || !root.startsWith('/')) throw new PrivateDirectoryError('E_PRIVATE_PATH');
    const parts = privatePathParts(root.slice(1));
    let fd = openSync('/', F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW); dirs.push(fd);
    // Missing /proc must not masquerade as a missing declared root.
    const probe = openSync('/proc/self/fd/' + fd, F.O_RDONLY | F.O_DIRECTORY);
    closeSync(probe);
    for (const part of parts) {
      const path = '/proc/self/fd/' + fd + '/' + part;
      let next: number;
      try { next = openSync(path, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (!create) return;
        mkdirSync(path, { mode: 0o700 });
        fsyncSync(fd);
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

/** Generated layout files only; roots and parents have already been validated. */
export function writePrivateLayoutFile(path: string, content: string, mode: number): void {
  provisionPrivateDirectory(dirname(path));
  const fd = openSync(path, F.O_WRONLY | F.O_CREAT | F.O_NOFOLLOW | F.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.geteuid!() || stat.nlink !== 1) throw new PrivateDirectoryError('E_PRIVATE_FILE');
    fchmodSync(fd, mode);
    ftruncateSync(fd);
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
