/** Deploy a committed snapshot using Railway's service-scoped build cache. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [project, service, environment = 'production', revision = 'HEAD'] = process.argv.slice(2);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
if (!uuid.test(project ?? '') || !uuid.test(service ?? '')) {
  throw new Error('Usage: node scripts/deploy-railway.mjs PROJECT_UUID SERVICE_UUID [environment] [revision]');
}
const root = resolve(import.meta.dirname, '..');
const sha = execFileSync('git', ['rev-parse', '--verify', `${revision}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
const snapshot = mkdtempSync(join(tmpdir(), 'valet-railway-'));
try {
  const archive = execFileSync('git', ['archive', sha], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', snapshot], { input: archive });
  const dockerfile = join(snapshot, 'docker/Dockerfile.api');
  const source = readFileSync(dockerfile, 'utf8');
  if (!source.includes('id=pnpm-store,')) throw new Error('API cache mount changed; review Railway cache substitution.');
  // Railway requires a literal service ID; Dockerfile ARG interpolation is unsupported.
  writeFileSync(dockerfile, source.replaceAll('id=pnpm-store,', `id=s/${service}-pnpm-store,`));
  console.log(`Deploying ${sha} to ${project}/${service} (${environment})`);
  execFileSync('railway', ['up', snapshot, '--path-as-root', '--project', project,
    '--service', service, '--environment', environment, '--detach'], { stdio: 'inherit' });
} finally {
  rmSync(snapshot, { recursive: true, force: true });
}
