import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectPlan, PlanInspectionError, validatePlanWalks } from './plan.js';
import type { WalkResult } from './types.js';

const walk = (path: string): WalkResult => ({ path, recipe: {
  name: path, agent: { systemPrompt: 'Hello ${PLAN_TEST_VAR}' },
} });
const parent = () => walk('/recipes/parent.json');
const child = () => walk('/recipes/child.json');
const service = { name: 'db', image: 'db:1' };
const template = { hostPath: 'config.json', inContainer: '/config.json', template: '${TOKEN}' };

function failure(walks: WalkResult[], text: string) {
  for (const inspect of [validatePlanWalks, (w: WalkResult[]) => inspectPlan(w, true),
    (w: WalkResult[]) => inspectPlan(w, false)]) {
    expect(() => inspect(walks)).toThrow(PlanInspectionError);
    expect(() => inspect(walks)).toThrow(text);
  }
}

describe('quiet plan inspection', () => {
  const stdout = spyOn(process.stdout, 'write');
  const stderr = spyOn(process.stderr, 'write');
  afterAll(() => { stdout.mockRestore(); stderr.mockRestore(); });
  afterEach(() => {
    expect(stdout).not.toHaveBeenCalled(); expect(stderr).not.toHaveBeenCalled();
    stdout.mockClear(); stderr.mockClear();
  });

  test('empty walk is a typed structural failure', () => {
    failure([], 'walker returned no recipes — internal error');
  });
  test('all filename collisions precede child-only declarations', () => {
    const walks = [parent(), walk('/a/same.json'), walk('/b/same.json'),
      walk('/a/other.json'), walk('/b/other.json')];
    walks[1]!.recipe.services = [service];
    failure(walks, 'recipe filename collision');
    expect(() => inspectPlan(walks, false)).toThrow(PlanInspectionError);
    try { inspectPlan(walks, false); } catch (err) {
      expect((err as PlanInspectionError).messages).toHaveLength(2);
      expect((err as Error).message).not.toContain('declares services');
    }
  });
  test('child services rejected before child templates or detection', () => {
    const c = child();
    c.recipe.services = [service];
    c.recipe.containerTemplateFiles = [template];
    c.recipe.mcpServers = { unresolved: { command: 'node' } };
    failure([parent(), c], 'declares services (sidecars)');
  });
  test('child container templates rejected', () => {
    const c = child(); c.recipe.containerTemplateFiles = [template];
    failure([parent(), c], 'declares containerTemplateFiles');
  });
  test('parent declarations and empty child declarations are accepted', () => {
    const p = parent(); p.recipe.services = [service]; p.recipe.containerTemplateFiles = [template];
    const c = child(); c.recipe.services = []; c.recipe.containerTemplateFiles = [];
    expect(() => validatePlanWalks([p, c])).not.toThrow();
  });
  test('returns sources, git/local extensions and env without output or mutation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cook-inspection-'));
    try {
      writeFileSync(join(dir, 'entry.ts'), 'export {};');
      const p = walk(join(dir, 'root.json'));
      p.recipe.mcpServers = { tool: { command: 'node', source: { url: 'https://example.test/tool.git', install: 'npm' } } };
      p.recipe.extensions = {
        git: { kind: 'module', path: 'index.ts', source: { url: 'https://example.test/ext.git' } },
        local: { kind: 'module', path: './entry.ts' },
      };
      const before = structuredClone(p);
      const result = inspectPlan([p], true);
      expect(result.sources.map(s => s.url)).toEqual(['https://example.test/tool.git', 'https://example.test/ext.git']);
      expect(result.sources[1]?.role).toBe('extension');
      expect(result.localExtensions[0]?.hostDir).toBe(dir);
      expect(result.envVars.map(v => v.name)).toEqual(['PLAN_TEST_VAR']);
      expect(result.warnings).toEqual([]);
      expect(p).toEqual(before);
      expect(stdout).not.toHaveBeenCalled(); expect(stderr).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('returns warnings from both detectors, including non-strict absolute extensions', () => {
    const p = parent(), c = child();
    p.recipe.mcpServers = { a: { source: { url: 'https://example.test/tool.git', install: 'npm' } } };
    c.recipe.mcpServers = { b: { source: { url: 'https://example.test/tool.git', install: 'pip-editable' } } };
    p.recipe.extensions = { ext: { kind: 'module', path: 'a.ts', source: { url: 'https://example.test/ext.git' } } };
    c.recipe.extensions = {
      ext: { kind: 'module', path: 'b.ts', source: { url: 'https://example.test/ext.git', ref: 'v2' } },
      external: { kind: 'module', path: '/external.ts' },
    };
    const result = inspectPlan([p, c], false);
    expect(result.warnings).toHaveLength(4);
    expect(result.warnings[0]).toContain('divergent install');
    expect(result.warnings[3]).toContain('must bind-mount');
    expect(stdout).not.toHaveBeenCalled(); expect(stderr).not.toHaveBeenCalled();
  });
  test('Codex prerequisite warning is returned before detector warnings', () => {
    const p = parent(), c = child();
    p.recipe.agent.provider = 'openai-codex';
    p.recipe.mcpServers = { a: { source: { url: 'https://example.test/tool.git', install: 'npm' } } };
    c.recipe.mcpServers = { b: { source: { url: 'https://example.test/tool.git', install: 'pip-editable' } } };
    const result = inspectPlan([p, c], false);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toBe(
      '! Codex inference requires a codex executable on PATH, writable persistent CODEX_HOME, ' +
      'and codex login in the runtime environment. Cook does not supply these prerequisites.\n',
    );
    expect(result.warnings[1]).toContain('divergent install');
  });
  test('detection failure carries preceding Codex and detector warnings', () => {
    const p = parent(), c = child();
    p.recipe.agent.provider = 'openai-codex';
    p.recipe.mcpServers = { a: { source: { url: 'https://example.test/tool.git', install: 'npm' } } };
    c.recipe.mcpServers = { b: { source: { url: 'https://example.test/tool.git', install: 'pip-editable' } } };
    p.recipe.extensions = { missing: { kind: 'module', path: './missing.ts' } };
    expect(() => inspectPlan([p, c], false)).toThrow(PlanInspectionError);
    try { inspectPlan([p, c], false); } catch (err) {
      const failure = err as PlanInspectionError;
      expect(failure.messages).toHaveLength(1);
      expect(failure.messages[0]).toContain('missing');
      expect(failure.warnings).toHaveLength(2);
      expect(failure.warnings[0]).toContain('Codex inference requires');
      expect(failure.warnings[1]).toContain('divergent install');
    }
  });
  test('structural failure carries the earlier Codex prerequisite warning', () => {
    const p = parent(), c = child();
    p.recipe.agent.provider = 'openai-codex';
    c.recipe.services = [service];
    expect(() => inspectPlan([p, c], false)).toThrow(PlanInspectionError);
    try { inspectPlan([p, c], false); } catch (err) {
      expect((err as PlanInspectionError).warnings).toHaveLength(1);
      expect((err as PlanInspectionError).warnings[0]).toContain('Codex inference requires');
    }
  });
  test('strict unresolved diagnostics retain the complete legacy aggregate', () => {
    const p = parent();
    p.recipe.mcpServers = { first: { command: 'node' }, second: { command: 'node' } };
    expect(() => inspectPlan([p], true)).toThrow(PlanInspectionError);
    try { inspectPlan([p], true); } catch (err) {
      expect((err as PlanInspectionError).messages).toEqual([
        "Recipe(s) reference MCP servers without a 'source' block (strict mode):\n" +
        "  - /recipes/parent.json :: first\n  - /recipes/parent.json :: second\n" +
        "Either add a 'source' block, change the command to 'npx'/'uvx', or rerun without --strict.",
      ]);
      expect((err as PlanInspectionError).warnings).toEqual([]);
    }
  });
  test('strict detection failures are typed, quiet and preserve messages', () => {
    for (const kind of ['source', 'extension']) {
      const p = parent();
      if (kind === 'source') p.recipe.mcpServers = { unresolved: { command: 'node' } };
      else p.recipe.extensions = { external: { kind: 'module', path: '/external.ts' } };
      expect(() => inspectPlan([p], true)).toThrow(PlanInspectionError);
      expect(() => inspectPlan([p], true)).toThrow('strict mode');
    }
    expect(stdout).not.toHaveBeenCalled(); expect(stderr).not.toHaveBeenCalled();
  });
});
