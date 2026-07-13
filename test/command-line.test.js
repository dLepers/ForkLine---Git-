const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { parseCommandLine, launchDetached } = require('../src/command-line');

test('parses a configured editor without invoking a shell', () => {
  assert.deepEqual(parseCommandLine('phpstorm --line 12'), { executable: 'phpstorm', args: ['--line', '12'] });
  assert.deepEqual(parseCommandLine('"/opt/My Editor/bin/editor" --reuse-window'), { executable: '/opt/My Editor/bin/editor', args: ['--reuse-window'] });
  assert.deepEqual(parseCommandLine("code '--profile=PHP project'"), { executable: 'code', args: ['--profile=PHP project'] });
});

test('rejects malformed editor commands', () => {
  assert.throws(() => parseCommandLine(''), /invalide/);
  assert.throws(() => parseCommandLine('"unterminated'), /incomplets/);
  assert.throws(() => parseCommandLine('-c anything'), /Exécutable/);
});

test('waits for a detached process to spawn before reporting success', async () => {
  const child = new EventEmitter();
  let unrefCalled = false;
  child.unref = () => { unrefCalled = true; };
  const spawnProcess = (executable, args, options) => {
    assert.equal(executable, '/usr/bin/editor');
    assert.deepEqual(args, ['file.txt']);
    assert.deepEqual(options, { cwd: '/repo', detached: true, stdio: 'ignore' });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };

  assert.equal(await launchDetached('/usr/bin/editor', ['file.txt'], '/repo', spawnProcess), true);
  assert.equal(unrefCalled, true);
});

test('propagates asynchronous detached process errors', async () => {
  const child = new EventEmitter();
  child.unref = () => {};
  const spawnProcess = () => {
    queueMicrotask(() => child.emit('error', new Error('ENOENT')));
    return child;
  };

  await assert.rejects(() => launchDetached('/missing', [], '/repo', spawnProcess), /ENOENT/);
});
