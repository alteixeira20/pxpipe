#!/usr/bin/env node
// Restart the local pxpipe proxy. Cross-platform and ownership-safe.
// Only a pxpipe process that actually owns the target listener may be stopped;
// a proxy from another clone/worktree on a different port is never signalled.

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const IS_WINDOWS = process.platform === 'win32';
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_ENTRY = path.join(REPO_ROOT, 'bin', 'cli.js');
const BUILD_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build.mjs');
const DEFAULT_PORT = 47821;
const DEFAULT_HOST = '127.0.0.1';
const GRACE_MS = 5000;
const POLL_MS = 100;

export class RestartError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'RestartError';
    this.exitCode = exitCode;
  }
}

export function parseArgs(argv) {
  let doBuild = true;
  let detach = false;
  for (const arg of argv) {
    if (arg === '--no-build') { doBuild = false; continue; }
    if (arg === '--detach') { detach = true; continue; }
    throw new RestartError(`unknown argument: ${arg}\n[restart] accepted flags: --no-build, --detach`, 2);
  }
  return { doBuild, detach };
}

export function resolveTarget(env = process.env) {
  const raw = env.PORT?.trim();
  const port = raw ? Number(raw) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RestartError(`invalid PORT: ${raw} (expected an integer 1-65535)`, 2);
  }
  return { port, host: env.HOST?.trim() || DEFAULT_HOST };
}

const PROXY_COMMAND_RE = /\bnode(?:\.exe)?\b.*[\s"'\\/]bin[\\/]cli\.js\b/i;
export function matchesProxyCommand(commandLine) {
  return typeof commandLine === 'string' && PROXY_COMMAND_RE.test(commandLine);
}

export function parsePsOutput(stdout) {
  const rows = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\S.*)$/);
    if (match) rows.push({ pid: Number(match[1]), command: match[2].trim() });
  }
  return rows;
}

export function parseWindowsProcessJson(stdout) {
  const text = stdout.trim();
  if (!text) return [];
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter((row) => row && Number.isInteger(Number(row.ProcessId)))
    .map((row) => ({ pid: Number(row.ProcessId), command: typeof row.CommandLine === 'string' ? row.CommandLine : '' }));
}

function runPowerShell(script) {
  for (const exe of ['powershell.exe', 'pwsh.exe']) {
    const res = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
    if (!res.error && res.status === 0) return res.stdout ?? '';
  }
  return null;
}

export function listProcesses() {
  if (IS_WINDOWS) {
    const out = runPowerShell("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress");
    return out === null ? [] : parseWindowsProcessJson(out);
  }
  const res = spawnSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8' });
  return res.error || res.status !== 0 ? [] : parsePsOutput(res.stdout ?? '');
}

export function findProxyPids(processes = listProcesses()) {
  return processes.filter((row) => row.pid !== process.pid && matchesProxyCommand(row.command)).map((row) => row.pid).sort((a, b) => a - b);
}

function parsePidTokens(text) {
  const out = new Set();
  for (const match of text.matchAll(/(?:pid=|PID\s+)(\d+)/gi)) out.add(Number(match[1]));
  return [...out].filter(Number.isInteger).sort((a, b) => a - b);
}

/** Return listener PIDs, [] for a definitely-free/no-listener port, or null if ownership is unknowable. */
export function findPortListenerPids(port) {
  if (IS_WINDOWS) {
    const out = runPowerShell(`Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique`);
    if (out === null) return null;
    return out.split(/\s+/).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
  }
  let res = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  if (!res.error) {
    if (res.status !== 0 && !(res.stdout ?? '').trim()) return [];
    return (res.stdout ?? '').split(/\s+/).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
  }
  res = spawnSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' });
  if (!res.error) {
    if (res.status !== 0 && !(res.stdout ?? '').trim()) return [];
    return parsePidTokens(res.stdout ?? '');
  }
  return null;
}

/** Only proxies that own the target port belong to this restart. */
export function findOwnedProxyPids(port, { processes = listProcesses(), listenerPids = findPortListenerPids(port) } = {}) {
  const proxies = findProxyPids(processes);
  if (proxies.length === 0) return [];
  if (listenerPids === null) {
    throw new RestartError(`[restart] cannot establish ownership of :${port}; refusing to signal pxpipe processes by name alone`);
  }
  const listeners = new Set(listenerPids);
  return proxies.filter((pid) => listeners.has(pid));
}

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
}

export function terminate(pid, { force = false } = {}) {
  if (IS_WINDOWS) {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    const res = spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true });
    return !res.error && res.status === 0;
  }
  try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already gone */ }
  return true;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function checkPortFree(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err) => resolve(err.code !== 'EADDRINUSE' && err.code !== 'EACCES'));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen({ port, host, exclusive: true });
  });
}

export function describePortHolder(port) {
  if (IS_WINDOWS) {
    const out = runPowerShell(`Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; \"PID $($_.OwningProcess) $($p.ProcessName)\" }`);
    return out?.trim() || null;
  }
  const res = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  if (!res.error && res.status === 0) return res.stdout?.trim() || null;
  const ss = spawnSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' });
  return !ss.error && ss.status === 0 ? ss.stdout?.trim() || null : null;
}

export function runBuild() {
  const res = spawnSync(process.execPath, [BUILD_SCRIPT], { cwd: REPO_ROOT, stdio: 'inherit' });
  return !res.error && res.status === 0;
}

export function startProxy({ detach = false } = {}) {
  if (detach) {
    try {
      const child = spawn(process.execPath, [CLI_ENTRY], { cwd: REPO_ROOT, detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return Promise.resolve(0);
    } catch (err) {
      console.error(`[restart] ERROR: failed to start proxy: ${err.message}`);
      return Promise.resolve(1);
    }
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_ENTRY], { cwd: REPO_ROOT, stdio: 'inherit' });
    const ignore = () => {};
    process.on('SIGINT', ignore);
    process.on('SIGTERM', ignore);
    const cleanup = () => { process.off('SIGINT', ignore); process.off('SIGTERM', ignore); };
    child.on('error', (err) => { cleanup(); console.error(`[restart] ERROR: failed to start proxy: ${err.message}`); resolve(1); });
    child.on('exit', (code, signal) => {
      cleanup();
      if (signal) resolve(128 + (os.constants.signals[signal] ?? 0));
      else resolve(code ?? 0);
    });
  });
}

export async function runRestart({
  argv = [], env = process.env,
  log = (msg) => console.log(msg), logError = (msg) => console.error(msg),
  findOwned = (port) => findOwnedProxyPids(port), alive = isAlive, kill = terminate,
  build = runBuild, portFree = checkPortFree, portHolder = describePortHolder,
  start = startProxy, wait = sleep,
} = {}) {
  let opts;
  let target;
  try { opts = parseArgs(argv); target = resolveTarget(env); }
  catch (err) {
    if (!(err instanceof RestartError)) throw err;
    logError(`[restart] ${err.message}`);
    return err.exitCode;
  }
  const { doBuild, detach } = opts;
  const { port, host } = target;
  let pids;
  try { pids = findOwned(port); }
  catch (err) {
    if (!(err instanceof RestartError)) throw err;
    logError(err.message);
    return err.exitCode;
  }
  if (pids.length) {
    log(`[restart] found pxpipe proxy owning ${host}:${port}: ${pids.join(' ')}`);
    const asked = [];
    const unreachable = [];
    for (const pid of pids) {
      if (!alive(pid)) continue;
      log(`[restart] asking ${pid} to shut down (drains requests, fsyncs tracker)`);
      (kill(pid, { force: false }) ? asked : unreachable).push(pid);
    }
    let stubborn = asked.filter(alive);
    for (let waited = 0; waited < GRACE_MS && stubborn.length; waited += POLL_MS) {
      await wait(POLL_MS);
      stubborn = stubborn.filter(alive);
    }
    const mustForce = [...unreachable.filter(alive), ...stubborn].sort((a, b) => a - b);
    if (mustForce.length) {
      logError(`[restart] WARNING: force-killing; in-flight requests are cut: ${mustForce.join(' ')}`);
      for (const pid of mustForce) kill(pid, { force: true });
      await wait(300);
    }
  } else {
    log(`[restart] no pxpipe proxy owns ${host}:${port}`);
  }
  if (doBuild) {
    log('[restart] rebuilding…');
    if (!build()) { logError('[restart] ERROR: build failed. Not starting a stale binary.'); return 1; }
  } else {
    log('[restart] --no-build: skipping rebuild (assuming dist/ is fresh)');
  }
  if (!(await portFree(port, host))) {
    const holder = portHolder(port);
    logError(`[restart] ERROR: port ${port} on ${host} is still in use.`);
    if (holder) logError(`    ${holder.split('\n').join('\n    ')}`);
    logError('  Free the listener and rerun; pxpipe will not kill an unowned process.');
    return 1;
  }
  log(`[restart] starting fresh proxy on ${host}:${port}${detach ? ' (detached)' : ' (Ctrl-C to stop)'}`);
  return start({ detach });
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exitCode = await runRestart({ argv: process.argv.slice(2) });
