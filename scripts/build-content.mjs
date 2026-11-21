import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageMetadata = JSON.parse(
  await readFile(resolve(root, 'package.json'), 'utf8'),
);
const skillRoot = resolve(root, 'skills/ath-case-design');
const paths = [
  'SKILL.md',
  'agents/openai.yaml',
  'references/business-rules.md',
  'references/coverage.md',
  'references/contracts.md',
  'references/review.md',
  'host-adapters/local.md',
  'host-adapters/platform.md',
];
const contents = Object.fromEntries(
  await Promise.all(
    paths.map(async (path) => [
      path,
      await readFile(resolve(skillRoot, path), 'utf8'),
    ]),
  ),
);
contents.LICENSE = await readFile(resolve(root, 'LICENSE'), 'utf8');
for (const [path, content] of Object.entries(contents)) {
  if (/\bTODO\b|\[placeholder\]/i.test(content))
    throw new Error(`Unfinished package file ${path}`);
  for (const match of content.matchAll(/\]\(([^)]+)\)/g))
    if (!/^https?:|^#/.test(match[1]))
      await readFile(resolve(skillRoot, match[1]));
}
const hashes = Object.fromEntries(
  Object.entries(contents).map(([path, content]) => [
    path,
    createHash('sha256').update(content).digest('hex'),
  ]),
);
const publishedBytes = await readFile(
  resolve(root, 'src/published-contracts.json'),
);
const published = JSON.parse(publishedBytes.toString('utf8'));
const apiContentBytes = await readFile(
  resolve(root, 'src/api-content.contract.json'),
);
const apiContent = JSON.parse(apiContentBytes.toString('utf8'));
const manifest = {
  schemaVersion: 'ath.skill-manifest.v1',
  skillId: 'ath-case-design',
  skillVersion: packageMetadata.version,
  compatibleContracts: ['ath.contracts.v1'],
  draftSchema: 'ath.case-design.draft.v2',
  outboxSchema: 'ath.case-design.outbox.v2',
  hosts: ['local', 'platform-content'],
  requiredCapabilities: [
    'explicit-source-reading',
    'private-durable-store',
    'aitesthub-business-tools',
  ],
  optionalCapabilities: ['official-mcp-human-confirmation'],
  implemented: [
    'ui-drafts',
    'independent-sets-and-scenarios',
    'existing-ui-case-revisions',
    'per-opinion-notes',
    'durable-outbox',
    'original-operation-lookup',
    'api-business-proposals',
    'provided-api-content-submission',
    'source-opinion-to-actual-written-revision-cas',
    'ui-business-steps',
    'official-mcp-ui-meeting-handoff-and-reply',
  ],
  outsideScope: [
    'api-executable-generation',
    'test-execution',
    'approval',
    'authentication',
    'http-transport',
    'network-retry',
  ],
  unverified: [
    'official-mcp-live',
    'model-output',
    'host-installation',
    'platform-loading',
    'human-review-ui',
    'file-channel',
  ],
  schemaValidation:
    'published-tool-inputs-and-asset-structure; server-refinements-and-authorization-remain-authoritative',
  contractSnapshot: {
    sha256: createHash('sha256').update(publishedBytes).digest('hex'),
    sourceFileHashes: published.provenance.files,
    sourceHashes: published.provenance.sourceHashes,
    currentApiContent: {
      sha256: createHash('sha256').update(apiContentBytes).digest('hex'),
      component: apiContent.component,
      sourceHashes: apiContent.sourceHashes,
    },
  },
  files: hashes,
};
const manifestText = JSON.stringify(manifest, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (
    (await readFile(resolve(skillRoot, 'LICENSE'), 'utf8')) !== contents.LICENSE
  )
    throw new Error('Packaged license differs from root license');
  if (
    (await readFile(resolve(skillRoot, 'manifest.json'), 'utf8')) !==
    manifestText
  )
    throw new Error(
      'Manifest differs from current rule sources; rebuild first',
    );
} else {
  await writeFile(resolve(skillRoot, 'LICENSE'), contents.LICENSE);
  await writeFile(resolve(skillRoot, 'manifest.json'), manifestText);
  await mkdir(resolve(root, 'dist'), { recursive: true });
  await mkdir(resolve(root, 'dist/src'), { recursive: true });
  // Preserve the imported immutable bytes; TypeScript's JSON emit reformats whitespace.
  await writeFile(
    resolve(root, 'dist/src/published-contracts.json'),
    publishedBytes,
  );
  await writeFile(
    resolve(root, 'dist/src/api-content.contract.json'),
    apiContentBytes,
  );
  await writeFile(
    resolve(root, 'dist/rules.js'),
    `// Generated from the single skill rule source; no runtime I/O.\nexport const skillManifest = ${JSON.stringify(manifest)};\nexport const skillContents = ${JSON.stringify(contents)};\n`,
  );
  await writeFile(
    resolve(root, 'dist/rules.d.ts'),
    'export declare const skillManifest: {skillId: string; skillVersion: string; files: Record<string,string>};\nexport declare const skillContents: Readonly<Record<string,string>>;\n',
  );
}
console.log(
  JSON.stringify({
    checkedFiles: Object.keys(contents).length,
    skillId: manifest.skillId,
    version: manifest.skillVersion,
    mode: process.argv.includes('--check') ? 'check' : 'build',
  }),
);
