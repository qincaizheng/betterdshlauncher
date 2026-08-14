// src/update.mjs — 插件更新检查与批量更新（registry 依赖走 pnpm outdated/update；link 插件走 git fetch/pull，跟随各仓库当前分支）
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolveDshHome, listBundles } from './registry.mjs';

function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolvePromise({ code: 127, out, err: String(e && e.message || e) }));
    child.on('close', (code, signal) => resolvePromise({ code: code ?? (signal ? 128 : 1), out, err }));
  });
}

function profileDir(profile) {
  return join(resolveDshHome(), 'profiles', profile);
}

/** registry 依赖更新检查：profile 目录跑 pnpm outdated --json（解析失败容错） */
export async function checkRegistryUpdates(profile) {
  const { code, out, err } = await run('pnpm', ['outdated', '--json'], { cwd: profileDir(profile) });
  if (code === 127) return { error: 'pnpm 不可用：' + err };
  let parsed = {};
  try { parsed = JSON.parse(out); } catch { /* 无 JSON（无更新/非常规输出） */ }
  if (code !== 0 && !Object.keys(parsed).length) return { error: 'pnpm outdated 失败：' + (err || out).slice(0, 300) };
  const items = [];
  for (const [name, info] of Object.entries(parsed)) {
    if (info && typeof info === 'object' && (info.latest !== info.current)) {
      items.push({ name, current: info.current, latest: info.latest, wanted: info.wanted });
    }
  }
  return { items };
}

/** link 插件更新检查：fetch 后按当前分支落后计数（无 upstream 跳过） */
export async function checkLinkUpdates(profile) {
  const bundles = await listBundles(profile);
  const items = [];
  for (const b of bundles) {
    if (b.source !== 'link') continue;
    const spec = await readSpec(profile, b.name);
    const dir = spec && spec.startsWith('link:') ? spec.slice(5) : null;
    if (!dir) continue;
    const behind = await gitBehind(dir);
    if (behind === null) continue; // 无 upstream/非仓库 → 跳过
    if (behind > 0) items.push({ name: b.name, dir, behind });
  }
  return { items };
}

async function readSpec(profile, name) {
  try {
    const pkg = JSON.parse(await readFile(join(profileDir(profile), 'package.json'), 'utf8'));
    return (pkg.dependencies && pkg.dependencies[name]) || null;
  } catch { return null; }
}

async function gitBehind(dir) {
  const upstream = await run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstream.code !== 0) return null;
  await run('git', ['-C', dir, 'fetch', '--quiet']);
  const n = await run('git', ['-C', dir, 'rev-list', '--count', 'HEAD..@{u}']);
  const m = String(n.out).trim().match(/^\d+$/);
  return m ? parseInt(m[0], 10) : null;
}

/** 更新 registry 依赖（pnpm update <pkg>） */
export async function updateRegistryPkgs(profile, names) {
  const { code, out, err } = await run('pnpm', ['update', ...names], { cwd: profileDir(profile), stdio: 'inherit' });
  return code;
}

/** 更新 link 插件（git pull 当前分支） */
export async function updateLinkPkg(profile, name) {
  const spec = await readSpec(profile, name);
  const dir = spec && spec.startsWith('link:') ? spec.slice(5) : null;
  if (!dir) throw new Error('bdl: ' + name + ' 不是 link 依赖或找不到目录');
  const { code, err } = await run('git', ['-C', dir, 'pull', '--ff-only'], { stdio: 'inherit' });
  if (code !== 0) throw new Error('bdl: git pull 失败（' + code + '）：' + String(err).slice(0, 200));
  return true;
}
