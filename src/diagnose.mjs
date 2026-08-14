// src/diagnose.mjs — 校验输出捕获与失败解析提示、日志查看
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveDshHome } from './registry.mjs';

/** 捕获 --dump-config 输出（30s 超时），返回 {code, out, err} */
export function captureDump(profile, dshPath) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [dshPath, '--profile', profile, '--dump-config'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 30000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolvePromise({ code: 127, out, err: String(e && e.message || e) }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolvePromise({ code: code ?? (signal ? 128 : 1), out, err }); });
  });
}

/** 从 dump 输出/错误中提取可操作提示 */
export function parseHints({ code, out, err }) {
  const hints = [];
  const all = out + '\n' + err;
  const bundle = all.match(/cannot resolve profile bundle\s*["']?([^"'\s]+)/i);
  if (bundle) hints.push('bundle「' + bundle[1] + '」未安装或无法解析 → 「插件管理 → 添加 bundle ' + bundle[1] + '」');
  if (/--profile <name> is required/i.test(all)) hints.push('缺少 --profile：请确认已选择整合包');
  if (/ENOENT|no such file/i.test(all)) hints.push('文件不存在：profile 目录或依赖缺失，检查 ~/.dsh/profiles/<name>/');
  if (/YAML|bad indentation|unknown tag|!!js/i.test(all)) hints.push('cordis.patch.yml 解析失败：注意 js-yaml 不支持的标签（如 !!js），需手工清理该文件');
  if (/EPERM|EACCES/i.test(all)) hints.push('权限不足：确认 ' + resolveDshHome() + ' 可写');
  if (code !== 0 && hints.length === 0) hints.push('退出码 ' + code + '：查看输出尾部定位失败的 bundle/patch');
  return hints;
}

/** 列出 DSH_HOME/logs 下的日志文件 */
export async function listLogs() {
  try { return (await readdir(join(resolveDshHome(), 'logs'))).filter((n) => n.endsWith('.log')); }
  catch { return []; }
}

/** 读取日志尾部 n 行 */
export async function tailLog(name, n = 80) {
  const text = await readFile(join(resolveDshHome(), 'logs', name), 'utf8');
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  return lines.slice(-n).join('\n');
}
