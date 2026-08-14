// src/dsh.mjs — 真实 dsh 的定位与调用封装（一律绝对路径，绝不 spawn 裸名 dsh）
import { spawn, execFileSync } from 'node:child_process';
import { constants, homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve, join } from 'node:path';
import { versionBinPath, defaultDshVersion } from './registry.mjs';

/** 平台默认的 dsh 候选绝对路径（Unix 为可执行/符号链接，Windows 为 bin.js） */
function defaultDshCandidates() {
  const home = homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    return [
      join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    ];
  }
  if (process.platform === 'darwin') {
    return ['/opt/homebrew/bin/dsh', '/usr/local/bin/dsh', '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'];
  }
  return ['/usr/local/bin/dsh', join(home, '.npm-global', 'bin', 'dsh'), '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'];
}

/** 解析系统安装的 dsh（which/where + 平台默认路径，不含 BDL 版本目录） */
function resolveSystemDsh() {
  const candidates = [];
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const args = process.platform === 'win32' ? ['dsh'] : ['-a', 'dsh'];
    const out = String(execFileSync(cmd, args));
    for (const line of out.trim().split('\n')) {
      const p = line.trim();
      if (p && isAbsolute(p)) candidates.push(p);
    }
  } catch { /* which/where 不可用或无结果，忽略 */ }
  candidates.push(...defaultDshCandidates());
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  throw new Error('bdl: 找不到系统 dsh；请设置环境变量 BDL_REAL_DSH 指向 dsh 的 bin.js 或可执行文件');
}

/**
 * 解析真实 dsh 的绝对路径。优先级：
 * BDL_REAL_DSH env（最高）→ pref='system' 系统版 → pref=具体版本号 BDL_HOME/versions/<v> →
 * pref='default'/缺省 走默认版本链（dshDefault：'system' 或版本号）→ 系统版兜底。
 */
export function resolveRealDsh(pref = 'default') {
  const env = process.env.BDL_REAL_DSH && process.env.BDL_REAL_DSH.trim();
  if (env) return isAbsolute(env) ? env : resolve(env);

  if (pref === 'system') return resolveSystemDsh();
  if (pref && pref !== 'default') {
    const p = versionBinPath(pref);
    if (existsSync(p)) return p;
    throw new Error('bdl: 未安装 dsh 版本 ' + pref + '（请先安装）');
  }

  const def = defaultDshVersion();
  if (def === 'system') return resolveSystemDsh();
  const p = versionBinPath(def);
  if (existsSync(p)) return p;
  return resolveSystemDsh(); // 默认版本缺失 → 回退系统版
}

/**
 * spawn 真实 dsh（绝对路径 + stdio inherit），转发 SIGINT/SIGTERM/SIGHUP，
 * 子进程退出后透传退出码（128+n 约定）。opts.dsh 覆盖要用的 dsh 绝对路径。
 */
export function spawnDsh(args, opts = {}) {
  const real = opts.dsh || resolveRealDsh();
  const lower = real.toLowerCase();
  const isJs = lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs');
  const isCmd = process.platform === 'win32' && lower.endsWith('.cmd');

  const child = isJs
    ? spawn(process.execPath, [real, ...args], { stdio: 'inherit', ...opts })
    : isCmd
      ? spawn(real, args, { stdio: 'inherit', shell: true, ...opts })
      : spawn(real, args, { stdio: 'inherit', ...opts });

  const forward = (sig) => () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(sig);
  };
  const handlers = {};
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const h = forward(sig);
    handlers[sig] = h;
    process.on(sig, h);
  }
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      for (const sig of Object.keys(handlers)) process.off(sig, handlers[sig]);
      resolveExit(code);
    };
    child.on('close', (code, signal) => {
      finish(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1));
    });
    child.on('error', (err) => {
      process.stderr.write('bdl: 无法启动真实 dsh：' + (err && err.message ? err.message : String(err)) + '\n');
      finish(127);
    });
  });
}

/** 转发给 dsh plugin 子进程（复用 runPlugin 的 pnpm 转发），resolve 为退出码 */
export function runPlugin(profile, args) {
  return spawnDsh(['plugin', '--profile', profile, ...args]);
}

/** 校验整合包：REAL --profile X --dump-config（幂等重写 cordis.yml 属预期行为） */
export function validateProfile(profile, opts = {}) {
  return spawnDsh(['--profile', profile, '--dump-config'], opts);
}
