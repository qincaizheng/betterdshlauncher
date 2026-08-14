// src/dsh-version.mjs — dsh 版本管理（对标 nvm / HMCL 多版本：安装/升降级/多版本共存/按整合包锁定）
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { resolveBdlHome, loadMeta, saveMeta, versionsDir, versionBinPath, versionPkgPath, versionCachePath, profileDshVersion, defaultDshVersion } from './registry.mjs';
import { resolveRealDsh } from './dsh.mjs';

const CACHE_TTL_MS = 3600 * 1000; // 1 小时

/** npm 缓存参数：BDL_NPM_CACHE env 指定则传入，否则用 npm 默认缓存（避免每次冷装 334MB） */
function npmCacheArgs() {
  const c = process.env.BDL_NPM_CACHE && process.env.BDL_NPM_CACHE.trim();
  return c ? ['--cache', c] : [];
}

/** 跑 npm（stdio inherit），resolve 退出码 */
function runNpm(args) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = spawn(isWin ? 'npm.cmd' : 'npm', args, { stdio: 'inherit', ...(isWin ? { shell: true } : {}) });
    child.on('error', (err) => {
      process.stderr.write('bdl: 无法运行 npm：' + (err && err.message ? err.message : String(err)) + '（请确认 npm 已安装并在 PATH 中）\n');
      resolve(127);
    });
    child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

async function readCache() {
  try {
    const o = JSON.parse(await readFile(versionCachePath(), 'utf8'));
    if (o && typeof o.ts === 'number' && o.data) return o;
  } catch {}
  return null;
}

async function writeCache(data) {
  await mkdir(join(resolveBdlHome(), 'cache'), { recursive: true });
  await writeFile(versionCachePath(), JSON.stringify({ ts: Date.now(), data }, null, 2), 'utf8');
}

/** 远程版本列表 + dist-tags（1 小时缓存；离线降级用缓存/空） */
export async function remoteVersions() {
  const cached = await readCache();
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) return cached.data;
  try {
    const versions = JSON.parse(String(execFileSync('npm', ['view', '@deepseek-ai/dsh', 'versions', '--json', ...npmCacheArgs()])));
    const distTags = JSON.parse(String(execFileSync('npm', ['view', '@deepseek-ai/dsh', 'dist-tags', '--json', ...npmCacheArgs()])));
    const data = { versions, distTags };
    await writeCache(data);
    return data;
  } catch {
    if (cached) return cached.data;
    return { versions: [], distTags: {} };
  }
}

/** 已安装版本列表（扫 BDL_HOME/versions/<v>/.../package.json） */
export async function installedVersions() {
  const dir = versionsDir();
  let entries;
  try { entries = await readdir(dir); } catch { return []; }
  const out = [];
  for (const name of entries) {
    try {
      if (!existsSync(versionBinPath(name))) continue; // 与 resolveRealDsh 同口径：以 bin.js 存在为准
      const o = JSON.parse(await readFile(versionPkgPath(name), 'utf8'));
      out.push({ version: o.version || name, dir: join(dir, name) });
    } catch { /* 非完整版本目录，跳过 */ }
  }
  return out;
}

/** 系统 dsh 版本（读其 package.json） */
export async function systemVersion() {
  try {
    const real = realpathSync(resolveRealDsh('system'));
    const o = JSON.parse(await readFile(join(dirname(dirname(real)), 'package.json'), 'utf8'));
    return o.version || 'unknown';
  } catch { return 'unknown'; }
}

/** 安装指定版本到 BDL_HOME/versions/<v>；成功后返回该版本 bin.js 绝对路径 */
export async function installVersion(v) {
  const prefix = join(versionsDir(), v);
  await mkdir(versionsDir(), { recursive: true });
  const args = ['install', '--prefix', prefix, '--no-save', '--no-audit', '--no-fund', '--loglevel=error', '@deepseek-ai/dsh@' + v, ...npmCacheArgs()];
  console.log('执行：npm ' + args.join(' '));
  const code = await runNpm(args);
  if (code !== 0) {
    await rm(prefix, { recursive: true, force: true }).catch(() => {});
    throw new Error('bdl: 安装 dsh ' + v + ' 失败（npm 退出码 ' + code + '）');
  }
  const bin = versionBinPath(v);
  if (!existsSync(bin)) {
    await rm(prefix, { recursive: true, force: true }).catch(() => {});
    throw new Error('bdl: 安装完成但未找到 ' + bin);
  }
  return bin;
}

/** 删除某版本（若是当前默认版本则拒绝并提示） */
export async function removeVersion(v) {
  if (defaultDshVersion() === v) throw new Error('bdl: ' + v + ' 是当前默认版本，请先切换默认（setDefault）再删除');
  await rm(join(versionsDir(), v), { recursive: true, force: true });
  return true;
}

/** 设置默认版本（'system' 或具体版本号），写 bundles.json 顶层 dshDefault */
export async function setDefault(v) {
  if (v !== 'system' && !existsSync(versionBinPath(v))) {
    throw new Error('bdl: 未安装 dsh 版本 ' + v + '（请先安装，或切换为 system）');
  }
  const meta = await loadMeta();
  meta.dshDefault = v;
  await saveMeta(meta);
  return meta.dshDefault;
}

/** 给某整合包设置版本锁定（v=null 或 'follow' 表示跟随默认） */
export async function setProfileLock(profile, v) {
  const meta = await loadMeta();
  if (!meta.bundles) meta.bundles = {};
  if (!meta.bundles[profile]) meta.bundles[profile] = { id: profile, name: profile };
  if (v === null || v === 'follow') delete meta.bundles[profile].dshVersion;
  else meta.bundles[profile].dshVersion = v;
  await saveMeta(meta);
  return true;
}

/** 解析某整合包要用的 dsh 绝对路径（锁定优先，否则默认链） */
export function resolveForProfile(profile) {
  const lock = profileDshVersion(profile);
  if (lock) return resolveRealDsh(lock);
  return resolveRealDsh('default');
}
