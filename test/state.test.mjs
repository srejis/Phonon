import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerProject, listProjects, getProject, projectDir, readLatest, writeLatest, writeFailure, acquireLock, releaseLock } from '../src/state.mjs';

const root = path.resolve(import.meta.dirname, '..');
const fixtureRoot = path.join(root, '.local', 'test-fixtures', 'state-regression', 'run-' + process.pid + '-' + Date.now());
fs.mkdirSync(path.join(fixtureRoot, 'source-a'), { recursive: true });
fs.mkdirSync(path.join(fixtureRoot, 'source-b'), { recursive: true });

// These are empty, owned fixture directories, not copies of external source projects.
const a = registerProject('State fixture A', path.join(fixtureRoot, 'source-a'));
const b = registerProject('State fixture B', path.join(fixtureRoot, 'source-b'));

test('two projects register separately and the same real source path reuses identity', () => {
  assert.notEqual(a.id, b.id);
  assert.equal(registerProject('Alternative label', path.join(fixtureRoot, 'source-a', '..', 'source-a')).id, a.id);
  assert.equal(listProjects().filter(project => [a.id, b.id].includes(project.id)).length, 2);
  assert.deepEqual(getProject(a.id), a);
  assert.equal(getProject(b.id).sourcePath, fs.realpathSync(path.join(fixtureRoot, 'source-b')));
  assert.throws(() => getProject('f'.repeat(32)), /Unknown project/);
});

test('state is isolated and an unsaved project returns null', () => {
  assert.equal(readLatest(a.id), null);
  assert.equal(readLatest(b.id), null);
  const snapshotA = { status: 'complete', nodes: [{ id: 'A', input: ['value'] }] };
  const snapshotB = { status: 'complete', nodes: [{ id: 'B', output: ['result'] }] };
  writeLatest(a.id, snapshotA);
  writeLatest(b.id, snapshotB);
  assert.deepEqual(readLatest(a.id), snapshotA);
  assert.deepEqual(readLatest(b.id), snapshotB);
});

test('recording failure and a failed serialization preserve the previous normal snapshot', () => {
  const previous = { status: 'complete', marker: 'last-good' };
  writeLatest(a.id, previous);
  const failure = { status: 'failed', reason: 'fixture failure', runId: 'test-run' };
  const failurePath = writeFailure(a.id, failure);
  assert.deepEqual(JSON.parse(fs.readFileSync(failurePath, 'utf8')), failure);
  assert.equal(path.dirname(failurePath), path.join(projectDir(a.id), 'failures'));
  assert.deepEqual(readLatest(a.id), previous);
  const circular = {}; circular.self = circular;
  assert.throws(() => writeLatest(a.id, circular), /circular/i);
  assert.deepEqual(readLatest(a.id), previous);
  assert.equal(fs.readdirSync(projectDir(a.id)).filter(name => name.endsWith('.tmp')).length, 0);
});

test('exclusive locks reject a second process and release permits the next run', () => {
  acquireLock(a.id);
  try {
    assert.throws(() => acquireLock(a.id), /already running/);
    const importUrl = new URL('../src/state.mjs', import.meta.url).href;
    const code = `import {acquireLock} from ${JSON.stringify(importUrl)}; try {acquireLock(${JSON.stringify(a.id)}); process.exit(2);} catch(e) { if(!e.message.includes('already running')) throw e; }`;
    const second = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    // Independent projects can run at the same time.
    acquireLock(b.id);
    releaseLock(b.id);
  } finally { releaseLock(a.id); }
  acquireLock(a.id);
  releaseLock(a.id);
  assert.throws(() => releaseLock(a.id), /No lock owned/);
});

test('path traversal, absolute ids and sources outside D project are rejected', () => {
  const badIds = ['../outside', '..\\outside', 'D:\\outside', a.id + '/..', '', null];
  for (const id of badIds) {
    for (const operation of [getProject, projectDir, readLatest, acquireLock]) assert.throws(() => operation(id), /Invalid project id/);
    assert.throws(() => writeLatest(id, { status: 'complete' }), /Invalid project id/);
    assert.throws(() => writeFailure(id, { reason: 'failure' }), /Invalid project id/);
  }
  assert.throws(() => registerProject('Outside source', 'C:\\Windows'), /inside D/);
  assert.throws(() => registerProject('File source', path.join(root, 'package.json')), /directory/);
  assert.deepEqual(fs.readdirSync(a.sourcePath), []);
  assert.deepEqual(fs.readdirSync(b.sourcePath), []);
});

