import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

const workspace = process.argv[2];
if (!workspace || !isAbsolute(workspace))
  throw new Error('Pass the absolute AITestHub platform source root.');

const root = fileURLToPath(new URL('../', import.meta.url));
const localBuild = resolve(root, '.local-build');
await mkdir(localBuild, { recursive: true });
const output = await mkdtemp(resolve(localBuild, 'api-content-'));
const source = resolve(workspace, 'packages/contracts/src');
const definition = resolve(source, 'domain.ts');
execFileSync(
  process.execPath,
  [
    resolve(root, 'node_modules/typescript/bin/tsc'),
    '--ignoreConfig',
    '--target',
    'ES2024',
    '--module',
    'NodeNext',
    '--strict',
    '--rootDir',
    source,
    '--outDir',
    output,
    definition,
  ],
  { cwd: workspace, stdio: 'inherit' },
);

const { apiCaseContentSchema } = await import(
  pathToFileURL(resolve(output, 'domain.js')).href
);
const schema = z.toJSONSchema(apiCaseContentSchema, {
  target: 'draft-2020-12',
  unrepresentable: 'throw',
  io: 'input',
  reused: 'ref',
});
const sourceFiles = ['domain.ts', 'base.ts', 'source-links.ts'];
const sourceHashes = Object.fromEntries(
  await Promise.all(
    sourceFiles.map(async (name) => [
      `packages/contracts/src/${name}`,
      createHash('sha256')
        .update(await readFile(resolve(source, name)))
        .digest('hex'),
    ]),
  ),
);
const projection = {
  component: 'domain.apiCaseContentSchema',
  sourceHashes,
  schema,
};
await writeFile(
  resolve(root, 'src/api-content.contract.json'),
  JSON.stringify(projection, null, 2) + '\n',
);
