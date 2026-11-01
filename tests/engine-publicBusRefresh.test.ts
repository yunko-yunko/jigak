import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { checkedPrivatePath } from '../src/common/engine/intelligence/public-bus-refresh.js';

test('private path check accepts a symlinked root and still refuses writes that escape through a symlink', async () => {
  const base = await realpath(await mkdtemp(resolve(tmpdir(), 'bus-root-link-'))), real = resolve(base, 'real'), outside = resolve(base, 'outside'), link = resolve(base, 'link');
  try {
    await mkdir(real); await mkdir(outside);
    await writeFile(resolve(real, 'a.json'), '{}'); await writeFile(resolve(outside, 'secret.json'), '{}');
    // Windows needs a privilege for symlinks; a junction is the unprivileged directory link realpath follows.
    const dirLink = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(real, link, dirLink);
    await symlink(outside, resolve(real, 'escape'), dirLink);
    const fileLinked = await symlink(resolve(outside, 'secret.json'), resolve(real, 'leak.json')).then(() => true, (error: NodeJS.ErrnoException) => {
      if (process.platform === 'win32' && error.code === 'EPERM') return false;
      throw error;
    });
    const realFile = resolve(real, 'a.json');
    assert.equal(await checkedPrivatePath(link, resolve(link, 'a.json')), realFile);
    assert.equal(await checkedPrivatePath(link, realFile), realFile);
    assert.equal(await checkedPrivatePath(link, resolve(link, 'new.json'), false), resolve(real, 'new.json'));
    await assert.rejects(checkedPrivatePath(link, resolve(outside, 'secret.json')), /outside-private-data/);
    await assert.rejects(checkedPrivatePath(link, resolve(link, 'escape', 'secret.json')), /outside-private-data/);
    await assert.rejects(checkedPrivatePath(link, resolve(link, 'escape', 'new.json'), false), /outside-private-data/);
    if (fileLinked) await assert.rejects(checkedPrivatePath(link, resolve(link, 'leak.json')), /outside-private-data/);
    await assert.rejects(checkedPrivatePath(link, resolve(link, '..', 'outside', 'secret.json')), /outside-private-data/);
  } finally { await rm(base, { recursive: true, force: true }); }
});
