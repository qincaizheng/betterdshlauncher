// src/tui.mjs — 全屏仪表盘 TUI：header / 左侧导航 / body 面板（鼠标 + 键盘两级导航）
// 选择类操作全部在右栏面板内完成；仅需要打字输入/大量输出的流程临时退出全屏。
import Enquirer from 'enquirer';
import { discoverProfiles, listBundles, isValidProfileName, defaultDshVersion, profileDshVersion, defaultProfile, setDefaultProfile, writeNpmrc, readNpmrc, loadMeta, saveMeta, metaPath, versionsDir } from './registry.mjs';
import { remoteVersions, installedVersions, systemVersion, installVersion, removeVersion, setDefault, setProfileLock, resolveForProfile } from './dsh-version.mjs';
import { runPlugin } from './dsh.mjs';
import { importPack, exportPack } from './pack.mjs';
import { fetchText, downloadFromGit, loadIndex, searchPacks, installFromSource } from './download.mjs';
import { checkRegistryUpdates, checkLinkUpdates, updateRegistryPkgs, updateLinkPkg } from './update.mjs';
import { upgradeProfile, rollbackProfile, listSnapshots, copyProfile, deleteProfile, renameProfile } from './upgrade.mjs';
import { createIsolatedEnv, removeIsolatedEnv, listIsolatedEnvs, launchIsolated, envHome, envProfileDir } from './isolate.mjs';
import { captureDump, parseHints, listLogs, tailLog } from './diagnose.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { handoffToDsh } from './handoff.mjs';
import { disableBundle, enableBundle, disabledIds } from './patch-edit.mjs';
import { Screen, renderFrame, c } from './ui/frame.mjs';

const enquirer = new Enquirer();

async function prompt(cfg) {
  return enquirer.prompt(cfg);
}

/** 拆分空格分隔的包名列表（过滤空串） */
function splitPkgs(s) {
  return String(s || '').trim().split(' ').filter(Boolean);
}

function isCancel(e) {
  const msg = typeof e === 'string' ? e : (e && e.message ? String(e.message) : '');
  return msg === '' || msg.toLowerCase().includes('cancel');
}

/** 流程输出后暂停，等待用户按键再回全屏 */
function waitKey(message) {
  return new Promise((resolve) => {
    process.stdout.write('\n' + (message || '按任意键返回…'));
    const stdin = process.stdin;
    if (!stdin.isTTY) { process.stdout.write('\n'); resolve(); return; }
    stdin.setRawMode(true);
    stdin.resume();
    const onData = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      resolve();
    };
    stdin.on('data', onData);
  });
}

// ---- 下载流程（新建整合包的远程来源） ----------------------------------------

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

async function flowDownloadUrl() {
  const { url } = await prompt({ type: 'input', name: 'url', message: 'bdl-pack.json 的 http(s)/file URL' });
  if (!url) return;
  const { sha } = await prompt({ type: 'input', name: 'sha', message: 'sha256（可选，回车跳过）' });
  try {
    const text = await fetchText(url.trim());
    await confirmInstall(text, { type: 'url', url: url.trim(), ...(sha && sha.trim() ? { sha256: sha.trim() } : {}) });
  } catch (e) { console.log('下载失败：' + (e && e.message ? e.message : e)); }
}

async function flowDownloadGit() {
  const { repo } = await prompt({ type: 'input', name: 'repo', message: 'git 仓库 URL（https/git@）' });
  if (!repo) return;
  const { ref } = await prompt({ type: 'input', name: 'ref', message: '分支/tag（可选，回车默认）' });
  try {
    const got = await downloadFromGit(repo.trim(), (ref && ref.trim()) || undefined);
    await confirmInstall(got.text, { type: 'git', url: repo.trim(), ...(ref && ref.trim() ? { ref: ref.trim() } : {}) });
  } catch (e) { console.log('下载失败：' + (e && e.message ? e.message : e)); }
}

/** 输 index URL 后返回「选包」下钻面板（由仪表盘在全屏内展示） */
async function flowDownloadIndex() {
  const { url } = await prompt({ type: 'input', name: 'url', message: 'index JSON 的 http(s)/file URL' });
  if (!url) return;
  let packs;
  try {
    const idx = await loadIndex(url.trim());
    packs = searchPacks(idx.packs, '');
  } catch (e) { console.log('下载失败：' + (e && e.message ? e.message : e)); return; }
  if (!packs.length) { console.log('index 为空。'); return; }
  return {
    title: '选择整合包（' + packs.length + ' 个）',
    info: [],
    items: packs.filter((p) => p.url).map((p) => ({
      label: p.name + ' v' + p.version,
      hint: p.description || '',
      run: async () => {
        try {
          const text = await fetchText(p.url);
          await confirmInstall(text, { type: 'url', url: p.url, ...(p.sha256 ? { sha256: p.sha256 } : {}) });
        } catch (e) { console.log('下载失败：' + (e && e.message ? e.message : e)); }
      },
    })),
  };
}

/** 首次引导里的下载（普通模式，非全屏）：选源 → 对应流程 */
async function bootstrapDownload() {
  const { src } = await prompt({
    type: 'select',
    name: 'src',
    message: '下载整合包 — 选择源',
    choices: ['直链 URL', 'git 仓库', 'bdl-pack index', '返回'],
  });
  if (src === '直链 URL') {
    await flowDownloadUrl();
  } else if (src === 'git 仓库') {
    await flowDownloadGit();
  } else if (src === 'bdl-pack index') {
    const panel = await flowDownloadIndex();
    if (panel && panel.items.length) {
      const { pick } = await prompt({
        type: 'autocomplete',
        name: 'pick',
        message: panel.title,
        choices: panel.items.map((it, i) => ({ name: String(i), message: it.label + (it.hint ? ' — ' + it.hint : '') })),
      });
      const it = panel.items[Number(pick)];
      if (it && it.run) await it.run();
    }
  }
}

// ---- 叶子流程（需要打字输入 / 大量输出，临时退出全屏执行） ---------------------

async function flowCreatePack() {
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
}

async function flowImportPack() {
  const { path } = await prompt({ type: 'input', name: 'path', message: 'bdl-pack.json 路径' });
  if (!path) return;
  try {
    const r = await importPack(path.trim());
    console.log('导入成功：profile「' + r.profile + '」（' + r.manifest.name + ' v' + r.manifest.version + '）');
  } catch (e) { console.log('导入失败：' + (e && e.message ? e.message : e)); }
}

async function flowExportPack(profile) {
  try {
    const r = await exportPack(profile);
    console.log('已导出：' + r.path + (r.vendorCount ? '（已打包 ' + r.vendorCount + ' 个本地插件，约 ' + Math.round(r.vendorBytes / 1024) + 'KB）' : ''));
  } catch (e) { console.log('导出失败：' + (e && e.message ? e.message : e)); }
}

async function flowCopyPack(src) {
  const { dst } = await prompt({ type: 'input', name: 'dst', message: '新整合包（profile）名', validate: (v) => isValidProfileName(v) ? true : '非法名字' });
  if (!dst) return;
  try { await copyProfile(src, dst); console.log('已复制为「' + dst + '」。'); }
  catch (e) { console.log('复制失败：' + (e && e.message ? e.message : e)); }
}

async function flowRenamePack(src) {
  const { dst } = await prompt({ type: 'input', name: 'dst', message: '新名字', validate: (v) => isValidProfileName(v) ? true : '非法名字' });
  if (!dst) return;
  try { await renameProfile(src, dst); console.log('已重命名为「' + dst + '」（建议校验一次）。'); }
  catch (e) { console.log('重命名失败：' + (e && e.message ? e.message : e)); }
}

async function flowDeletePack(src) {
  const { ok } = await prompt({ type: 'confirm', name: 'ok', message: '确认删除「' + src + '」？此操作不可恢复', initial: false });
  if (!ok) return;
  try { await deleteProfile(src); console.log('已删除「' + src + '」。'); }
  catch (e) { console.log('删除失败：' + (e && e.message ? e.message : e)); }
}

async function flowPluginAdd(profile) {
  const { pkgs } = await prompt({ type: 'input', name: 'pkgs', message: '要添加的包名（空格分隔）' });
  const list = splitPkgs(pkgs);
  if (list.length) { const code = await runPlugin(profile, ['add', ...list]); console.log('退出码 ' + code); }
}

async function flowPluginRemove(profile) {
  const { pkgs } = await prompt({ type: 'input', name: 'pkgs', message: '要移除的包名（空格分隔）' });
  const list = splitPkgs(pkgs);
  if (list.length) { const code = await runPlugin(profile, ['remove', ...list]); console.log('退出码 ' + code); }
}

async function flowCheckUpdates(profile) {
  console.log('检查 registry 依赖…');
  const reg = await checkRegistryUpdates(profile);
  if (reg.error) console.log(reg.error);
  else if (!reg.items.length) console.log('registry 依赖全部最新。');
  else for (const i of reg.items) console.log('• ' + i.name + '  ' + i.current + ' → ' + i.latest + '（wanted ' + i.wanted + '）');
  console.log('检查 link 插件（git）…');
  const link = await checkLinkUpdates(profile);
  if (!link.items.length) console.log('link 插件全部最新（或无可检测项）。');
  else for (const i of link.items) console.log('• ' + i.name + '  落后 ' + i.behind + ' 个提交（' + i.dir + '）');
}

async function flowBatchUpdate(profile) {
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

async function flowInstallOne(v) {
  const { ok } = await prompt({ type: 'confirm', name: 'ok', message: '将下载约 529 包 / 334MB，确认安装 ' + v + '？', initial: true });
  if (!ok) return;
  console.log('安装 ' + v + '（可能需要数分钟，进度实时显示）…');
  try { const bin = await installVersion(v); console.log('安装完成：' + bin); }
  catch (e) { console.log('安装失败：' + (e && e.message ? e.message : e)); }
}

function flowShowManualInstall(v) {
  console.log('请在终端自己执行（装完回来自动识别）：');
  console.log('');
  console.log('  npm install --prefix ' + join(versionsDir(), v) + ' --no-save @deepseek-ai/dsh@' + v);
  console.log('');
  console.log('约 529 包 / 334MB / 2 分钟；中途反悔直接 Ctrl-C，不影响任何现有版本。');
}

/** 安装版本：远程版本列表面板 → 每个版本下钻安装方式 */
async function installVersionPanel() {
  const { versions, distTags } = await remoteVersions();
  if (!versions || !versions.length) {
    return { title: '安装版本', info: [c.gray('无法获取远程版本（离线？）')], items: [] };
  }
  const latest = (distTags && distTags.latest) || versions[versions.length - 1];
  return {
    title: '安装版本 — 选择版本',
    info: [],
    items: versions.map((v) => ({
      label: v + (v === latest ? '（latest）' : ''),
      children: () => ({
        title: '安装 ' + v,
        info: [c.gray('约 529 包 / 334MB / 2 分钟')],
        items: [
          { label: '一键安装（推荐）', hint: 'bdl 代跑 npm', run: () => flowInstallOne(v) },
          { label: '显示手动安装命令', run: () => flowShowManualInstall(v) },
        ],
      }),
    })),
  };
}

/** 切换默认版本：内联生效，状态行反馈 */
async function switchDefaultPanel() {
  const installed = await installedVersions();
  const panel = {
    title: '选择默认版本',
    info: [],
    items: [
      { label: 'system', hint: '系统版', inline: true, run: async () => { await setDefault('system'); return '默认版本已设为 system'; } },
      ...installed.map((iv) => ({
        label: iv.version, inline: true,
        run: async () => { await setDefault(iv.version); return '默认版本已设为 ' + iv.version; },
      })),
    ],
  };
  panel.rebuild = switchDefaultPanel;
  return panel;
}

/** 删除版本：内联执行，面板原地刷新 */
async function removeVersionPanel() {
  const installed = await installedVersions();
  const panel = {
    title: '选择要删除的版本',
    info: installed.length ? [] : [c.gray('（无已装版本）')],
    items: installed.map((iv) => ({
      label: iv.version,
      inline: true,
      run: async () => { await removeVersion(iv.version); return '已删除 ' + iv.version; },
    })),
  };
  panel.rebuild = removeVersionPanel;
  return panel;
}

/** 锁定整合包版本：版本列表面板，内联生效 */
async function lockVersionPanel(profile) {
  const installed = await installedVersions();
  const build = async () => lockVersionPanel(profile);
  return {
    title: '选择 ' + profile + ' 锁定的版本',
    info: [c.gray('当前：' + profileDshVersion(profile))],
    rebuild: build,
    items: [
      { label: '跟随默认（解除锁定）', inline: true, run: async () => { await setProfileLock(profile, null); return profile + ' 已解除锁定，跟随默认'; } },
      { label: 'system', hint: '系统版', inline: true, run: async () => { await setProfileLock(profile, 'system'); return profile + ' 锁定为 system'; } },
      ...installed.map((iv) => ({
        label: iv.version, inline: true,
        run: async () => { await setProfileLock(profile, iv.version); return profile + ' 锁定为 ' + iv.version; },
      })),
    ],
  };
}
async function flowUpgrade(profile) {
  console.log('将快照 package.json / pnpm-lock.yaml / cordis.patch.yml 后执行 pnpm update…');
  try {
    const s = await upgradeProfile(profile);
    console.log('升级完成，快照：' + s.dir);
    console.log('建议立即「校验整合包」确认组合正常。');
  } catch (e) { console.log('升级失败：' + (e && e.message ? e.message : e)); }
}

async function flowRollback(profile, ts) {
  try { await rollbackProfile(profile, ts); console.log('已回滚到 ' + ts); }
  catch (e) { console.log('回滚失败：' + (e && e.message ? e.message : e)); }
}

async function flowCreateEnv(profile) {
  console.log('将复制 profile 文件到 ' + envHome(profile) + ' 并执行 pnpm install（首次较慢）…');
  try { await createIsolatedEnv(profile); console.log('隔离环境已创建：' + envHome(profile)); }
  catch (e) { console.log('创建失败：' + (e && e.message ? e.message : e)); }
}

async function flowLaunchEnv(profile) {
  if (!existsSync(envProfileDir(profile))) { console.log('隔离环境不存在，请先创建。'); return; }
  const code = await launchIsolated(profile);
  console.log('（隔离会话已退出，码 ' + code + '）');
}

async function flowDeleteEnv(name) {
  const { ok } = await prompt({ type: 'confirm', name: 'ok', message: '确认删除隔离环境「' + name + '」？', initial: false });
  if (!ok) return;
  await removeIsolatedEnv(name);
  console.log('已删除 ' + name);
}

async function flowVerify(profile) {
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

async function flowTailLog(name) {
  try { console.log(await tailLog(name, 80)); }
  catch (e) { console.log('读取失败：' + (e && e.message ? e.message : e)); }
}

async function flowSetExtraArgs(profile) {
  const meta = await loadMeta();
  const cur = (meta.bundles && meta.bundles[profile] && meta.bundles[profile].extraArgs) || [];
  const { args } = await prompt({ type: 'input', name: 'args', message: '启动参数（空格分隔，回车清空）当前：' + cur.join(' ') });
  const next = splitPkgs(args);
  if (!meta.bundles) meta.bundles = {};
  if (!meta.bundles[profile]) meta.bundles[profile] = { id: profile, name: profile, profile };
  meta.bundles[profile].extraArgs = next;
  await saveMeta(meta);
  console.log('已保存：' + next.join(' '));
}

async function flowSetNpmrc(profile) {
  const cur = await readNpmrc(profile);
  console.log('当前 .npmrc：' + (cur || '（未设置，用全局 npm 配置）'));
  const { url } = await prompt({ type: 'input', name: 'url', message: 'registry URL（如 https://registry.npmmirror.com；回车跳过）' });
  if (url && url.trim()) {
    await writeNpmrc(profile, url.trim());
    console.log('已写入 ' + url.trim());
  }
}

// ---- 面板构建（body 内容；选择类操作全部内联） --------------------------------

/** 汇总仪表盘需要的状态（均为本地读，开销小） */
async function gatherContext() {
  const [profiles, installed, sys, envs, meta, logs] = await Promise.all([
    discoverProfiles(), installedVersions(), systemVersion(), listIsolatedEnvs(), loadMeta(), listLogs(),
  ]);
  return {
    profiles, installed, sys, envs, meta, logs,
    def: defaultProfile(),
    dshDef: defaultDshVersion(),
  };
}

/** profile 列表 → 面板条目（make(p) 返回 { run } / { children } / { inline, run }） */
function profileItems(ctx, make) {
  return ctx.profiles.map((p) => ({
    label: p.name + (p.name === ctx.def ? '（默认）' : ''),
    hint: p.bundles.length + ' 个 bundle',
    ...make(p),
  }));
}

function profilesPanel(ctx, title, make) {
  const panel = {
    title,
    info: ctx.profiles.length ? [] : [c.gray('（无整合包）')],
    items: profileItems(ctx, make),
  };
  panel.rebuild = async () => profilesPanel(await gatherContext(), title, make);
  return panel;
}

async function envsPanel(title, make) {
  const envs = await listIsolatedEnvs();
  return { title, info: envs.length ? [] : [c.gray('（无隔离环境）')], items: envs.map((e) => ({ label: e, ...make(e) })) };
}

/** 插件启停面板：Enter 直接切换，不离开全屏 */
async function bundleTogglePanel(profile) {
  const list = await listBundles(profile);
  const disabled = await disabledIds(profile);
  return {
    title: '启用/禁用（' + profile + '）',
    info: list.length ? [c.gray('Enter 切换，立即生效')] : [c.gray('（该整合包无 bundle）')],
    rebuild: () => bundleTogglePanel(profile),
    items: list.map((b) => ({
      label: b.name,
      hint: disabled.has(b.name) ? '已禁用' : '启用',
      inline: true,
      run: async () => {
        if (disabled.has(b.name)) { await enableBundle(profile, b.name); return '已启用 ' + b.name; }
        await disableBundle(profile, b.name); return '已禁用 ' + b.name;
      },
    })),
  };
}

async function pluginOpsPanel(profile) {
  return {
    title: '插件管理（' + profile + '）',
    info: [],
    rebuild: () => pluginOpsPanel(profile),
    items: [
      {
        label: 'bundle 列表', hint: '版本与来源',
        children: async () => {
          const list = await listBundles(profile);
          return {
            title: profile + ' 的 bundle',
            info: list.length ? [] : [c.gray('（无 bundle）')],
            items: list.map((b) => ({ label: b.name, hint: b.version + ' [' + b.source + ']' })),
          };
        },
      },
      { label: '启用/禁用', hint: 'Enter 直接切换', children: () => bundleTogglePanel(profile) },
      { label: '添加 bundle', run: () => flowPluginAdd(profile) },
      { label: '移除 bundle', run: () => flowPluginRemove(profile) },
      { label: '更新检查', hint: 'registry + git', run: () => flowCheckUpdates(profile) },
      { label: '批量更新', hint: '勾选后执行', run: () => flowBatchUpdate(profile) },
    ],
  };
}

const CATS = [
  {
    id: 'launch', label: '启动整合包', desc: '选择整合包并启动 dsh',
    panel: (ctx) => {
      const used = (n) => (ctx.meta.bundles && ctx.meta.bundles[n] && ctx.meta.bundles[n].lastUsedAt) || '';
      const ps = [...ctx.profiles].sort((a, b) => (used(b.name) > used(a.name) ? 1 : -1));
      const info = [
        c.gray('默认整合包  ') + (ctx.def ? c.green(ctx.def) : '（未设置）'),
        c.gray('dsh 版本    ') + ctx.dshDef,
      ];
      if (!ps.length) info.push(c.gray('（还没有整合包：到「整合包管理」下载或新建）'));
      return {
        title: '选择要启动的整合包',
        info,
        items: ps.map((p) => ({
          label: p.name + (p.name === ctx.def ? '（默认）' : ''),
          hint: p.bundles.length + ' 个 bundle · dsh ' + profileDshVersion(p.name),
          run: async () => { await handoffToDsh({ profile: p.name }); return 'exit'; },
        })),
      };
    },
  },
  {
    id: 'packs', label: '整合包管理', desc: '新建 / 下载 / 导入 / 导出 / 复制 / 重命名 / 删除',
    panel: (ctx) => ({
      title: '整合包管理',
      info: [ctx.profiles.length ? c.gray('共 ' + ctx.profiles.length + ' 个整合包') : c.gray('（还没有整合包）')],
      items: [
        {
          label: '浏览整合包', hint: '查看 bundle 构成',
          children: async () => profilesPanel(await gatherContext(), '浏览整合包', (p) => ({
            children: () => ({
              title: p.name + ' 的 bundle',
              info: p.bundles.length ? [] : [c.gray('（空）')],
              items: p.bundles.map((b) => ({ label: b })),
            }),
          })),
        },
        { label: '新建整合包', hint: '手动选插件', run: flowCreatePack },
        {
          label: '下载整合包', hint: 'URL / git / index',
          children: () => ({
            title: '下载整合包 — 选择来源',
            info: [],
            items: [
              { label: '直链 URL', hint: 'bdl-pack.json 的 http(s)/file 地址', run: flowDownloadUrl },
              { label: 'git 仓库', hint: 'https/git@ 仓库', run: flowDownloadGit },
              { label: 'bdl-pack index', hint: '从索引里挑选', run: flowDownloadIndex },
            ],
          }),
        },
        { label: '导入整合包', hint: '本地 bdl-pack.json', run: flowImportPack },
        { label: '导出整合包', children: async () => profilesPanel(await gatherContext(), '选择要导出的整合包', (p) => ({ run: () => flowExportPack(p.name) })) },
        { label: '复制整合包', children: async () => profilesPanel(await gatherContext(), '选择要复制的整合包', (p) => ({ run: () => flowCopyPack(p.name) })) },
        { label: '重命名整合包', children: async () => profilesPanel(await gatherContext(), '选择要重命名的整合包', (p) => ({ run: () => flowRenamePack(p.name) })) },
        { label: '删除整合包', hint: '不可恢复', children: async () => profilesPanel(await gatherContext(), '选择要删除的整合包', (p) => ({ run: () => flowDeletePack(p.name) })) },
      ],
    }),
  },
  {
    id: 'plugins', label: '插件管理', desc: 'bundle 列表、启停、增删与更新',
    panel: (ctx) => ({
      title: '插件管理 — 选择整合包',
      info: ctx.profiles.length ? [] : [c.gray('（先创建一个整合包）')],
      items: profileItems(ctx, (p) => ({ children: () => pluginOpsPanel(p.name) })),
    }),
  },
  {
    id: 'version', label: 'dsh 版本管理', desc: '安装 / 切换 / 锁定 dsh 版本',
    panel: (ctx) => ({
      title: 'dsh 版本管理',
      info: [
        c.gray('系统版本  ') + ctx.sys + (ctx.dshDef === 'system' ? c.green('（默认）') : ''),
        c.gray('默认版本  ') + ctx.dshDef,
        ctx.installed.length
          ? c.gray('已装      ') + ctx.installed.map((iv) => iv.version + (ctx.dshDef === iv.version ? '（默认）' : '')).join('  ')
          : c.gray('已装      （BDL 尚未安装任何版本）'),
      ],
      items: [
        { label: '安装版本', hint: '从 npm 拉取', children: installVersionPanel },
        { label: '切换默认版本', hint: '内联生效', children: switchDefaultPanel },
        { label: '删除版本', children: removeVersionPanel },
        { label: '锁定整合包版本', children: async () => profilesPanel(await gatherContext(), '选择要锁定版本的整合包', (p) => ({ children: () => lockVersionPanel(p.name) })) },
      ],
    }),
  },
  {
    id: 'upgrade', label: '升级与回滚', desc: '依赖升级（带快照）与一键回滚',
    panel: (ctx) => ({
      title: '升级与回滚',
      info: [c.gray('升级前自动快照 package.json / pnpm-lock.yaml / cordis.patch.yml')],
      items: [
        { label: '依赖升级', hint: 'pnpm update + 快照', children: async () => profilesPanel(await gatherContext(), '选择要升级依赖的整合包', (p) => ({ run: () => flowUpgrade(p.name) })) },
        {
          label: '回滚到快照',
          children: async () => profilesPanel(await gatherContext(), '选择要回滚的整合包', (p) => ({
            children: async () => {
              const snaps = await listSnapshots(p.name);
              return {
                title: '选择快照（' + p.name + '，新→旧）',
                info: snaps.length ? [] : [c.gray('（该整合包无快照）')],
                items: snaps.map((ts) => ({ label: ts, run: () => flowRollback(p.name, ts) })),
              };
            },
          })),
        },
      ],
    }),
  },
  {
    id: 'isolate', label: '环境隔离', desc: '独立 DSH_HOME 的隔离环境',
    panel: (ctx) => ({
      title: '环境隔离',
      info: [ctx.envs.length ? c.gray('现有环境  ') + ctx.envs.join('  ') : c.gray('（无隔离环境；整树隔离 = 独立 DSH_HOME）')],
      items: [
        { label: '创建隔离环境', children: async () => profilesPanel(await gatherContext(), '选择要隔离的整合包', (p) => ({ run: () => flowCreateEnv(p.name) })) },
        { label: '在隔离环境启动', children: () => envsPanel('选择要启动的隔离环境', (e) => ({ run: () => flowLaunchEnv(e) })) },
        { label: '删除隔离环境', children: () => envsPanel('选择要删除的隔离环境', (e) => ({ run: () => flowDeleteEnv(e) })) },
      ],
    }),
  },
  {
    id: 'verify', label: '校验整合包', desc: '--dump-config 组合校验',
    panel: (ctx) => ({
      title: '校验整合包 — 选择整合包',
      info: [c.gray('以 --dump-config 验证 bundle 组合可正常加载')],
      items: profileItems(ctx, (p) => ({ run: () => flowVerify(p.name) })),
    }),
  },
  {
    id: 'diagnose', label: '诊断', desc: '查看运行日志',
    panel: (ctx) => ({
      title: '诊断 — 选择日志',
      info: ctx.logs.length ? [] : [c.gray('（无日志文件）')],
      items: ctx.logs.map((l) => ({ label: l, run: () => flowTailLog(l) })),
    }),
  },
  {
    id: 'settings', label: '设置', desc: '默认整合包 / 启动参数 / 镜像源',
    panel: (ctx) => ({
      title: '设置',
      info: [
        c.gray('默认整合包  ') + (ctx.def || '（未设置）'),
        c.gray('元数据      ') + c.dim(metaPath()),
      ],
      items: [
        {
          label: '设置默认整合包',
          children: async () => profilesPanel(await gatherContext(), '选择默认整合包', (p) => ({
            inline: true,
            run: async () => { await setDefaultProfile(p.name); return '默认整合包已设为 ' + p.name; },
          })),
        },
        { label: '启动参数（extraArgs）', children: async () => profilesPanel(await gatherContext(), '选择整合包', (p) => ({ run: () => flowSetExtraArgs(p.name) })) },
        { label: '镜像源（profile .npmrc）', children: async () => profilesPanel(await gatherContext(), '选择整合包', (p) => ({ run: () => flowSetNpmrc(p.name) })) },
      ],
    }),
  },
  {
    id: 'quit', label: '退出', desc: '退出 bdl',
    panel: () => ({
      title: '退出',
      info: [c.gray('感谢使用 bdl。')],
      items: [{ label: '退出 bdl', run: () => 'exit' }],
    }),
  },
];

// ---- 仪表盘主循环 -------------------------------------------------------------

async function dashboard() {
  const screen = new Screen();
  let ctx = await gatherContext();
  let cat = 0;
  let focus = 'nav'; // 'nav'（左栏）| 'body'（右栏面板）
  let stack = [];    // 当前分类的面板栈（children 下钻）
  let statusMsg = null;
  let loadSeq = 0;
  let layout = null;

  const top = () => stack[stack.length - 1];

  function paint() {
    const t = top() || { title: '', info: [], items: [], sel: 0 };
    const navFocused = focus === 'nav';
    const out = renderFrame({
      cols: screen.cols,
      rows: screen.rows,
      headerLeft: 'bdl · Better DSH Launcher',
      headerRight: '整合包 ' + (ctx.def || '—') + ' · dsh ' + ctx.dshDef,
      navCaption: '导航',
      menu: CATS,
      selected: cat,
      navFocused,
      bodyTitle: t.title,
      bodyInfo: statusMsg ? [c.yellow(statusMsg), ...t.info] : t.info,
      bodyItems: t.items,
      bodySel: t.sel || 0,
      bodyFocused: !navFocused,
      bodyBack: stack.length > 1,
      footerLeft: navFocused
        ? '↑/↓ 移动 · Enter/→ 进入 · 鼠标点击选择 · q 退出'
        : '↑/↓ 选择 · Enter 执行 · Esc/←/右键 返回 · q 退出',
      footerRight: CATS[cat].desc,
    });
    layout = out.layout;
    screen.render(out.text);
  }

  async function loadRoot() {
    const seq = ++loadSeq;
    stack = [{ title: CATS[cat].label, info: [c.gray('加载中…')], items: [], sel: 0 }];
    paint();
    const p = await CATS[cat].panel(ctx);
    p.sel = 0;
    if (seq === loadSeq) { stack = [p]; paint(); }
  }

  /** 全屏流程结束后：刷新状态并重建当前分类根面板（焦点进 body 继续操作） */
  async function refreshRoot() {
    ctx = await gatherContext();
    const p = await CATS[cat].panel(ctx);
    p.sel = 0;
    stack = [p];
    focus = p.items.length ? 'body' : 'nav';
    paint();
  }

  /** 执行一个面板条目；返回 'exit' 表示结束整个 TUI */
  async function activate(item) {
    if (!item) return;
    statusMsg = null;
    if (item.children) {
      const p = await item.children();
      p.sel = 0;
      stack.push(p);
      paint();
      return;
    }
    if (!item.run) return;
    if (item.inline) {
      // 内联操作：不离开全屏，结果显示在状态行，面板原地刷新
      try { statusMsg = (await item.run()) || null; }
      catch (e) { statusMsg = '失败：' + (e && e.message ? e.message : e); }
      ctx = await gatherContext();
      const t = top();
      if (t.rebuild) {
        const fresh = await t.rebuild();
        fresh.sel = Math.min(t.sel, Math.max(0, fresh.items.length - 1));
        stack[stack.length - 1] = fresh;
      }
      paint();
      return;
    }
    // 输入/输出型流程：临时退出全屏执行
    screen.exit();
    let r;
    try { r = await item.run(); }
    catch (e) { if (!isCancel(e)) console.log('出错了：' + (e && e.message ? e.message : e)); }
    if (r === 'exit') return 'exit';
    // 流程可以返回一个下钻面板（如先输 index URL，再回面板里选包）
    if (r && typeof r === 'object' && Array.isArray(r.items)) {
      screen.enter();
      r.sel = 0;
      stack.push(r);
      paint();
      return;
    }
    await waitKey();
    screen.enter();
    await refreshRoot();
  }

  /** 返回上一级：子面板弹栈；根面板焦点回左栏 */
  function goBack() {
    if (focus !== 'body') return;
    if (stack.length > 1) stack.pop();
    else focus = 'nav';
    statusMsg = null;
    paint();
  }

  /** 鼠标点击：左栏切分类（再点进 body），右栏选条目（再点执行），「‹ 返回」行弹栈 */
  async function onMouse(k) {
    if (!layout) return;
    if (layout.backY && k.y === layout.backY && k.x > layout.leftW) { goBack(); return; }
    if (k.x <= layout.leftW) {
      const i = layout.navOffset + (k.y - layout.navY);
      if (i < 0 || i >= CATS.length) return;
      if (i === cat) {
        focus = focus === 'nav' && top() && top().items.length ? 'body' : 'nav';
        paint();
      } else {
        cat = i;
        focus = 'nav';
        statusMsg = null;
        await loadRoot();
      }
      return;
    }
    const t = top();
    if (!t || !t.items.length) return;
    const i = layout.bodyOffset + (k.y - layout.bodyItemY);
    if (i < 0 || i >= t.items.length) return;
    if (i === t.sel && focus === 'body') return activate(t.items[i]);
    t.sel = i;
    focus = 'body';
    paint();
  }

  screen.onResize = paint;
  screen.enter();
  await loadRoot();
  try {
    for (;;) {
      const k = await screen.key();
      if (k.name === 'quit' || k.name === 'ctrl-c') return;
      if (k.name === 'esc' || k.name === 'left' || k.name === 'back' || k.name === 'rmb') {
        if (focus === 'body') {
          goBack();
        } else if (k.name === 'esc') {
          return; // 左栏按 Esc = 退出
        }
        continue;
      }
      if (k.name === 'up' || k.name === 'down' || k.name === 'wheelUp' || k.name === 'wheelDown') {
        const d = (k.name === 'up' || k.name === 'wheelUp') ? -1 : 1;
        statusMsg = null;
        if (focus === 'nav') {
          cat = (cat + CATS.length + d) % CATS.length;
          await loadRoot();
        } else {
          const t = top();
          if (t.items.length) { t.sel = (t.sel + d + t.items.length) % t.items.length; paint(); }
        }
        continue;
      }
      if (k.name === 'num') {
        if (focus === 'nav') { if (k.n >= 1 && k.n <= CATS.length) { cat = k.n - 1; await loadRoot(); } }
        else { const t = top(); if (k.n >= 1 && k.n <= t.items.length) { t.sel = k.n - 1; paint(); } }
        continue;
      }
      if (k.name === 'right') {
        if (focus === 'nav' && top() && top().items.length) { focus = 'body'; paint(); }
        continue;
      }
      if (k.name === 'enter') {
        if (focus === 'nav') {
          if (CATS[cat].id === 'quit') return;
          if (top() && top().items.length) { focus = 'body'; paint(); }
        } else {
          const r = await activate(top().items[top().sel || 0]);
          if (r === 'exit') return;
        }
        continue;
      }
      if (k.name === 'mouse') {
        const r = await onMouse(k);
        if (r === 'exit') return;
      }
    }
  } finally {
    screen.exit();
  }
}

/** 进入 TUI；启动整合包会通过 handoffToDsh 结束进程 */
export async function runTui() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('bdl: 交互界面需要 TTY 终端。\n');
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
        await bootstrapDownload();
      } else if (first === '导入本地 bdl-pack.json') {
        await flowImportPack();
      } else if (first === '新建整合包（手动选插件）') {
        await flowCreatePack();
      } else {
        return;
      }
      // 首次引导完成后继续进入仪表盘（若无整合包仍会再次引导）
      const after = await discoverProfiles();
      if (after.length === 0) return;
    }
    await dashboard();
  } catch (e) {
    if (isCancel(e)) {
      console.log('\n已取消。');
      process.exit(0);
    }
    throw e;
  }
}
