import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Run in a clean process: no inherited credentials, probes, prompts or network.
// Readable projections and events were recorded from pre-refactor 916cad09
// in a scratch tree, then verified unchanged against the refactored implementation.
const root = resolve(import.meta.dir, '..');
const fixtures = ['triumvirate', 'triumvirate-mid'].flatMap(dir =>
  readdirSync(`${root}/examples/${dir}/recipes`).filter(f => f.endsWith('.json')).sort()
    .map(f => `examples/${dir}/recipes/${f}`),
);
const scratch = '.cache/plan-characterization';
beforeAll(() => {
  const recipe = (extra = {}) => ({ name: 'characterization', agent: { provider: 'openai-codex', systemPrompt: 'test' }, ...extra });
  const write = (path: string, data: unknown) => {
    mkdirSync(resolve(root, scratch, path, '..'), { recursive: true });
    writeFileSync(resolve(root, scratch, path), JSON.stringify(data));
  };
  const service = { name: 'db', image: 'db:1' };
  const template = { hostPath: 'config.json', inContainer: '/config.json', template: '${TOKEN}' };
  write('a/same.json', recipe({ services: [service] }));
  write('b/same.json', recipe());
  write('a/other.json', recipe()); write('b/other.json', recipe());
  write('collisions.json', recipe({ modules: { fleet: { children: ['a/same.json', 'b/same.json', 'a/other.json', 'b/other.json'].map(recipe => ({ name: recipe, recipe })) } } }));
  for (const [name, extra] of Object.entries({ services: { services: [service], containerTemplateFiles: [template] }, templates: { containerTemplateFiles: [template] } })) {
    write(`${name}-child.json`, recipe(extra));
    write(`${name}.json`, recipe({ modules: { fleet: { children: [{ name: 'child', recipe: `${name}-child.json` }] } } }));
  }
  writeFileSync(resolve(root, scratch, 'entry.ts'), 'export {};');
  const source = (install: string) => ({ command: 'node', source: { url: 'https://example.test/tool.git', install } });
  write('warning-success-child.json', recipe({ mcpServers: { tool: source('pip-editable') } }));
  write('warning-success.json', recipe({
    mcpServers: { tool: source('npm') },
    modules: { fleet: { children: [{ name: 'child', recipe: 'warning-success-child.json' }] } },
    extensions: {
      git: { kind: 'module', path: 'index.ts', source: { url: 'https://example.test/ext.git' } },
      local: { kind: 'module', path: './entry.ts' },
    },
  }));
  write('warnings.json', recipe({ extensions: {
    external: { kind: 'module', path: '/external.ts' },
    missing: { kind: 'module', path: './missing.ts' },
  } }));
});
afterAll(() => rmSync(resolve(root, scratch), { recursive: true, force: true }));
const cases = [...fixtures, 'missing-recipe.json', ...['collisions', 'services', 'templates', 'warnings', 'warning-success'].map(f => `${scratch}/${f}.json`)];
for (const fixture of cases) {
  for (const mode of (fixture === fixtures[0] ? ['loose', 'strict', 'missing-env'] : ['loose', 'strict'])) {
    const strict = mode === 'strict';
    const envFile = mode === 'missing-env' ? 'missing-values.env' : undefined;
    test(`resolvePlan main characterization: ${fixture}, mode=${mode}`, () => {
      const script = `
        import { resolvePlan } from './src/plan.ts';
        const events = [];
        process.stdout.write = s => { events.push(['stdout', String(s)]); return true; };
        process.stderr.write = s => { events.push(['stderr', String(s)]); return true; };
        const result = await resolvePlan(${JSON.stringify(fixture)}, {strict: ${strict}, noPrompts: true, envFile: ${JSON.stringify(envFile)}});
        console.log = () => {};
        const plan = result.ok ? {
          sources: result.plan.sources.map(s => ({ key: s.key, url: s.url, ref: s.ref, role: s.role ?? 'mcp', installKind: s.install.kind })),
          localExtensions: result.plan.localExtensions.map(e => ({ name: e.name, entryBasename: e.entryBasename })),
          envVars: result.plan.envVars.map(v => v.name),
          runtimeOnlyVars: result.plan.runtimeOnlyVars,
          credentialFiles: result.plan.credentialFiles.map(f => f.path),
          values: Object.keys(result.plan.values),
          credentialValues: Object.fromEntries(Object.entries(result.plan.credentialValues).map(([path, fields]) => [path, Object.keys(fields)])),
        } : undefined;
        await Bun.write(Bun.stdout, JSON.stringify({events, exitCode: result.ok ? 0 : result.exitCode, plan}));
      `;
      const result = Bun.spawnSync([process.execPath, '-e', script], {
        cwd: root, env: { PATH: process.env.PATH!, HOME: '/nonexistent' },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe('');
      const recorded = JSON.parse(result.stdout.toString().replaceAll(root, '<repo>'));
      expect(JSON.stringify(recorded, null, 2)).toMatchSnapshot();
    });
  }
}
