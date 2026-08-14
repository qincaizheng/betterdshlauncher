# bdl — BetterDshLauncher

对 dsh CLI（DeepSeek Harness 启动器）的薄交互层：把「裸跑 dsh 无交互、整合包（bundle set）切换要手动改 profile」两个痛点，换成菜单式操作。

- 独立指令 `bdl`，**不接管、不遮蔽真实 `dsh`**（原 `dsh` 行为完全不变）。
- `bdl` 无参数 → TUI 菜单（选整合包启动 / 管理整合包 / 管理插件 / 校验）。
- `bdl <args>` → 原样直通真实 dsh（`bdl web` ≡ `dsh web`，`bdl --version` ≡ `dsh --version`）。

## 功能

**P0（MVP）**
- 启动整合包（profile）：AutoComplete 选包（按最近使用排序 + 默认整合包标记）→ 移交真实 dsh。
- 整合包管理：发现已有 profile、新建（`dsh plugin add`）、复制/重命名/删除。
- 插件管理：bundle 列表（版本/来源）、启用/禁用（`cordis.patch.yml` 的 `disabled` 条目，原子写 + 备份）、添加/移除 bundle。
- 校验整合包：`dsh --profile X --dump-config`（捕获输出 + 失败原因解析提示）。

**P1（整合包全生命周期）**
- 导入/导出：`bdl-pack.json` 格式（对标 .mrpack），严格校验 + 路径遍历防护 + 失败自动回滚。
- 下载：三种源（直链 URL / git 仓库 / bdl-pack index），sha256 校验，安装前展示摘要确认。
- 更新检查与批量更新：registry 依赖走 `pnpm outdated/update`；link 插件（git 仓库）走 `git fetch/pull`（跟随各仓库当前分支）。
- 依赖升级 + 快照回滚：升级前快照 package.json / pnpm-lock.yaml / cordis.patch.yml 到 `BDL_HOME/backups/<profile>/<ts>/`，可一键回滚。
- 整树隔离（L3）：独立 `DSH_HOME=BDL_HOME/envs/<profile>`，继承 settings/凭据可选，sessions/storages/logs 完全隔离。
- dsh 版本管理：安装/升级/降级、多版本共存（`BDL_HOME/versions/<v>`）、切换默认、按整合包锁定版本。

**P2（简易项）**
- 诊断：查看日志（`~/.dsh/logs/*.log` 尾部）。
- 镜像源：写 profile `.npmrc` 的 registry。
- 设置：默认整合包、启动参数（extraArgs）。

## 安装

### 一行安装（含依赖 + shim）

```bash
node ~/codex/workspace/betterdshlauncher/scripts/install.mjs
```

- macOS / Linux：写 `~/.local/bin/bdl`（POSIX sh，`chmod +x`）。
- Windows：写 `%USERPROFILE%/bin/bdl.cmd`。
- 运行后确认目标目录在你的 `PATH` 中（沙箱内运行会被 EPERM 拒绝，脚本会提示到真实 shell 运行）。

## 用法

```bash
bdl                    # 无参数进 TUI
bdl web                # 直通：启动 web profile
bdl --version          # 直通：打印 dsh 版本
bdl --profile X --help # 直通：任意参数都原样交给真实 dsh
```

## 目录约定

- `BDL_HOME`（bdl 元数据）：`BDL_HOME` env → 否则 unix `~/.config/bdl` / Windows `%APPDATA%/bdl`。含 `bundles.json`、`backups/<profile>/<ts>/`、`versions/<v>/`、`envs/<profile>/`（隔离环境）、`exports/`、`overlays/<profile>/`、`cache/`、`tmp/`。
- `DSH_HOME`（真实 dsh 家目录，只读）：`DSH_HOME` env → 否则 `~/.dsh`。`profiles/<name>/` 即一个整合包。
- 真实 dsh 定位：`BDL_REAL_DSH` env（最高）→ 整合包锁定版本 → 默认版本 → 系统 `which dsh` → 平台默认路径；一律绝对路径调用，绝不 spawn 裸名 `dsh`。
- npm 缓存：默认用 npm 全局缓存；`BDL_NPM_CACHE` env 可覆盖（受限环境测试用）。

## 整合包文件格式

`bdl-pack.json`：`manifestVersion:1` + `id/name/version` + `bundles[]`（有序，`version` 为约束如 `^1.0.0`，`source:link/git` 携带 `path/url`，`link` 路径支持 `~/` 前缀）+ `deps[]`（仅安装不激活的依赖，如 insert 挂载型插件，与 bundles 同构）+ `vendor[]`（**导出时自动打包本地 link 插件源码**：`{key, files:[{p, c: base64 内容 | link: 符号链接}]}`，排除 `node_modules`/`.git`/5MB+ 单文件；导入时解包到 `BDL_HOME/vendor/<profile>/<key>/` 并把 link 指向解包目录，无 vendor 时回退 `path`）+ `patch`（内联 cordis.patch.yml 文本）+ `overlays[]`（`--patch` overlay 文件内联）。导入时严格校验、防路径遍历，失败自动回滚（删 profile/overlays/vendor/元数据）。完整示例见 `examples/oh-my-dsh.bdl-pack.json`。

## dsh 版本管理

对标 nvm / HMCL 多版本：可安装多个 dsh 版本并存、切换默认、按整合包锁定。

- 目录：`BDL_HOME/versions/<version>/node_modules/@deepseek-ai/dsh/lib/bin.js`（每版独立安装，约 334MB / 529 包）。
- 默认版本：记录在 `bundles.json` 顶层 `dshDefault`（`system` 或具体版本号）。
- 锁定：某整合包元数据 `dshVersion` 字段锁定其使用的 dsh 版本；启动该整合包用锁定版，否则用默认版。
- 解析优先级：`BDL_REAL_DSH` env → 整合包锁定 → 默认版本 → 系统安装。

### 升降级示例（TUI：主菜单 → dsh 版本管理）

1. 安装版本：列远程版本（latest/next 标记）→ 选版本 → `npm install --prefix BDL_HOME/versions/<v> @deepseek-ai/dsh@<v>`。
2. 切换默认版本：选已装版本或 `system` → 写 `dshDefault`。
3. 锁定整合包版本：选整合包 → 选版本（或「跟随默认」解除锁定）。

### 风险提示

- 新 dsh 建的 profile 可能用旧版不兼容；切换版本后请用「校验整合包」（`--dump-config`）验证。
- 每版安装约 334MB；多版本共存磁盘成本显著。
- 删除默认版本会被拒绝（先切换默认再删）。

## 真实 dsh 不受影响

`bdl` 与 `dsh` 是两个独立命令名；`bdl` 内部只通过绝对路径调用真实 dsh。卸载 bdl 只需删除 shim（`~/.local/bin/bdl` / `bdl.cmd`）。
