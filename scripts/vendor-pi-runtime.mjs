import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, 'packaging/pi');
const provenance = JSON.parse(await readFile(join(output, 'provenance.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const piPackage = 'node_modules/@earendil-works/pi-coding-agent';
const sourcePaths = new Map();
for (const source of provenance.sources) {
  const nested = `${piPackage}/node_modules/${source.name}`;
  const path = lock.packages[nested] ? nested : `node_modules/${source.name}`;
  const pinned = lock.packages[path];
  for (const key of ['version', 'resolved', 'integrity']) {
    if (pinned?.[key] !== source[key]) throw new Error(`Pinned Pi source changed: ${source.name} ${key}`);
  }
  sourcePaths.set(source.name, path);
}

// Reinstall from the lock in isolation; never read a global or mutated installation.
const staging = await mkdtemp(join(tmpdir(), 'vrata-vendor-pi-'));
try {
  for (const file of ['package.json', 'package-lock.json']) {
    await copyFile(join(root, file), join(staging, file));
  }
  const installed = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: staging, stdio: 'inherit', shell: process.platform === 'win32' });
  if (installed.error) throw installed.error;
  if (installed.status !== 0) throw new Error(`Isolated npm ci failed: ${installed.status}`);

  const files = new Map();
  async function addFile(source, target) {
    files.set(target, await readFile(source));
  }
  async function addTree(source, target) {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const path = join(source, entry.name);
      const destination = `${target}/${entry.name}`;
      if (entry.isDirectory()) await addTree(path, destination);
      else if (entry.isFile()) {
        if (!/(?:\.map|\.d\.(?:ts|cts|mts))$/.test(entry.name)) await addFile(path, destination);
      } else throw new Error(`Unexpected runtime symlink: ${path}`);
    }
  }
  const pi = join(staging, piPackage);
  for (const directory of ['dist/bundle', 'dist/core/export-html', 'dist/modes/interactive/theme',
    'dist/modes/interactive/assets', 'docs', 'examples', 'schemas']) {
    await addTree(join(pi, directory), directory);
  }
  for (const file of ['package.json', 'README.md', 'CHANGELOG.md']) await addFile(join(pi, file), file);
  for (const source of provenance.sources) {
    if (source.name !== '@earendil-works/pi-coding-agent') {
      await addTree(join(staging, sourcePaths.get(source.name)), `node_modules/${source.name}`);
    }
  }
  for (const [source, target] of [['LICENSE', 'LICENSE'], ['NOTICE.md', 'NOTICE.md'],
    ['license-sources.json', 'LICENSE-SOURCES.json'], ['provenance.json', 'PROVENANCE.json']]) {
    await addFile(join(output, source), target);
  }
  const sorted = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const digest = createHash('sha256');
  const entries = [];
  let sourceBytes = 0;
  for (const [path, bytes] of sorted) {
    digest.update(JSON.stringify([path, bytes.byteLength])).update(bytes);
    const text = bytes.toString('utf8');
    const encoding = Buffer.from(text, 'utf8').equals(bytes) ? 'utf8' : 'base64';
    entries.push([path, [encoding, bytes.toString(encoding)]]);
    sourceBytes += bytes.byteLength;
  }
  const sha256 = digest.digest('hex');
  const archive = brotliCompressSync(Buffer.from(JSON.stringify(Object.fromEntries(entries))), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 9 },
  });
  await writeFile(join(output, 'runtime.json.br'), archive);
  await writeFile(join(output, 'runtime-meta.json'), JSON.stringify({ version: provenance.version, sha256 }) + '\n');
  console.log(JSON.stringify({ version: provenance.version, files: files.size, sourceBytes,
    archiveBytes: archive.byteLength, sha256 }, null, 2));
} finally {
  await rm(staging, { recursive: true, force: true });
}
