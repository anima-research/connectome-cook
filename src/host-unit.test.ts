import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderUserUnit, validateUserUnit } from './host-unit.js';

test('R1-1: WorkingDirectory is bare with only percent escaped; ExecStart stays quoted', () => {
  const path = '/srv/example %h "quoted"\\root/$HOME';
  const unit = renderUserUnit(path);
  expect(unit.split('\n').find(line => line.startsWith('WorkingDirectory=')))
    .toBe('WorkingDirectory=' + path.replace(/%/g, '%%'));
  expect(unit).toContain('ExecStart=/bin/bash "/srv/example %%h \\"quoted\\"\\\\root/$$HOME/run.sh" --headless');
  expect(unit).not.toContain('Environment=');
});
test('R1-1: unit renderer refuses relative, control and trailing-whitespace paths', () => {
  for (const path of ['relative', '/srv/a\nb', '/srv/a\0b', '/srv/a\tb', '/srv/a\rb', '/srv/a\x7fb', ' /srv/a', '/srv/a ', '/srv/a\u00a0']) {
    expect(() => renderUserUnit(path)).toThrow('E_HOST_UNIT');
  }
});
test('R1-3: unit names have a 255-byte bound and reject paths/templates', () => {
  expect(() => validateUserUnit('a'.repeat(247) + '.service')).not.toThrow();
  for (const name of ['a'.repeat(248) + '.service', '../a.service', 'a.socket', 'a@b.service', '', 'a\n.service', 'a.service\n']) {
    expect(() => validateUserUnit(name)).toThrow('E_HOST_UNIT');
  }
});
test('R1-5: unit orders after network-online without enabling or starting anything', () => {
  const unit = renderUserUnit('/srv/example');
  expect(unit).toContain('After=network-online.target');
  expect(unit).not.toContain('EnvironmentFile=');
});

// Probe a known-good unit first: missing systemd/user-manager support is a
// reason to skip, but a failure parsing our generated unit must never be one.
function verify(unit: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cook-unit-parser-'));
  try {
    const file = join(dir, 'example.service');
    writeFileSync(file, unit);
    return spawnSync('systemd-analyze', ['--user', 'verify', file], { encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const probe = verify('[Service]\nExecStart=/bin/true\n');
const skipReason = probe.error ? probe.error.message
  : probe.status !== 0 ? (probe.stderr.trim() || 'systemd user verification unavailable') : undefined;
if (skipReason) console.warn('SKIP systemd parser tests: ' + skipReason);
const parserTest = skipReason ? test.skip : test;
parserTest('R1-1 parser: systemd-analyze --user verify accepts generated special paths' + (skipReason ? ' (skip: ' + skipReason + ')' : ''), () => {
  for (const path of ['/srv/ordinary', '/srv/space path', '/srv/percent %h', '/srv/unicode λ雪', '/srv/example %h "quoted"\\root/$HOME']) {
    const result = verify(renderUserUnit(path));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  }
});
parserTest('R1-1 parser: systemd rejects quoted WorkingDirectory (negative control)' + (skipReason ? ' (skip: ' + skipReason + ')' : ''), () => {
  const unit = renderUserUnit('/srv/example').replace(/^WorkingDirectory=.*$/m, 'WorkingDirectory="/srv/example"');
  const result = verify(unit);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('WorkingDirectory= path is not absolute');
});

test('R2: unit renderer refuses terminal backslashes, including even runs', () => {
  for (const count of [1, 2, 3]) {
    expect(() => renderUserUnit('/srv/end' + '\\'.repeat(count)))
      .toThrow('E_HOST_UNIT: installation path must not end in a backslash');
  }
});
parserTest('R2 parser: terminal backslash consumes ExecStart (negative control)', () => {
  const path = '/srv/end' + '\\';
  // Bypass validation only to demonstrate why this input must be refused.
  const unit = renderUserUnit('/srv/safe').replace('WorkingDirectory=/srv/safe', 'WorkingDirectory=' + path);
  const result = verify(unit);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Service has no ExecStart=');
  expect(() => renderUserUnit(path)).toThrow('E_HOST_UNIT');
});
