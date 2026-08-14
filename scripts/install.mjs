// scripts/install.mjs — 一行安装：装依赖（如缺）→ 跨平台生成 bdl shim（POSIX: ~/.local/bin/bdl；win32: %USERPROFILE%/bin/bdl.cmd）
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, chmod, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const binEntry = join(repoRoot, 'bin', 'bdl.mjs');

/** 依赖缺失时自动 npm install（首次运行一次性） */
function ensureDeps() {
  const need = ['enquirer', 'js-yaml'].some((p) => !existsSync(join(repoRoot, 'node_modules', p)));
  if (!need) return true;
  console.log('首次运行：安装依赖（enquirer + js-yaml，约 1.6MB）…');
  const r = spawnSync('npm', ['install'], { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error('依赖安装失败（npm 退出码 ' + r.status + '）');
    return false;
  }
  return true;
}

async function main() {
  const os = platform();
  const home = homedir();
  try {
    if (!ensureDeps()) process.exit(1);
    if (os === 'win32') {
      const dir = join(home, 'bin');
      await mkdir(dir, { recursive: true });
      const target = join(dir, 'bdl.cmd');
      await writeFile(target, '@echo off\r\nnode "' + binEntry + '" %*\r\n', 'utf8');
      console.log('已写入 ' + target);
      console.log('请确认 %USERPROFILE%\bin 在你的 PATH 中（PowerShell 检查：$env:PATH -split ";"）。');
    } else {
      const dir = join(home, '.local', 'bin');
      await mkdir(dir, { recursive: true });
      const target = join(dir, 'bdl');
      await writeFile(target, '#!/bin/sh\nexec node "' + binEntry + '" "$@"\n', 'utf8');
      await chmod(target, 0o755);
      console.log('已写入 ' + target);
      console.log('请确认 ~/.local/bin 在你的 PATH 中（检查：echo $PATH）。');
    }
  } catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) {
      console.error('无法写入（权限受限，可能在受限沙箱中）：' + (e.message || e));
      console.error('请在真实 shell 中运行：node ' + join(repoRoot, 'scripts', 'install.mjs'));
    } else {
      throw e;
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
