// src/registry.mjs — BDL/DSH home 解析、元数据读写、profile 发现与 bundle 列表
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile, writeFile, rename, mkdir, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/** 解析 BDL_HOME（BDL_HOME env → unix: XDG_CONFIG_HOME 或 ~/.config/bdl；win: %APPDATA%/bdl） */
export function resolveBdlHome() {
  const env = process.env.BDL_HOME && process.env.BDL_HOME.trim();
  if (env) return resolve(env);
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'bdl');
  }
  const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim();
  return join(xdg || join(homedir(), '.config'), 'bdl');
}

/** 解析 DSH_HOME（env 优先 → ~/.dsh，与 dsh-home-paths 一致） */
export function resolveDshHome() {
  const env = process.env.DSH_HOME && process.env.DSH_HOME.trim();
  if (env) return resolve(env);
  return join(homedir(), '.dsh');
}

/** bundles.json 的绝对路径 */
export function metaPath() {
  return join(resolveBdlHome(), 'bundles.json');
}

/** 读元数据（不存在/损坏则返回空结构） */
export async function loadMeta() {
  const p = metaPath();
  let raw;
  try { raw = await readFile(p, 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return { version: 1, bundles: {} }; throw e; }
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : { version: 1, bundles: {} };
  } catch { return { version: 1, bundles: {} }; }
}

/** 原子写元数据（同目录 tmp + rename） */
export async function saveMeta(meta) {
  const p = metaPath();
  await mkdir(resolveBdlHome(), { recursive: true });
  const tmp = p + '.' + randomBytes(6).toString('hex') + '.tmp';
  await writeFile(tmp, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  await rename(tmp, p);
}

/** profile 名合法性（拒绝空、.、..、node_modules、含 / 或 \\ 的名字） */
export function isValidProfileName(name) {
  if (typeof name !== 'string' || name === '') return false;
  if (name === '.' || name === '..' || name === 'node_modules') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  return true;
}

/** 扫描 $DSH_HOME/profiles/<name>/package.json 读 dsh.profile.bundles */
export async function discoverProfiles() {
  const dir = join(resolveDshHome(), 'profiles');
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (e) { if (e && e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name === 'node_modules') continue;
    const pkgPath = join(dir, ent.name, 'package.json');
    let pkg;
    try { pkg = JSON.parse(await readFile(pkgPath, 'utf8')); }
    catch { continue; }
    const bundles = pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
    out.push({ name: ent.name, dir: join(dir, ent.name), bundles });
  }
  return out;
}

/** 读取某 profile 的 bundle 版本与来源（版本查 node_modules，来源查 dependencies） */
export async function listBundles(profile) {
  const profilesDir = join(resolveDshHome(), 'profiles');
  const profDir = join(profilesDir, profile);
  let pkg;
  try { pkg = JSON.parse(await readFile(join(profDir, 'package.json'), 'utf8')); }
  catch (e) { throw new Error('bdl: 无法读取 profile ' + profile + ' 的 package.json：' + (e && e.message ? e.message : e)); }
  const deps = (pkg && pkg.dependencies) || {};
  const names = (pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)) ? pkg.dsh.profile.bundles : [];
  const results = [];
  for (const name of names) {
    results.push({
      name,
      version: await readVersion(name, [join(profDir, 'node_modules'), join(profilesDir, 'node_modules')]),
      source: depSource(deps[name]),
    });
  }
  return results;
}

function depSource(spec) {
  if (typeof spec !== 'string') return 'bundled';
  if (spec.startsWith('link:')) return 'link';
  if (spec.startsWith('file:')) return 'file';
  if (spec.startsWith('git')) return 'git';
  return 'registry';
}

async function readVersion(name, dirs) {
  for (const dir of dirs) {
    try {
      const o = JSON.parse(await readFile(join(dir, name, 'package.json'), 'utf8'));
      if (o && o.version) return o.version;
    } catch { /* 继续尝试下一处 */ }
  }
  return '?';
}

// ---- dsh 版本管理相关（同步读元数据，供 resolveRealDsh 等同步调用） ----

/** 同步读元数据（不存在/损坏则返回空结构） */
export function loadMetaSync() {
  try {
    const raw = readFileSync(metaPath(), 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : { version: 1, bundles: {} };
  } catch { return { version: 1, bundles: {} }; }
}

/** 默认 dsh 版本（'system' 或具体版本号），缺省 'system' */
export function defaultDshVersion() {
  const m = loadMetaSync();
  return (typeof m.dshDefault === 'string' && m.dshDefault) ? m.dshDefault : 'system';
}

/** 某整合包锁定的 dsh 版本（未锁定返回 null） */
export function profileDshVersion(profile) {
  const m = loadMetaSync();
  const b = m.bundles && m.bundles[profile];
  return b && typeof b.dshVersion === 'string' && b.dshVersion ? b.dshVersion : null;
}

/** 多版本目录 BDL_HOME/versions */
export function versionsDir() {
  return join(resolveBdlHome(), 'versions');
}

/** 某版本 dsh 的 bin.js 绝对路径 */
export function versionBinPath(version) {
  return join(versionsDir(), version, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

/** 某版本 dsh 的 package.json 绝对路径 */
export function versionPkgPath(version) {
  return join(versionsDir(), version, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
}

/** 版本缓存文件绝对路径 */
export function versionCachePath() {
  return join(resolveBdlHome(), 'cache', 'versions.json');
}

/** 默认整合包（meta.defaultProfile），未设返回 null */
export function defaultProfile() {
  const m = loadMetaSync();
  return typeof m.defaultProfile === 'string' && m.defaultProfile ? m.defaultProfile : null;
}

/** 设置默认整合包 */
export async function setDefaultProfile(name) {
  const meta = await loadMeta();
  meta.defaultProfile = name;
  await saveMeta(meta);
  return true;
}

/** 记录使用（lastUsedAt/useCount，供置顶与默认项展示） */
export async function touchUsage(profile) {
  const meta = await loadMeta();
  if (!meta.bundles) meta.bundles = {};
  const b = meta.bundles[profile] || (meta.bundles[profile] = { id: profile, name: profile, profile });
  b.lastUsedAt = new Date().toISOString();
  b.useCount = (b.useCount || 0) + 1;
  await saveMeta(meta);
  return b;
}

/** profile .npmrc 路径（镜像源） */
export function profileNpmrcPath(profile) {
  return join(resolveDshHome(), 'profiles', profile, '.npmrc');
}

/** 写 profile .npmrc（原子写） */
export async function writeNpmrc(profile, registryUrl) {
  const p = profileNpmrcPath(profile);
  await mkdir(join(resolveDshHome(), 'profiles', profile), { recursive: true });
  const tmp = p + '.' + randomBytes(6).toString('hex') + '.tmp';
  await writeFile(tmp, 'registry=' + registryUrl + '\n', 'utf8');
  await rename(tmp, p);
  return true;
}

/** 读 profile .npmrc */
export async function readNpmrc(profile) {
  try { return (await readFile(profileNpmrcPath(profile), 'utf8')).trim(); }
  catch { return null; }
}

/** 导出目录 BDL_HOME/exports */
export function exportsDir() {
  return join(resolveBdlHome(), 'exports');
}

/** 某整合包 overlay 目录 BDL_HOME/overlays/<profile> */
export function overlaysDir(profile) {
  return join(resolveBdlHome(), 'overlays', profile);
}
