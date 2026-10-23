import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/prepare-release.mjs', import.meta.url));

test('release preparation bumps both manifests and rejects invalid or reused versions before changes', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'vrata-release-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const run = (version) => spawnSync(process.execPath, [script], {
    cwd, encoding: 'utf8', env: { ...process.env, RELEASE_VERSION: version },
  });
  const read = (name) => JSON.parse(readFileSync(join(cwd, name), 'utf8'));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: '@vrata-ai/bb-plugin', version: '1.2.3' }));
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify({
    name: '@vrata-ai/bb-plugin', version: '1.2.3', lockfileVersion: 3,
    packages: { '': { name: '@vrata-ai/bb-plugin', version: '1.2.3' } },
  }));
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release@example.invalid');
  git('add', '.');
  git('commit', '-m', 'initial version');
  git('tag', 'v1.2.4');
  const head = git('rev-parse', 'HEAD');

  for (const version of ['', 'v1.2.5', '1.2.5-beta.1', '1.2.5+build', '01.2.5', 'patch', '1.2.3', '1.1.9', '1.2.4']) {
    const result = run(version);
    assert.notEqual(result.status, 0, `Must reject ${version}`);
    assert.equal(git('status', '--porcelain'), '', `Must not modify files for ${version}`);
  }
  for (const version of ['1.2.5', '1.10.0', '2.0.0']) {
    const result = run(version);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(read('package.json').version, version);
    const lock = read('package-lock.json');
    assert.equal(lock.version, version);
    assert.equal(lock.packages[''].version, version);
    assert.equal(git('rev-parse', 'HEAD'), head, 'Preparation must not commit before checks');
    assert.equal(git('tag', '--list'), 'v1.2.4', 'Preparation must not create a tag before checks');
  }
});
