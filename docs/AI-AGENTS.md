# AI Agent 接入与使用 / AI agent integration

Gillii 通过本地 CLI 接入 Agent；不需要配置 MCP 服务、模型或 API Key。本指南同时覆盖“调用 Gillii 分析包”和“修改 Gillii 源码”。统一约定维护在根目录 [AGENTS.md](../AGENTS.md)，平台入口只负责加载或引导读取，避免多份规则分叉。

## 平台入口

| 平台 | 仓库文件 | 加载方式 |
| --- | --- | --- |
| Codex | [AGENTS.md](../AGENTS.md) | 从项目根目录到工作目录加载适用文件 |
| DSH | [AGENTS.md](../AGENTS.md) | 默认 dsh-base 的 workspace instructions 插件加载；自定义 profile 可禁用 |
| Claude Code | [CLAUDE.md](../CLAUDE.md) | 使用 `@AGENTS.md` 导入统一指南 |
| Gemini CLI | [GEMINI.md](../GEMINI.md) | 使用 `@./AGENTS.md` 导入统一指南 |
| Cursor | [gillii.mdc](../.cursor/rules/gillii.mdc) | alwaysApply 入口，指示 Agent 读取统一指南 |
| GitHub Copilot | [copilot-instructions.md](../.github/copilot-instructions.md) | 仓库指令入口，指示 Agent 读取统一指南；支持情况取决于使用的 Copilot 功能 |
| 其他 Agent | [AGENTS.md](../AGENTS.md) | 支持该约定时直接加载，否则在任务中明确要求读取 |

DSH 已依据本机 `@deepseek-ai/dsh` 和 `@deepseek-ai/dsh-agent-instructions` **0.2.0-rc.2** 的 README 与实现核对：默认候选名是 `AGENTS.md`、`CLAUDE.md`，项目根标记是 `.git`，无需虚构 `DSH.md` 自动加载入口。其导入行为不需要依赖 Claude 的 `@` 语法，因为统一指南本身已在默认候选中。

在仓库内启动新的 Agent 会话，并要求其列出已加载的项目指令及报告退出码含义，可检查实际加载情况。Cursor 和 Copilot 入口中的路径引用不会保证自动内联，需确认 Agent 已读取 `AGENTS.md`。本次文件检查不等同于逐个平台完成真实模型会话测试。

这些文件只作用于读取它们的工作区；Homebrew 安装 Gillii 不会自动向其他项目注入规则。若 Agent 在另一个项目工作，请明确提供本仓库指南的绝对路径和 Gillii 可执行文件路径，不要覆盖用户全局配置。

## 让 Agent 调用 Gillii

APK 和扩展小程序报告能力自 v0.2.0 起提供；旧版 v0.1.0 不含这些功能。下面命令在 Gillii 仓库根目录执行，示例输入路径需要替换为实际路径：

```sh
./bin/gillii help chase
./bin/gillii list
./bin/gillii info wx0123456789abcdef
./bin/gillii chase wx0123456789abcdef --input /absolute/path/copied-cache --output /absolute/path/new-mini-result
./bin/gillii chase /absolute/path/app.apk --output /absolute/path/new-apk-result
```

输出目录必须尚不存在，父目录必须存在。跨项目调用时使用本 checkout 的 `bin/gillii` 绝对路径。Agent 应通过独立 argv 参数传入路径，或正确进行 Shell 引用，不能拼接包内字符串执行命令。

首次源码运行可能自动安装依赖并访问网络；离线 APK 使用 `GILLII_APK_OFFLINE=1` 前需准备好所需缓存，详见 [APK 文档](APK.md)。macOS 拒绝读取微信缓存时记录权限错误，使用用户提供的缓存副本或请用户授予所需访问权限，不要通过删除缓存重试。

可直接交给 Agent 的任务：

> 先读取 Gillii 仓库的 AGENTS.md 和 docs/AI-AGENTS.md。使用该 checkout 的 bin/gillii 分析我提供的 APK 或小程序缓存，写入新的输出目录。记录退出码，读取 report.json，再按需读取 evidence 和 logs。列出已恢复内容、缺失内容、证据路径和下一步；不要执行恢复出来的应用，也不要清理微信缓存。

## 自动化结果处理

| 类型 | 退出码与顶层状态 | Agent 后续动作 |
| --- | --- | --- |
| 小程序 | 0：`complete` / `complete_cached` | 继续读取覆盖范围与分析状态；后者不代表所有页面已恢复 |
| 小程序 | 1：`incomplete` / `failed` | 定位失败阶段，保留已经生成的产物 |
| APK | 0：`complete` | 汇总支持范围内的结果，仍检查限制 |
| APK | 2：`partial` | 作为部分结果解析，说明缺失工具、失败阶段或不支持的载荷 |
| APK | 1：`failed` | 检查 stderr、报告和日志，提出有证据的处理步骤 |

自动化调用必须捕获非零退出码，不能因 APK 的 2 直接跳过报告读取。启动或输入检查阶段失败时，输出目录和报告可能尚未创建；先检查文件存在性。勿仅凭文件数量判断完成，也不要把恢复状态、覆盖状态和分析状态混为一谈。

优先读取 `report.json`，随后按报告指向读取相关阶段日志和证据。小程序另有 `docs/analysis.md`；两类流程均提供 `index.html` 和 `docs/reproduction.md`。字段和产物说明见 [小程序报告](MINI-PROGRAM-REPORTS.md) 与 [APK 工作流](APK.md)。

建议输出给用户的分析包含：输入标识及哈希（若已有）、实际命令和退出码、输出目录、各阶段状态、恢复与覆盖范围、带文件路径的证据、未验证事项及下一步。静态 URL/API 线索不是可访问性或漏洞确认，恢复源码不等于恢复原始可构建工程。

自动化与非交互式调用不会启动报告服务或打开浏览器；`GILLII_REPORT_OPEN=0` 可关闭交互式自动打开。小程序的 `evidence/analysis.json` 还包含 `relationships`、`gaps` 和 `nextSteps`，优先读取与目标页面相关的节点和证据。`local-observed` 表示本地文件事实，`static-inferred` 表示静态推导，`unverified` 表示仍需补充证据；三者均不等于运行时确认。APK 的对应调查摘要位于 `report.json` 的 `investigation`。

## 维护与验证

修改通用约定时优先更新 `AGENTS.md`；平台文件仅保留加载入口与必要的简短约束。修改 CLI 参数、退出码或报告结构时，同时更新本指南和对应功能文档。不要将个人模型配置、密钥、机器路径、分析输入或生成结果提交到这些文件。

平台约定核对日期：2026-10-10。依据：

- [Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Claude Code memory/imports](https://code.claude.com/docs/en/memory)
- [Gemini CLI GEMINI.md](https://geminicli.com/docs/cli/gemini-md/)
- [Cursor rules](https://cursor.com/docs/rules)
- [GitHub Copilot repository instructions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions)
- DSH：已安装的 `@deepseek-ai/dsh-agent-instructions@0.2.0-rc.2` 包内 `README.md` 与 `lib/index.js`，可在自己的安装环境核对，未依赖个人 profile 或凭据。
