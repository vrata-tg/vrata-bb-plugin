import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/check-release.mjs', import.meta.url));

test('release gate checks stable versions, lockfile consistency and main ancestry', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'vrata-release-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const check = (tag, accepted) => {
    const result = spawnSync(process.execPath, [script], {
      cwd, encoding: 'utf8', env: { ...process.env, RELEASE_TAG: tag },
    });
    assert.equal(result.status === 0, accepted, `${tag}: ${result.stderr}`);
  };
  const lock = { version: '1.2.3', packages: { '': { version: '1.2.3' } } };
  const writeLock = () => writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify(lock));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: '@vrata-ai/bb-plugin', version: '1.2.3' }));
  writeLock();
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release@example.invalid');
  git('add', '.');
  git('commit', '-m', 'release');
  git('tag', '-a', 'v1.2.3', '-m', 'release');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '--detach', 'v1.2.3');
  check('v1.2.3', true);
  for (const tag of ['', 'v1.2.4', 'v1.2.3-beta.1', 'v1.2.3+build', 'v01.2.3', '1.2.3']) {
    check(tag, false);
  }
  lock.version = '1.2.2';
  writeLock();
  check('v1.2.3', false);
  lock.version = '1.2.3';
  lock.packages[''].version = '1.2.2';
  writeLock();
  check('v1.2.3', false);
  lock.packages[''].version = '1.2.3';
  writeLock();

  const release = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-m', 'unmerged work');
  check('v1.2.3', false);
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '--detach', release);
  check('v1.2.3', true);
});
