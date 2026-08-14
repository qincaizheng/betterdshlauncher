# 示例整合包：oh-my-dsh

依据上层目录 `oh-my-dsh/repo/` 的权威定义生成：
- `PLUGINS.md` — 插件清单（唯一权威，16 依赖键 / 16 功能组）
- `INSTALL.md` — 安装手册
- `DISABLED.md` — 默认禁用清单

## 内容（与 PLUGINS.md 一致）

- **bundles（15）**：
  - 2 内置：`@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app`（锁 `^0.1.0-rc.6`）
  - A 组：`@linxin666/dsh-web-ui-all` `^0.1.12`（全家桶聚合，npm 实测版本）
  - B 组（npm）：`@canglongcl/dsh-web-review` `^0.1.0`、`@zseven-w/dsh-openpencil` `0.1.0-rc.1`、`dsh-auto-approval` `^0.1.0`
  - C 组（源码 link，9 个 bundle 挂载）：at-file / agent-teams / git-identity / plugin-console / toolkit / **sidechain** / **upstream-fixes（必装修复层）** / mcp-manager / annotation
- **deps（3，仅安装不激活）**：`dsh-better-sidebar`、`@dsh-community/dsh-paste-input`（由 patch insert 激活）、`dsh-client-ui-auto-approval` `^0.1.0`
- **patch**：两条 insert（better-sidebar / dsh-paste-input，各只写一次）+ DISABLED.md 三条禁用（`ui-dsh-aionui-panel`、`live-stats`、`dsh-sidechain`）
- **dsh 约束**：`minVersion 0.1.0-rc.6`，`profileTemplate web`

## 使用方式（任选）

1. **导入本地**：`bdl` → 整合包管理 → 导入整合包 → 填 `examples/oh-my-dsh.bdl-pack.json` 绝对路径
2. **直链下载**：`bdl` → 下载整合包 → 直链 URL → `file://…/examples/oh-my-dsh.bdl-pack.json`
3. **index 浏览**：`bdl` → 下载整合包 → bdl-pack index → `file://…/examples/index.json`（自动校验 sha256）

## ⚠️ 导入前必读（对应 INSTALL.md 的坑）

1. **link 路径**：manifest 里 C 组/de deps 的 `path` 用 `~/.dsh/plugins/<dir>` 表示（导入时自动展开）。对方机器必须先把对应仓库 clone 到该目录（clone 清单见 INSTALL.md §2.3）并完成构建：
   - `dsh-toolkit`：清 lockfile 后 `npm install && bash scripts/build-all.sh`
   - `dsh-sidechain`：`pnpm install --no-frozen-lockfile && pnpm build`
   - `plugin-console`：子包 `packages/plugin/console` 内 pnpm install
   - `dsh-upstream-fixes`：link 后必须手动 `node scripts/install-aliases.mjs`
   - `dsh-agent-teams`：peer 指向未发布私有包，需按 INSTALL.md §4.3 断链修复
2. **allowBuilds**：首次装 `dsh-web-ui-all` 若报 `ERR_PNPM_IGNORED_BUILDS`，把 `cloudflared`/`cpu-features`/`ssh2` 加进 profile 的 `pnpm-workspace.yaml` allowBuilds 后重装。
3. **重启生效**：装完重启 `dsh web` + 浏览器硬刷新；禁用/启用同理。
4. **幂等**：重复导入同名 profile 会被拒绝；insert 行只写一次（manifest 已含）。

## 导出时本地插件自动打包（vendor）

用 `bdl` → 整合包管理 → 导出整合包 时，**存在本地源码的 link 插件会被自动打包进 manifest 的 `vendor[]`**（base64 内联源码树，排除 `node_modules`/`.git`/5MB+ 单文件，符号链接保留）。导入方无需自己 clone 这些插件——bdl 会把 vendor 解包到 `BDL_HOME/vendor/<profile>/<key>/` 并把 link 指向解包目录。本示例为手工维护版（数据源是 PLUGINS.md 权威清单），未内联 vendor；如需携带源码，用导出流程对真实 profile 重新导出即可。

## 与官方仓库同步

权威文档在 GitHub：<https://github.com/qincaizheng/oh-my-dsh>。PLUGINS.md 更新后，改 `examples/oh-my-dsh.bdl-pack.json` 的 bundles/deps/patch 并重算 `index.json` 的 sha256 即可。
