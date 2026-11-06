import type { McpSource } from './types.js';

/** Reject inline credentials before a source URL can reach logs, git, or artifacts. */
export function assertCredentialFreeSourceUrl(url: string, location = 'Source URL'): void {
  const credentialError = () => new Error(`${location}: embedded credentials are not allowed.`);
  // URL() silently trims whitespace and removes some controls. Reject the raw
  // spelling first, before parsing, logging, or passing it to another tool.
  if (url !== url.trim() || /[\x00-\x1f\x7f]/.test(url)) {
    throw new Error(`${location}: source URLs must not contain surrounding whitespace or ASCII controls.`);
  }
  const checkUsername = (value: string) => {
    let username: string;
    try {
      username = decodeURIComponent(value);
    } catch {
      throw new Error(`${location}: invalid source URL; use a URL without embedded credentials.`);
    }
    const tokenPrefix = /^(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-)/i;
    const tokenUser = /^(?:oauth2|x-access-token|x-token-auth)$/i;
    // Reject invisible/format characters after decoding, before token matching.
    // Default-ignorable characters include non-format marks such as U+034F.
    if (/[\p{Cc}\p{Cf}\p{Z}\p{Default_Ignorable_Code_Point}\s]/u.test(username) || username.includes(':') || tokenPrefix.test(username) || tokenUser.test(username)) {
      throw credentialError();
    }
  };
  // Also cover local/scp-style forms that URL() cannot parse.
  const userinfo = url.match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/?#]*)@/i)?.[1];
  if (userinfo) checkUsername(userinfo);
  // Source path derivation does not support URL suffixes.
  if (url.includes('?') || url.includes('#')) {
    throw new Error(`${location}: query strings and fragments are not supported in source URLs.`);
  }
  // URL-shaped spellings must parse or fail, never fall through as paths.
  if (!/^(?:\/\/|[a-z][a-z0-9+.-]*:[/\\])/i.test(url)) return; // Local/scp paths.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Never echo the rejected URL: it may contain a credential.
    throw new Error(`${location}: invalid source URL; use a URL without embedded credentials.`);
  }
  checkUsername(parsed.username);
  checkUsername(parsed.password);
  if (parsed.password) throw credentialError();
}

/** Declaring location, without including potentially unvalidated URL contents. */
export function sourceLocation(source: McpSource): string {
  const ref = source.refs[0];
  if (!ref) return 'Source';
  const section = source.role === 'extension' ? 'extensions' : 'mcpServers';
  return `${ref.recipePath} :: ${section}.${ref.mcpServerName}.source`;
}
