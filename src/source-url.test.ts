import { expect, test } from 'bun:test';
import { assertCredentialFreeSourceUrl } from './source-url.js';

const USERNAME_RULE = 'username must be non-empty and contain only ASCII letters, digits, ".", "_" and "-" after percent-decoding';

// Include ordinary non-ASCII text without a token: token detection must not
// substitute for the username allowlist.
for (const char of ['\u200b', '\u200c', '\u200d', '\u180e', '\ufeff',
  '\u0301', '\u0300', '\u20dd', 'ｇ', 'é', ' ', '\t', '\n', '\u0000', '\u007f']) {
  for (const spelling of [char, encodeURIComponent(char)]) {
    test(`R3 allowlist: reject U+${char.codePointAt(0)!.toString(16)} ${spelling === char ? 'literal' : 'encoded'}`, () => {
      for (const username of [`${spelling}user`, `${spelling}ghp_CANARY123`]) {
        expect(() => assertCredentialFreeSourceUrl(`https://${username}@host/repo`)).toThrow(
          /[\x00-\x1f\x7f]/.test(spelling) ? 'ASCII controls' : USERNAME_RULE,
        );
      }
    });
  }
}

for (const username of ['', '%25', '%2520', 'user%2F%2Fname', 'user%40name', 'user+name', 'user%3Aname']) {
  test(`R3 allowlist: reject empty or disallowed ASCII username ${username}`, () => {
    expect(() => assertCredentialFreeSourceUrl(`https://${username}@host/repo`)).toThrow(USERNAME_RULE);
  });
}

test('R3 allowlist: protocol-relative spellings name the explicit-scheme rule', () => {
  for (const url of ['//host/repo', '//user@host/repo', '//ghp_CANARY123@host/repo']) {
    expect(() => assertCredentialFreeSourceUrl(url)).toThrow('use an explicit scheme');
  }
});

for (const prefix of ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'glpat-']) {
  test(`R3 token anywhere: reject mid-username ${prefix} case-insensitively after decoding`, () => {
    for (const token of [prefix, prefix.toUpperCase(), `%${prefix.charCodeAt(0).toString(16)}${prefix.slice(1)}`]) {
      expect(() => assertCredentialFreeSourceUrl(`https://user-${token}CANARY123@host/repo`))
        .toThrow('embedded credentials are not allowed.');
    }
  });
}

test('R3 allowlist: keep valid transports and percent-encoded ASCII usernames', () => {
  for (const url of ['git@host:org/repo', 'ssh://git@host/org/repo', 'https://host/org/repo',
    'http://host/org/repo', 'https://user-name.1@host/org/repo',
    'https://%75ser-name%2E1@host/org/repo', 'https://USER_name-1@host/org/repo']) {
    expect(() => assertCredentialFreeSourceUrl(url)).not.toThrow();
  }
});

test('R3 passwords: refuse any HTTP(S) password component, even empty, with the existing error', () => {
  for (const scheme of ['http', 'https']) {
    for (const password of ['', 'ordinary', '%CC%81', '%', 'ghp_CANARY123']) {
      expect(() => assertCredentialFreeSourceUrl(`${scheme}://user:${password}@host/repo`))
        .toThrow('Source URL: embedded credentials are not allowed.');
    }
  }
});

test('R3 allowlist: URL normalization cannot hide empty userinfo or password components', () => {
  for (const start of ['https:///', 'http:////', 'https:/\\']) {
    expect(() => assertCredentialFreeSourceUrl(`${start}@host/repo`)).toThrow(USERNAME_RULE);
    expect(() => assertCredentialFreeSourceUrl(`${start}user:@host/repo`))
      .toThrow('Source URL: embedded credentials are not allowed.');
  }
});
