/** Versioned deployment record. Never serialize resolved operator values here. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, statSync, lstatSync, fchmodSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import type { InstallPlan } from './plan.js';
import type { McpSource } from './types.js';
import { deriveRequiredVars } from './prompts.js';
import { looksLikeSha } from './pin-refs.js';
import { assertCredentialFreeSourceUrl, sourceLocation } from './source-url.js';
import pkg from '../package.json' with { type: 'json' };

export const LOCKFILE_NAME = 'connectome.lock';

export interface LegacyComponent {
  kind?: 'git' | 'copy';
  key: string;
  role: 'mcp' | 'extension';
  url: string;
  ref: string;
  commit?: string;
  path: string;
  install: string;
}
export interface LockedGitComponent extends LegacyComponent {
  kind: 'git';
  // Docker records unresolved refs honestly; host materialization requires HEAD.
  commit?: string;
}
export interface LockedNpmComponent {
  kind: 'npm';
  key: string;
  role: 'mcp' | 'extension';
  name?: string;
  spec: string;
  version?: string;
  integrity?: string;
  // Git-only fields: make callers narrow before using provenance.
  url?: never;
  ref?: never;
  commit?: never;
  path?: never;
  install?: never;
}
export interface LockedCopyComponent extends Omit<LegacyComponent, 'kind'> { kind: 'copy' }
export type LockedComponent = LockedGitComponent | LockedNpmComponent | LockedCopyComponent;

/** v1 carried arbitrary answers here, including secrets. v2 is names only. */
export interface LockedRequirement {
  name: string;
  envName: string;
  origin: string;
}
interface LockCommon {
  hostDependencies?: import('./host-dependency.js').LockedHostDependency[];
  incomplete?: true;
  engines?: import('./host-engines.js').HostEngines;
  backend: 'docker' | 'host';
  recipePath: string;
  createdAt: string;
  localExtensions: Array<{ name: string; hostDir: string; path: string }>;
  launch: { kind: 'compose'; dir: string } | { kind: 'script'; script: string; userUnit?: string };
}
export interface LockfileV1 extends LockCommon {
  version: 1;
  connectomeHost: { url: string; ref: string; commit?: string; path?: string };
  components: LegacyComponent[];
  requirements: Array<LockedRequirement & { value?: string }>;
}
/** New v2 metadata is informational; it does not drive reconcile or launch. */
export interface LockfileV2 extends LockCommon {
  version: 2;
  cook: { packageVersion: string };
  recipe: { path: string; sha256: string };
  connectomeHost: { url: string; ref: string; commit?: string; path?: string };
  components: LockedComponent[];
  requirements: LockedRequirement[];
  build: { dir: string };
  referencedVariables: string[];
  /** Only if cook defines a state location outside build.dir. */
  state?: { path: string };
  outputs: Array<{ path: string; mode: number; sha256?: string }>;
}
export type Lockfile = LockfileV1 | LockfileV2;

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
/** Canonical JSON: lexically sorted object keys; array order is significant. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
  }
  return JSON.stringify(value);
}
export function fullCommit(commit: string | undefined, location: string): string {
  if (!commit || !looksLikeSha(commit)) {
    throw new Error(`${location}: lock v2 requires a full commit SHA when recording a commit; no provenance can be guessed`);
  }
  return commit.toLowerCase();
}

const npmArchive = /\.(?:tgz|tar\.gz|tar)$/i;
const npmScpHost = /^[^@/\\?#]+@([^@:/\\?#]+):[^#]+/;

function isRegistryAliasTarget(target: string): boolean {
  // Registry aliases can still refer to legacy names containing ~'!()*.
  const [, name, selector] = /^((?:@[a-z0-9_~'!()*-][a-z0-9._~'!()*-]*\/[a-z0-9_~'!()*-]|[a-z0-9~'!()*-])[a-z0-9._~'!()*-]*)(?:@(.*))?$/i.exec(target) ?? [];
  if (!name || name.length > 214 || /^(?:node_modules|favicon\.ico)$/i.test(name)) return false;
  // npm treats unscoped archive names and file-shaped selectors as paths.
  if (!name.startsWith('@') && npmArchive.test(name)) return false;
  if (!selector) return true;
  if (selector.startsWith('.') || npmArchive.test(selector)) return false;
  // Keep semver optional for commands that do not need range validation.
  const { validRange } = createRequire(import.meta.url)('semver') as typeof import('semver');
  // npm treats non-range selectors as tags only if encodeURIComponent leaves them unchanged.
  return validRange(selector) !== null || /^[A-Za-z0-9_.!~*'()-]+$/.test(selector.trim());
}

/** Inventory only what the recipe declares. No new registry/cache lookup:
 * cook has no offline npm integrity metadata, so integrity is omitted. */
export function resolveNpmComponents(sources: McpSource[]): LockedNpmComponent[] {
  return sources.filter(s => s.install.kind === 'npm-global').map(source => {
    if (source.install.kind !== 'npm-global') throw new Error('unreachable');
    const spec = source.install.package;
    // Strip an optional registry-name alias, not URL/shorthand userinfo.
    const [, name, target] = /^((?:@[\w.~%'!()*-]+\/)?[\w.~%'!()*-]+)(?:@([\s\S]*))?$/.exec(spec) ?? [];
    // npm recognizes bare user@dotted.host:path before splitting on "@".
    const bareScp = npmScpHost.exec(spec)?.[1]?.includes('.');
    const sourceSpec = bareScp ? spec : target ?? spec;
    const component: LockedNpmComponent = { kind: 'npm', key: source.key, role: source.role ?? 'mcp', spec };
    const location = `${sourceLocation(source)}.npm`;
    if (/^npm:/i.test(sourceSpec)) {
      if (!isRegistryAliasTarget(sourceSpec.slice('npm:'.length))) {
        throw new Error(`${location}: npm aliases must target a registry package.`);
      }
      return component;
    }
    const shortcut = /^(?:github|gitlab|bitbucket|gist):/i.test(sourceSpec);
    const hosted = !(name && target === undefined) && (/^[^/\\?#]+\/[^/\\?#]+/.test(sourceSpec) || shortcut);
    const url = /^[a-z][a-z0-9+.-]*:[/\\]/i.test(sourceSpec) || sourceSpec.includes('://');
    // In ambiguous user@host/repo spellings, retain possible SSH usernames.
    // Scoped and legacy npm names, or a target with its own userinfo, are aliases.
    const shorthandUser = !url && !shortcut && !/^[^/?#]*@/.test(sourceSpec) && /^[\w.%-]+$/.test(name ?? '');
    const checkedSpec = shorthandUser ? spec : sourceSpec;
    const scp = npmScpHost.test(checkedSpec);
    if (url || hosted || scp) {
      assertCredentialFreeSourceUrl(checkedSpec, location, { allowSuffix: true, allowGitScp: true });
    }
    // Names and exact versions describe registry specs only, not e.g. Git,
    // tarballs, local paths, hosted shorthands or npm aliases.
    const registry = name !== undefined && !url && !hosted && !scp
      && (!target || !/[:/\\@?#]/.test(target)) && !name.startsWith('.') && !npmArchive.test(sourceSpec);
    const declaredVersion = registry ? target ?? '' : '';
    const version = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(declaredVersion);
    const exact = version && !version[1]?.split('.').some(part => /^0\d+$/.test(part));
    return { ...component,
      ...(registry ? { name } : {}),
      ...(exact ? { version: declaredVersion } : {}) };
  });
}

/** Names are a conservative superset: runtime vars have no secret marker.
 * RequiredVar already classifies build/sidecar secrets; LockedRequirement does
 * not. Reuse the existing collector rather than maintain a secret-name list. */
export function referencedVariables(plan: InstallPlan): string[] {
  const sidecarSecrets = (plan.parentWalk.recipe.services ?? []).flatMap(s => s.secrets ?? []);
  const vars = deriveRequiredVars(plan.envVars, plan.sources, sidecarSecrets, plan.walks);
  return [...new Set([
    ...vars.map(v => v.name),
    ...vars.flatMap(v => v.altNames ?? []),
    ...plan.requirements.map(r => r.envName),
    ...plan.credentialFiles.flatMap(cf => cf.fields.map(f => f.envOverride ?? `${cf.path}#${f.name}`)),
  ])].sort();
}

export function deploymentRecord(
  plan: InstallPlan,
  dir: string,
): Pick<LockfileV2, 'cook' | 'recipe' | 'build' | 'referencedVariables' | 'requirements'> {
  const { sourceSha256, recipe } = plan.parentWalk;
  return {
    cook: { packageVersion: pkg.version },
    // Programmatic plans without loader provenance hash canonical recipe JSON.
    recipe: { path: plan.recipePath, sha256: sourceSha256 ?? sha256(canonicalJson(recipe)) },
    build: { dir: resolve(dir) },
    referencedVariables: referencedVariables(plan),
    requirements: plan.requirements.map(({ name, envName, origin }) => ({ name, envName, origin })),
  };
}

/** Eligibility is declared by the writer, never inferred from operator answers. */
export type PublicOutputDigest = string | undefined;

/** Explicit inventory, never a recursive scan of operator state. Public
 * digests must be captured from generated bytes BEFORE writing, not read back
 * from the filesystem. Undefined digests mean mode only. Disk supplies modes
 * only: symlinks, hardlinks and concurrent changes cannot supply hash inputs.
 * Sensitive paths (env, credentials, rendered templates) always get mode only,
 * even when also declared public under another spelling of the same path. */
export function outputRecords(
  dir: string,
  publicOutputs: ReadonlyMap<string, PublicOutputDigest>,
  sensitivePaths: string[] = [],
): LockfileV2['outputs'] {
  const root = resolve(dir);
  const normalize = (path: string) => relative(root, resolve(root, path));
  const sensitive = new Set(['.env', ...sensitivePaths].map(normalize));
  const digests = new Map([...publicOutputs].map(([path, digest]) => [normalize(path), digest]));
  const records: LockfileV2['outputs'] = [];
  for (const path of [...new Set([...digests.keys(), ...sensitive])].sort()) {
    let mode: number;
    try { mode = statSync(resolve(root, path)).mode & 0o777; }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      continue; // A declared but unwritten output is not recorded.
    }
    const digest = sensitive.has(path) ? undefined : digests.get(path);
    records.push({ path, mode, ...(digest === undefined ? {} : { sha256: digest }) });
  }
  return records;
}

export function writeLockfile(dir: string, lock: Lockfile): void {
  if (lock.version === 2 && !lock.incomplete) {
    if (lock.backend === 'host' || lock.connectomeHost.commit !== undefined) {
      fullCommit(lock.connectomeHost.commit, 'connectome-host');
    }
    for (const c of lock.components) if (c.kind === 'git' && (lock.backend === 'host' || c.commit !== undefined)) {
      fullCommit(c.commit, c.key);
    }
  }
  // Defense in depth against callers passing a wider runtime requirement.
  const safe = { ...lock, requirements: lock.requirements.map(({ name, envName, origin }) => ({ name, envName, origin })) };
  // Same-directory rename publishes a whole record, including incomplete markers.
  const path = join(dir, LOCKFILE_NAME);
  const temp = join(dir, `.${LOCKFILE_NAME}.${randomUUID()}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(safe, null, 2) + '\n');
    // Keep the temp file private while writing; publish with normal lock permissions.
    const previous = lstatSync(path, { throwIfNoEntry: false });
    const mode = previous?.isFile() ? previous.mode & 0o777 : 0o666 & ~process.umask();
    fchmodSync(fd, mode);
    closeSync(fd);
    renameSync(temp, path);
  } catch (err) {
    try { closeSync(fd); } catch { /* Already closed. */ }
    try { unlinkSync(temp); } catch { /* Preserve the original failure. */ }
    throw err;
  }
}

export function readLockfile(dir: string): Lockfile | null {
  const path = join(dir, LOCKFILE_NAME);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as { version: unknown };
  if (raw.version !== 1 && raw.version !== 2) {
    throw new Error(`${path}: unsupported lockfile version ${String(raw.version)}`);
  }
  return raw as Lockfile;
}
