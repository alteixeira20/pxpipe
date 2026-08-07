import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createTcpServer, connect as netConnect, type Server as NetServer } from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
let child: ChildProcess | undefined;
let echoServer: NetServer | undefined;

afterEach(async () => {
  if (child?.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child!.once('exit', () => resolve()));
  }
  child = undefined;
  if (echoServer) await new Promise<void>((resolve) => echoServer!.close(() => resolve()));
  echoServer = undefined;
});

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startPxpipe(port: number): Promise<void> {
  const output: string[] = [];
  child = spawn(process.execPath, [tsxCli, 'src/node.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      PXPIPE_PROFILE: 'passthrough',
      PXPIPE_LOG: `/tmp/pxpipe-connect-${process.pid}-${port}.jsonl`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk) => output.push(String(chunk)));
  child.stderr?.on('data', (chunk) => output.push(String(chunk)));
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(output.join(''))), 10_000);
    const poll = () => {
      if (output.join('').includes('[pxpipe] listening on')) {
        clearTimeout(deadline);
        resolve();
        return;
      }
      if (child?.exitCode !== null) {
        clearTimeout(deadline);
        reject(new Error(output.join('')));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

describe('persistent Node CONNECT listener', () => {
  it('blind-tunnels an unrelated loopback CONNECT target on the same PXPipe port', async () => {
    const pxpipePort = await freePort();
    const echoPort = await freePort();
    echoServer = createTcpServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => echoServer!.listen(echoPort, '127.0.0.1', resolve));
    await startPxpipe(pxpipePort);

    const socket = netConnect(pxpipePort, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(
      `CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`,
    );

    let received = '';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CONNECT timeout: ${received}`)), 5_000);
      const onData = (chunk: Buffer) => {
        received += chunk.toString('utf8');
        if (received.includes('\r\n\r\n')) {
          clearTimeout(timer);
          socket.off('data', onData);
          resolve();
        }
      };
      socket.on('data', onData);
      socket.once('error', reject);
    });
    expect(received).toContain('200 Connection established');

    const marker = `echo-${Date.now()}`;
    const echoed = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('echo timeout')), 5_000);
      const onData = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (text.includes(marker)) {
          clearTimeout(timer);
          socket.off('data', onData);
          resolve(text);
        }
      };
      socket.on('data', onData);
      socket.once('error', reject);
      socket.write(marker);
    });
    expect(echoed).toContain(marker);
    socket.destroy();
  });
});
