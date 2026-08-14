# 自制 dsh 启动器（Launcher）调研报告

> 调研对象：`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh`（v0.1.0-rc.6）+ 本机 `~/.dsh`
> 启动入口（设计定案）：独立指令 **`bdl`**（BetterDshLauncher）——不接管、不遮蔽真实 `dsh`；`bdl` 无参数进 TUI 选整合包，有参数原样直通真实 dsh。
> 调研方式：只读实测 + 源码通读（bin.js / profile-boot / plugin / dump-config / dsh-app-boot）。
> 说明：本调研在 agent 的 workspace-write 沙箱内运行，对 `~/.dsh` 与 `/opt/homebrew` 的**写**操作被拦截（EPERM）；文中所称「可写」均指用户正常 shell 环境（证据：`~/.local/bin` 与 `~/.dsh/profiles` 已有用户工具写入的符号链接/文件）。

---

## 一、现状确认

### 1.1 裸跑行为（实测）

```bash
# 分离 stdout / stderr 实测
dsh </dev/null >/tmp/out 2>/tmp/err; echo "exit=$?"
# exit=1
# stdout: (空, 0 字节)
# stderr: error: --profile <name> is required   (36 字节, 无结尾换行)
```

| 命令 | 退出码 | stdout | stderr |
|---|---|---|---|
| `dsh`（裸跑） | **1** | 空 | `error: --profile <name> is required` |
| `dsh --version` | 0 | `0.1.0-rc.6` | 空 |
| `dsh --help` | 0 | launcher 自己的帮助 | 空 |

结论确认：**裸跑 dsh 无任何交互界面**，直接报错退出。`dsh --help` 打印的是 launcher 自己的帮助（profile/patch/web/plugin/dump-config 等），不是 web 应用帮助。

### 1.2 `--dump-config` 的副作用（重要，影响「dry-run 校验」设计）

实测两个 dump 命令在本沙箱都因写 `~/.dsh/profiles/web/cordis.yml` 被拒而报 `EPERM`；读源码确认原因：

- `dump-config-D-jtgwY3.js` 的 `runDumpConfig()` 先调 `prepareProfile()`；
- `prepareProfile()`（在 `profile-boot-DG5t9aNs.js`）会：
  1. `healProfilesModuleFallback()` — 维护 `~/.dsh/profiles/node_modules` 符号链接农场（幂等）；
  2. `writeFileSync(join(profile.dir, "cordis.yml"), PROFILE_ROOT_CONFIG)` — **把 `cordis.yml` 重写回规范的空根 `[]`**。

所以 `--dump-config` / `--dump-default-config` **并非严格只读**：会重写 profile 的 `cordis.yml`（内容恒定为空根 `[]`，幂等）并重建符号链接。它们**不 boot、不起服务、不 eval `!!js`**，是安全的。输出是**带 `# == 来源注释` 的分组 YAML**，逐层标注每段行来自哪个 bundle/patch 文件。

**给 launcher 的结论**：「校验」直接复用 `dsh --profile <name> --dump-config`（或 `--dump-default-config` 只校验 bundle 层）即可——它复用 dsh 自己的组合算法，永远不会和真实 boot 漂移；代价是每次会重写一次 `cordis.yml`（幂等、可接受）。launcher 不要自己重实现组合逻辑。

### 1.3 profile / bundle 模型（源码确认）

- **profile** = `$DSH_HOME/profiles/<name>` 目录，含 `package.json`（含 `dsh.profile.bundles` 有序列表 + `dependencies`）、`cordis.yml`（规范空根，总是被重写为 `[]`）、`cordis.patch.yml`（用户 patch 层）、`pnpm-workspace.yaml`（`nodeLinker: hoisted`）。
- **bundle** = 在其 `package.json` 里声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 的 npm 包；它的 patch 列表构成一层。
- **bundle 解析顺序（`resolveBundleDir`）**：先**从 dsh 安装本身**解析，再从 **profile 目录**解析。内置 bundle（`@deepseek-ai/dsh-base` / `dsh-web-app` / `dsh-headless`）永远来自安装；out-of-tree 插件来自 profile 的 `node_modules`（并通过 `~/.dsh/profiles/node_modules` 扁平符号链接农场补齐安装依赖闭包）。
- **层组合顺序（`allPatches`，自底向上）**：`bundlePatches`（按 `dsh.profile.bundles` 顺序）→ `profile.cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml`（home 级全局层）→ `--patch` overlays。最后还追加 telemetry 开关 patch 与 `agent-presets` 覆盖层（最顶层）。

### 1.4 本机关键文件确切内容

`~/.dsh/profiles/web/package.json` 的 `dsh` 字段（精确形状）：

```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@loserfox/git-identity",
        "dsh-at-file",
        "dsh-agent-teams",
        "@canglongcl/dsh-web-review",
        "@zseven-w/dsh-openpencil",
        "@dsh-external/plugin-console",
        "@deepseek-ai/dsh-toolkit",
        "dsh-auto-approval",
        "@dsh-external/dsh-sidechain",
        "@dsh-external/dsh-upstream-fixes",
        "dsh-mcp-manager",
        "@omdsh-dev/dsh-annotation",
        "@linxin666/dsh-web-ui-all",
        "@linxin666/dsh-client-ui-skin-blue-fantasy"
      ]
    }
  },
  "dependencies": {
    "@deepseek-ai/dsh-toolkit": "link:/Users/qdd/.dsh/plugins/dsh-toolkit",
    "dsh-agent-teams": "link:/Users/qdd/.dsh/plugins/dsh-agent-teams",
    "dsh-at-file": "link:/Users/qdd/.dsh/plugins/dsh-at-file"
  }
}
```

（`dependencies` 为 registry `^version` 与 `link:/abs/path` 混用。）

`~/.dsh/profiles/web/cordis.yml`（总是被重写为）：`[]`（空根 entry list）。

`~/.dsh/profiles/web/cordis.patch.yml` 是用户 patch 层，形如：

```yaml
- id: webserver
  config: { host: 0.0.0.0, port: 3080 }
- insert:
    - id: better-sidebar
      name: 'dsh-better-sidebar'
- id: permission
  config:
    presets: { read-only: {...}, workspace-write: {...}, auto: {...} }
- id: live-stats
  disabled: true
- id: ui-dsh-aionui-panel
  disabled: true
```

`~/.dsh/cordis.patch.yml`（home 级全局层，作用于每个 profile）：

```yaml
# --- dsh-skin managed (auto-generated; do not edit) ---
- id: ui-skin-qq98
  disabled: true
- id: ui-skin-ths
  disabled: true
# ... 共 8 个 ui-skin-* disabled 条目
```

---

## 二、启动器完整功能规格（bdl）

对齐 HMCL 功能集，分七组，标优先级 P0（MVP）/P1/P2。对应关系：**Minecraft 版本/整合包实例 = dsh profile；mod = bundle（npm 包）；mod 配置 = cordis.patch.yml；包管理器 = pnpm（经 `dsh plugin` 转发）**。

| 分组 | 功能 | 优先级 | 依赖 | 实现要点 |
|---|---|---|---|---|
| 启动 | 无参进 TUI 选整合包启动 | P0 | — | spawn 真实 dsh `--profile X` |
| 启动 | 有参直通真实 dsh | P0 | — | sh `exec` / `.cmd` 转调 |
| 启动 | 记住上次整合包（默认项/一键续用） | P1 | 元数据 | lastUsedAt 排序置顶 |
| 整合包管理 | 发现已有 profile（列表/详情） | P0 | 扫描 profiles/* | 读 `dsh.profile.bundles` |
| 整合包管理 | 新建整合包 | P0 | `dsh plugin` | `dsh plugin --profile X add ...` |
| 整合包管理 | 删除整合包 | P1 | — | `rm -rf` profile + 元数据（二次确认） |
| 整合包管理 | 复制整合包 | P1 | 新建 | 复制 package.json + patch + 重装 |
| 整合包管理 | 重命名整合包 | P2 | — | 改名目录 + 更新元数据（校验 profile 名） |
| 整合包管理 | 导入整合包（bdl-pack.json） | P1 | 导入格式 | 见「整合包导入/导出格式」章 |
| 整合包管理 | 导出整合包（bdl-pack.json） | P1 | 导入格式 | 从 profile 生成 manifest |
| 整合包管理 | 下载整合包（URL/git/index） | P1 | 导入格式 | 下载 manifest → sha256 校验 → 安装（见 8.5）；子项：直链/git 下载、index 浏览/搜索、多源切换、校验与重试 |
| 插件管理 | 查看 bundle 列表（版本/来源） | P0 | — | 读 package.json + node_modules 版本 |
| 插件管理 | 启用/禁用插件 | P0 | 原子写 | cordis.patch.yml `disabled` 条目 |
| 插件管理 | 增删 bundle（装/卸依赖） | P0 | `dsh plugin` | add/remove + reconcile |
| 插件管理 | 更新检查（diff 展示） | P1 | npm view 批量 | `npm view <pkg> version` vs 已装 |
| 插件管理 | 批量更新 | P1 | 更新检查 | pnpm update / link 插件 git pull |
| 环境隔离 | 共享 DSH_HOME + profile 边界（默认） | P0 | — | 仅隔离依赖+patch 层 |
| 环境隔离 | 整树隔离（独立 DSH_HOME） | P1 | 隔离模型 | 注入 `DSH_HOME=~/.config/bdl/envs/<id>` |
| 升级与回滚 | profile 依赖升级 + 快照回滚 | P1 | 备份 | pnpm update + 备份三文件 |
| 升级与回滚 | 整合包定义升级（URL/git） | P2 | 导入格式 | diff + 备份 |
| 升级与回滚 | dsh 本体升级检测 | P2 | — | `npm view @deepseek-ai/dsh version` 提示 |
| 诊断 | 校验整合包（dry-run） | P0 | — | 复用 `dsh --dump-config` |
| 诊断 | 校验失败解析（定位坏 bundle/patch） | P1 | — | 解析 dump 输出/启动报错 |
| 诊断 | 查看日志（logs/*.log） | P2 | — | tail 展示 |
| 设置 | 默认整合包/启动参数 | P1 | 元数据 | extraArgs |
| 设置 | 镜像源（npm registry） | P2 | — | 写 profile `.npmrc` |
| dsh 版本管理 | 安装指定版本 | P1 | 版本管理 | `npm install --prefix BDL_HOME/versions/<v>` |
| dsh 版本管理 | 升级/降级（安装+切换默认） | P1 | 版本管理 | installVersion + setDefault |
| dsh 版本管理 | 多版本共存切换 | P1 | 版本管理 | 默认版本 `dshDefault` |
| dsh 版本管理 | 按整合包锁定版本 | P1 | 版本管理 | 元数据 `dshVersion` + resolveForProfile |

**分阶段**：
- **P0（MVP）**：启动（TUI+直通）、发现/新建整合包、查看 bundle 列表、启用禁用、增删 bundle、校验、共享隔离。
- **P1**：下载/导入/导出、dsh 版本管理、更新检查+批量更新、整树隔离、依赖升级+回滚、复制/删除、诊断解析、默认项。
- **P2**：重命名、定义升级、dsh 本体升级提示、日志查看、镜像源。

**非功能**（延续原清单）：薄（依赖少/零构建/Node ESM）；独立指令 `bdl` 不遮蔽 dsh；内部调用真实 dsh 一律绝对路径；干净移交终端。

---

## 三、整合包数据模型与切换机制

### 3.1 两种模型对比

| | A. 整合包 = 命名 profile | B. 整合包 = 可复用 `--patch` 文件 |
|---|---|---|
| 本质 | 自己的一套 `dsh.profile.bundles` + `cordis.patch.yml` | 叠加到共享 profile 上的一份 patch-list |
| bundle 激活 | 靠 `dsh.profile.bundles` 列出（含**安装** + **激活**） | 靠 `insert`/config 覆盖；**无法新增 bundle**（patch 只能按 id/name 插行或覆盖配置） |
| bundle 自带 patch 层 | 会自动生效（bundle 的 `dsh.bundle.patch`） | **无法复现**——`--patch` 不会触发某 bundle 自己的 patch 层 |
| 依赖 | 每个 profile 各自 `pnpm install`（仅 out-of-tree 插件；内置 bundle 共享安装） | 共享 profile 须预装所有插件的并集 |
| 切换成本 | `dsh --profile X` ↔ `dsh --profile Y`；首次需装各自依赖 | 只换 `--patch` 层，秒切；但「集」受限于已装并集 |

关键事实：**bundle 的默认 patch 层（如 `dsh-web-ui-all` 通过自身 bundle patch 插入的一堆插件）只有在该 bundle 进入 `dsh.profile.bundles` 时才会应用**。`--patch` overlay 与用户 patch 层都只能「按 id 覆盖 / insert 行 / disable」，不能表达「加载某 bundle 的完整 patch 层」。因此模型 B 只能做「同一个基础 profile 之上的**轻量变体**（开关几个插件、改几项配置）」，做不了「换一整套 bundle」。

### 3.2 推荐模型：A 为主 + B 作可选叠加层（混合）

- **主模型 A**：一个整合包 = 一个命名 profile。`dsh.profile.bundles` 是 bundle 集的事实来源（source of truth）。这正是 dsh profile 概念的本意，切换即 `--profile`，隔离性好。
- **叠加 B**：launcher 元数据里允许给每个整合包挂 0..N 个 `--patch` overlay 文件（如主题覆盖、dev 开关），spawn 时作为 `--patch` 传入。这只用于「变体」，不用于「换 bundle」。
- home 级 `~/.dsh/cordis.patch.yml` 是**全局用户层**（对每个 profile 生效），不是 bundle 集机制；launcher 只读它、展示它、在 dump 校验里体现它，不管理它。

### 3.3 launcher 元数据存储与 schema

建议存 `~/.config/bdl/bundles.json`（一个 JSON 文件，键为整合包 id；**与 DSH_HOME 解耦**，见「环境隔离模型」章）：

```json
{
  "version": 1,
  "bundles": {
    "coding": {
      "id": "coding",
      "name": "Coding 工作台",
      "description": "日常编码插件集",
      "profile": "coding",
      "source": { "type": "url", "url": "https://example.com/packs/coding/bdl-pack.json" },
      "patchOverlays": [
        "/Users/qdd/.config/bdl/overlays/coding-theme.yml"
      ],
      "extraArgs": [],
      "lastUsedAt": "2025-08-14T15:00:00Z",
      "useCount": 12
    }
  }
}
```

- `profile` 是**与真实 profile 的连接键**；bundle 列表不重复存（实时读 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles`），或仅存一份缓存快照用于离线展示。
- 也可把 `bundles.json` 拆成 `~/.config/bdl/*.json`（每整合包一个文件）；单文件更简单，够用。

### 3.4 TUI 多级菜单树

```
bdl
├─ 启动                     → [选择整合包] → spawn dsh --profile X
│    └─ (记住上次 / 默认项)
├─ 整合包管理
│    ├─ 列表/详情             (扫描 profiles + 元数据)
│    ├─ 新建                  (id → dsh plugin add ...)
│    ├─ 复制 / 删除 / 重命名
│    ├─ 下载整合包 (URL/git/index)
│    ├─ 导入 bdl-pack.json
│    └─ 导出 bdl-pack.json
├─ 插件管理 (对选定整合包)
│    ├─ bundle 列表 (版本/来源/状态)
│    ├─ 启用/禁用             (改 cordis.patch.yml disabled)
│    ├─ 添加/移除 bundle       (dsh plugin add/remove)
│    └─ 更新检查 / 批量更新
├─ 环境隔离
│    ├─ 共享模式 (默认)
│    └─ 整树隔离 (独立 DSH_HOME)
├─ 升级与回滚
│    ├─ 依赖升级 (快照→更新→回滚)
│    ├─ 定义升级 (URL/git)
│    └─ dsh 本体升级检测
├─ dsh 版本管理
│    ├─ 已装版本 / 安装 / 切换默认 / 删除
│    └─ 锁定整合包版本
├─ 诊断
│    ├─ 校验 (--dump-config)
│    └─ 校验失败解析 / 查看日志
└─ 设置
     ├─ 默认整合包 / 启动参数
     └─ 镜像源
```

---

## 四、HMCL 功能映射总表

HMCL（Hello Minecraft! Launcher，Java 跨平台 Minecraft 启动器）功能集（来源：HMCL 官方站 hmcl.huangyuhui.net、GitHub README/wiki、社区资料）与 dsh 语境映射。**对应关系**：Minecraft 版本/整合包实例 = dsh profile；mod = bundle（npm 包）；mod 配置 = cordis.patch.yml patch 层；包管理器 = pnpm（`dsh plugin` 转发）。标注：✅ 直接可行 / 🔧 需扩展设计（给方案）/ ❌ 不适用（给理由）。

| HMCL 功能 | HMCL 具体形态 | dsh 对应机制 | 可行性 | bdl 落点 |
|---|---|---|---|---|
| 启动游戏 | 选版本→下载/启动 | `dsh --profile X` boot | ✅ | 启动整合包（P0） |
| 安装新版本 | 原版/Forge/Fabric/Quilt/OptiFine 自动装 | `dsh plugin --profile X add <pkg>` 新建 profile | ✅ | 新建整合包（P0） |
| 删除版本 | 删版本目录 | `rm -rf ~/.dsh/profiles/X` | ✅ | 删除整合包（P1） |
| 版本列表/详情 | 版本 + 图标 + 版本号 | 扫描 profiles/*/package.json | ✅ | 发现/详情（P0） |
| 版本设置 | Java 路径/JVM 参数/内存（版本级） | profile cordis.patch.yml 覆盖（webserver/llm 等） | 🔧 | 编辑 patch（P1） |
| **版本隔离** | 全局共享 vs 每版本独立 .minecraft | 共享 DSH_HOME vs 独立 DSH_HOME | 🔧 | 环境隔离模型章（P0/P1） |
| 整合包搜索/下载 | Modrinth/CurseForge/mcmod 搜索下载 | dsh 无整合包市场；bdl 用 URL/git/index 下载 bdl-pack.json | 🔧 | 整合包下载功能（P1）+ 市场/社区源（P2） |
| 整合包导入 | .mrpack / CurseForge zip / HMCL 格式 | bdl-pack.json manifest 导入 | 🔧 | 导入/导出格式章（P1） |
| 整合包导出 | 导出 CurseForge/MR/服务端/HMCL | 从 profile 生成 bdl-pack.json | 🔧 | 导入/导出格式章（P1） |
| 整合包更新检查 | Modrinth/CurseForge 查新版提示 | bundles.json 定义升级（URL/git）+ npm view | 🔧 | 升级与回滚章（P2） |
| mod 列表 | 查看已装 mod | bundle 列表 + node_modules 版本 | ✅ | 插件管理（P0） |
| mod 启用/禁用 | 勾选启用 | cordis.patch.yml `disabled: true` | ✅ | 启用禁用（P0） |
| mod 删除 | 删 mod 文件 | `dsh plugin --profile X remove` | ✅ | 增删 bundle（P0） |
| mod 下载 | Modrinth/CurseForge/MCBBS/mcmod 搜索 | `dsh plugin add <pkg>`（npm）/ plugin_search | ✅/🔧 | 增删 bundle（P0；市场 P2） |
| mod 更新 | 检查更新/批量更新 | pnpm outdated/update + link 插件 git pull | 🔧 | 更新检查（P1） |
| mod 依赖检查 | 自动解析依赖 | pnpm 自动解析 + reconcile | ✅ | 复用 pnpm（自动） |
| 资源包/材质 | 下载安装资源包 | dsh 皮肤 = bundle（ui-skin-*） | 🔧 | 皮肤即插件（P2） |
| 光影 shader | 下载光影 | ❌ 无对应（非游戏渲染） | ❌ | 不适用 |
| 世界/存档 | 下载导入存档 | ❌ 无对应（sessions 为会话历史） | ❌ | 不适用 |
| 账户 | 离线/Microsoft/authlib-injector 多账户 | dsh .credentials.yaml + llm 配置 | ✅/🔧 | 账户切换（P2，薄） |
| 下载源/镜像 | 官方/BMCLAPI/MCBBS/自定义 | pnpm/npm registry 镜像（.npmrc） | 🔧 | 镜像源（P2） |
| 日志查看 | 游戏日志实时输出 | ~/.dsh/logs/*.log tail | 🔧 | 诊断（P2） |
| 崩溃诊断 | 崩溃报告解析/上传 | `dsh --dump-config` 失败解析 + 启动报错 | 🔧 | 诊断解析（P1） |
| 设置 | 下载线程/代理/主题/语言 | bdl 自有设置 + dsh settings.yaml | 🔧 | 设置（P1/P2） |
| 启动器自身更新 | HMCL 检查自身更新 | bdl 自更新 + dsh 本体升级提示 | 🔧 | dsh 本体升级（P2） |

---

## 五、环境隔离模型

### 5.1 dsh 里全局共享 vs per-profile 的实测划分

| 数据 | 位置 | 隔离性 | 说明（实测） |
|---|---|---|---|
| settings.yaml | `$DSH_HOME/settings.yaml` | **全局共享** | 顶层键：ui-onboarding/permission/ui-theme/ui-conversation/agent-presets/llm-pi-ai/agent-default-model/auto-approval/pet/dsh-better-sidebar |
| sessions/ | `$DSH_HOME/sessions/` | **全局共享** | 会话文件按 workspace 路径命名（如 `--Users-...-betterdshlauncher--`） |
| storages/ | `$DSH_HOME/storages/` | **全局共享** | session_projcache.json、workspace.json |
| logs/ | `$DSH_HOME/logs/` | **全局共享** | auto-approval.log 等 |
| plugins/ | `$DSH_HOME/plugins/` | **全局共享** | 13 个 link 插件源码 checkout（全是 git 仓库） |
| cache/、.credentials.yaml、pet.json、.anonymous-user-id | `$DSH_HOME/` | **全局共享** | 凭据/匿名 id/缓存 |
| home 级 cordis.patch.yml | `$DSH_HOME/cordis.patch.yml` | **全局共享**（作用于每个 profile） | dsh-skin 管理的 disabled 皮肤 |
| profiles/<name>/ | `$DSH_HOME/profiles/<name>/` | **per-profile 隔离** | package.json + cordis.yml + cordis.patch.yml + pnpm-lock.yaml + node_modules + pnpm-workspace.yaml |

结论：dsh 内置隔离只覆盖「插件依赖集 + 用户 patch 层」，其余（设置/会话/存储/日志/凭据）**全部全局共享**。

### 5.2 三种隔离层次

| 层次 | 隔离内容 | 实现 | 成本 |
|---|---|---|---|
| L1 只隔离配置层 | 仅 profile 的 cordis.patch.yml | dsh 内置 | 零成本（现状） |
| L2 只隔离插件依赖 | + profile 的 node_modules/bundles | dsh 内置（pnpm per-profile） | 每 profile 装依赖（内置 bundle 共享安装） |
| L3 全隔离（整树隔离） | + settings/sessions/storages/logs/credentials | 注入独立 DSH_HOME | 需 seed + 重装依赖 + 凭据/设置处理 |

### 5.3 整树隔离（L3）可行性：注入独立 DSH_HOME

- **机制**：`resolveDshHome()` 读 `DSH_HOME` 环境变量（源码确认），故 bdl spawn 真实 dsh 时注入 `DSH_HOME=~/.config/bdl/envs/<id>` 即可整树隔离，**无需改 dsh**。
- **seed 清单**：
  - `profiles/<name>/`：必须存在。dsh `loadProfile` 对 web/headless 有模板自动 init，其它名字缺 package.json 会报错 `create it with dsh plugin`。故 bdl 需把目标 profile（package.json + cordis.patch.yml + pnpm-workspace.yaml）复制进 env home，再 `dsh plugin --profile X install`（或 pnpm install）装依赖。
  - `profiles/node_modules` 符号链接农场：boot 时 `healProfilesModuleFallback` 自动重建（幂等），**无需手动 seed**。
  - settings.yaml：dsh 首次启动会生成默认值（推断，待验证）；**建议「继承」**——复制默认 home 的 settings.yaml 作基线，或留空用默认。
  - .credentials.yaml：**不复制会要求重新登录**；复制 = 继承凭据（无凭据隔离）。二选一，按隔离强度取舍。
  - sessions/storages/logs/cache：留空 = 真隔离（各 env 独立会话/日志）。
- **成本**：每 env 首次要跑一次依赖安装（磁盘 + 时间）；link 插件仍指向 `~/.dsh/plugins`（绝对路径，共享源码），registry 插件按 env 各自安装。
- **折中（推荐默认）**：L2——共享 DSH_HOME，bdl 只管理 profile 边界；per-profile 会话隔离留给用户手动设 `DSH_HOME`。

### 5.4 launcher 元数据位置结论

**问题**：若用 L3 独立 DSH_HOME，`$DSH_HOME/launcher` 会随 env 隔离，bdl 的 bundles.json/备份/overlays 被拆散到每个 env。

**结论**：bdl 元数据**固定在 `~/.config/bdl/`（macOS/Linux）/ `%APPDATA%\bdl`（Windows），可用 `BDL_HOME` 覆盖，与 DSH_HOME 完全解耦**。目录：`~/.config/bdl/{bundles.json, backups/, overlays/, envs/, logs/}`。这样无论共享还是整树隔离，bdl 元数据始终唯一。旧的 `~/.dsh/launcher` 不再推荐（避免随 DSH_HOME 漂移/隔离）。

---

## 六、整合包升级与备份回滚

### 6.1 修改插件列表的两种语义（精确区分）

| 语义 | 操作对象 | 实现 | 是否触发 pnpm |
|---|---|---|---|
| 启用/禁用插件 | cordis.patch.yml 的 `disabled` 条目 | 增删 `- id: X / disabled: true`（参考 home 级 dsh-skin 做法） | **否**（纯配置层，热生效） |
| 增删 bundle | profile package.json 的 `dsh.profile.bundles` + `dependencies` | `dsh plugin --profile X add/remove <pkg>`（pnpm add/remove + reconcilePlugins 自动同步 bundles） | **是**（装/卸依赖） |

关键源码结论：**bundle 解析发生在 boot 时**（`loadProfile → resolveBundleDir → packageDirFromAnchor`），不是 install 时。因此：
- 若手动把某包加进 `dsh.profile.bundles` 却没装依赖 → boot 报 `cannot resolve profile bundle`。
- 正确做法：**先 `dsh plugin add`（装依赖 + reconcile 自动追加 bundle）**；删除同理 `dsh plugin remove`。
- `healProfilesModuleFallback` 在 boot 时把「dsh 安装的依赖闭包」符号链接到 `~/.dsh/profiles/node_modules`，故**内置 bundle 无需 per-profile 安装**即可解析。

### 6.2 原子写策略（编辑 package.json / cordis.patch.yml）

复用 `@deepseek-ai/dsh-atomic-write` 的模式（源码确认）：`writeFileAtomic`（写随机后缀兄弟文件 + `wx` 独占创建 + `rename` 原子替换）+ `withFileLock`（`<file>.lock` + 指数退避，串行化并发写）。bdl 编辑流程：**读 → 内存改 → 备份到 `~/.config/bdl/backups/<id>/<ts>/` → writeFileAtomic 写回**。YAML 用 js-yaml 解析/序列化（对禁用列表等结构化改动可接受；复杂 patch 建议只做增删条目级操作）。

### 6.3 更新插件列表（实测/源码确认）

- `dsh plugin --profile X outdated/update` = **转发给 profile 目录下的 pnpm**（runPlugin `spawnSync("pnpm", args, {cwd: profileDir})`，源码确认），语义即 pnpm 语义。**注意**：pnpm `outdated` 有更新时退出码为 1，runPlugin 会多打一行「pnpm failed」——bdl 应**直接在 profile 目录跑 `pnpm outdated`**，或用 `dsh plugin` 但忽略尾随错误行。
- **内置 bundle**（`@deepseek-ai/dsh-base/dsh-web-app/dsh-headless` 及全部 `@deepseek-ai/*` 依赖）版本锁定 `^0.1.0-rc.6` = dsh 本体版本，**更新 = 更新 dsh 本体**。本机 `npm view @deepseek-ai/dsh version`（temp cache 实测）= `0.1.0-rc.6`，与已装一致，当前无更新。
- **registry 插件（^version）**：更新 = `pnpm update <pkg>`（profile 目录，遵守 ^ 范围）；检查 = `pnpm outdated`。
- **link 插件**（`link:/Users/qdd/.dsh/plugins/<name>`，实测 13 个全是 git 仓库）：更新 = 进目录 `git pull`；pnpm link 自动指向新源码。检查 = `git -C <dir> fetch` + `git status` 看落后。
- **更新检查 UI**：`npm view <pkg> version`（批量，temp cache，只读）比对已装（读 `profiles/<name>/node_modules/<pkg>/package.json`）→ diff（当前 → wanted → latest）→ 勾选 → 分别执行 pnpm update / git pull。

### 6.4 整合包升级三层设计

| 层 | 对象 | 升级动作 | 备份/回滚 |
|---|---|---|---|
| (i) 定义升级 | bundles.json（整合包元数据/依赖约束） | 从 git 仓库/URL 拉新版 bdl-pack.json，diff 展示 | 升级前备份旧 bundles.json |
| (ii) profile 依赖升级 | package.json + pnpm-lock.yaml + cordis.patch.yml | `pnpm update`（profile 目录） | 快照三文件到 `~/.config/bdl/backups/<id>/<ts>/`，回滚 = 恢复三文件 + `pnpm install` |
| (iii) dsh 本体升级 | @deepseek-ai/dsh 本体 | **完整版本管理**（安装/升降级/多版本共存/按整合包锁定） | 见「dsh 版本管理」章（第七章） |

**交互（参考 HMCL「整合包更新提示 + 备份旧版本」）**：启动前检查（可选）→ 发现更新 → 展示 changelog/diff → 用户确认 → 自动备份 → 执行升级 → 成功写元数据 / 失败提示回滚。

---

## 七、dsh 版本管理（对标 nvm / HMCL 多版本）

### 7.1 npm registry 实测数据

- 公开发布 ✓；`latest` = `0.1.0-rc.6`，`next` = `0.1.0-rc.6`。
- 历史版本（6 个，升降级可行）：`0.0.1-rc.1 / 0.0.1-rc.2 / 0.0.1-rc.5 / 0.1.0-rc.2 / 0.1.0-rc.3 / 0.1.0-rc.6`。
- `time`：created 2026-08-10，latest 2026-08-13（迭代极快，约每日一个 rc）。
- `dist.unpackedSize` = 116711 字节（~114KB，仅 CLI 本体 + config）；`dependencies` = 59 个（几乎全是 `@deepseek-ai/*` `^0.1.0-rc.6`）。
- **安装实测**：`npm install --prefix <tmp> @deepseek-ai/dsh@0.1.0-rc.6 --no-save` → 529 packages、约 334MB、~2min；`node <bin.js> --version` 输出 `0.1.0-rc.6`。

### 7.2 版本目录布局与解析优先级

- 多版本目录：`BDL_HOME/versions/<version>/node_modules/@deepseek-ai/dsh/lib/bin.js`（每版独立安装）。
- 默认版本：`bundles.json` 顶层 `dshDefault`（`'system'` 或具体版本号；缺省 `'system'`）。
- 解析优先级（`resolveRealDsh`）：`BDL_REAL_DSH` env（最高）→ 整合包锁定 `dshVersion` → 默认 `dshDefault` → 系统安装（which/默认路径）。

### 7.3 安装/切换/删除/锁定流程

- 安装：`npm install --prefix BDL_HOME/versions/<v> --no-save @deepseek-ai/dsh@<v>`（temp cache 规避权限；失败友好报错）。
- 切换默认（升级/降级）：安装 + `setDefault`（写 `dshDefault`）。
- 删除：`removeVersion`（默认版本拒绝删除，先切换）。
- 锁定：某整合包元数据 `dshVersion`（`resolveForProfile` 读取；未锁走默认）。
- 远程列表：`npm view versions/dist-tags --json`，缓存 1 小时（`BDL_HOME/cache/versions.json`），离线降级用缓存/空。

### 7.4 按整合包锁定与校验联动

- `handoffToDsh` 先 `resolveForProfile(profile)` 得到该整合包要用的 dsh（锁定/默认），`spawnDsh(argv, { dsh })` 启动；启动前打印将用的 dsh 路径。
- 锁定版本切换后，用「校验整合包」（`--dump-config`）验证该 profile 在目标版本下可组合。

### 7.5 降级风险提示

- 每版完整安装 ~334MB / 529 包；多版本共存磁盘成本显著。
- 新 dsh 建的 profile 可能不被旧版兼容（bundles 版本锁定 `^0.1.0-rc.6` = 同 minor；跨 minor 降级风险更高）——降级后用 `--dump-config` 验证。
- 版本目录自管理后，系统安装方式（brew/npm -g）不再影响 BDL 切换；`BDL_REAL_DSH` 仍最高优先（逃生口）。

---

## 八、整合包导入/导出格式（bdl-pack.json，对标 .mrpack / packwiz）

### 8.1 manifest 结构

```json
{
  "$schema": "https://example.com/bdl-pack.schema.json",
  "manifestVersion": 1,
  "id": "my-coding-stack",
  "name": "我的编码工作台",
  "version": "1.2.0",
  "description": "编码常用插件集",
  "author": "qdd",
  "dsh": { "minVersion": "0.1.0-rc.6", "profileTemplate": "web" },
  "bundles": [
    { "name": "@deepseek-ai/dsh-base", "version": "^0.1.0-rc.6" },
    { "name": "dsh-at-file", "source": "link", "path": "~/.dsh/plugins/dsh-at-file" },
    { "name": "@linxin666/dsh-web-ui-all", "version": "latest" }
  ],
  "patch": "- id: webserver\n  config: { host: 0.0.0.0, port: 3080 }\n",
  "overlays": [
    { "path": "overlays/theme.yml", "content": "- id: ui-theme\n  config: {}\n" }
  ]
}
```

- `bundles[]`：有序 bundle 列表；`version` 为约束（^x.y.z / latest），`source: "link"` 表示本地源码（导出时警告：link 不可移植，导入方需自备同名依赖）。
- `patch`：profile cordis.patch.yml 的内联 YAML 文本（导出自 `~/.dsh/profiles/<name>/cordis.patch.yml`）。
- `overlays[]`：`--patch` overlay 文件（内联 content 或相对路径引用）。
- `dsh.minVersion`/`profileTemplate`：目标 dsh 最低版本 / 新 profile 用哪个内置模板（web/headless）。

### 8.2 导出流程（从现有 profile 生成）

1. 读 `~/.dsh/profiles/<name>/package.json` 的 `dsh.profile.bundles` + `dependencies`（版本约束）。
2. 读 `cordis.patch.yml` 内联为 `patch`；读 bdl 元数据登记的 overlays 内联为 `overlays[]`。
3. 组装 manifest + 元数据（id/name/version/description）→ 写 `bdl-pack.json`（可打包 zip，含 overlays 目录）。

### 8.3 导入流程（校验 → 建 profile → 应用 patch → 写元数据）

1. **校验**：JSON Schema 校验 manifest；检查 `bundles[].name`、版本约束合法；`dsh.minVersion` 与当前 dsh 版本比对。
2. **建 profile**：`dsh plugin --profile <id> add <bundle...>`（按序安装，reconcile 自动组 bundles）。
3. **应用 patch**：把 `patch` 写入新 profile 的 `cordis.patch.yml`（writeFileAtomic）；`overlays[]` 解包到 `~/.config/bdl/overlays/<id>/`。
4. **写元数据**：bundles.json 登记（id/name/description/overlays 路径/lastUsedAt）。
5. **校验**：`dsh --profile <id> --dump-config` 确认组合成功，失败则回滚（删 profile + 删元数据）。

### 8.4 JSON Schema 草案

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["manifestVersion", "id", "name", "version", "bundles"],
  "properties": {
    "manifestVersion": { "const": 1 },
    "id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]*$" },
    "name": { "type": "string" },
    "version": { "type": "string" },
    "description": { "type": "string" },
    "author": { "type": "string" },
    "dsh": {
      "type": "object",
      "properties": {
        "minVersion": { "type": "string" },
        "profileTemplate": { "enum": ["web", "headless"] }
      }
    },
    "bundles": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name"],
        "properties": {
          "name": { "type": "string" },
          "version": { "type": "string" },
          "source": { "enum": ["registry", "link", "git"] },
          "path": { "type": "string" },
          "url": { "type": "string" }
        }
      }
    },
    "patch": { "type": "string" },
    "overlays": {
      "type": "array",
      "items": { "type": "object", "properties": { "path": { "type": "string" }, "content": { "type": "string" } } }
    }
  }
}
```

---

### 8.5 整合包下载与 bdl-pack index

参考 HMCL 下载整合包形态（Modrinth/CurseForge API 搜索、.mrpack 直链下载、多下载源切换、下载进度/重试、安装前展示内容清单）。

**前置事实（实测）**：本机 `~/.dsh/plugin-sources/` **不存在**（dsh harness 的 `plugin_search`/`plugin_install` 属 Web 层工具，其 `$DSH_HOME/plugin-sources/` 懒初始化、本机未触发）；dsh CLI 包内 **无** hub catalog / plugin-sources 实现代码（grep 仅命中 runPlugin 的 allowBuilds 报错文案）。`{"repos": [...]}` 目录格式是 harness `plugin_search` 工具的约定，不在 dsh CLI 里。**结论：bdl-pack index 自定义简单 JSON 格式（`{"packs": [...]}`），风格对齐 dsh 生态（多源 + 懒探测 + 缓存），但不强行复用 `repos`。**

#### 8.5.1 下载源类型

| 源类型 | 形态 | 拉取方式 | 用途 |
|---|---|---|---|
| 直链 URL | `https://.../bdl-pack.json` | HTTPS GET | 单包直下 |
| git 仓库 | `https://github.com/.../pack.git` | `git clone` / raw URL（支持 `ref`/`tag`/`branch`） | 版本化分发 |
| bdl-pack index | JSON 目录文件（`packs[]`） | HTTPS GET（缓存 + 刷新） | 浏览/搜索多包 |

**多源**：内置默认源（bdl 官方 index，可选）+ 用户自添加源（bundles.json 的 `sources[]`）+ 本地文件源（`file:///path`，离线/内网）。

#### 8.5.2 index JSON 草案

```json
{
  "format": "bdl-pack-index",
  "version": 1,
  "updatedAt": "2025-08-14T00:00:00Z",
  "packs": [
    {
      "id": "my-coding-stack",
      "name": "我的编码工作台",
      "description": "编码常用插件集",
      "version": "1.2.0",
      "url": "https://example.com/packs/my-coding-stack/bdl-pack.json",
      "sha256": "abc123...",
      "dsh": { "minVersion": "0.1.0-rc.6" }
    }
  ]
}
```

#### 8.5.3 下载安装交互流程

```
bdl download
1. 选源            (内置 index / 自定义源 / 本地文件 / 直接 URL / git 仓库)
2. 浏览/搜索列表    (index → 列表 + 模糊过滤；缓存 + 手动刷新)
3. 选包 → 下载 manifest (HTTPS GET / git fetch；带进度 + 重试)
4. sha256 校验     (index/URL 声明的 sha256，不匹配即中止)
5. 解析展示详情    (名称/描述/bundles 列表/版本约束/patch 内容)
6. 确认 → 安装     (复用 8.3 导入流程：建 profile → dsh plugin add → 应用 patch → 写 bundles.json 元数据 + source 字段)
7. 完成 / 失败重试 (幂等：同名 profile 已存在 → 提示覆盖/改名)
```

#### 8.5.4 依赖与安全

- **依赖安装**：bundles 一律经 pnpm/npm registry 安装（镜像源切换写 profile `.npmrc`，见 P2 镜像源）。
- **manifest 校验**：复用 7.4 JSON Schema（`strict`），**拒绝未知字段**；`path`/`overlays[].path` 必须做**路径遍历防护**（`path.resolve` 后限定在 bdl 目录内，禁止 `../` 逃逸）。
- **git-hosted bundle**：prepare 脚本受 pnpm `allowBuilds` 门控；下载安装遇构建拦截时，给出与 `dsh plugin` 一致的提示（引用 runPlugin 逻辑：`git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed — add the exact key pnpm printed above under allowBuilds in pnpm-workspace.yaml, then re-run`）。

#### 8.5.5 与升级联动

安装时把下载源写入 bundles.json 元数据（`source` 字段：`{ "type": "url"|"git"|"index", "url", "ref"? }`）；第六章第 (i) 层「定义升级」即可对该源做「检查新版本」：重拉 manifest/index → 比对 `version` → 提示升级（复用 6.4 交互 + 备份）。

---

## 九、bdl 命令注册方案（独立指令，不接管 dsh）

### 9.1 本机事实（实测）

```
which -a dsh            → /opt/homebrew/bin/dsh
ls -l /opt/homebrew/bin/dsh → ../lib/node_modules/@deepseek-ai/dsh/lib/bin.js (符号链接)
which -a node           → /opt/homebrew/bin/node  → ../Cellar/node/26.3.0/bin/node  (brew 安装, v26.3.0)
npm prefix -g           → /opt/homebrew/Cellar/node/26.3.0        ← 注意：不是 /opt/homebrew
npm root -g             → /opt/homebrew/Cellar/node/26.3.0/lib/node_modules
PATH 顺序(前段)          → ~/.grok/bin, ~/.codeium/..., ~/Library/pnpm/bin, ~/.local/bin, /opt/homebrew/bin, ... /usr/local/bin ...
~/.local/bin            → 属主 qdd(rwx)，已含 dsh-skin / codex / grok / pytest 等符号链接
which -a bdl            → （未安装；bdl 为全新独立指令名，注册后无任何同名冲突）
```

### 9.2 关键结论

- 入口改为独立指令 `bdl` 后，**不再需要遮蔽真实 dsh**：`bdl` 是唯一名字，只要所在目录在 PATH 中任意位置即可命中，PATH 顺序不再关键。
- 本机事实仍相关：brew 版 node 的 npm 全局 prefix 是版本固定的 Cellar 目录（`/opt/homebrew/Cellar/node/26.3.0`，**不在 PATH**），所以 `npm i -g` 一个 bin 名为 `bdl` 的包在本机**不会生效**（且 `brew upgrade node` 后失效）；**pnpm 全局 prefix（`~/Library/pnpm/bin`）在 PATH 中**，走 npm 包分发时用 `pnpm i -g` 可行。
- 结论：本机以 `~/.local/bin/bdl` shim 为首选；若以后把 launcher 发布为 npm 包（bin 名 `bdl`），Linux 上 `npm i -g` 视 prefix 可用，macOS 本机用 `pnpm i -g`。

### 9.3 方案对比

| 方案 | bdl 是否生效 | brew upgrade 影响 | 脚本/子进程可用 | 结论 |
|---|---|---|---|---|
| (a) npm 全局包 bin=bdl | ❌ 本机装进 Cellar，不在 PATH | 会失效 | 视 PATH | 本机弃用（Linux 视 prefix 可用） |
| (a′) pnpm 全局 bin=bdl | ✅ `~/Library/pnpm/bin` 在 PATH | 无影响 | ✅ | 走 npm 包分发时本机可用 |
| (b) `~/.local/bin/bdl` shim | ✅ 已在 PATH | 无影响 | ✅ 是真实可执行文件 | **推荐** |
| (c) zsh function / alias | ⚠️ 仅交互 shell | 无影响 | ❌ 非交互脚本不加载、alias 不展开、zsh 无 `export -f` | 仅作个人快捷键补充 |
| (d) `/usr/local/bin/bdl` 符号链接 | ✅ 无需遮蔽，PATH 任意位置即可命中 | 无影响 | ✅ | 可用但非必需 |

**推荐方案 (b)**：在 `~/.local/bin/bdl` 放 shim 脚本。理由：
1. `bdl` 是独立名字，只需能被找到，PATH 顺序不再关键（不必排在 `/opt/homebrew/bin` 之前）。
2. `~/.local/bin` 是用户既有约定（dsh-skin、codex、grok 等符号链接已在此目录）。
3. `brew upgrade` 从不碰它；无 npm prefix 冲突。
4. 是真实可执行文件，脚本/子进程/GUI 子进程都能正确命中（不同于 function/alias）。

shim 示例（第十一节给完整版）。**调用铁律**：shim 内部调用真实 dsh 必须用**绝对路径** `/opt/homebrew/bin/dsh`（或 `node /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`）——虽然 `bdl` 与 `dsh` 名字不同已无递归风险，绝对路径仍能保证不受 PATH 里其它同名文件干扰。

### 9.4 三系统命令注册对比（bdl 独立指令，无遮蔽问题）

| 平台 | 真实 dsh 安装位置（仅供 bdl 内部绝对路径调用） | npm 全局 bin | 推荐 bdl 注册点 | 要点 |
|---|---|---|---|---|
| **macOS** | Homebrew 符号链接 `/opt/homebrew/bin/dsh`（Intel 为 `/usr/local/bin/dsh`） | 本机实测 = `/opt/homebrew/Cellar/node/26.3.0`（版本固定 Cellar，**不在 PATH**）；pnpm -g = `~/Library/pnpm/bin`（在 PATH） | `~/.local/bin/bdl` shim（已在 PATH）；或 `pnpm i -g` 走 npm 包分发 | `bdl` 名字独立，与真实 dsh 无任何冲突；PATH 顺序不再关键 |
| **Linux** | 通常 `/usr/local/bin/dsh` 或 `~/.npm-global/bin/dsh`；发行版可能有同名 `dsh` 包（Debian/Ubuntu「Dancer's shell」）——**与本 launcher 无关**（bdl 是独立名字） | `/usr/local/bin`（系统 npm）或 `~/.npm-global/bin`（自定义 prefix）；nvm 下在 `~/.nvm/...` | `~/.local/bin/bdl` shim（多数发行版已在 PATH）；`npm i -g` 视 prefix 亦可用 | 不再需要检查发行版 dsh 包的位置 |
| **Windows** | `npm i -g` 装到 `%APPDATA%\npm`，真实 dsh 为 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js` | `%APPDATA%\npm` | `%USERPROFILE%\bin\bdl.cmd`（+ `bdl.ps1`），加入 PATH；或直接放 `%APPDATA%\npm`（名字独立，无需排在真实 dsh 之前） | `bdl.cmd` 内部用 `node` + 真实 dsh 绝对路径接力；`.PS1` 默认不在 PATHEXT，以 `.cmd` 为主 |

**三系统各自的推荐注册方式**：
- **macOS**：`~/.local/bin/bdl`（POSIX sh shim，见第十一节）；npm 包分发时用 `pnpm i -g`。
- **Linux**：`~/.local/bin/bdl`（同款 POSIX sh shim）；`npm i -g` 视 prefix 亦可用。
- **Windows**：`bdl.cmd`（cmd 批处理 shim）+ `bdl.ps1`（PowerShell 版）放入用户 bin 目录（如 `%USERPROFILE%\bin` 并加入 PATH，或直接 `%APPDATA%\npm`）。PowerShell 交互用户可选在 `$PROFILE` 里定义 `function bdl { ... }`，但 function 仅交互 session 生效，仍以 `.cmd` 文件为主。WSL / Git Bash 下按 Linux 规则处理（各自有一套 `~/.local/bin`）。

---

## 十、TUI 技术选型

标准：依赖少/零构建、方向键选择 + 搜索过滤、能干净退出并移交子进程、彩色输出。

| 库 | 依赖 | 方向键 | 搜索过滤 | 构建 | 评价 |
|---|---|---|---|---|---|
| **enquirer** | 1 个纯 JS 依赖 | ✅ `Select`/`AutoComplete` | ✅ `AutoComplete` 内建输入过滤 | 零构建 | **推荐**：一个 prompt 同时给方向键+过滤+彩色 |
| @clack/prompts | 少量依赖 | ✅ `select` | ⚠️ select 无过滤，需另拼 `text` | 零构建 | 次选，更现代美观，过滤要自己写 |
| node:readline | 0 依赖 | 需手写 raw mode/ANSI | 需手写 | 零构建 | 零依赖兜底，样板代码多 |
| ink (React) | React 全家桶 | ✅ | ✅ | 需 JSX 转换 | 过重，弃用 |
| blessed | 较大/陈旧 | ✅ | 部分 | 零构建但 API 老 | 过重，弃用 |

**推荐 enquirer**，伪代码：

```js
// tui.mjs
import Enquirer from 'enquirer';
import { readBundles } from './registry.mjs';

const items = readBundles(); // [{name:'Coding 工作台', value:'coding'}, ...]
const { value } = await new Enquirer().prompt({
  type: 'autocomplete',
  name: 'value',
  message: '选择整合包（输入过滤 / 方向键 / 回车）',
  choices: items,
});
// 返回后 enquirer 已恢复终端 → 交给 spawn（第十一节）
handoffToDsh(value);
```

干净退出要点：选择完成后 enquirer 会自行恢复终端（raw mode 关闭），再 spawn 子进程即可安全共享 TTY。

### 10.1 三系统兼容性

| 库 | Windows Terminal | 旧版 conhost / cmd.exe | Linux/macOS 终端 | 说明 |
|---|---|---|---|---|
| **enquirer** | ✅（VT 序列原生支持） | ⚠️ 需 VT 启用（Win10 1511+ 可手动开；老版本降级无色/乱码） | ✅ | 纯 JS + ANSI，无 POSIX 依赖 |
| @clack/prompts | ✅ | ⚠️ 同上 | ✅ | 同 enquirer，依赖 ANSI/VT |
| node:readline | ✅ | ✅（原生 line 模式稳；raw 方向键需自解析且 conhost 键码不同） | ✅ | 零依赖，兜底用 |
| ink (React) | ✅ | ⚠️ 依赖 VT | ✅ | React 渲染 ANSI |
| blessed | ⚠️ 部分光标/鼠标 POSIX-only | ❌ 多已知问题 | ✅ | 弃用（POSIX 依赖） |

**结论与降级策略**：
1. 首选 **enquirer**（纯 JS，不依赖 POSIX）；它只输出 ANSI/VT，Windows Terminal 与启用 VT 的新 conhost 表现一致，Linux/macOS 终端天然支持。
2. **避免 blessed 等 POSIX-only 光标/鼠标库**。
3. **降级链**：检测 `process.stdin.isTTY` 与 `process.stdout.isTTY`，再探测 `TERM`/`WT_SESSION`（Windows Terminal 会设置 `WT_SESSION`）与 `NO_COLOR`；无 TTY 或 VT 不可用 → 回退到最朴素的 `readline` 单行输入（「输入整合包 id / 回车=默认」），保证在 cmd.exe 老 conhost、`| tee`、CI 里不卡死、不花屏。

---

## 十一、与真实 dsh 的握手协议

### 11.1 事实前提（源码确认）

- `bin.js` 只做 commander 解析 → 按 mode 动态 `import()` 本地 lib 文件：profile 模式 boot 在**进程内**、plugin 模式 `spawnSync("pnpm", ...)`、dump 模式打印后自然退出。
- **真实 dsh 从不从 PATH 重新调用 `dsh`**（全仓仅 `plugin` 模式 spawn `pnpm`）。本 launcher 用独立指令名 `bdl`，不存在「shim 命中自己」的递归面；内部调用真实 dsh 一律绝对路径，PATH 状态不影响行为。
- `runProfile` 自带信号处理：`SIGINT → interrupt(130)`、`SIGTERM → interrupt(0)`；**没有 SIGHUP handler**（SIGHUP 走默认终止）。web profile boot 后由插件接管进程寿命、不自行退出。

### 11.2 spawn 握手 vs exec 替换

| | spawn + 信号转发 + 透传退出码 | exec 替换 |
|---|---|---|
| PID 复用 | ❌ 父子两个进程 | ✅ 复用 PID |
| 信号 | 需手动转发（有双投风险，见下） | 天然继承 |
| 灵活性 | 可带任意 `--patch`/extraArgs | ✅（shell `exec "$@"` 也行） |
| Node 可移植 exec | —— | **Node 无原生 exec**（只能用 shell shim 实现） |

**推荐分层设计**（两种都用，各取所长）：

1. **带参数直通**：用 shell shim 的 `exec` 真替换——零开销、PID 复用、信号天然正确。
2. **无参数 → TUI → 选中后移交**：由 Node TUI `spawn` 真实 dsh（绝对路径）+ 信号转发 + 透传退出码（Node 无原生 exec，此路径 spawn 是务实选择）。

### 11.3 shim 脚本（注册方案落地的完整骨架）

```sh
#!/bin/sh
# ~/.local/bin/bdl — 薄 shim；真实 dsh 一律绝对路径，绝不通过 PATH 解析
REAL_DSH=/opt/homebrew/bin/dsh
TUI=/Users/qdd/.config/bdl/tui.mjs

if [ $# -eq 0 ]; then
  exec node "$TUI"          # 无参数 → 进 TUI（TUI 内部 spawn 真实 dsh）
else
  exec "$REAL_DSH" "$@"     # 有参数 → 真 exec 替换，原样直通
fi
```

```sh
chmod +x ~/.local/bin/bdl
```

### 11.4 Node TUI 的 spawn 握手骨架

```js
// handoff.mjs
import { spawn } from 'node:child_process';
import { constants } from 'node:os';

const REAL_DSH = '/opt/homebrew/bin/dsh'; // 绝对路径：不依赖 PATH 解析（bdl 与 dsh 异名，无递归风险，纯为行为稳定）

export function handoffToDsh({ profile, patchOverlays = [], extraArgs = [] }) {
  const argv = ['--profile', profile,
    ...patchOverlays.flatMap((p) => ['--patch', p]),
    ...extraArgs];
  const child = spawn(REAL_DSH, argv, { stdio: 'inherit' });

  // 转发信号（父与子通常同前台进程组，终端会把信号同时发给两者；
  // 这里转发作为后台/跨组场景的兜底，且 SIGHUP 真实 dsh 不自行处理）
  const forward = (sig) => () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(sig);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, forward(sig));

  // 透传退出码（含被信号杀死的 128+n 约定）
  child.on('close', (code, signal) => {
    process.exit(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1));
  });
}
```

**双信号投递注意**：父子同前台进程组时 Ctrl-C 会把 SIGINT 同时发给父子；父的转发会给子再投一次 SIGINT，而 dsh 的 shutdown 对重复信号会立即强退（跳过 5s 优雅 dispose）。缓解策略二选一：(1) 父收到 SIGINT/SIGTERM 时**只忽略并等待子进程退出**（子已从终端直接收到信号），仅对 **SIGHUP** 显式转发（dsh 不处理它）；(2) 简单起见先转发、接受极少数场景下优雅退出被打断。PoC 建议先按骨架实现，实测 Ctrl-C 行为后再微调。

### 11.5 交互语义

- `bdl`（0 参数）→ TUI。
- `bdl <任何参数>` → 直通真实 dsh（含 `web`、`--profile`、`plugin`、`--help`、`--version`），即 `bdl web` ≡ `dsh web`。
- 真实 `dsh` 未被接管：原命令行为完全不变（0 参数依旧报 `--profile required`），**无需任何逃生口**；`DSH_NO_TUI`、`--no-tui` 机制整体移除。
- launcher 的 shim 只需一个分支判断（`$# -eq 0`），不需要解析任何自己的 flag。

### 11.6 三系统握手差异

| 能力 | macOS / Linux | Windows |
|---|---|---|
| 信号 | POSIX 信号（SIGINT/SIGTERM/SIGHUP），dsh 自行处理 SIGINT(130)/SIGTERM(0) | **无 POSIX 信号**；Ctrl+C 是 console ctrl event（发给整组）；`child.kill('SIGTERM')` 实际是 `TerminateProcess`（硬杀，不优雅） |
| exec 替换 | shell `exec "$REAL_DSH" "$@"` 真替换（复用 PID、天然继承信号） | **无 exec**；只能 spawn + `stdio:'inherit'` + 等待 + `process.exit(code)` |
| 信号转发 | 需转发（有双投风险，见 11.4） | 无需转发（无信号可转）；Ctrl+C 由系统发 ctrl event 给整组 |
| 杀进程子树 | `kill <pid>`；父退后子通常随 SIGHUP 结束 | 父进程退出**不会**自动带走子进程树；需 `taskkill /PID <pid> /T /F` 或 `windows-kill`/`tree-kill` 包 |
| 退出码 | `$?`（sh）/ `$status`（zsh） | cmd `%ERRORLEVEL%`；PowerShell `$LASTEXITCODE` |
| 平台分支 | sh shim 的 `exec` 真替换 + Node TUI spawn 握手 | 全部走 Node `spawn` 握手；shim 用 `.cmd` 转调 Node，**不 `exec`** |

**推荐（平台分支）**：
- **macOS / Linux**：维持第十一节——带参数用 sh `exec` 真替换；无参数进 TUI 后 Node `spawn` 握手（信号转发 + 退出码透传）。
- **Windows**：**统一走 Node `spawn` 握手**（无 exec、无信号转发）：`.cmd` shim 用 `node "%~dp0launcher.mjs" %*` 转调；launcher 里 `spawn(node, [realBinJs, ...argv], { stdio:'inherit' })`，子进程 `close` 后 `process.exit(code)`。Ctrl+C 由系统 ctrl event 直接送达整棵进程组，无需转发；若需程序化停止子进程树，用 `taskkill /PID <pid> /T /F`。

---

## 十二、三系统适配

本节汇总跨平台事实与结论（源码验证 + 推断标注）。前置事实：dsh 包 **无 `os`/`cpu` 安装限制**（`package.json` 未声明），三系统共用同一份 `lib/bin.js`；平台差异由运行时选择的 backend 体现——Unix 用 bash executor（`dsh-bash-local` / `dsh-bash-sandbox`），Windows 用 PowerShell executor（`dsh-pwsh-local` / `dsh-pwsh-sandbox`），Windows 沙箱为 `dsh-sandbox-windows-acl`（restricted-token + 能力 SID 写白名单，依赖 koffi FFI）。故 launcher 须三系统可用。

### 12.1 路径与目录三系统（`$DSH_HOME` 源码确认）

读 `dsh-home-paths` 源码确认：`defaultDshHome() = join(os.homedir(), ".dsh")`，目录名恒为 `.dsh`，用 Node 平台化 `path.join`。故三系统默认一致：

| 平台 | 默认 `$DSH_HOME` | profiles 目录 | 建议 launcher 元数据目录 |
|---|---|---|---|
| macOS | `/Users/<u>/.dsh` | `~/.dsh/profiles` | `~/.config/bdl/` |
| Linux | `/home/<u>/.dsh` | `~/.dsh/profiles` | `~/.config/bdl/` |
| Windows | `C:\Users\<u>\.dsh`（= `%USERPROFILE%\.dsh`，**非** `%APPDATA%`/`%LOCALAPPDATA%`） | `%USERPROFILE%\.dsh\profiles` | `%APPDATA%\bdl\` |

- `resolveDshHome()` 优先级：显式配置路径 > `$DSH_HOME`（非空非空白）> 默认 `~/.dsh`。`expandHomePath` 同时处理 `~/` 与 Windows 的 `~\` 前缀。
- **结论：bdl 元数据统一放 `~/.config/bdl/`（macOS/Linux）/ `%APPDATA%\bdl`（Windows），与 `$DSH_HOME` 解耦**（见「环境隔离模型」章 5.4）；不随 `DSH_HOME` 漂移/隔离。
- **路径与引号**：launcher 代码全部用 Node `path.join`/`resolve`（平台化分隔符），**不要手拼 `/`**；shim 脚本里含空格的路径（Windows 常见 `C:\Users\<u>\...`）必须整体引号包裹（POSIX 用 `"$..."`，`.cmd` 用 `"%~dp0..."`）。

### 12.2 开发/分发矩阵

| 分发形态 | macOS | Linux | Windows |
|---|---|---|---|
| **单文件 shim（推荐）** | `~/.local/bin/bdl`（POSIX sh，`chmod +x`） | 同左 | `%USERPROFILE%\bin\bdl.cmd`（+ `bdl.ps1` 可选），加入 PATH |
| **npm 全局包（bin=bdl）** | ⚠️ 本机 prefix 版本固定 Cellar、不在 PATH，需改用 `pnpm i -g`（`~/Library/pnpm/bin` 在 PATH） | ✅ 视 prefix（`/usr/local` 或 `~/.npm-global`）可用 | ✅ 装进 `%APPDATA%\npm` 即生成 `bdl.cmd`；名字独立，与真实 dsh 无冲突 |
| **pnpm 全局** | ✅ 本机 `~/Library/pnpm/bin` 已在 PATH | ✅ | ✅ |

**推荐**：三系统统一「**单文件 shim + Node 脚本**」分发（`launcher.mjs` + 平台 shim 三件套 `.sh`/`.cmd`/`.ps1`）；`bdl` 名字独立后，npm/pnpm 全局包分发也完全可行（无撞名、无遮蔽），可作后续选项。README 按三系统分别写安装步骤（macOS/Linux：`chmod +x` + 确认 `~/.local/bin` 在 PATH；Windows：放 `.cmd` 进 PATH 目录）。

### 12.3 统一安装脚本（install.mjs）

用 Node 探测平台 + 定位真实 dsh 的 bin.js，写对应 shim：

```js
// install.mjs（零依赖，Node ≥18）
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';

const os = platform();                    // 'darwin' | 'linux' | 'win32'
const HOME = homedir();
const LAUNCHER = join(HOME, '.config', 'bdl');
mkdirSync(LAUNCHER, { recursive: true });

const REAL_BIN = resolveRealDshBin();     // 探测到的真实 bin.js 绝对路径
const TUI = join(LAUNCHER, 'tui.mjs');

if (os === 'win32') {
  const dir = join(HOME, 'bin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bdl.cmd'), [
    '@echo off',
    'if "%~1"=="" (',
    '  node "' + TUI + '"',
    '  exit /b %errorlevel%',
    ')',
    'node "' + REAL_BIN + '" %*',
    ''
  ].join(CRLF));
  // 提示用户把 %USERPROFILE%\bin 加入 PATH
} else {
  const dir = join(HOME, '.local', 'bin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bdl'), [
    '#!/bin/sh',
    'REAL_DSH="' + REAL_BIN + '"',
    'TUI="' + TUI + '"',
    'if [ $# -eq 0 ]; then',
    '  exec node "$TUI"',
    'else',
    '  exec node "$REAL_DSH" "$@"',
    'fi',
    ''
  ].join(LF));
  chmodSync(join(dir, 'bdl'), 0o755);
}
```

要点：POSIX shim 与 Windows `.cmd` 都用 `node` 显式启动 bin.js（不依赖 bin.js 的 shebang/可执行位），**两平台口径一致、真实 dsh 一律绝对路径**，不依赖 PATH 解析（`CRLF`/`LF` 为换行常量，略）。

---

## 十三、PoC 实施路线图（分阶段）

**P0（MVP：能选、能改、能启）**
1. 只读骨架：`~/.config/bdl/registry.mjs` 扫描 `~/.dsh/profiles/*/package.json` 读 `dsh.profile.bundles`，合并 `bundles.json`；不写 profile。
2. TUI 多级菜单 + 启动：enquirer，「启动」调 `handoffToDsh()`。
3. shim 注册：`~/.local/bin/bdl`（第十一节），`chmod +x`；验证 `bdl` 出 TUI、`bdl web` 直通、真实 `dsh` 不变。
4. 新建/校验：新建 `spawn(REAL_DSH, ['plugin','--profile',name,'add',...pkg])`；校验 `REAL_DSH --profile X --dump-config`。
5. 插件管理（P0 子集）：bundle 列表、启用/禁用（cordis.patch.yml `disabled` + writeFileAtomic）、增删 bundle（`dsh plugin add/remove`）。
6. 信号/退出码实测：Ctrl-C / `kill -TERM` / `kill -HUP`，按 11.4 微调。

**P1（完整整合包管理）**
7. 导入/导出 bdl-pack.json（第八章）。
8. 更新检查 + 批量更新（pnpm outdated / link 插件 git pull，第六章）。
9. 整树隔离（注入独立 DSH_HOME，第五章）。
10. 依赖升级 + 快照回滚（备份到 `~/.config/bdl/backups/`）。
11. 复制/删除整合包、诊断解析、默认项。
12. 整合包下载（URL/git/index 源，8.5）。
13. dsh 版本管理（安装/切换默认/锁定，第七章）。

**P2（增强）**
14. 重命名、定义升级（URL/git）、dsh 本体升级提示、日志查看、镜像源、市场/社区源。

---

## 十四、开放问题与风险

1. **写权限需在真实 shell 验证**：本 agent 沙箱对 `~/.dsh`、`~/.local/bin`、`~/.config` 写操作返回 EPERM；目录属主为 qdd 且有既有写入痕迹，但 PoC 必须在用户真实 shell 里验证 `~/.local/bin/bdl` 与 `~/.config/bdl/` 可写。
2. **`--dump-config` 会重写 `cordis.yml`**：虽幂等（恒写空根 `[]`）且不 boot，但属「非严格只读」的副作用，需在文档中向用户说明，避免误判为纯校验。
3. **双信号投递导致优雅退出被强退**（11.4）：需实测 Ctrl-C 后决定是否改为「SIGINT/SIGTERM 只忽略+等待、仅转发 SIGHUP」。
4. **enquirer 的 `AutoComplete` 在非 TTY 下会退化**：需保证 `bdl` 在 `| tee` / CI 无 TTY 时自动回退到直通（检测 `process.stdin.isTTY`），避免 TUI 卡死。
5. **profile 名合法性**：dsh 拒绝含 `/`、`\`、`.`、`..`、`node_modules` 的名字（`resolveProfileDir`）；新建/导入整合包需前置校验。
6. **`dsh plugin` 需要 pnpm 在 PATH**：本机 pnpm 经 `~/Library/pnpm/bin` 提供；spawn 子进程继承环境即可，但需提示「pnpm not found」失败路径（退出码 127）。
7. **brew upgrade node 的连带影响**：npm 全局 prefix 版本固定（九章），bdl 不用 npm 全局安装即无此风险；但内部缓存 node 路径需重新解析（用 `#!/usr/bin/env node` 或 `node` 而非硬编码 Cellar 路径）。
8. **dsh 本体升级已由版本管理接管**（第七章）：BDL 版本目录自管理后，系统安装方式（brew/npm -g）不再影响 BDL 切换；`BDL_REAL_DSH` 仍最高优先作逃生口。多版本共存的磁盘成本（~334MB/版）与跨 minor 降级兼容性需注意。
9. **环境隔离成本**（第五章）：L3 整树隔离每 env 需重装依赖（磁盘+时间）+ 凭据继承/重登录取舍；建议默认 L2 共享、L3 仅按需。
10. **原子写与并发**：编辑 package.json/cordis.patch.yml 必须 writeFileAtomic + withFileLock + 先备份（第六章 6.2），否则与 dsh 自身写回（如 `dsh plugin` reconcile、Loader write-back）竞争会丢改动。
11. **npm registry 限速/离线**：批量 `npm view` 更新检查需节流 + 用 temp cache；离线时优雅降级（跳过检查，不报错）。
12. **与未来 `dsh` 官方交互能力的关系**：`bdl` 独立指令，不修改/不遮蔽 dsh，与 dsh 未来任何原生 TUI 完全共存；卸载删 `bdl` shim 即可。发布 npm 包前需确认 bin 名 `bdl` 未被占用。
13. **下载源可用性/断点重试**（8.5）：index/URL 失效、网络中断需可重试 + 缓存已下 manifest；`git clone` 失败降级到 raw URL；离线时优雅降级。

---

## 十五、实现状态（代码已完成，与报告对照）

| 报告章节 | 功能 | 实现文件 | 状态 |
|---|---|---|---|
| 二（P0） | 启动/直通/发现/新建/插件启停/增删/校验 | bin/bdl.mjs、src/{registry,tui,dsh,patch-edit,handoff}.mjs | ✅ 已实现+测试 |
| 七 | dsh 版本管理（安装/升降级/多版本/锁定） | src/dsh-version.mjs | ✅ 已实现+测试 |
| 八 8.1-8.4 | 导入/导出 bdl-pack.json（strict 校验/防遍历/回滚） | src/pack.mjs | ✅ 已实现+测试 |
| 八 8.5 | 下载（URL/git/index + sha256 + 摘要确认） | src/download.mjs | ✅ 已实现+测试 |
| 六 6.3 | 更新检查/批量更新（pnpm outdated/update、git fetch/pull） | src/update.mjs | ✅ 已实现+测试 |
| 六 6.4(ii) | 依赖升级+快照回滚、复制/删除/重命名 | src/upgrade.mjs | ✅ 已实现+测试 |
| 五（L3） | 整树隔离（独立 DSH_HOME=BDL_HOME/envs/<id>） | src/isolate.mjs | ✅ 已实现+测试 |
| 二（P1/P2） | 诊断解析、日志查看、默认整合包、extraArgs、镜像源 | src/diagnose.mjs、registry.mjs、tui.mjs | ✅ 已实现+测试 |
| 十一 | 三系统 shim 安装 | scripts/install.mjs | ✅ 已实现（win32 分支未实测） |

**实现偏离报告处（已接受）**：shim 统一 `exec node bin/bdl.mjs "$@"`，TUI/直通分支收进 bin/bdl.mjs（原 11.3 shim 内分支）；带参直通走 Node spawnDsh 而非 sh exec 真替换（原 11.2）。测试脚本：scripts/review-stage2.sh / review-stage3.sh（假 BDL_HOME/DSH_HOME 回归）。
14. **manifest 恶意内容防护**（8.5.4）：下载的 bdl-pack.json 需 strict schema 校验 + 路径遍历防护 + sha256 校验；bundles 只经 npm registry 安装、不允许任意命令执行。
15. **index 缓存与节流**：index 拉取需缓存（带 `updatedAt`/ETag）+ 限频节流，避免每次启动都全量拉取；多源合并去重（按 `id`+`version`）。
