import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const metadata = JSON.parse(
  await readFile(resolve(root, 'package.json'), 'utf8'),
);
const version = metadata.version,
  tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
const temporary = await mkdtemp(
  resolve(tmpdir(), `ath-s01-${version}-package-`),
);
const hashes = {};
for (const [kind, name, prefix] of [
  ['library', `aitesthub-case-design-skill-${version}.tgz`, 'package/'],
  ['skill', `ath-case-design-${version}.zip`, 'ath-case-design/'],
]) {
  const archive = resolve(root, 'dist/packages', name),
    bytes = await readFile(archive);
  hashes[name] = {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
  const entries = execFileSync(tar, ['-t', '-f', archive], { encoding: 'utf8' })
    .trim()
    .split(/\r?\n/);
  assert.ok(
    entries.every(
      (path) =>
        path.startsWith(prefix) &&
        !path.split('/').includes('..') &&
        !/^(?:\/|[A-Za-z]:)/.test(path),
    ),
  );
  assert.ok(
    !entries.some((path) =>
      /(?:^|\/)(?:tests|test-results|releases|design|\.env|secrets|node_modules)(?:\/|$)/.test(
        path,
      ),
    ),
  );
  const destination = resolve(temporary, kind);
  await mkdir(destination);
  execFileSync(tar, ['-x', '-f', archive, '-C', destination], {
    stdio: 'pipe',
  });
}
const pkg = resolve(temporary, 'library/package'),
  skill = resolve(temporary, 'skill/ath-case-design');
const packedMetadata = JSON.parse(
  await readFile(resolve(pkg, 'package.json'), 'utf8'),
);
assert.equal(packedMetadata.version, version);
assert.equal(packedMetadata.dependencies.zod, '4.6.7');
// Dependency supplied only to this private extraction check; no user/Skill installation.
await mkdir(resolve(pkg, 'node_modules'));
await cp(resolve(root, 'node_modules/zod'), resolve(pkg, 'node_modules/zod'), {
  recursive: true,
  dereference: true,
});
const runtime = await import(
  pathToFileURL(resolve(pkg, 'dist/src/index.js')).href
);
const rules = await import(pathToFileURL(resolve(pkg, 'dist/rules.js')).href);
assert.equal(typeof runtime.CaseDesignWorkflow, 'function');
assert.equal(runtime.DRAFT_VERSION, 'ath.case-design.draft.v2');
assert.equal(rules.skillManifest.skillVersion, version);
const manifest = JSON.parse(
  await readFile(resolve(skill, 'manifest.json'), 'utf8'),
);
assert.deepEqual(rules.skillManifest, manifest);
for (const [name, content] of Object.entries(rules.skillContents)) {
  assert.equal(await readFile(resolve(skill, name), 'utf8'), content);
  assert.equal(
    createHash('sha256').update(content).digest('hex'),
    manifest.files[name],
  );
}
assert.equal(
  await readFile(resolve(pkg, 'dist/src/published-contracts.json'), 'utf8'),
  await readFile(resolve(root, 'src/published-contracts.json'), 'utf8'),
);
assert.equal(
  await readFile(resolve(pkg, 'LICENSES/zod-4.6.7-LICENSE'), 'utf8'),
  await readFile(resolve(root, 'node_modules/zod/LICENSE'), 'utf8'),
);
const preserved = JSON.parse(
  await readFile(resolve(root, 'releases/0.1.0/inventory.json'), 'utf8'),
);
// The archive has no dependency on the current build; verify each preserved original.
const inventory = preserved.copiedFiles;
for (const file of inventory) {
  const path = file.source;
  const bytes = await readFile(resolve(root, 'releases/0.1.0', path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
}
const evidence = {
  version,
  packageHashes: hashes,
  extractionDirectory: temporary,
  runtimeImport: true,
  ruleFileParity: true,
  contractBytesParity: true,
  licenseParity: true,
  preserved010: true,
  hostInstalls: 0,
  livePlatformCalls: 0,
  modelCalls: 0,
  egoCalls: 0,
  dependencyCheck:
    'Zod copied to private temporary extraction only; no package manager installation',
};
const path = resolve(
  root,
  `dist/packages/package-verification-${version}.json`,
);
await mkdir(dirname(path), { recursive: true });
await writeFile(path, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence));
