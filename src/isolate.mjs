// src/isolate.mjs — 整树隔离（L3：独立 DSH_HOME = BDL_HOME/envs/<profile>，按 RESEARCH.md 5.3 seed + 实测结论）
import { mkdir, copyFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { resolveBdlHome, resolveDshHome, isValidProfileName } from './registry.mjs';
import { spawnDsh, resolveRealDsh } from './dsh.mjs';

/** 隔离环境 home（独立 DSH_HOME） */
export function envHome(profile) {
  return join(resolveBdlHome(), 'envs', profile);
}

export function envProfileDir(profile) {
  return join(envHome(profile), 'profiles', profile);
}

export async function listIsolatedEnvs() {
  try { return (await readdir(join(resolveBdlHome(), 'envs'))).filter((n) => !n.startsWith('.')); }
  catch { return []; }
}

function runPnpmInherit(args, cwd) {
  return new Promise((resolvePromise) => {
    const child = spawn('pnpm', args, { cwd, stdio: 'inherit' });
    child.on('error', (e) => { process.stderr.write('bdl: 无法运行 pnpm：' + (e && e.message || e) + '\n'); resolvePromise(127); });
    child.on('close', (code, signal) => resolvePromise(code ?? (signal ? 128 : 1)));
  });
}

/**
 * 创建隔离环境：复制 profile 三文件到 env home 的 profiles/<name>/，可选继承 settings/凭据，
 * 然后 pnpm install（内置 bundle 由 boot 时 healProfilesModuleFallback 自动补齐，无需 seed）。
 */
export async function createIsolatedEnv(profile, { inheritSettings = true, inheritCredentials = true } = {}) {
  if (!isValidProfileName(profile)) throw new Error('bdl: 非法 profile 名：' + profile);
  const src = join(resolveDshHome(), 'profiles', profile);
  if (!existsSync(src)) throw new Error('bdl: 源 profile 不存在：' + profile);
  const dst = envProfileDir(profile);
  await mkdir(dst, { recursive: true });
  for (const f of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
    try { await copyFile(join(src, f), join(dst, f)); }
    catch (e) { if (!(e && e.code === 'ENOENT')) throw e; }
  }
  if (inheritSettings) { try { await copyFile(join(resolveDshHome(), 'settings.yaml'), join(envHome(profile), 'settings.yaml')); } catch { /* 无则留空用默认 */ } }
  if (inheritCredentials) { try { await copyFile(join(resolveDshHome(), '.credentials.yaml'), join(envHome(profile), '.credentials.yaml')); } catch { /* 无则不继承 */ } }
  const code = await runPnpmInherit(['install'], dst);
  if (code !== 0) throw new Error('bdl: 隔离环境依赖安装失败（退出码 ' + code + '）');
  return envHome(profile);
}

/** 删除隔离环境 */
export async function removeIsolatedEnv(profile) {
  await rm(envHome(profile), { recursive: true, force: true });
  return true;
}

/** 在隔离环境里启动某整合包（注入 DSH_HOME），透传退出码 */
export async function launchIsolated(profile, { patchOverlays = [], extraArgs = [] } = {}) {
  if (!existsSync(envProfileDir(profile))) throw new Error('bdl: 隔离环境不存在：' + profile + '（请先创建）');
  const dsh = resolveRealDsh('default');
  const argv = ['--profile', profile, ...patchOverlays.flatMap((p) => ['--patch', p]), ...extraArgs];
  const env = { ...process.env, DSH_HOME: envHome(profile) };
  console.log('使用 dsh：' + dsh + '（隔离 DSH_HOME=' + env.DSH_HOME + '）');
  return spawnDsh(argv, { dsh, env });
}
