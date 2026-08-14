// src/download.mjs — 整合包下载（直链 URL / git 仓库 / bdl-pack index + sha256 校验 + 安装，按 RESEARCH.md 8.5）
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { importPack } from './pack.mjs';
import { resolveBdlHome } from './registry.mjs';

/** 拉取文本（https/http fetch + 超时 + 重试；file:// 直接读文件） */
export async function fetchText(url, { timeoutMs = 30000, retries = 2 } = {}) {
  if (url.startsWith('file://')) {
    const p = decodeURIComponent(url.slice('file://'.length));
    return readFile(p, 'utf8');
  }
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw new Error('bdl: 下载失败 ' + url + '：' + (lastErr && (lastErr.message || lastErr.name) || lastErr));
}

/** git 仓库源：clone --depth 1（支持 ref/tag/branch）到临时目录读 bdl-pack.json；github 失败降级 raw URL */
export async function downloadFromGit(repo, ref) {
  const tmp = join(tmpdir(), 'bdl-git-' + randomBytes(6).toString('hex'));
  const cloneArgs = ['clone', '--depth', '1'];
  if (ref) cloneArgs.push('--branch', ref);
  cloneArgs.push(repo, tmp);
  try {
    await runGit(cloneArgs);
    const text = await readFile(join(tmp, 'bdl-pack.json'), 'utf8');
    return { text, from: 'git', url: repo, ref: ref || undefined };
  } catch (e) {
    // github 降级 raw URL
    const m = String(repo).match(/^(?:https?:\/\/|git@)github\.com[:\/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (m) {
      const raw = 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + (ref || 'HEAD') + '/bdl-pack.json';
      try {
        const text = await fetchText(raw);
        return { text, from: 'raw', url: raw, ref: ref || undefined };
      } catch (e2) {
        throw new Error('bdl: git 拉取失败 ' + repo + '：' + (e && e.message ? e.message : e) + '；raw 降级也失败：' + (e2 && e2.message ? e2.message : e2));
      }
    }
    throw new Error('bdl: git 拉取失败 ' + repo + '：' + (e && e.message ? e.message : e));
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

function runGit(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error('git 退出码 ' + code + (err ? '：' + err.slice(0, 200) : ''))));
  });
}

/** 拉取并校验 index JSON（format 必须为 bdl-pack-index） */
export async function loadIndex(indexUrl) {
  const raw = await fetchText(indexUrl);
  let o;
  try { o = JSON.parse(raw); } catch { throw new Error('bdl: index 不是合法 JSON：' + indexUrl); }
  if (!o || o.format !== 'bdl-pack-index' || !Array.isArray(o.packs)) throw new Error('bdl: index 格式非法（需要 format=bdl-pack-index + packs[]）：' + indexUrl);
  return o;
}

/** index 内模糊搜索（按 id/name/description） */
export function searchPacks(packs, term) {
  const t = String(term || '').trim().toLowerCase();
  if (!t) return packs;
  return packs.filter((p) => [p.id, p.name, p.description].some((s) => s && String(s).toLowerCase().includes(t)));
}

/** sha256 校验（不匹配抛错；expected 缺省跳过） */
export function verifySha256(text, expected) {
  if (!expected) return true;
  const actual = createHash('sha256').update(text, 'utf8').digest('hex');
  if (actual.toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error('bdl: sha256 校验失败（期望 ' + expected + '，实际 ' + actual + '）');
  }
  return true;
}

/** 从源安装整合包：拉取 → sha256 → 临时 manifest → importPack（source 字段回写） */
export async function installFromSource({ type, url, ref, sha256, profile }) {
  const got = type === 'git'
    ? await downloadFromGit(url, ref)
    : { text: await fetchText(url), from: type, url };
  verifySha256(got.text, sha256);
  const tmp = join(resolveBdlHome(), 'tmp', 'dl-' + randomBytes(6).toString('hex') + '.bdl-pack.json');
  await mkdir(join(resolveBdlHome(), 'tmp'), { recursive: true });
  await writeFile(tmp, got.text, 'utf8');
  try {
    return await importPack(tmp, {
      ...(profile ? { profile } : {}),
      source: { type, url, ...(ref ? { ref } : {}) },
    });
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}
