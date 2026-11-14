import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = process.argv[2];
if (!source || !isAbsolute(source))
  throw new Error('Pass an explicit absolute published-schema directory.');
const manifest = JSON.parse(
  await readFile(resolve(source, 'manifest.json'), 'utf8'),
);
if (
  manifest.protocolVersion !== '2026-07-28' ||
  manifest.structuralValidationOnly !== true ||
  manifest.serverRemainsBusinessAuthority !== true ||
  manifest.omittedComponents.length
)
  throw new Error('Unexpected structural snapshot manifest');
const files = {};
for (const name of ['catalog.json', 'components.json']) {
  const bytes = await readFile(resolve(source, name));
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.files[name])
    throw new Error(`Published hash mismatch: ${name}`);
  files[name] = JSON.parse(bytes.toString('utf8'));
}
const names = ['ath_assets', 'ath_reviews', 'ath_operation_status'];
const tools = files['catalog.json'].tools.filter((t) => names.includes(t.name));
if (tools.length !== names.length)
  throw new Error('Missing required published tool schemas');
const componentNames = [
  'assets.assetSchema',
  'domain.apiCaseContentSchema',
  'assets.optimizationNotesInputSchema',
];
const components = Object.fromEntries(
  componentNames.map((name) => {
    const value = files['components.json'].schemas[name];
    if (!value) throw new Error(`Missing published component: ${name}`);
    return [name, value];
  }),
);
const output = {
  provenance: manifest,
  tools,
  components,
};
const root = fileURLToPath(new URL('../', import.meta.url));
await writeFile(
  resolve(root, 'src/published-contracts.json'),
  JSON.stringify(output, null, 2) + '\n',
);
console.log(
  JSON.stringify({
    tools: names,
    components: componentNames,
    sourceHashes: manifest.sourceHashes,
    sourceFileHashes: manifest.files,
    structuralOnly: true,
  }),
);
