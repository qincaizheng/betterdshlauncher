// src/handoff.mjs — 选中整合包后把控制权移交给真实 dsh（按整合包锁定/默认版本解析，spawn + 透传退出码）
import { spawnDsh } from './dsh.mjs';
import { resolveForProfile } from './dsh-version.mjs';
import { loadMeta, touchUsage } from './registry.mjs';

/**
 * 启动某整合包：解析该整合包要用的 dsh（锁定/默认），spawn --profile X，
 * 子进程退出后透传退出码并结束进程（信号转发在 spawnDsh 内）。
 * 记录使用（lastUsedAt/useCount）；extraArgs 优先用显式传入，否则读元数据。
 */
export async function handoffToDsh({ profile, patchOverlays = [], extraArgs = [], env }) {
  const dsh = resolveForProfile(profile);
  await touchUsage(profile);
  const meta = await loadMeta();
  const entry = (meta.bundles && meta.bundles[profile]) || {};
  const args = ['--profile', profile, ...patchOverlays.flatMap((p) => ['--patch', p]), ...(entry.extraArgs || []), ...extraArgs];
  console.log('使用 dsh：' + dsh + (env ? '（隔离 DSH_HOME=' + env.DSH_HOME + '）' : ''));
  process.exit(await spawnDsh(args, { dsh, ...(env ? { env } : {}) }));
}
