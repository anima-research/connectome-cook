import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as directory from './private-directory.js';
import { layoutTestDirectory } from './test-layout-directory.js';

let dir: string;
beforeEach(() => { dir = layoutTestDirectory('cook-private-policy-'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
test('R4-3 main private-directory API retains dependency symlink policy', () => {
  const target = join(dir, 'target'), link = join(dir, 'link');
  mkdirSync(target, { mode: 0o700 }); symlinkSync(target, link);
  expect(() => directory.provisionPrivateDirectory(link)).not.toThrow();
  expect(directory.resolvePrivateDirectoryPath(link)).toBe(target);
  expect(statSync(target).mode & 0o7777).toBe(0o700);
  expect(() => directory.provisionPrivateDirectory(join(dir, 'bad\\name'))).toThrow('E_PRIVATE_PATH');
});
