#!/usr/bin/env node
// bin/bdl.mjs — CLI 入口：有参数直通真实 dsh；无参数 + TTY 进 TUI；无参数 + 非 TTY 打印用法
import { spawnDsh } from '../src/dsh.mjs';
import { runTui } from '../src/tui.mjs';

const args = process.argv.slice(2);

if (args.length > 0) {
  // 有参数 → 原样直通真实 dsh（spawn 绝对路径 + stdio inherit + 透传退出码）
  process.exit(await spawnDsh(args));
} else if (process.stdin.isTTY && process.stdout.isTTY) {
  // 无参数 + 交互终端 → 进 TUI
  await runTui();
} else {
  // 无参数 + 非 TTY → 用法提示并退出非零
  process.stderr.write('用法：bdl <args...>  直通真实 dsh（如 bdl web、bdl --version）；无参数时请在交互终端运行以进入菜单。\n');
  process.exit(2);
}
