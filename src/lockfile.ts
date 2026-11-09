/**
 * connectome.lock — the record of resolution.
 *
 * Written by every backend next to its output; consumed by `cook run`
 * (launch the materialized artifact without re-resolving) and by repeat
 * installs (idempotent reconcile: a component whose url+ref+install match
 * the lock — and whose target directory exists — is skipped, not re-cloned).
 *
 * Secrets never land here — values live in the backend's .env. The lock
 * records WHAT was materialized (components, commits, paths,
 * requirement names and origins), not answers or credentials.
 */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const LOCKFILE_NAME = 'connectome.lock';

export interface LockedComponent {
  /** Dedup key from the plan (`url@ref`, `ext:<name>`, `sibling:<name>`). */
  key: string;
  /** 'mcp' | 'extension' — mirrors McpSource.role. */
  role: 'mcp' | 'extension';
  url: string;
  ref: string;
  /** Commit SHA actually checked out (host backend fills after clone;
   *  docker backend leaves undefined until --pin-refs lands). */
  commit?: string;
  /** Materialized path: in-container path (docker) or host path (host). */
  path: string;
  /** Human description of the install pattern applied. */
  install: string;
}

export interface LockedRequirement {
  name: string;
  envName: string;
  /** Legacy v1 input only; never persisted by writeLockfile. */
  value?: string;
  origin: string;
}

export interface Lockfile {
  version: 1;
  /** Hash-pinned local inputs and explicit pre-install package.json edits. */
  hostDependencies?: import('./host-dependency.js').LockedHostDependency[];
  /** A confirmed reinstall started but has not completed successfully. */
  incomplete?: true;
  /** Operator-selected engines, validated against the acquired host. */
  engines?: import('./host-engines.js').HostEngines;
  /** Which backend materialized this directory. */
  backend: 'docker' | 'host';
  /** The recipe path/URL the operator named at resolve time. */
  recipePath: string;
  /** ISO timestamp of the materialization. */
  createdAt: string;
  /** connectome-host provenance. */
  connectomeHost: { url: string; ref: string; commit?: string; path?: string };
  components: LockedComponent[];
  /** Local extension bundles (name → source dir on the operator's disk). */
  localExtensions: Array<{ name: string; hostDir: string; path: string }>;
  requirements: LockedRequirement[];
  /** Backend-specific launch hint: compose dir (docker) or launcher path (host). */
  launch: { kind: 'compose'; dir: string } | { kind: 'script'; script: string; userUnit?: string };
}

export function writeLockfile(dir: string, lock: Lockfile): void {
  // Strip legacy answers at the persistence boundary, including when an old
  // lock is rewritten as incomplete. Do not mutate the caller's in-memory lock.
  const sanitized = {
    ...lock,
    requirements: lock.requirements.map(({ value: _value, ...metadata }) => metadata),
  };
  const path = join(dir, LOCKFILE_NAME);
  const temporary = join(dir, `.${LOCKFILE_NAME}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify(sanitized, null, 2) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function readLockfile(dir: string): Lockfile | null {
  const path = join(dir, LOCKFILE_NAME);
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const raw = JSON.parse(content) as Lockfile;
  if (raw.version !== 1) {
    throw new Error(`${path}: unsupported lockfile version ${String(raw.version)}`);
  }
  return raw;
}
