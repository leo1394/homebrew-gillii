# 小程序分析与报告

当前源码功能，尚未发布。命令不变：

```sh
gillii chase wx0123456789abcdef
gillii chase wx0123456789abcdef --input /path/to/cache --output ./new-result
```

`--output` 必须是新目录。仅在找到输入、成功创建输出目录后生成报告；无缓存或目录创建失败时仍返回命令行错误。

## 输出

| 文件 | 内容 |
| --- | --- |
| `index.html` | 离线阅读：恢复/覆盖状态、统计、各阶段耗时和错误、API 调用、URL 常量、页面权限、组件引用、证据链接 |
| `report.json` | 保留原有字段，增加 schemaVersion 2、stages、commands、tools、analysis、coverage 和 artifacts |
| `docs/analysis.md` | 可阅读的静态分析，包含证据适用范围 |
| `docs/reproduction.md` | 从保留包快照重新恢复的命令及实际执行过的子进程参数、退出状态与日志路径 |
| `evidence/raw-files.json` | 解包文件相对路径、字节数、SHA-256 |
| `evidence/source-files.json` | 源码目录文件相对路径、字节数、SHA-256；其中也有保留的编译产物，不能等同于业务模块数 |
| `evidence/analysis.json` | 配置、页面、分包、权限、组件、插件声明，以及带文件/行号的直接 API 调用和 URL 字符串常量 |
| `packages/<AppID>/` | 本次选择的主包与同版本分包快照；原 `original.wxapkg` 仍保留 |
| `logs/` | 每条恢复命令的独立日志；依赖安装失败记录在 dependencies.log |

报告依赖现有 Node 工具，不新增 Python 运行依赖。HTML 无远程脚本、资源或业务请求；包内文本均按文本转义。

## 状态含义

保留既有恢复状态和退出码：`complete`、`complete_cached` 返回 0；`incomplete`、`failed` 返回 1。

`complete_cached` 表示已缓存内容通过静态校验，声明的部分页面没有缓存。新增 `coverage.status` 会标为 `partial`，不会把未缓存页面当作恢复失败，也不会暗示已全量恢复。

分析本身可能不完整，例如缺少解析依赖、配置不可读、JavaScript 无法解析。具体原因写入 `analysis.errors` 和报告阶段，不据此伪造 API 结果。报告写入失败时记录 reportingError 并返回非零状态。未执行阶段为 `not_run`。依赖准备、解密、恢复或校验失败时，保留已产生的证据和失败报告。

## 分析与复现边界

API 统计来自 AST 中直接的 `wx.*`、`uni.*`、`tt.*` 调用，不执行应用代码；不会准确追踪别名、动态属性、条件可达性或动态拼接。URL 来自 HTTP(S) 字符串常量，不代表实际请求；报告省略用户名、密码、查询参数与片段，原始代码仍按原样保留。组件列表是声明证据，不代表运行时使用已确认。

复现命令读取保留快照，默认创建新输出目录，可额外指定尚不存在的 `--output`。同版本分包与主包一起保留，避免只重跑主包而遗漏分包。原安装位置、Node 与锁定依赖仍须可用；迁移到其他机器需要调整路径。单条子进程记录保留当次输出路径，直接重跑可能修改生成文件。

不恢复服务端代码、原始变量名，不保证构建、运行或视觉等价。

## 本次验证

覆盖静态 API/URL 证据、HTML 转义与离线链接、损坏包失败报告、已有输出保护、未缓存页面区分、主包/分包快照重跑文件哈希一致、依赖安装失败后保留报告。另执行原有 Node、APK Python、CLI/安装/补全回归。

真实微信缓存被 macOS 隐私权限拒绝读取，本次没有宣称已重跑真实缓存；端到端验证使用包含主包和分包的可控样本。Fish 环境不可用。
