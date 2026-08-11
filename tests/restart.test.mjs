import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RestartError,
  findOwnedProxyPids,
  matchesProxyCommand,
  parseArgs,
  parsePsOutput,
  parseWindowsProcessJson,
  resolveTarget,
  runRestart,
} from '../scripts/restart.mjs';

test('parses supported flags and validates target', () => {
  assert.deepEqual(parseArgs([]), { doBuild: true, detach: false });
  assert.deepEqual(parseArgs(['--no-build', '--detach']), { doBuild: false, detach: true });
  assert.deepEqual(resolveTarget({ PORT: '47999', HOST: '127.0.0.2' }), { port: 47999, host: '127.0.0.2' });
  assert.throws(() => parseArgs(['--port']), RestartError);
  assert.throws(() => resolveTarget({ PORT: '99999' }), RestartError);
});

test('process parsers recognize proxy commands portably', () => {
  assert.equal(matchesProxyCommand('/usr/bin/node /tmp/repo/bin/cli.js'), true);
  assert.equal(matchesProxyCommand('"C:\\node.exe" bin\\cli.js'), true);
  assert.equal(matchesProxyCommand('/usr/bin/node other.js'), false);
  assert.deepEqual(parsePsOutput(' 42 node /x/bin/cli.js\n 9 bash\n'), [
    { pid: 42, command: 'node /x/bin/cli.js' },
    { pid: 9, command: 'bash' },
  ]);
  assert.equal(parseWindowsProcessJson('{"ProcessId":42,"CommandLine":"node bin\\\\cli.js"}')[0].pid, 42);
});

test('ownership is target-port intersection, never process name alone', () => {
  const processes = [
    { pid: 10, command: 'node /a/bin/cli.js' },
    { pid: 20, command: 'node /b/bin/cli.js' },
    { pid: 30, command: 'node other.js' },
  ];
  assert.deepEqual(findOwnedProxyPids(47821, { processes, listenerPids: [20, 30] }), [20]);
  assert.deepEqual(findOwnedProxyPids(47821, { processes, listenerPids: [] }), []);
  assert.throws(
    () => findOwnedProxyPids(47821, { processes, listenerPids: null }),
    /refusing to signal pxpipe processes by name alone/,
  );
});

test('restart aborts on build failure and does not start', async () => {
  let started = false;
  const errors = [];
  const code = await runRestart({
    argv: [],
    findOwned: () => [],
    build: () => false,
    start: async () => { started = true; return 0; },
    log: () => {},
    logError: (m) => errors.push(m),
  });
  assert.equal(code, 1);
  assert.equal(started, false);
  assert.match(errors.join('\n'), /build failed/);
});

test('restart signals only owned proxy and forwards detach', async () => {
  const killed = [];
  let startOpts;
  const aliveState = new Map([[42, true]]);
  const code = await runRestart({
    argv: ['--no-build', '--detach'],
    findOwned: () => [42],
    alive: (pid) => aliveState.get(pid) === true,
    kill: (pid, opts) => { killed.push([pid, opts.force]); aliveState.set(pid, false); return true; },
    portFree: async () => true,
    start: async (opts) => { startOpts = opts; return 0; },
    wait: async () => {},
    log: () => {},
    logError: () => {},
  });
  assert.equal(code, 0);
  assert.deepEqual(killed, [[42, false]]);
  assert.deepEqual(startOpts, { detach: true });
});

test('occupied target port fails closed and never starts', async () => {
  let started = false;
  const errors = [];
  const code = await runRestart({
    argv: ['--no-build'],
    findOwned: () => [],
    portFree: async () => false,
    portHolder: () => 'PID 99 foreign-service',
    start: async () => { started = true; return 0; },
    log: () => {},
    logError: (m) => errors.push(m),
  });
  assert.equal(code, 1);
  assert.equal(started, false);
  assert.match(errors.join('\n'), /PID 99 foreign-service/);
});
