import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = resolve(root, 'dist/packages');
const manifest = JSON.parse(
  await readFile(resolve(root, 'skills/ath-case-design/manifest.json'), 'utf8'),
);
await mkdir(destination, { recursive: true });
const archive = resolve(
  destination,
  `ath-case-design-${manifest.skillVersion}.zip`,
);
const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
// Development-time packaging only; this script is not distributed as a Skill tool.
execFileSync(
  tar,
  ['-a', '-c', '-f', archive, '-C', resolve(root, 'skills'), 'ath-case-design'],
  { stdio: 'pipe' },
);
const entries = execFileSync(tar, ['-t', '-f', archive], { encoding: 'utf8' })
  .trim()
  .split(/\r?\n/);
if (
  entries.some(
    (name) =>
      !name.startsWith('ath-case-design/') ||
      name.includes('..') ||
      name.startsWith('/'),
  )
)
  throw new Error('Unexpected archive path');
const archiveBytes = await readFile(archive);
if (archiveBytes[0] !== 0x50 || archiveBytes[1] !== 0x4b)
  throw new Error(
    'This packaging host did not produce ZIP; use a ZIP-capable bsdtar host.',
  );
const evidence = {
  skillId: manifest.skillId,
  version: manifest.skillVersion,
  archive: `dist/packages/ath-case-design-${manifest.skillVersion}.zip`,
  sha256: createHash('sha256').update(archiveBytes).digest('hex'),
  entries,
  installsPerformed: 0,
  providerCallsPerformed: 0,
};
await writeFile(
  resolve(destination, 'skill-package.json'),
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(
  // Versioned evidence preserves previous release facts as well as the latest alias.
  JSON.stringify({
    archive: evidence.archive,
    sha256: evidence.sha256,
    entries: entries.length,
    installsPerformed: 0,
  }),
);
await writeFile(
  resolve(destination, `skill-package-${manifest.skillVersion}.json`),
  JSON.stringify(evidence, null, 2) + '\n',
);
