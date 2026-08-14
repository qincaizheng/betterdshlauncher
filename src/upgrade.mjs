// src/upgrade.mjs — 整合包依赖升级与快照回滚、复制/删除/重命名（按 RESEARCH.md 6.4 第 (ii) 层）
import { readFile, writeFile, copyFile, rename, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { resolveBdlHome, resolveDshHome, loadMeta, saveMeta, overlaysDir } from './registry.mjs';

const SNAP_FILES = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'];

function profileDir(profile) {
  return join(resolveDshHome(), 'profiles', profile);
}

function runPnpm(args, cwd) {
  return new Promise((resolvePromise) => {
    const child = spawn('pnpm', args, { cwd, stdio: 'inherit' });
    child.on('error', (e) => { process.stderr.write('bdl: 无法运行 pnpm：' + (e && e.message || e) + '\n'); resolvePromise(127); });
    child.on('close', (code, signal) => resolvePromise(code ?? (signal ? 128 : 1)));
  });
}

function backupDir(profile) {
  return join(resolveBdlHome(), 'backups', profile);
}

/** 快照 profile 三文件到 BDL_HOME/backups/<profile>/<ts>/ */
export async function snapshotProfile(profile) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(backupDir(profile), ts);
  await mkdir(dir, { recursive: true });
  for (const f of SNAP_FILES) {
    try { await copyFile(join(profileDir(profile), f), join(dir, f)); }
    catch (e) { if (!(e && e.code === 'ENOENT')) throw e; }
  }
  return { ts, dir };
}

/** 依赖升级：快照 → pnpm update（profile 目录） */
export async function upgradeProfile(profile) {
  const snap = await snapshotProfile(profile);
  const code = await runPnpm(['update'], profileDir(profile));
  if (code !== 0) throw new Error('bdl: pnpm update 失败（退出码 ' + code + '），快照在 ' + snap.dir + '，可用回滚');
  return snap;
}

/** 列出某 profile 的快照时间戳（降序） */
export async function listSnapshots(profile) {
  try {
    const entries = await readdir(backupDir(profile));
    return entries.filter((n) => /^\d{4}-/.test(n)).sort().reverse();
  } catch { return []; }
}

/** 回滚：恢复三文件 + pnpm install */
export async function rollbackProfile(profile, ts) {
  const dir = join(backupDir(profile), ts);
  if (!existsSync(dir)) throw new Error('bdl: 快照不存在 ' + ts);
  for (const f of SNAP_FILES) {
    try { await copyFile(join(dir, f), join(profileDir(profile), f)); }
    catch (e) { if (!(e && e.code === 'ENOENT')) throw e; }
  }
  const code = await runPnpm(['install'], profileDir(profile));
  if (code !== 0) throw new Error('bdl: 回滚后 pnpm install 失败（退出码 ' + code + '）');
  return true;
}

/** 复制整合包：复制 package.json/cordis.patch.yml/pnpm-workspace.yaml + pnpm install */
export async function copyProfile(src, dst) {
  const from = profileDir(src), to = profileDir(dst);
  if (!existsSync(from)) throw new Error('bdl: 源 profile 不存在：' + src);
  if (existsSync(to)) throw new Error('bdl: 目标 profile 已存在：' + dst);
  await mkdir(to, { recursive: true });
  for (const f of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
    try { await copyFile(join(from, f), join(to, f)); }
    catch (e) { if (!(e && e.code === 'ENOENT')) throw e; }
  }
  const code = await runPnpm(['install'], to);
  if (code !== 0) throw new Error('bdl: 复制后 pnpm install 失败（退出码 ' + code + '）');
  // 元数据登记
  const meta = await loadMeta();
  if (!meta.bundles) meta.bundles = {};
  const base = meta.bundles[src] || {};
  meta.bundles[dst] = { ...base, id: dst, name: dst + '（复制自 ' + src + '）', profile: dst, copiedFrom: src, importedAt: new Date().toISOString() };
  await saveMeta(meta);
  return true;
}

/** 删除整合包：rm profile 目录 + overlays + 元数据条目 */
export async function deleteProfile(profile) {
  const dir = profileDir(profile);
  if (!existsSync(dir)) throw new Error('bdl: profile 不存在：' + profile);
  await rm(dir, { recursive: true, force: true });
  await rm(overlaysDir(profile), { recursive: true, force: true }).catch(() => {});
  const meta = await loadMeta();
  if (meta.bundles && meta.bundles[profile]) { delete meta.bundles[profile]; await saveMeta(meta); }
  return true;
}

/** 重命名整合包：mv 目录 + 更新元数据 profile 引用 + overlays 目录改名 */
export async function renameProfile(src, dst) {
  const from = profileDir(src), to = profileDir(dst);
  if (!existsSync(from)) throw new Error('bdl: 源 profile 不存在：' + src);
  if (existsSync(to)) throw new Error('bdl: 目标 profile 已存在：' + dst);
  await rename(from, to);
  if (existsSync(overlaysDir(src))) {
    await mkdir(join(resolveBdlHome(), 'overlays'), { recursive: true });
    await rename(overlaysDir(src), overlaysDir(dst)).catch(() => {});
  }
  const meta = await loadMeta();
  if (meta.bundles && meta.bundles[src]) {
    meta.bundles[dst] = { ...meta.bundles[src], id: dst, profile: dst };
    delete meta.bundles[src];
    await saveMeta(meta);
  }
  return true;
}
