/**
 * Source detector — Phase 1 of BUILD-PLAN.md.
 *
 * Pure function. Walks each recipe's `mcpServers` and produces a deduplicated
 * list of `McpSource` describing what needs to be cloned + installed at image
 * build time.
 *
 * Dedup key: `${normalizedUrl}@${ref || 'main'}`. Normalization strips
 * a trailing `/` and a `.git` suffix so `https://x/y` and `https://x/y.git/`
 * collapse onto the same source. The actual `url` field on the emitted
 * McpSource is whatever the FIRST referencing recipe spelled it as.
 *
 * Behavior for an mcpServer with no `source` block:
 *   - `command === 'npx' || command === 'uvx'` → skipped (recipe declares
 *     how to fetch the MCP at runtime; no clone needed at build time).
 *   - strict mode → collected, then ONE error thrown listing every unresolved
 *     `(recipePath, mcpServerName)` pair.
 *   - non-strict mode → emit a sibling-copy entry. Operator must supply a
 *     checkout adjacent to the recipe at build time.
 *
 * A server marked `source: { external: true }` is installed on the host
 * outside cook: it is validated (see `detectExternalServers`) and skipped
 * in both modes — it is never a source.
 */

import { basename, isAbsolute } from 'node:path';
import { assertCredentialFreeSourceUrl } from './source-url.js';
import type {
  ExternalServer,
  InstallPattern,
  McpSource,
  SourceRef,
  WalkResult,
} from './types.js';
import type {
  RecipeMcpServer,
  RecipeMcpServerExternalSource,
  RecipeMcpServerGitSource,
  RecipeMcpServerNpmSource,
  RecipeMcpServerSource,
} from './vendor/recipe.js';

export interface DetectOptions {
  strict: boolean;
}

/**
 * Strip trailing `/` and `.git` for stable deduplication. The original URL
 * is preserved in the McpSource for the Dockerfile generator to consume.
 */
function normalizeUrlForKey(url: string): string {
  let normalized = url.trim();
  // Strip any number of trailing slashes first, then `.git`, then any
  // remaining trailing slash that the .git unmasked. Idempotent.
  normalized = normalized.replace(/\/+$/, '');
  if (normalized.endsWith('.git')) {
    normalized = normalized.slice(0, -4);
  }
  normalized = normalized.replace(/\/+$/, '');
  return normalized;
}

/**
 * Default in-container path: `/${basename(url)}` with `.git` stripped.
 * Examples:
 *   https://github.com/x/zulip_mcp.git → /zulip_mcp
 *   https://github.com/x/zulip_mcp     → /zulip_mcp
 *   https://github.com/x/zulip_mcp/    → /zulip_mcp
 */
function defaultInContainerPath(url: string): string {
  // basename() honors path separators only, so we must trim trailing
  // slashes first to match URLs like `.../foo/`.
  const trimmed = url.trim().replace(/\/+$/, '');
  const withoutGit = trimmed.endsWith('.git') ? trimmed.slice(0, -4) : trimmed;
  const name = basename(withoutGit);
  return `/${name}`;
}

/**
 * Map a recipe-shaped `install` field to our internal `InstallPattern`.
 * `undefined` → custom-with-no-build-step (operator must rely on the source
 * being directly executable, e.g. a precompiled `bin/` checked into git).
 */
function mapInstall(
  install: RecipeMcpServerGitSource['install'] | undefined,
): InstallPattern {
  if (install === 'npm') return { kind: 'npm' };
  if (install === 'pip-editable') return { kind: 'pip-editable' };
  if (install && typeof install === 'object') {
    return { kind: 'custom', run: install.run, runtime: install.runtime };
  }
  return { kind: 'custom', run: '', runtime: 'custom' };
}

/**
 * Equality check between two install patterns. Used only to decide whether
 * to emit a divergence warning when the same source key appears with
 * conflicting metadata across recipes.
 */
function installEquals(a: InstallPattern, b: InstallPattern): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'custom' && b.kind === 'custom') {
    return a.run === b.run && a.runtime === b.runtime;
  }
  if (a.kind === 'sibling-copy' && b.kind === 'sibling-copy') {
    return a.siblingDir === b.siblingDir;
  }
  if (a.kind === 'npm-global' && b.kind === 'npm-global') {
    return a.package === b.package;
  }
  return true; // npm vs npm, pip-editable vs pip-editable
}

function describeInstall(install: InstallPattern): string {
  if (install.kind === 'custom') {
    return `custom(runtime=${install.runtime}, run=${JSON.stringify(install.run)})`;
  }
  if (install.kind === 'sibling-copy') {
    return `sibling-copy(${install.siblingDir})`;
  }
  return install.kind;
}

/** Emit a stderr warning about a metadata conflict. */
function warnConflict(
  key: string,
  field: string,
  first: { ref: SourceRef; value: string },
  next: { ref: SourceRef; value: string },
): void {
  process.stderr.write(
    `[source-detector] WARN: source ${key} has divergent ${field} — ` +
      `${first.ref.recipePath}#${first.ref.mcpServerName} says ${first.value}, ` +
      `${next.ref.recipePath}#${next.ref.mcpServerName} says ${next.value}; ` +
      `keeping the first.\n`,
  );
}

/**
 * Inspect every walker result, every mcpServer entry, and produce the
 * deduplicated list of sources we need at image build time.
 *
 * Throws an aggregated error in strict mode when any mcpServer lacks both
 * `source` and a runtime fetch command (npx/uvx).
 */
export function detectSources(
  walks: WalkResult[],
  options: DetectOptions,
): McpSource[] {
  /** Insertion-ordered map of dedup key → source under construction. */
  const byKey = new Map<string, McpSource>();
  /** Unresolved entries to either error on (strict) or shim (non-strict). */
  const unresolved: Array<{ recipePath: string; mcpServerName: string }> = [];
  // Validates every external marker; those servers are skipped below.
  detectExternalServers(walks);

  for (const walk of walks) {
    const servers = walk.recipe.mcpServers;
    if (!servers) continue;

    for (const [serverName, server] of Object.entries(servers)) {
      const ref: SourceRef = { recipePath: walk.path, mcpServerName: serverName };

      if (server.source && isExternalSource(server.source)) continue;
      if (server.source) {
        if (isNpmRegistrySource(server.source)) {
          addNpmRegistrySource(byKey, server.source, ref);
        } else {
          addSourcedServer(byKey, server.source, ref);
        }
        continue;
      }

      // No source block. Either skip (npx/uvx, or a remote websocket server
      // that the host dials and nothing has to be built) or fall through to
      // unresolved.
      if (isRuntimeFetchCommand(server.command)) continue;
      if (isRemoteWebSocketServer(server)) continue;
      unresolved.push({ recipePath: walk.path, mcpServerName: serverName });
    }
  }

  // Strict mode: aggregate every unresolved entry into a single error so the
  // operator sees them all at once instead of fixing-and-rerunning.
  if (options.strict && unresolved.length > 0) {
    const lines = unresolved
      .map((u) => `  - ${u.recipePath} :: ${u.mcpServerName}`)
      .join('\n');
    throw new Error(
      `Recipe(s) reference MCP servers without a 'source' block (strict mode):\n${lines}\n` +
        `Either add a 'source' block, change the command to 'npx'/'uvx', or rerun without --strict.`,
    );
  }

  // Non-strict mode: turn each unresolved entry into a sibling-copy shim.
  for (const u of unresolved) {
    addSiblingCopySource(byKey, u.recipePath, u.mcpServerName);
  }

  return Array.from(byKey.values());
}

/** Narrow a recipe source to the cook-only external marker. */
function isExternalSource(
  source: RecipeMcpServerSource,
): source is RecipeMcpServerExternalSource {
  return 'external' in source;
}

/**
 * Every server marked `source: { external: true }`, in walk order. The
 * marker only makes sense when the host can launch the server without cook:
 * check the executable and recognized interpreter entry point, not the
 * server's own arguments. Report invalid launches in one aggregated error.
 */
export function detectExternalServers(walks: WalkResult[]): ExternalServer[] {
  const servers: ExternalServer[] = [];
  const problems: string[] = [];
  for (const walk of walks) {
    for (const [name, server] of Object.entries(walk.recipe.mcpServers ?? {})) {
      if (!server.source || !isExternalSource(server.source)) continue;
      const problem = externalServerProblem(server);
      if (problem) problems.push(`  - ${walk.path} :: ${name}: ${problem}`);
      else servers.push({ recipePath: walk.path, name, command: server.command! });
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `MCP server(s) marked source.external are not launchable as installed:\n${problems.join('\n')}\n` +
        `Use a literal absolute command and, for an interpreter script, a literal absolute script path.`,
    );
  }
  return servers;
}

/** Package-manager front ends and their common JavaScript entry points. */
const EXTERNAL_FETCH_TOOLS = new Set(['npx', 'uvx', 'npm', 'pnpm', 'yarn', 'bunx', 'pipx']);

function isFetchTool(entry: string): boolean {
  return EXTERNAL_FETCH_TOOLS.has(basename(entry).replace(/(?:-cli)?\.[cm]?js$/, ''));
}

// Only options that take a separate value need listing. This is not a full
// CLI parser: unlisted leading options are treated as single tokens.
const INTERPRETER_VALUE_FLAGS = new Map<string, readonly string[]>([
  ['node', ['-r', '--require', '--import', '--loader', '--experimental-loader',
    '--env-file', '--env-file-if-exists', '-C', '--conditions']],
  ['bun', ['-r', '--preload', '--require', '--import', '-c', '--config', '--cwd', '--env-file', '--conditions']],
  ['deno', ['-c', '--config', '--import-map', '--env-file', '--location', '--lock']],
  ['python', ['-W', '-X']],
  ['uv', ['--directory', '--project', '--config-file', '--python', '-p', '--with',
    '--with-requirements', '--env-file']],
]);

/** Find the entry-point selector after the interpreter's own flags. */
function launchOperands(
  args: readonly string[],
  valueFlags: readonly string[],
  entryOption?: RegExp,
): readonly string[] {
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--' || arg === '-' || !arg.startsWith('-') || entryOption?.test(arg)) break;
    if (valueFlags.includes(arg)) i++;
  }
  return args.slice(i);
}

function externalServerProblem(server: RecipeMcpServer): string | undefined {
  if (typeof server.command !== 'string' || !server.command || server.url ||
    (server.transport !== undefined && server.transport !== 'stdio')) {
    return 'external requires a stdio command, not a url';
  }
  if (server.args?.some(arg => typeof arg !== 'string')) return 'external args must be strings';

  const command = server.command;
  const name = basename(command);
  const fetchProblem = `command '${command}' fetches at runtime; use an installed server or drop the external marker`;
  if (isFetchTool(command)) return fetchProblem;
  const literalAbsolute = (value: string) => isAbsolute(value) && !value.includes('${');
  if (!literalAbsolute(command)) {
    return `command ${JSON.stringify(command)} must be a literal absolute path`;
  }

  const runtime = name === 'nodejs' ? 'node'
    : /^python(?:\d+(?:\.\d+)?)?$/.test(name) ? 'python'
    : name;
  const valueFlags = INTERPRETER_VALUE_FLAGS.get(runtime);
  if (!valueFlags) return undefined;

  // Inline code and project scripts aren't paths to an installed server.
  const entryOption = runtime === 'python' ? /^-[mc]/
    : runtime === 'node' || runtime === 'bun' ? /^(?:-[ep]|--(?:eval|print|run))(?:=|$)/
    : undefined;
  let operands = launchOperands(server.args ?? [], valueFlags, entryOption);
  if ((runtime === 'bun' || runtime === 'deno') && operands[0] === 'x') return fetchProblem;
  if (runtime === 'uv' && operands[0] === 'tool' &&
    launchOperands(operands.slice(1), valueFlags)[0] === 'run') return fetchProblem;

  if ((runtime !== 'node' && runtime !== 'python' && operands[0] === 'run') ||
    (runtime === 'deno' && operands[0] === 'serve')) {
    operands = launchOperands(operands.slice(1), valueFlags, entryOption);
  }
  const [entry, next] = operands;
  if (runtime === 'python' && entry?.startsWith('-m')) {
    const module = entry.slice(2) || next;
    if (module && /^(?:pipx?|uvx?)(?:\.|$)/.test(module)) return fetchProblem;
    if (module && /^\w+(?:\.\w+)*$/.test(module)) return undefined;
    return 'python -m needs a literal module name';
  }
  const script = entry === '--' ? next : entry;
  if (!entry || !script || entryOption?.test(entry)) return `interpreter '${name}' needs an installed script`;
  if (isFetchTool(script)) return fetchProblem;
  if (!literalAbsolute(script)) return `script ${JSON.stringify(script)} must be a literal absolute path`;
  return undefined;
}

/**
 * Some recipe commands (npx, uvx) fetch and run the MCP server on the fly
 * at runtime — we don't need to clone or install them at image build time.
 */
function isRuntimeFetchCommand(command: string | undefined): boolean {
  return command === 'npx' || command === 'uvx';
}

/**
 * A websocket MCPL server (`url` set, no `command`) is dialed by the host at
 * runtime — there is no checkout to clone, build, or copy next to the recipe.
 * Treating it as unresolved would demand a sibling checkout that can never
 * exist (`sibling checkout not found: <recipe-dir>/<name>`).
 */
function isRemoteWebSocketServer(server: { command?: string; url?: string; transport?: string }): boolean {
  if (server.command) return false;
  return typeof server.url === 'string' && server.url.length > 0;
}

/**
 * Insert (or merge into) the dedup map for a server with an explicit source.
 * First-write-wins on metadata; subsequent divergences are warned.
 */
function addSourcedServer(
  byKey: Map<string, McpSource>,
  source: RecipeMcpServerGitSource,
  ref: SourceRef,
): void {
  assertCredentialFreeSourceUrl(source.url, `${ref.recipePath} :: mcpServers.${ref.mcpServerName}.source.url`);
  const refStr = source.ref ?? 'main';
  const key = `${normalizeUrlForKey(source.url)}@${refStr}`;
  const install = mapInstall(source.install);
  const inContainerPath = source.inContainer?.path ?? defaultInContainerPath(source.url);

  const existing = byKey.get(key);
  if (!existing) {
    const newSource: McpSource = {
      key,
      url: source.url,
      ref: refStr,
      install,
      inContainerPath,
      refs: [ref],
      ...(source.authSecret !== undefined ? { authSecret: source.authSecret } : {}),
      ...(source.sslBypass !== undefined ? { sslBypass: source.sslBypass } : {}),
      ...(source.systemPackages !== undefined ? { systemPackages: source.systemPackages } : {}),
    };
    byKey.set(key, newSource);
    return;
  }

  // Existing entry: append the ref, warn on any metadata divergence, keep
  // first-write-wins semantics.
  const firstRef = existing.refs[0]!;

  if (existing.url !== source.url) {
    warnConflict(
      key,
      'url',
      { ref: firstRef, value: existing.url },
      { ref, value: source.url },
    );
  }
  if (!installEquals(existing.install, install)) {
    warnConflict(
      key,
      'install',
      { ref: firstRef, value: describeInstall(existing.install) },
      { ref, value: describeInstall(install) },
    );
  }
  if ((existing.sslBypass ?? false) !== (source.sslBypass ?? false)) {
    warnConflict(
      key,
      'sslBypass',
      { ref: firstRef, value: String(existing.sslBypass ?? false) },
      { ref, value: String(source.sslBypass ?? false) },
    );
  }
  if ((existing.authSecret ?? '') !== (source.authSecret ?? '')) {
    warnConflict(
      key,
      'authSecret',
      { ref: firstRef, value: existing.authSecret ?? '(none)' },
      { ref, value: source.authSecret ?? '(none)' },
    );
  }
  if (existing.inContainerPath !== inContainerPath) {
    warnConflict(
      key,
      'inContainerPath',
      { ref: firstRef, value: existing.inContainerPath },
      { ref, value: inContainerPath },
    );
  }

  // systemPackages unions across refs rather than first-write-wins: a
  // superset apt install is harmless and is the correct semantics for "what
  // does this source need at runtime" (dropping a later ref's packages would
  // silently ship an image missing a binary — the exact bug this field
  // prevents). deduped + sorted so the generated apt line is stable.
  if (source.systemPackages && source.systemPackages.length > 0) {
    existing.systemPackages = [
      ...new Set([...(existing.systemPackages ?? []), ...source.systemPackages]),
    ].sort();
  }

  existing.refs.push(ref);
}

/** Narrow a recipe source to the npm-registry shape. */
function isNpmRegistrySource(
  source: RecipeMcpServerSource,
): source is RecipeMcpServerNpmSource {
  return 'npm' in source;
}

/**
 * Insert (or merge into) the dedup map for a server whose source is a
 * published npm package. Deduped by the full package spec (`npm:<package>`),
 * so two recipes referencing the same `@scope/pkg@version` collapse onto one
 * `npm install -g` while distinct versions stay separate. No git URL, ref, or
 * in-container path — the package is installed globally in the runtime stage.
 */
function addNpmRegistrySource(
  byKey: Map<string, McpSource>,
  source: RecipeMcpServerNpmSource,
  ref: SourceRef,
): void {
  const key = `npm:${source.npm}`;
  const existing = byKey.get(key);
  if (existing) {
    existing.refs.push(ref);
    return;
  }
  byKey.set(key, {
    key,
    url: '',
    ref: '',
    install: { kind: 'npm-global', package: source.npm },
    inContainerPath: '',
    refs: [ref],
  });
}

/**
 * Sibling-copy fallback: emit one entry per (recipe, server) pair, since we
 * have no URL/ref to dedup on. Key is `sibling:<serverName>`.
 */
function addSiblingCopySource(
  byKey: Map<string, McpSource>,
  recipePath: string,
  serverName: string,
): void {
  const key = `sibling:${serverName}`;
  const ref: SourceRef = { recipePath, mcpServerName: serverName };

  const existing = byKey.get(key);
  if (existing) {
    existing.refs.push(ref);
    return;
  }

  byKey.set(key, {
    key,
    url: '',
    ref: '',
    install: { kind: 'sibling-copy', siblingDir: serverName },
    inContainerPath: `/${serverName}`,
    refs: [ref],
  });
}
