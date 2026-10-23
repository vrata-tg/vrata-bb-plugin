import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tag = process.env.RELEASE_TAG ?? '';
assert.match(tag, /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Release tag must be vX.X.X');

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
assert.equal(tag, `v${manifest.version}`, 'Release tag must match package.json version');
assert.equal(lock.version, manifest.version, 'Lockfile version must match package.json');
assert.equal(lock.packages[''].version, manifest.version, 'Lockfile root version must match package.json');

execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { stdio: 'inherit' });
console.log(`Validated ${manifest.name}@${manifest.version} on main`);
