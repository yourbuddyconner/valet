/** Run with mise exec node@22 -- node scripts/rollback/check-thread-rollback.mjs. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const baseline = process.argv[2] ?? 'd3e9ede2e7788314dcbd319bfa9aaaa343d21b6a';
const sha = execFileSync('git', ['rev-parse', `${baseline}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
const scratch = mkdtempSync(join(tmpdir(), 'valet-thread-rollback-'));
const old = join(scratch, 'baseline');
mkdirSync(old);
const archive = execFileSync('git', ['archive', sha], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
execFileSync('tar', ['-x', '-C', old], { input: archive });
// Only external dependencies are shared. All Valet imports resolve inside each source tree.
symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'));
const require = createRequire(join(root, 'packages/api/package.json'));
const { build } = require('esbuild');
const { inlineAssetsPlugin } = await import(pathToFileURL(join(root, 'packages/api/build/inline-assets.mjs')));
const fixture = readFileSync(join(root, 'scripts/rollback/probe.ts'), 'utf8');
for (const [label, tree] of [['old', old], ['new', root]]) {
  const entry = join(scratch, `${label}.ts`);
  writeFileSync(entry, fixture.replaceAll('__SOURCE__', tree));
  await build({ entryPoints: [entry], outfile: join(scratch, `${label}.mjs`), bundle: true,
    platform: 'node', format: 'esm', target: 'node22', packages: 'external',
    plugins: [{ name: 'versioned-workspace', setup(builder) {
      builder.onResolve({ filter: /^@valet\// }, ({ path }) => {
        const [, name, ...subpath] = path.split('/');
        const packageRoot = join(tree, 'packages', name);
        const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
        const exp = pkg.exports?.[subpath.length ? `./${subpath.join('/')}` : '.'];
        const target = typeof exp === 'string' ? exp : exp?.import ?? pkg.main;
        return { path: resolve(packageRoot, target.replace(/^\.\/dist\//, './src/').replace(/\.js$/, '.ts')) };
      });
    } }, inlineAssetsPlugin], logLevel: 'warning' });
}
console.log(JSON.stringify({ baseline: sha, current: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), scratch }));
for (const [binary, phase] of [['old', 'seed'], ['new', 'upgrade'], ['old', 'rollback'], ['new', 'verify']]) {
  const result = spawnSync(process.execPath, [join(scratch, `${binary}.mjs`), join(scratch, 'pg'), phase], { encoding: 'utf8' });
  writeFileSync(join(scratch, `${phase}.log`), result.stdout + result.stderr);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`${phase} failed; evidence retained at ${scratch}`);
}
console.log(`PASS: four independent compiled processes reopened one isolated database. Evidence: ${scratch}`);
