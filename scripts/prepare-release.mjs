import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const version = process.env.RELEASE_VERSION ?? '';
assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Version must be X.X.X');

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const current = manifest.version.split('.').map(BigInt);
const next = version.split('.').map(BigInt);
const changed = next.findIndex((part, index) => part !== current[index]);
assert.ok(changed !== -1 && next[changed] > current[changed], 'Version must be newer than package.json');
assert.equal(execFileSync('git', ['tag', '--list', `v${version}`], { encoding: 'utf8' }).trim(), '', 'Release tag already exists');

const windows = process.platform === 'win32';
const result = spawnSync(windows ? 'npm.cmd' : 'npm',
  ['version', version, '--no-git-tag-version', '--ignore-scripts'], { stdio: 'inherit', shell: windows });
if (result.error) throw result.error;
assert.equal(result.status, 0, 'npm version failed');
