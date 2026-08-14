// src/pack.mjs — bdl-pack.json 整合包导入/导出（校验/防遍历/导出/导入计划/导入+回滚，按 RESEARCH.md 第八章）
import { readFile, writeFile, rename, mkdir, readdir, rm, stat, readlink, symlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, isAbsolute, basename, sep, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import yaml from 'js-yaml';
import { resolveBdlHome, resolveDshHome, loadMeta, saveMeta, isValidProfileName, exportsDir, overlaysDir } from './registry.mjs';
import { runPlugin, resolveRealDsh } from './dsh.mjs';

const TOP_KEYS = ['format', 'manifestVersion', 'id', 'name', 'version', 'description', 'author', 'dsh', 'bundles', 'deps', 'patch', 'overlays', 'vendor'];

/** overlay 路径防遍历：拒绝绝对路径、盘符、../ 逃逸；必须能安全落在目标目录内 */
function assertSafeOverlayPath(p, targetDir) {
  if (typeof p !== 'string' || p === '') throw new Error('bdl: overlay 路径为空');
  if (isAbsolute(p) || /^[a-zA-Z]:/.test(p)) throw new Error('bdl: overlay 路径不能是绝对路径：' + p);
  const resolved = resolve(targetDir, p);
  const root = resolve(targetDir) + sep;
  if (!resolved.startsWith(root) && resolved !== resolve(targetDir)) {
    throw new Error('bdl: overlay 路径越界（禁止 ../）：' + p);
  }
  return basename(resolved);
}

/** 严格校验 manifest（8.1/8.4）：未知顶层键/类型错误/非法 id 一律抛错 */
export function validateManifest(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('bdl: manifest 必须是对象');
  for (const k of Object.keys(obj)) if (!TOP_KEYS.includes(k)) throw new Error('bdl: manifest 含未知字段 ' + k);
  if (obj.manifestVersion !== 1) throw new Error('bdl: 仅支持 manifestVersion 1');
  if (typeof obj.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(obj.id)) throw new Error('bdl: manifest id 非法（^[a-z0-9][a-z0-9-]*$）');
  if (typeof obj.name !== 'string' || !obj.name) throw new Error('bdl: manifest.name 缺失');
  if (typeof obj.version !== 'string' || !obj.version) throw new Error('bdl: manifest.version 缺失');
  if (!Array.isArray(obj.bundles) || obj.bundles.length === 0) throw new Error('bdl: manifest.bundles 必须是非空数组');
  for (const b of obj.bundles) validatePkgItem(b, 'bundle');
  if (obj.deps !== undefined) {
    if (!Array.isArray(obj.deps)) throw new Error('bdl: manifest.deps 必须是数组');
    for (const d of obj.deps) validatePkgItem(d, 'dep');
  }
  if (obj.vendor !== undefined) {
    if (!Array.isArray(obj.vendor)) throw new Error('bdl: manifest.vendor 必须是数组');
    for (const v of obj.vendor) {
      if (!v || typeof v !== 'object' || typeof v.key !== 'string' || !v.key) throw new Error('bdl: vendor 项必须含 key');
      if (!Array.isArray(v.files)) throw new Error('bdl: vendor.files 必须是数组');
      for (const f of v.files) {
        if (!f || typeof f !== 'object' || typeof f.p !== 'string' || !f.p) throw new Error('bdl: vendor 文件项必须含 p（相对路径）');
        assertSafeOverlayPath(f.p, join(resolveBdlHome(), 'vendor', '__probe__'));
        if (f.c !== undefined && typeof f.c !== 'string') throw new Error('bdl: vendor 文件 c 必须是 base64 字符串');
        if (f.link !== undefined && typeof f.link !== 'string') throw new Error('bdl: vendor 文件 link 必须是字符串');
        if (f.c === undefined && f.link === undefined) throw new Error('bdl: vendor 文件项需含 c（base64 内容）或 link（符号链接目标）');
      }
    }
  }
  if (obj.patch !== undefined && typeof obj.patch !== 'string') throw new Error('bdl: manifest.patch 必须是 YAML 文本字符串');
  if (obj.overlays !== undefined) {
    if (!Array.isArray(obj.overlays)) throw new Error('bdl: manifest.overlays 必须是数组');
    for (const o of obj.overlays) {
      if (!o || typeof o !== 'object' || typeof o.path !== 'string' || typeof o.content !== 'string') {
        throw new Error('bdl: overlay 项必须含 path 与 content');
      }
      assertSafeOverlayPath(o.path, join(resolveBdlHome(), 'overlays', '__probe__'));
    }
  }
  return obj;
}

const MAX_VENDOR_FILE = 5 * 1024 * 1024; // 单文件 5MB 上限（打包产物类跳过）

/** 递归收集目录为 vendor 文件树（base64 内联；排除 node_modules/.git；符号链接存 link 字段） */
async function collectDir(dir, prefix, skipped) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const rel = prefix ? prefix + '/' + ent.name : ent.name;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...await collectDir(full, rel, skipped));
    } else if (ent.isFile()) {
      const st = await stat(full).catch(() => null);
      if (st && st.size > MAX_VENDOR_FILE) { skipped.push(rel); continue; }
      out.push({ p: rel, c: (await readFile(full)).toString('base64') });
    } else if (ent.isSymbolicLink()) {
      out.push({ p: rel, link: await readlink(full) });
    }
  }
  return out;
}

/** 校验 bundles/deps 单项（{name, version?, source?, path?, url?}） */
function validatePkgItem(item, label) {
  if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !item.name) throw new Error('bdl: ' + label + ' 项必须含 name 字符串');
  if (item.version !== undefined && typeof item.version !== 'string') throw new Error('bdl: ' + label + '.version 必须是字符串');
  if (item.source !== undefined && !['registry', 'link', 'git'].includes(item.source)) throw new Error('bdl: ' + label + '.source 非法');
}

function depSource(spec) {
  if (typeof spec !== 'string') return 'bundled';
  if (spec.startsWith('link:')) return 'link';
  if (spec.startsWith('file:')) return 'file';
  if (spec.startsWith('git')) return 'git';
  return 'registry';
}

/** 读某 profile 的 bundles + dependencies（版本约束） */
async function readProfileSpec(profile) {
  const pkgPath = join(resolveDshHome(), 'profiles', profile, 'package.json');
  let pkg;
  try { pkg = JSON.parse(await readFile(pkgPath, 'utf8')); }
  catch (e) { throw new Error('bdl: 无法读取 profile ' + profile + ' 的 package.json：' + (e && e.message ? e.message : e)); }
  const deps = (pkg && pkg.dependencies) || {};
  const bundles = (pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)) ? pkg.dsh.profile.bundles : [];
  return { deps, bundles, pkg };
}

/** 导出：从现有 profile 生成 manifest，原子写（缺省 BDL_HOME/exports/<id>-<version>.bdl-pack.json） */
export async function exportPack(profile, outPath) {
  const { deps, bundles } = await readProfileSpec(profile);
  const meta = await loadMeta();
  const entry = (meta.bundles && meta.bundles[profile]) || {};
  const id = entry.id || profile;
  const version = entry.version || '0.1.0';
  const list = [];
  for (const name of bundles) {
    const spec = deps[name];
    const src = depSource(spec);
    if (src === 'link') {
      list.push({ name, source: 'link', path: typeof spec === 'string' ? spec.slice('link:'.length) : undefined });
    } else if (src === 'git') {
      list.push({ name, source: 'git', url: typeof spec === 'string' ? spec.replace(/^git+/, '') : undefined });
    } else {
      list.push({ name, version: typeof spec === 'string' ? spec : 'latest' });
    }
  }
  // patch：内联 cordis.patch.yml 原文
  let patch;
  try { patch = await readFile(join(resolveDshHome(), 'profiles', profile, 'cordis.patch.yml'), 'utf8'); }
  catch { patch = undefined; }
  // overlays：内联 BDL_HOME/overlays/<profile>/ 下所有文件
  const overlays = [];
  const odir = overlaysDir(profile);
  try {
    for (const f of await readdir(odir)) {
      overlays.push({ path: f, content: await readFile(join(odir, f), 'utf8') });
    }
  } catch { /* 无 overlay 目录 */ }
  // vendor：打包存在的本地 link 插件源码（排除 node_modules/.git）
  const vendor = [];
  const skipped = [];
  const vendorize = async (item) => {
    if (item.source !== 'link' || !item.path) return;
    const p = item.path.startsWith('~/') ? join(homedir(), item.path.slice(2)) : item.path;
    if (!existsSync(p)) return;
    const files = await collectDir(p, '', skipped);
    if (files.length === 0) return;
    vendor.push({ key: item.name, files });
    item.vendorKey = item.name;
  };
  for (const b of list) await vendorize(b);
  // deps：dependencies 里不在 bundles 的条目（仅安装、不激活为 bundle）
  const depList = [];
  for (const [name, spec] of Object.entries(deps)) {
    if (bundles.includes(name)) continue;
    const src = depSource(spec);
    let item;
    if (src === 'link') {
      item = { name, source: 'link', path: typeof spec === 'string' ? spec.slice('link:'.length) : undefined };
    } else if (src === 'git') {
      item = { name, source: 'git', url: typeof spec === 'string' ? spec.replace(/^git\+/, '') : undefined };
    } else {
      item = { name, version: typeof spec === 'string' ? spec : 'latest' };
    }
    await vendorize(item);
    depList.push(item);
  }
  if (skipped.length) console.warn('bdl: 导出跳过 ' + skipped.length + ' 个超大文件（>5MB）：' + skipped.slice(0, 5).join(', ') + (skipped.length > 5 ? ' …' : ''));
  const manifest = {
    format: 'bdl-pack',
    manifestVersion: 1,
    id,
    name: entry.name || profile,
    version,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.author ? { author: entry.author } : {}),
    bundles: list,
    ...(depList.length ? { deps: depList } : {}),
    ...(patch !== undefined ? { patch } : {}),
    ...(overlays.length ? { overlays } : {}),
    ...(vendor.length ? { vendor } : {}),
  };
  const target = outPath || join(exportsDir(), id + '-' + version + '.bdl-pack.json');
  await mkdir(dirname(target), { recursive: true });
  const tmp = target + '.' + randomBytes(6).toString('hex') + '.tmp';
  await writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await rename(tmp, target);
  const vendorBytes = vendor.reduce((s, v) => s + v.files.reduce((s2, f) => s2 + (f.c ? Math.round(f.c.length * 3 / 4) : 0), 0), 0);
  return { path: target, manifest, vendorCount: vendor.length, vendorBytes };
}

/** 纯函数：从 manifest 生成导入计划（便于测试） */
export function buildImportPlan(manifest, opts = {}) {
  const m = validateManifest(manifest);
  const profile = opts.profile || m.id;
  if (!isValidProfileName(profile)) throw new Error('bdl: 目标 profile 名非法：' + profile);
  const addArgs = [];
  for (const b of [...m.bundles, ...(m.deps || [])]) {
    if (b.source === 'link') {
      let p;
      if (b.vendorKey && (m.vendor || []).some((v) => v.key === b.vendorKey)) {
        // 打包进 vendor 的本地插件：指向导入时解包出的目录（BDL_HOME/vendor/<profile>/<key>）
        p = join(resolveBdlHome(), 'vendor', profile, b.vendorKey);
      } else {
        // pnpm 的 link: spec 不展开 ~，这里统一展开成绝对路径
        p = b.path && b.path.startsWith('~/') ? join(homedir(), b.path.slice(2)) : b.path;
      }
      addArgs.push(p ? 'link:' + p : b.name);
    } else if (b.source === 'git') {
      addArgs.push(b.url ? 'git+' + b.url : b.name);
    } else {
      addArgs.push(b.version && b.version !== 'latest' ? b.name + '@' + b.version : b.name);
    }
  }
  return { profile, addArgs, patchText: m.patch, overlays: m.overlays || [], manifest: m };
}

/** 极简 semver 比较（支持 0.1.0-rc.6）：返回 -1/0/1；不可比时 null */
function compareVersions(a, b) {
  const norm = (s) => { const [core, pre] = String(s).split('-'); return { core: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre || '' }; };
  const na = norm(a), nb = norm(b);
  for (let i = 0; i < 3; i++) {
    if (na.core[i] !== nb.core[i]) return na.core[i] < nb.core[i] ? -1 : 1;
  }
  if (na.pre === nb.pre) return 0;
  if (na.pre === '') return 1;
  if (nb.pre === '') return -1;
  return na.pre < nb.pre ? -1 : 1;
}

/** 当前默认 dsh 的版本号（不可读返回 null） */
function currentDshVersion() {
  try {
    const real = resolveRealDsh('default');
    const root = real.replace(/[\\/]lib[\\/]bin\.js$/, '');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch { return null; }
}

/** 导入：校验 → 建 profile（dsh plugin add）→ 写 patch → 展开 overlays → 写元数据 → dump-config 校验（失败回滚） */
export async function importPack(manifestPath, opts = {}) {
  let raw;
  try { raw = await readFile(manifestPath, 'utf8'); }
  catch (e) { throw new Error('bdl: 无法读取 manifest：' + (e && e.message ? e.message : e)); }
  let manifest;
  try { manifest = JSON.parse(raw); } catch { throw new Error('bdl: manifest 不是合法 JSON'); }
  const plan = buildImportPlan(manifest, opts);
  const profileDir = join(resolveDshHome(), 'profiles', plan.profile);
  if (existsSync(profileDir) && !opts.force) {
    throw new Error('bdl: profile ' + plan.profile + ' 已存在（用 force 覆盖或换名导入）');
  }
  // minVersion 检查
  const cur = currentDshVersion();
  const min = plan.manifest.dsh && plan.manifest.dsh.minVersion;
  if (min && cur && compareVersions(cur, min) === -1) {
    throw new Error('bdl: 需要 dsh >= ' + min + '，当前 ' + cur + '（请先安装/切换 dsh 版本）');
  }
  const applied = [];
  try {
    // vendor 解包（本地插件源码 → BDL_HOME/vendor/<profile>/<key>/）
    if (plan.manifest.vendor && plan.manifest.vendor.length) {
      const vroot = join(resolveBdlHome(), 'vendor', plan.profile);
      for (const v of plan.manifest.vendor) {
        const dir = join(vroot, v.key);
        for (const f of v.files) {
          const safe = assertSafeOverlayPath(f.p, dir);
          const full = join(dir, safe);
          if (f.link !== undefined) {
            await mkdir(dirname(full), { recursive: true });
            await symlink(f.link, full).catch(() => {});
          } else {
            await mkdir(dirname(full), { recursive: true });
            await writeFile(full, Buffer.from(f.c, 'base64'));
          }
        }
      }
      applied.push('vendor');
    }
    if (plan.addArgs.length) {
      const code = await runPlugin(plan.profile, ['add', ...plan.addArgs]);
      if (code !== 0) throw new Error('bdl: dsh plugin add 失败（退出码 ' + code + '）');
      applied.push('profile');
    }
    if (typeof plan.patchText === 'string' && plan.patchText.trim() !== '' && plan.patchText.trim() !== '[]') {
      await mkdir(profileDir, { recursive: true });
      const patchFile = join(profileDir, 'cordis.patch.yml');
      const tmp = patchFile + '.' + randomBytes(6).toString('hex') + '.tmp';
      await writeFile(tmp, plan.patchText, 'utf8');
      await rename(tmp, patchFile);
      applied.push('patch');
    }
    if (plan.overlays.length) {
      const odir = overlaysDir(plan.profile);
      await mkdir(odir, { recursive: true });
      for (const o of plan.overlays) {
        const safeName = assertSafeOverlayPath(o.path, odir);
        await writeFile(join(odir, safeName), o.content, 'utf8');
      }
      applied.push('overlays');
    }
    // 元数据登记（含下载源）
    const meta = await loadMeta();
    if (!meta.bundles) meta.bundles = {};
    meta.bundles[plan.profile] = {
      id: plan.manifest.id,
      name: plan.manifest.name,
      ...(plan.manifest.description ? { description: plan.manifest.description } : {}),
      ...(plan.manifest.author ? { author: plan.manifest.author } : {}),
      profile: plan.profile,
      version: plan.manifest.version,
      ...(opts.source ? { source: opts.source } : {}),
      importedAt: new Date().toISOString(),
    };
    await saveMeta(meta);
    applied.push('meta');
    // 校验组合（失败回滚）
    const { spawnDsh } = await import('./dsh.mjs');
    const code = await spawnDsh(['--profile', plan.profile, '--dump-config']);
    if (code !== 0) throw new Error('bdl: 导入后 --dump-config 校验失败（退出码 ' + code + '）');
    return { profile: plan.profile, manifest: plan.manifest };
  } catch (e) {
    // 回滚：删 profile、删 overlays、恢复元数据
    for (const what of applied.reverse()) {
      try {
        if (what === 'profile') await rm(profileDir, { recursive: true, force: true });
        else if (what === 'overlays') await rm(overlaysDir(plan.profile), { recursive: true, force: true });
        else if (what === 'vendor') await rm(join(resolveBdlHome(), 'vendor', plan.profile), { recursive: true, force: true });
        else if (what === 'meta') {
          const meta = await loadMeta();
          if (meta.bundles && meta.bundles[plan.profile]) { delete meta.bundles[plan.profile]; await saveMeta(meta); }
        }
      } catch { /* 回滚尽力而为 */ }
    }
    throw new Error('bdl: 导入失败已回滚：' + (e && e.message ? e.message : e));
  }
}

export { assertSafeOverlayPath, compareVersions };
