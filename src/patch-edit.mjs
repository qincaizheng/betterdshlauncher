// src/patch-edit.mjs — 启用/禁用 bundle（编辑 profile cordis.patch.yml 的 disabled 条目，原子写 + 备份）
import { readFile, writeFile, rename, mkdir, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import yaml from 'js-yaml';
import { resolveBdlHome, resolveDshHome } from './registry.mjs';

/** 某 profile 的 cordis.patch.yml 绝对路径 */
export function patchPath(profile) {
  return join(resolveDshHome(), 'profiles', profile, 'cordis.patch.yml');
}

async function readPatches(profile) {
  const p = patchPath(profile);
  let text;
  try { text = await readFile(p, 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return []; throw e; }
  const parsed = yaml.load(text);
  if (parsed == null) return [];
  if (!Array.isArray(parsed)) throw new Error('bdl: ' + p + ' 不是列表（数组）格式，拒绝编辑以免覆盖原内容');
  return parsed;
}

/** 备份原 cordis.patch.yml 到 BDL_HOME/backups/<profile>/<ts>/ */
async function backup(profile) {
  const src = patchPath(profile);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(resolveBdlHome(), 'backups', profile, ts);
  await mkdir(dir, { recursive: true });
  try { await copyFile(src, join(dir, 'cordis.patch.yml')); }
  catch (e) { if (!(e && e.code === 'ENOENT')) throw e; }
}

async function writePatchesAtomic(profile, patches) {
  const p = patchPath(profile);
  await mkdir(dirname(p), { recursive: true });
  const text = yaml.dump(patches, { noRefs: true, lineWidth: -1 });
  const tmp = p + '.' + randomBytes(6).toString('hex') + '.tmp';
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, p);
}

/** 禁用 bundle：追加 {id, disabled:true}（去重），写前备份 */
export async function disableBundle(profile, id) {
  const patches = await readPatches(profile);
  const exists = patches.some((p) => p && p.id === id && p.disabled === true);
  if (exists) return { changed: false };
  await backup(profile);
  patches.push({ id, disabled: true });
  await writePatchesAtomic(profile, patches);
  return { changed: true };
}

/** 启用 bundle：移除该 id 的 disabled:true 条目，写前备份 */
export async function enableBundle(profile, id) {
  const patches = await readPatches(profile);
  const next = patches.filter((p) => !(p && p.id === id && p.disabled === true));
  if (next.length === patches.length) return { changed: false };
  await backup(profile);
  await writePatchesAtomic(profile, next);
  return { changed: true };
}

/** 返回某 profile 中当前 disabled:true 的 id 集合（供 TUI 展示初始选中态） */
export async function disabledIds(profile) {
  const patches = await readPatches(profile);
  const set = new Set();
  for (const p of patches) if (p && p.id && p.disabled === true) set.add(p.id);
  return set;
}
