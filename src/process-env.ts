import { execFileSync } from 'node:child_process';
import { repositoryIndependentGitEnv } from './git-env.js';
import type { InstallPlan } from './plan.js';

/** Recipe value names excluded from source-acquisition environments only. */
export function knownSecretEnvironmentNames(plan: InstallPlan): Set<string> {
  const requirements = new Set(plan.requirements.map(r => r.envName));
  return new Set([
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    ...(plan.parentWalk.recipe.services ?? []).flatMap(service => service.secrets ?? []),
    ...plan.sources.flatMap(source => source.authSecret ? [source.authSecret] : []),
    ...plan.credentialFiles.flatMap(file => file.fields.flatMap(field => field.envOverride ? [field.envOverride] : [])),
    ...plan.envVars.filter(variable => !requirements.has(variable.name)).map(variable => variable.name),
    ...Object.keys(plan.values).filter(name => !requirements.has(name)),
  ]);
}

/** Host builds receive only ordinary base settings and explicitly selected
 * parent values. Recipe declarations and resolved values do not participate. */
export function processAllowlistEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowed = new Set([
    'PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM', 'CI', 'USER', 'LOGNAME', 'SHELL',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
    'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
    'PYTHON', 'PKG_CONFIG_PATH', 'CC', 'CXX', 'SSH_AUTH_SOCK',
    'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_COLLATE', 'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME',
    'LC_PAPER', 'LC_NAME', 'LC_ADDRESS', 'LC_TELEPHONE', 'LC_MEASUREMENT', 'LC_IDENTIFICATION',
    'npm_config_registry', 'NPM_CONFIG_REGISTRY', 'PIP_INDEX_URL', 'UV_INDEX_URL',
    'CARGO_HOME', 'RUSTUP_HOME',
  ]);
  const selected = (process.env.COOK_PASS_ENV ?? '').split(/[,\s]+/).filter(Boolean);
  if (selected.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new Error('COOK_PASS_ENV must contain environment variable names, not values.');
  }
  for (const key of selected) allowed.add(key);
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/** Git additionally receives external authentication hooks and configuration channels. */
export function gitEnvironment(base = processAllowlistEnv(), excluded: Iterable<string> = []): NodeJS.ProcessEnv {
  const blocked = new Set(excluded);
  const selected = new Set((process.env.COOK_PASS_ENV ?? '').split(/[,\s]+/).filter(Boolean));
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    if (blocked.has(name) && process.env[name] !== undefined) {
      if (!selected.has(name)) {
        throw new Error(`Recipe secret ${name} collides with Git's helper environment; explicitly select ${name} with COOK_PASS_ENV to forward the parent value, or rename the recipe secret.`);
      }
      blocked.delete(name);
    }
  }
  let env = { ...base };
  for (const key of blocked) delete env[key];
  // Explicit build opt-ins must not redirect Git repositories or bypass its
  // separate authentication/configuration policy. Re-add Git's channels below.
  for (const key of Object.keys(env)) {
    if (/^GCM_/.test(key) || [
      'GH_TOKEN', 'GITHUB_TOKEN', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR',
      'XDG_CONFIG_HOME', 'SSH_ASKPASS', 'COOK_PASS_ENV',
    ].includes(key)) delete env[key];
  }
  // Strip repository-local controls BEFORE restoring indexed operator config
  // and BEFORE sourceGitEnvironment injects a credential.
  env = repositoryIndependentGitEnv(env);
  for (const key of [
    'SSH_AUTH_SOCK', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT',
    'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_TERMINAL_PROMPT',
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_NOSYSTEM', 'XDG_CONFIG_HOME',
    'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'GIT_SSL_CERT', 'GIT_SSL_KEY',
    'GIT_PROXY_SSL_CAINFO', 'GIT_PROXY_SSL_CAPATH', 'GIT_PROXY_SSL_CERT', 'GIT_PROXY_SSL_KEY',
    'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'GH_TOKEN', 'GITHUB_TOKEN',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Copy only indexed entries selected by COUNT; iterate present names rather
  // than an arbitrary count so malformed configuration cannot cause a long loop.
  const count = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GCM_')) env[key] = process.env[key];
    const match = /^GIT_CONFIG_(?:KEY|VALUE)_(\d+)$/.exec(key);
    if (match && Number(match[1]) < count) env[key] = process.env[key];
  }
  for (const key of blocked) delete env[key];
  return env;
}

/** Add a private source's credential only to this action's Git subprocesses. */
export function sourceGitEnvironment(
  url: string, authSecret: string | undefined, values: NodeJS.ProcessEnv = process.env,
  location = 'Source', base?: NodeJS.ProcessEnv, excluded: Iterable<string> = [],
): NodeJS.ProcessEnv {
  const env = gitEnvironment(base, excluded);
  if (!authSecret) return env;
  delete env[authSecret];
  const token = values[authSecret];
  if (!token) throw new Error(`${location}: missing authSecret $${authSecret}.`);
  let origin: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error();
    origin = parsed.origin;
  } catch {
    throw new Error(`${location}: authSecret requires an HTTP(S) source; use external Git authentication for other transports.`);
  }
  const rawCount = env.GIT_CONFIG_COUNT ?? '0';
  const count = Number(rawCount);
  if (!/^\d+$/.test(rawCount) || !Number.isSafeInteger(count) || count > Number.MAX_SAFE_INTEGER - 4) {
    throw new Error(`${location}: authSecret requires a valid GIT_CONFIG_COUNT.`);
  }
  assertAuthGitVersion(env, location);
  env.GIT_CONFIG_COUNT = String(count + 4);
  env[`GIT_CONFIG_KEY_${count}`] = `http.${origin}/.extraHeader`;
  env[`GIT_CONFIG_VALUE_${count}`] = `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`;
  // Keep all three redirect blocks as defense in depth. The exact key beats
  // more-specific operator path config: URL specificity wins before scope/order.
  for (const [index, key] of [
    'http.followRedirects', `http.${origin}/.followRedirects`, `http.${url}.followRedirects`,
  ].entries()) {
    env[`GIT_CONFIG_KEY_${count + 1 + index}`] = key;
    env[`GIT_CONFIG_VALUE_${count + 1 + index}`] = 'false';
  }
  assertUnrewrittenSourceUrl(url, env, location, token);
  return env;
}

/** Resolve fetch rewrites offline using the acquisition environment/config.
 * pushInsteadOf affects pushes only and is intentionally irrelevant here. */
export function assertUnrewrittenSourceUrl(
  url: string, env: NodeJS.ProcessEnv, location: string, token?: string, cwd?: string,
): void {
  let effective: string;
  try {
    effective = execFileSync('git', ['ls-remote', '--get-url', url], {
      env, cwd, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\r?\n$/, '');
  } catch {
    // Do not echo Git diagnostics: configuration can contain other credentials.
    throw new Error(`${location}: E_AUTH_SOURCE_URL_CHECK: could not resolve the source URL offline; no authenticated Git request made.`);
  }
  if (effective !== url) {
    const safeUrl = effective.replace(/(\/\/)[^/?#]*@/g, '$1').replace(/^[^/]*@(?=[^/]+:)/, '');
    const display = gitFailureOutput({ stdout: safeUrl }, token);
    throw new Error(`${location}: E_AUTH_SOURCE_URL_REWRITTEN: the source URL is rewritten by Git configuration to ${display}. Credentials are only sent to the exact URL in the recipe; put the real URL in the recipe or remove the rewrite.`);
  }
}

/** GIT_CONFIG_COUNT is available starting with Git 2.31. Do not try auth on older Git. */
function assertAuthGitVersion(env: NodeJS.ProcessEnv, location: string): void {
  let version: string;
  try {
    version = execFileSync('git', ['--version'], { env, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error(`${location}: authSecret requires Git >= 2.31; git --version failed.`);
  }
  const match = /^git version (\d+)\.(\d+)(?:\.|\s|$)/.exec(version);
  if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 31)) {
    throw new Error(`${location}: authSecret requires Git >= 2.31 (GIT_CONFIG_COUNT support).`);
  }
}

/** Keep useful diagnostics without relaying known private credentials or an
 * exec error's message (which may include the environment/command). */
export function gitFailureOutput(error: unknown, token?: string): string {
  const { stdout, stderr } = error as { stdout?: unknown; stderr?: unknown };
  let output = [stdout, stderr].filter(value => value !== undefined && value !== null).map(String).join('\n').trim();
  if (token) {
    const forms = [token, Buffer.from(token).toString('base64'), Buffer.from(`oauth2:${token}`).toString('base64')]
      .sort((a, b) => b.length - a.length);
    for (const form of forms) output = output.replaceAll(form, '[REDACTED]');
  }
  return output;
}

export const AUTH_REDIRECT_HINT = 'authSecret disables HTTP redirects; put the final URL in the recipe.';
