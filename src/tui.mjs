// src/tui.mjs — enquirer 多级菜单（P0 子集：启动 / 整合包管理 / 插件管理 / 校验）
import Enquirer from 'enquirer';
import { discoverProfiles, listBundles, isValidProfileName, defaultDshVersion, profileDshVersion, defaultProfile, setDefaultProfile, writeNpmrc, readNpmrc, loadMeta, versionsDir } from './registry.mjs';
import { remoteVersions, installedVersions, systemVersion, installVersion, removeVersion, setDefault, setProfileLock } from './dsh-version.mjs';
import { runPlugin } from './dsh.mjs';
import { resolveForProfile } from './dsh-version.mjs';
import { importPack, exportPack } from './pack.mjs';
import { fetchText, downloadFromGit, loadIndex, searchPacks, installFromSource } from './download.mjs';
import { checkRegistryUpdates, checkLinkUpdates, updateRegistryPkgs, updateLinkPkg } from './update.mjs';
import { upgradeProfile, rollbackProfile, listSnapshots, copyProfile, deleteProfile, renameProfile } from './upgrade.mjs';
import { createIsolatedEnv, removeIsolatedEnv, listIsolatedEnvs, envHome, envProfileDir } from './isolate.mjs';
import { captureDump, parseHints, listLogs, tailLog } from './diagnose.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { handoffToDsh } from './handoff.mjs';
import { disableBundle, enableBundle, disabledIds } from './patch-edit.mjs';

const enquirer = new Enquirer();

async function prompt(cfg) {
  return enquirer.prompt(cfg);
}

/** 选择整合包（AutoComplete 支持输入过滤），按最近使用排序 + 默认标记，无 profile 时返回 null */
async function pickProfile(message) {
  const profiles = await discoverProfiles();
  if (profiles.length === 0) {
    console.log('未发现任何 profile（请先在「整合包管理」新建）。');
    return null;
  }
  const meta = await loadMeta();
  const def = defaultProfile();
  const used = (name) => (meta.bundles && meta.bundles[name] && meta.bundles[name].lastUsedAt) || '';
  profiles.sort((a, b) => (used(b.name) > used(a.name) ? 1 : -1));
  const names = profiles.map((p) => p.name);
  const initial = def && names.includes(def) ? def : names[0];
  const { value } = await prompt({
    type: 'autocomplete',
    name: 'value',
    message: (message || '选择整合包') + '（默认：' + initial + '）',
    choices: names.map((n) => n + (n === def ? '（默认）' : '')),
    initial,
  });
  return value ? String(value).replace(/（默认）$/, '') : value;
}

/** 拆分空格分隔的包名列表（过滤空串） */
function splitPkgs(s) {
  return String(s || '').trim().split(' ').filter(Boolean);
}

/** manifest 摘要（下载前展示） */
function summarizeManifest(text) {
  let o;
  try { o = JSON.parse(text); } catch { return '(无法解析 manifest)'; }
  const bundles = (o.bundles || []).map((b) => b.name).join(', ');
  return o.name + ' v' + o.version + (o.description ? ' — ' + o.description : '') + '\nbundles(' + (o.bundles || []).length + '): ' + bundles;
}

/** 确认后安装（展示摘要 → 是/否 → installFromSource） */
async function confirmInstall(text, source) {
  console.log(summarizeManifest(text));
  const { ok } = await prompt({ type: 'confirm', name: 'ok', message: '确认安装该整合包？', initial: true });
  if (!ok) return;
  try {
    const r = await installFromSource(source);
    console.log('安装成功：profile「' + r.profile + '」');
  } catch (e) { console.log('安装失败：' + (e && e.message ? e.message : e)); }
}

async function downloadFlow() {
  const { src } = await prompt({
    type: 'select',
    name: 'src',
    message: '下载整合包 — 选择源',
    choices: ['直链 URL', 'git 仓库', 'bdl-pack index', '返回'],
  });
  if (src === '直链 URL') {
    const { url } = await prompt({ type: 'input', name: 'url', message: 'bdl-pack.json 的 http(s)/file URL' });
    if (!url) return;
    const { sha } = await prompt({ type: 'input', name: 'sha', message: 'sha256（可选，回车跳过）' });
    try {
      const text = await fetchText(url.trim());
      await confirmInstall(text, { type: 'url', url: url.trim(), ...(sha && sha.trim() ? { sha256: sha.trim() } : {}) });
    } catch (e) { console.log('下载失败：' + (e && e.message ? e.message : e)); }
  } else if (src === 'git 仓库') {
    const { repo } = await prompt({ type: 'input', name: 'repo', message: 'git 仓库 URL（https/git@）' });
    if (!repo) return;
    const { ref } = await prompt({ type: 'input', name: 'ref', message: '分支/tag（可选，回车默认）' });
    try {
      const got = await downloadFromGit(repo.trim(), (ref && ref.trim()) || undefined);
      await confirmInstall(got.text, { type: 'git', url: repo.trim(), ...(ref && ref.trim() ? { ref: ref.trim() } : {}) });
    } catch (e) { console.log('下载失败：' + (e && e.message ? e.message : e)); }
  } else if (src === 'bdl-pack index') {
    const { url } = await prompt({ type: 'input', name: 'url', message: 'index JSON 的 http(s)/file URL' });
    if (!url) return;
    try {
      const idx = await loadIndex(url.trim());
      const packs = searchPacks(idx.packs, '');
      if (!packs.length) { console.log('index 为空。'); return; }
      const { pick } = await prompt({
        type: 'autocomplete',
        name: 'pick',
        message: '搜索/选择整合包（' + packs.length + ' 个）',
        choices: packs.map((p) => ({ name: p.id, message: p.name + ' v' + p.version + (p.description ? ' — ' + p.description : '') })),
      });
      const pack = packs.find((p) => p.id === pick);
      if (!pack || !pack.url) { console.log('该条目无 url。'); return; }
      const text = await fetchText(pack.url);
      await confirmInstall(text, { type: 'url', url: pack.url, ...(pack.sha256 ? { sha256: pack.sha256 } : {}) });
    } catch (e) { console.log('下载失败：' + (e && e.message ? e.message : e)); }
  }
}

async function managePacks() {
  const { op } = await prompt({
    type: 'select',
    name: 'op',
    message: '整合包管理',
    choices: ['列表/详情', '新建整合包', '导入整合包', '导出整合包', '下载整合包', '复制整合包', '重命名整合包', '删除整合包', '返回'],
  });
  if (op === '列表/详情') {
    const profiles = await discoverProfiles();
    if (profiles.length === 0) { console.log('无 profile。'); return; }
    for (const p of profiles) {
      console.log('• ' + p.name + '（' + p.bundles.length + ' 个 bundle）');
      for (const b of p.bundles) console.log('    - ' + b);
    }
  } else if (op === '新建整合包') {
    const { name } = await prompt({
      type: 'input',
      name: 'name',
      message: '新整合包（profile）名',
      validate: (v) => isValidProfileName(v) ? true : '非法名字（不能含 / 或 \\、不能是 . .. node_modules）',
    });
    if (!name) return;
    const { pkgs } = await prompt({
      type: 'input',
      name: 'pkgs',
      message: '要安装的 bundle 包名（空格分隔；回车默认 @deepseek-ai/dsh-base）',
    });
    const list = splitPkgs(pkgs);
    const addArgs = list.length ? list : ['@deepseek-ai/dsh-base'];
    console.log('创建 profile「' + name + '」并安装：' + addArgs.join(' '));
    const code = await runPlugin(name, ['add', ...addArgs]);
    console.log('完成（退出码 ' + code + '）。');
  } else if (op === '导入整合包') {
    const { path } = await prompt({ type: 'input', name: 'path', message: 'bdl-pack.json 路径' });
    if (!path) return;
    try {
      const r = await importPack(path.trim());
      console.log('导入成功：profile「' + r.profile + '」（' + r.manifest.name + ' v' + r.manifest.version + '）');
    } catch (e) { console.log('导入失败：' + (e && e.message ? e.message : e)); }
  } else if (op === '导出整合包') {
    const profile = await pickProfile('选择要导出的整合包');
    if (!profile) return;
    try {
      const r = await exportPack(profile);
      console.log('已导出：' + r.path + (r.vendorCount ? '（已打包 ' + r.vendorCount + ' 个本地插件，约 ' + Math.round(r.vendorBytes / 1024) + 'KB）' : ''));
    } catch (e) { console.log('导出失败：' + (e && e.message ? e.message : e)); }
  } else if (op === '下载整合包') {
    await downloadFlow();
  } else if (op === '复制整合包') {
    const src = await pickProfile('选择要复制的整合包');
    if (!src) return;
    const { dst } = await prompt({ type: 'input', name: 'dst', message: '新整合包（profile）名', validate: (v) => isValidProfileName(v) ? true : '非法名字' });
    if (!dst) return;
    try { await copyProfile(src, dst); console.log('已复制为「' + dst + '」。'); }
    catch (e) { console.log('复制失败：' + (e && e.message ? e.message : e)); }
  } else if (op === '重命名整合包') {
    const src = await pickProfile('选择要重命名的整合包');
    if (!src) return;
    const { dst } = await prompt({ type: 'input', name: 'dst', message: '新名字', validate: (v) => isValidProfileName(v) ? true : '非法名字' });
    if (!dst) return;
    try { await renameProfile(src, dst); console.log('已重命名为「' + dst + '」（建议校验一次）。'); }
    catch (e) { console.log('重命名失败：' + (e && e.message ? e.message : e)); }
  } else if (op === '删除整合包') {
    const src = await pickProfile('选择要删除的整合包');
    if (!src) return;
    const { ok } = await prompt({ type: 'confirm', name: 'ok', message: '确认删除「' + src + '」？此操作不可恢复', initial: false });
    if (!ok) return;
    try { await deleteProfile(src); console.log('已删除「' + src + '」。'); }
    catch (e) { console.log('删除失败：' + (e && e.message ? e.message : e)); }
  }
}

async function toggleBundles(profile) {
  const list = await listBundles(profile);
  if (list.length === 0) { console.log('该 profile 无 bundle。'); return; }
  const disabled = await disabledIds(profile);
  const choices = list.map((b) => ({ name: b.name, message: b.name + '（' + (disabled.has(b.name) ? '已禁用' : '启用') + '）' }));
  const initialIndices = list.map((b, i) => i).filter((i) => disabled.has(list[i].name));
  const { selected } = await prompt({
    type: 'multiselect',
    name: 'selected',
    message: '空格切换选中；选中 = 禁用该插件（回车提交）',
    choices,
    initial: initialIndices,
  });
  const toDisable = new Set(selected);
  for (const b of list) {
    if (toDisable.has(b.name)) await disableBundle(profile, b.name);
    else await enableBundle(profile, b.name);
  }
  console.log('已更新 cordis.patch.yml（禁用：' + (selected && selected.length ? selected.join(', ') : '无') + '）。');
}

async function managePlugins() {
  const profile = await pickProfile('选择要管理插件的整合包');
  if (!profile) return;
  const { op } = await prompt({
    type: 'select',
    name: 'op',
    message: '插件管理（' + profile + '）',
    choices: ['bundle 列表', '启用/禁用', '添加 bundle', '移除 bundle', '更新检查', '批量更新', '返回'],
  });
  if (op === 'bundle 列表') {
    const list = await listBundles(profile);
    if (list.length === 0) { console.log('无 bundle。'); return; }
    for (const b of list) console.log('• ' + b.name + '  ' + b.version + '  [' + b.source + ']');
  } else if (op === '启用/禁用') {
    await toggleBundles(profile);
  } else if (op === '添加 bundle') {
    const { pkgs } = await prompt({ type: 'input', name: 'pkgs', message: '要添加的包名（空格分隔）' });
    const list = splitPkgs(pkgs);
    if (list.length) { const code = await runPlugin(profile, ['add', ...list]); console.log('退出码 ' + code); }
  } else if (op === '移除 bundle') {
    const { pkgs } = await prompt({ type: 'input', name: 'pkgs', message: '要移除的包名（空格分隔）' });
    const list = splitPkgs(pkgs);
    if (list.length) { const code = await runPlugin(profile, ['remove', ...list]); console.log('退出码 ' + code); }
  } else if (op === '更新检查') {
    console.log('检查 registry 依赖…');
    const reg = await checkRegistryUpdates(profile);
    if (reg.error) console.log(reg.error);
    else if (!reg.items.length) console.log('registry 依赖全部最新。');
    else for (const i of reg.items) console.log('• ' + i.name + '  ' + i.current + ' → ' + i.latest + '（wanted ' + i.wanted + '）');
    console.log('检查 link 插件（git）…');
    const link = await checkLinkUpdates(profile);
    if (!link.items.length) console.log('link 插件全部最新（或无可检测项）。');
    else for (const i of link.items) console.log('• ' + i.name + '  落后 ' + i.behind + ' 个提交（' + i.dir + '）');
  } else if (op === '批量更新') {
    const reg = await checkRegistryUpdates(profile);
    const link = await checkLinkUpdates(profile);
    const choices = [
      ...reg.items.map((i) => ({ name: 'reg:' + i.name, message: i.name + '（registry ' + i.current + ' → ' + i.latest + '）' })),
      ...link.items.map((i) => ({ name: 'link:' + i.name, message: i.name + '（git 落后 ' + i.behind + '）' })),
    ];
    if (!choices.length) { console.log('无可更新项。'); return; }
    const { selected } = await prompt({ type: 'multiselect', name: 'selected', message: '选择要更新的项（空格切换，回车提交）', choices });
    if (!selected || !selected.length) return;
    for (const s of selected) {
      const [kind, name] = s.split(/:(.*)/s);
      if (kind === 'reg') { console.log('更新 ' + name + ' …'); await updateRegistryPkgs(profile, [name]); }
      else { console.log('git pull ' + name + ' …'); try { await updateLinkPkg(profile, name); } catch (e) { console.log(String(e && e.message || e)); } }
    }
    console.log('批量更新完成。');
  }
}

async function showInstalledVersions() {
  const installed = await installedVersions();
  const def = defaultDshVersion();
  const sys = await systemVersion();
  const profiles = await discoverProfiles();
  console.log('系统版本：' + sys + (def === 'system' ? '（当前默认）' : ''));
  if (installed.length === 0) console.log('（未安装任何 BDL 版本）');
  for (const iv of installed) {
    const lockers = profiles.filter((p) => profileDshVersion(p.name) === iv.version).map((p) => p.name);
    console.log('• ' + iv.version + (def === iv.version ? '（当前默认）' : '') + (lockers.length ? '（锁定于：' + lockers.join(', ') + '）' : ''));
  }
}

async function installVersionFlow() {
  const { versions, distTags } = await remoteVersions();
  if (!versions || !versions.length) { console.log('无法获取远程版本（离线？）。'); return; }
  const latest = (distTags && distTags.latest) || versions[versions.length - 1];
  const choices = versions.map((v) => ({ name: v, message: v + (v === latest ? '（latest）' : '') }));
  const { v } = await prompt({ type: 'autocomplete', name: 'v', message: '选择要安装的版本', choices });
  if (!v) return;
  const { way } = await prompt({
    type: 'select',
    name: 'way',
    message: '安装方式',
    choices: ['一键安装（bdl 代跑 npm，推荐）', '显示手动安装命令', '返回'],
  });
  if (way === '一键安装（bdl 代跑 npm，推荐）') {
    const { ok } = await prompt({ type: 'confirm', name: 'ok', message: '将下载约 529 包 / 334MB，确认安装 ' + v + '？', initial: true });
    if (!ok) return;
    console.log('安装 ' + v + '（可能需要数分钟，进度实时显示）…');
    try { const bin = await installVersion(v); console.log('安装完成：' + bin); }
    catch (e) { console.log('安装失败：' + (e && e.message ? e.message : e)); }
  } else if (way === '显示手动安装命令') {
    console.log('请在终端自己执行（装完回本菜单即自动识别）：');
    console.log('');
    console.log('  npm install --prefix ' + join(versionsDir(), v) + ' --no-save @deepseek-ai/dsh@' + v);
    console.log('');
    console.log('约 529 包 / 334MB / 2 分钟；中途反悔直接 Ctrl-C，不影响任何现有版本。');
  }
}

async function switchDefaultFlow() {
  const installed = await installedVersions();
  const choices = [{ name: 'system', message: 'system（系统版）' }, ...installed.map((iv) => ({ name: iv.version, message: iv.version }))];
  const { v } = await prompt({ type: 'select', name: 'v', message: '选择默认版本', choices });
  if (!v) return;
  await setDefault(v);
  console.log('默认版本已设为 ' + v);
}

async function removeVersionFlow() {
  const installed = await installedVersions();
  if (!installed.length) { console.log('无已装版本。'); return; }
  const { v } = await prompt({ type: 'select', name: 'v', message: '选择要删除的版本', choices: installed.map((iv) => iv.version) });
  if (!v) return;
  try { await removeVersion(v); console.log('已删除 ' + v); }
  catch (e) { console.log('删除失败：' + (e && e.message ? e.message : e)); }
}

async function lockProfileFlow() {
  const profiles = await discoverProfiles();
  if (!profiles.length) { console.log('无 profile。'); return; }
  const { profile } = await prompt({ type: 'autocomplete', name: 'profile', message: '选择整合包', choices: profiles.map((p) => p.name) });
  if (!profile) return;
  const installed = await installedVersions();
  const choices = [
    { name: 'follow', message: '跟随默认（解除锁定）' },
    { name: 'system', message: 'system（系统版）' },
    ...installed.map((iv) => ({ name: iv.version, message: iv.version })),
  ];
  const { v } = await prompt({ type: 'select', name: 'v', message: '选择 ' + profile + ' 锁定的版本', choices });
  if (!v) return;
  await setProfileLock(profile, v === 'follow' ? null : v);
  console.log('已设置 ' + profile + ' 的锁定版本：' + (v === 'follow' ? '跟随默认' : v));
}

async function isolateMenu() {
  const { op } = await prompt({
    type: 'select',
    name: 'op',
    message: '环境隔离（整树隔离 = 独立 DSH_HOME）',
    choices: ['隔离环境列表', '创建隔离环境', '在隔离环境启动', '删除隔离环境', '返回'],
  });
  const envs = await listIsolatedEnvs();
  if (op === '隔离环境列表') {
    console.log(envs.length ? envs.join('\n') : '（无隔离环境）');
  } else if (op === '创建隔离环境') {
    const profile = await pickProfile('选择要隔离的整合包');
    if (!profile) return;
    console.log('将复制 profile 文件到 ' + envHome(profile) + ' 并执行 pnpm install（首次较慢）…');
    try { await createIsolatedEnv(profile); console.log('隔离环境已创建：' + envHome(profile)); }
    catch (e) { console.log('创建失败：' + (e && e.message ? e.message : e)); }
  } else if (op === '在隔离环境启动') {
    const profile = await pickProfile('选择要在隔离环境启动的整合包');
    if (!profile) return;
    if (!existsSync(envProfileDir(profile))) { console.log('隔离环境不存在，请先创建。'); return; }
    const { launchIsolated } = await import('./isolate.mjs');
    const code = await launchIsolated(profile);
    console.log('（隔离会话已退出，码 ' + code + '）');
  } else if (op === '删除隔离环境') {
    if (!envs.length) { console.log('无隔离环境。'); return; }
    const { pick } = await prompt({ type: 'select', name: 'pick', message: '选择要删除的隔离环境', choices: envs });
    if (pick) { await removeIsolatedEnv(pick); console.log('已删除 ' + pick); }
  }
}

async function diagnoseMenu() {
  const { op } = await prompt({
    type: 'select',
    name: 'op',
    message: '诊断',
    choices: ['查看日志', '返回'],
  });
  if (op === '查看日志') {
    const logs = await listLogs();
    if (!logs.length) { console.log('（无日志文件）'); return; }
    const { pick } = await prompt({ type: 'select', name: 'pick', message: '选择日志', choices: logs });
    if (pick) {
      try { console.log(await tailLog(pick, 80)); }
      catch (e) { console.log('读取失败：' + (e && e.message ? e.message : e)); }
    }
  }
}

async function settingsMenu() {
  const { op } = await prompt({
    type: 'select',
    name: 'op',
    message: '设置',
    choices: ['设置默认整合包', '启动参数（extraArgs）', '镜像源（profile .npmrc）', '返回'],
  });
  if (op === '设置默认整合包') {
    const profile = await pickProfile('选择默认整合包');
    if (profile) { await setDefaultProfile(profile); console.log('默认整合包：' + profile); }
  } else if (op === '启动参数（extraArgs）') {
    const profile = await pickProfile('选择整合包');
    if (!profile) return;
    const meta = await loadMeta();
    const cur = (meta.bundles && meta.bundles[profile] && meta.bundles[profile].extraArgs) || [];
    const { args } = await prompt({ type: 'input', name: 'args', message: '启动参数（空格分隔，回车清空）当前：' + cur.join(' ') });
    const next = splitPkgs(args);
    if (!meta.bundles) meta.bundles = {};
    if (!meta.bundles[profile]) meta.bundles[profile] = { id: profile, name: profile, profile };
    meta.bundles[profile].extraArgs = next;
    await (await import('./registry.mjs')).saveMeta(meta);
    console.log('已保存：' + next.join(' '));
  } else if (op === '镜像源（profile .npmrc）') {
    const profile = await pickProfile('选择整合包');
    if (!profile) return;
    const cur = await readNpmrc(profile);
    console.log('当前 .npmrc：' + (cur || '（未设置，用全局 npm 配置）'));
    const { url } = await prompt({ type: 'input', name: 'url', message: 'registry URL（如 https://registry.npmmirror.com；回车跳过）' });
    if (url && url.trim()) {
      await writeNpmrc(profile, url.trim());
      console.log('已写入 ' + url.trim());
    }
  }
}

async function upgradeMenu() {
  const { op } = await prompt({
    type: 'select',
    name: 'op',
    message: '升级与回滚',
    choices: ['依赖升级（pnpm update + 快照）', '回滚到快照', '返回'],
  });
  if (op === '依赖升级（pnpm update + 快照）') {
    const profile = await pickProfile('选择要升级依赖的整合包');
    if (!profile) return;
    console.log('将快照 package.json / pnpm-lock.yaml / cordis.patch.yml 后执行 pnpm update…');
    try {
      const s = await upgradeProfile(profile);
      console.log('升级完成，快照：' + s.dir);
      console.log('建议立即「校验整合包」确认组合正常。');
    } catch (e) { console.log('升级失败：' + (e && e.message ? e.message : e)); }
  } else if (op === '回滚到快照') {
    const profile = await pickProfile('选择要回滚的整合包');
    if (!profile) return;
    const snaps = await listSnapshots(profile);
    if (!snaps.length) { console.log('该整合包无快照。'); return; }
    const { ts } = await prompt({ type: 'select', name: 'ts', message: '选择快照（新→旧）', choices: snaps });
    if (!ts) return;
    try { await rollbackProfile(profile, ts); console.log('已回滚到 ' + ts); }
    catch (e) { console.log('回滚失败：' + (e && e.message ? e.message : e)); }
  }
}

async function versionMenu() {
  const { op } = await prompt({
    type: 'select', name: 'op', message: 'dsh 版本管理',
    choices: ['已装版本', '安装版本', '切换默认版本', '删除版本', '锁定整合包版本', '显示系统版本', '返回'],
  });
  if (op === '已装版本') await showInstalledVersions();
  else if (op === '安装版本') await installVersionFlow();
  else if (op === '切换默认版本') await switchDefaultFlow();
  else if (op === '删除版本') await removeVersionFlow();
  else if (op === '锁定整合包版本') await lockProfileFlow();
  else if (op === '显示系统版本') console.log('系统 dsh 版本：' + await systemVersion());
}

/** 进入 TUI 主循环；启动整合包会通过 handoffToDsh 结束进程 */
export async function runTui() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('bdl: 交互菜单需要 TTY 终端。\n');
    process.exit(2);
  }
  try {
    // 首次使用（无任何整合包）：引导下载/导入，而不是手搓新建
    const existing = await discoverProfiles();
    if (existing.length === 0) {
      const { first } = await prompt({
        type: 'select',
        name: 'first',
        message: '欢迎使用 bdl — 还没有任何整合包，先装一个：',
        choices: ['下载整合包（URL / git / index）', '导入本地 bdl-pack.json', '新建整合包（手动选插件）', '退出'],
      });
      if (first === '下载整合包（URL / git / index）') {
        await downloadFlow();
      } else if (first === '导入本地 bdl-pack.json') {
        const { path } = await prompt({ type: 'input', name: 'path', message: 'bdl-pack.json 路径' });
        if (path && path.trim()) {
          try {
            const r2 = await importPack(path.trim());
            console.log('导入成功：profile「' + r2.profile + '」（' + r2.manifest.name + ' v' + r2.manifest.version + '）');
          } catch (e) { console.log('导入失败：' + (e && e.message ? e.message : e)); }
        }
      } else if (first === '新建整合包（手动选插件）') {
        const { name } = await prompt({
          type: 'input',
          name: 'name',
          message: '新整合包（profile）名',
          validate: (v) => isValidProfileName(v) ? true : '非法名字（不能含 / 或 \\、不能是 . .. node_modules）',
        });
        if (name) {
          const { pkgs } = await prompt({ type: 'input', name: 'pkgs', message: '要安装的 bundle 包名（空格分隔；回车默认 @deepseek-ai/dsh-base）' });
          const list = splitPkgs(pkgs);
          const addArgs = list.length ? list : ['@deepseek-ai/dsh-base'];
          console.log('创建 profile「' + name + '」并安装：' + addArgs.join(' '));
          const code = await runPlugin(name, ['add', ...addArgs]);
          console.log('完成（退出码 ' + code + '）。');
        }
      } else {
        return;
      }
      // 首次引导完成后继续进入主循环（若无整合包仍会再次引导）
      const after = await discoverProfiles();
      if (after.length === 0) return;
    }
    for (;;) {
      const { action } = await prompt({
        type: 'select',
        name: 'action',
        message: 'bdl 主菜单',
        choices: ['启动整合包', '整合包管理', '插件管理', '升级与回滚', '环境隔离', '诊断', 'dsh 版本管理', '校验整合包', '设置', '退出'],
      });
      if (action === '退出') break;
      if (action === '启动整合包') {
        const profile = await pickProfile('选择要启动的整合包');
        if (profile) { await handoffToDsh({ profile }); return; }
      } else if (action === '整合包管理') {
        await managePacks();
      } else if (action === '插件管理') {
        await managePlugins();
      } else if (action === '升级与回滚') {
        await upgradeMenu();
      } else if (action === '环境隔离') {
        await isolateMenu();
      } else if (action === '诊断') {
        await diagnoseMenu();
      } else if (action === '设置') {
        await settingsMenu();
      } else if (action === 'dsh 版本管理') {
        await versionMenu();
      } else if (action === '校验整合包') {
        const profile = await pickProfile('选择要校验的整合包');
        if (profile) {
          console.log('校验 ' + profile + '（--dump-config）…');
          let dsh;
          try { dsh = resolveForProfile(profile); }
          catch (e) { console.log('无法解析该整合包使用的 dsh：' + (e && e.message ? e.message : e)); return; }
          const r = await captureDump(profile, dsh);
          console.log('校验退出码：' + r.code);
          if (r.code !== 0) {
            console.log('--- 输出尾部 ---');
            console.log((r.err || r.out).split('\n').slice(-10).join('\n') || '(无输出)');
            console.log('--- 提示 ---');
            for (const h of parseHints(r)) console.log('• ' + h);
          } else {
            console.log('组合校验通过。');
          }
        }
      }
    }
  } catch (e) {
    const msg = typeof e === 'string' ? e : (e && e.message ? String(e.message) : '');
    if (msg === '' || msg.toLowerCase().includes('cancel')) {
      console.log('\n已取消。');
      process.exit(0);
    }
    throw e;
  }
}
