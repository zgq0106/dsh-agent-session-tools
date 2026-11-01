# 发布到 GitHub 与 DSH 社区

这份指南只讲动作，不讲概念。每一步都有可验证的完成信号；哪一步没做到，后面不用继续。

> 本包的发布决定（2026-11-01）：包名 `dsh-agent-session-tools`，仓库 `zgq0106/dsh-agent-session-tools`，**只发 GitHub，不发 npm**。所有命令按这个前提写死，换名字请全局替换。

---

## 0. 先看本机现状

在本机（Windows）实测：

| 工具 | 状态 | 影响 |
|---|---|---|
| `node` | v24.21.0，可用 | 跑测试没问题 |
| `npm` | 11.19.0，可用 | 可用于 `npm pack` 自查，不必发 npm |
| `git` | **不在 PATH** | 命令行推不了，需先装（见路线 A） |
| `gh`（GitHub CLI） | **不在 PATH** | 建仓库、提 PR 得走网页，除非一并装 |
| `pnpm` | 不在 PATH（DSH 自带） | 发布不需要它；`dsh plugin add` 内部会用自己的 pnpm |

所以第一件事是选一条上传路线。

---

## 1. 选上传路线

| 路线 | 适合 | 代价 |
|---|---|---|
| **A. 装 Git for Windows**（推荐） | 想以后持续更新、改一次推一次 | 装一次，约 60 MB |
| **B. GitHub Desktop** | 不想碰命令行，但又要能持续更新 | 装一次，界面操作；首次仍需登录 GitHub |
| **C. 网页上传** | 只想先发出去，不打算马上改 | 免安装，但隐藏文件（`.gitignore`）容易漏，且以后每次改动都要手动重传 |

三个路线不冲突：先用 C 发出去，日后再补装 A 也完全可行。

---

## 2. 发布前自查（1 分钟）

在包目录执行：

```powershell
cd E:\HarnessWorkRoom\dsh-agent-session-tools
node --check index.js
node test/smoke.mjs          # 应输出 59 passed, 0 failed
npm pack --dry-run --json    # 看 files 列表：应为 11 个文件，无 node_modules
```

再看一眼有没有不该上传的东西：

```powershell
Get-ChildItem -Force | Select-Object Name
```

应该只有：`CHANGELOG.md`、`LICENSE`、`README.md`、`README.en.md`、`PUBLISHING.md`、`cordis.patch.yml`、`icon.svg`、`index.js`、`locale/`、`package.json`、`test/`、`.gitignore`。

---

## 3. 建 GitHub 仓库

1. 打开 <https://github.com/new>。
2. **Repository name** 填 `dsh-agent-session-tools`（必须和 `package.json` 的 `name` 一致，否则别人 `dsh plugin add` 出来的目录名和包名对不上）。
3. **Description** 建议填：
   `Agent tools for DeepSeek Harness sessions: create a session, inject queued or steering messages into any session.`
4. 选 **Public**。
5. **不要**勾 Add a README / .gitignore / license——本地已经有了，勾了会产生冲突。
6. 点 Create repository。

完成信号：看到仓库空页面，上面提示 `…or push an existing repository from the command line`。

---

## 4. 上传代码

### 路线 A：Git for Windows

安装（任选其一）：

```powershell
winget install --id Git.Git -e --source winget
# 或到 https://git-scm.com/download/win 下载安装包
```

装完**关掉当前终端再开新的**，确认：

```powershell
git --version
```

然后推送：

```powershell
cd E:\HarnessWorkRoom\dsh-agent-session-tools
git init -b main
git add .
git commit -m "feat: initial release 0.1.0"
git remote add origin https://github.com/zgq0106/dsh-agent-session-tools.git
git push -u origin main
```

首次 `push` 要认证。GitHub 早已不接受账号密码，二选一：

- 用 **Personal Access Token** 当密码：GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token，勾 `repo` 权限，复制生成的串（只显示一次）。推送时用户名填 `zgq0106`，密码粘贴 token。
- 或者装 GitHub CLI（`winget install --id GitHub.cli`），`gh auth login` 走一次浏览器授权。

完成信号：刷新仓库页面，能看到 12 个左右的文件和 `main` 分支。

### 路线 B：GitHub Desktop

1. 下载 <https://desktop.github.com/> 并登录。
2. File → Add local repository → 选 `E:\HarnessWorkRoom\dsh-agent-session-tools`（提示不是仓库时点 `create a repository`）。
3. 填 Commit message = `feat: initial release 0.1.0` → Commit to main。
4. 点 **Publish repository**，取消勾选 Keep this code private，仓库名填 `dsh-agent-session-tools`。

完成信号：Publish 按钮变成 Fetch/Pull，网页上能看到文件。

### 路线 C：网页上传

1. 在空仓库页点 **uploading an existing file**。
2. 把包目录里的文件拖进去。**注意**：Windows 资源管理器默认不显示 `.gitignore`，先开「查看 → 隐藏的项目」，否则会漏。
3. Commit message 填 `feat: initial release 0.1.0` → Commit changes。

完成信号：仓库根目录能看到 `package.json`、`index.js`、`locale/`、`test/`。

---

## 5. 补齐仓库门面（社区收录会看这几项）

在仓库页面点右上 **⚙ Settings** 之外的入口操作：

1. 仓库右侧 **About** → ⚙ → Description 填第 3 步那句话；Website 可以不填。
2. **Topics** 填（每个回车确认）：

```
dsh-plugin
deepseek-harness
dsh
cordis
agent
session
multi-agent
```

`dsh-plugin` 这个 topic 是社区目录的硬性要求（`awesome-deepseekharness` 的贡献指南原文写着 strongly required），少了会直接被要求改。

完成信号：仓库标题下方出现这些 topic 标签，点 `dsh-plugin` 能在 GitHub topic 页里搜到本仓库。

---

## 6. 打版本标签 + 发 Release

社区收录要求「有版本标签（`v0.1.0`）」。

```powershell
cd E:\HarnessWorkRoom\dsh-agent-session-tools
git tag v0.1.0
git push origin v0.1.0
```

然后在网页：仓库 → **Releases** → **Draft a new release** → 选 `v0.1.0` → Title `v0.1.0` → 描述直接抄 `CHANGELOG.md` 的 0.1.0 段 → **Publish release**。

网页上传路线（C）没有本地 git，等价做法：Releases → Draft a new release → **Choose a tag** 里输入 `v0.1.0` → Create new tag on publish → 填标题描述 → Publish。效果一样。

完成信号：`https://github.com/zgq0106/dsh-agent-session-tools/releases/tag/v0.1.0` 能打开。

---

## 7. 验证别人真的装得上

这一步别跳过——「仓库能打开」不等于「插件能装」。

```powershell
# 换成你自己的 profile 名；桌面版默认 desktop，Web 版常见 web
dsh plugin --profile desktop add github:zgq0106/dsh-agent-session-tools
```

如果 pnpm 不认 `github:` 前缀，用完整地址：

```powershell
dsh plugin --profile desktop add "git+https://github.com/zgq0106/dsh-agent-session-tools.git"
```

然后：

1. **重启 DSH**（Host 插件的模块按包名缓存，禁用/启用不会重读）。
2. 打开插件管理页，确认出现「会话工具 / Agent Session Tools」条目和图标。
3. 新开一个会话，问 Agent「你现在有哪些 session_ 开头的工具」，应能看到 `session_create` / `session_inject` / `session_list` / `session_cancel`。

完成信号：四个工具都在，且 `session_list` 能返回真实会话列表。

> 本机测试注意：本机还装着旧的私有版 `@local/dsh-session-control`，两者注册同名工具。要在本机真机验证，先移除旧版：
> `dsh plugin --profile desktop remove @local/dsh-session-control`，并把它从 profile `package.json` 的 `dsh.profile.bundles` 里删掉，再装新的。**这一步会改变你正在用的环境，先确认再动。**

---

## 8. 提交到 DSH 社区目录

社区没有统一「官方商店」，公开的发现入口是几个 awesome 目录站。按性价比排序：

### 8.1 `kejixiaoliang/awesome-dsh-plugins`（280+ 插件，14 分类）

流程（已核实其 CONTRIBUTING）：

1. 先在 `plugins/<分类>.md` 里搜 `zgq0106`，确认没重复。
2. 分类选 **Agent Orchestration / 多 Agent 类**（本插件是给 Agent 调度会话的工具）——按 `docs/taxonomy.md` 的边界确认，别硬塞。
3. 在该分类文件末尾加一行：

```markdown
- [dsh-agent-session-tools](https://github.com/zgq0106/dsh-agent-session-tools) — 给 Agent 用的会话工具：新建会话、向任意会话注入消息（排队/引导），可列出会话并取消运行中的轮次
```

4. 提 PR，标题形如 `Add dsh-agent-session-tools to Agent Orchestration`。

收录门槛（原文要点）：必须是 DSH 专属、有公开仓库、有 README、有可运行代码，且能通过 `dsh plugin add` 安装。**无 README 的占位仓库直接拒收。**

### 8.2 `awesome-deepseekharness/awesome-deepseek-harness`（双语，PR 检查严）

流程（已核实其 CONTRIBUTING）：

1. 分类选 **🧩 Tools, Workflows & Presets**。
2. **必须同时改两个文件**，位置一致：
   - `README.md`（英文）：

```markdown
| [zgq0106/dsh-agent-session-tools](https://github.com/zgq0106/dsh-agent-session-tools) | Session tools for DSH agents: create a session and inject queued or steering messages into any session | 0 |
```

   - `README.zh.md`（中文）：

```markdown
| [zgq0106/dsh-agent-session-tools](https://github.com/zgq0106/dsh-agent-session-tools) | 给 DSH Agent 的会话工具：新建会话、向任意会话注入消息（排队/引导） | 0 |
```

3. PR 标题：`Add zgq0106/dsh-agent-session-tools to Tools, Workflows & Presets`。
4. PR 正文必须写清：与 DSH 的关系（1–2 句）、**验证过的安装命令**、License、`dsh-plugin` topic 已设、版本。

硬性检查（原文）：只改 `README.md` 不改 `README.zh.md` 会被 CI 判 request changes；star 数填 0 可以，别空着。

### 8.3 官方 Discussions（可选，但曝光最直接）

DSH 官方的插件讨论区在 <https://github.com/deepseek-ai/deepseek-harness/discussions>。发一条贴，带上：一句话定位、安装命令、截图（插件管理页条目 + 四个工具列表）、与 `dsh-session-bridge` 的差异说明。

> 这一条是社区 CONTRIBUTING 里给出的官方入口链接；发帖前先看该 Discussions 的分类板块，别发错版块。

---

## 9. 发布后检查清单

- [ ] 仓库 `package.json` 的 `name` 与仓库名一致
- [ ] LICENSE 是 MIT，`package.json` 里 `license` 字段也是 `MIT`
- [ ] `v0.1.0` tag 存在，Release 页面能打开
- [ ] `dsh-plugin` 等 topics 已设
- [ ] 换一台机器（或临时目录）实测 `dsh plugin add github:…` 成功 + 重启后工具可见
- [ ] README 里没有本机私有路径、内网地址、凭据
- [ ] 至少提了一个社区目录的 PR

---

## 10. 后续更新流程

1. 改代码 → 跑 `node test/smoke.mjs`。
2. 改 `package.json` 的 `version`（如 0.1.1），在 `CHANGELOG.md` 顶部加一段。
3. `git add -A; git commit -m "fix: …"; git push`。
4. `git tag v0.1.1; git push origin v0.1.1`，网页发 Release。
5. 用户升级：`dsh plugin --profile <名> add github:zgq0106/dsh-agent-session-tools` 再重启 DSH（默认会取最新提交；要锁版本就写 `#v0.1.1`）。

> 记得：Host 半侧改动必须重启 DSH 才生效，重新装 bundle 也不会重读 `index.js`。
