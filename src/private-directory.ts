/** Private directory provisioning for the effective user, never chmod/chown.
 * Linux descriptor-relative traversal rejects symlinks even in ancestors.
 * Existing ancestors need not be private; the declared root must be 0700.
 * Same-uid processes are trusted. */
import { closeSync, constants as F, fstatSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
class PrivateDirectoryError extends Error { constructor(code: string) { super(code); } }
function privatePathParts(path: string): string[] {
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[\\\0]/.test(part))) throw new PrivateDirectoryError('E_PRIVATE_PATH');
  return parts;
}

export function provisionPrivateDirectory(root: string, create = true): void {
  const dirs: number[] = [];
  try {
    if (process.platform !== 'linux' || process.geteuid?.() === undefined) throw new PrivateDirectoryError('E_PRIVATE_UNSUPPORTED');
    if (typeof root !== 'string' || !root.startsWith('/')) throw new PrivateDirectoryError('E_PRIVATE_PATH');
    const parts = privatePathParts(root.slice(1));
    let fd = openSync('/', F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW); dirs.push(fd);
    // Distinguish a missing /proc descriptor bridge from a not-yet-created ancestor.
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
