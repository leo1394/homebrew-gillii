# Gillii

![gillii 横幅](assets/banner.svg)

<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>

本地逆向工程工作台，特色支持微信小程序。从缓存恢复客户端代码，或分析 Android APK，在同一个工作区探索架构、源码与证据。

- **微信小程序：**发现缓存包，解密并恢复客户端代码，合并同版本已缓存分包，追踪页面、事件、函数与引用。
- **Android APK：**检查包信息和资源，反编译 Java 与托管程序集，导出受支持的 Unity 资源，分析 Flutter ARM64 Dart AOT。
- **开发工作台：**浏览架构与源码，追溯证据，查看复建蓝图，在 VS Code、Sublime Text、Android Studio、Cursor 或 Antigravity 中打开项目。
- **结果留存：**中英文 HTML 报告、JSON 证据、原始包、文件哈希与复现步骤。

## 安装

### Homebrew（推荐）

```bash
brew install leo1394/gillii/gillii
```

Homebrew 自动安装 Node.js。发布包自带小程序恢复依赖，安装 Gillii 无需本地编译。

### Bash (Linux / macOS)

需要 Bash 3.2+、Node.js 22+。

```bash
curl -fsSL https://raw.githubusercontent.com/leo1394/homebrew-gillii/master/install.sh | bash
```

安装器下载最新正式版，校验 SHA256，默认安装到 `~/.local`。如果提示 PATH 缺少 `~/.local/bin`，按提示添加。再次执行同一命令即可升级。

APK 工具仅在首次分析 APK 时，按识别到的载荷准备。安装 Gillii 或逆向小程序不会下载 APK 工具。APK 分析需要 Python 3.10+ 及 `venv`/`pip`；macOS 配有 Homebrew 时，缺少 Python 会在首次使用时准备。Java 反编译需要已安装的 Java 11+；Flutter 分析首次使用时可能编译分析工具。详见 [APK 依赖与离线操作](docs/APK.md)。

## 快速上手

### 微信小程序

```bash
gillii list
gillii chase wx0123456789abcdef
```

不知道 AppID 时，先退出桌面微信，执行 `gillii clean`。重新打开微信并访问目标小程序，再用 `list` 和 `chase` 恢复代码。`clean` 永久删除发现的 `.wxapkg` 包，保留其他微信数据。

`chase` 自动选择最新可读主包，拷贝、解密并恢复已有客户端代码。结果保存在当前目录的新 `<AppID>-<唯一后缀>` 目录中，恢复代码位于 `source/`。查看包详情可使用 `gillii info <AppID>`。

### Android APK

```bash
gillii chase /path/to/app.apk
```

结果保存在新的 `<文件名>-apk-<唯一后缀>` 目录中，按实际内容提供分析：

| 载荷 | 结果 |
| --- | --- |
| Android DEX | Manifest 与资源检查、JADX Java 反编译 |
| 托管程序集 / Unity Mono | ILSpy C# 反编译，导出受支持的 Unity 资源 |
| Flutter ARM64 AOT | 注释汇编、函数映射诊断、静态调用图、CFG/寄存器 SSA，以及包含受支持局部控制结构的低层伪代码 |
| Unity IL2CPP / 其他原生库 | 文件清单与保留的二进制，暂不支持完整源码恢复 |

Dart 分析在证据支持时识别简单分支、自然循环和等值链 switch，不恢复原始 Dart 源码或完整动态调用图。动态采集列入后续阶段。详见 [Dart AOT 能力边界](docs/DART-AOT.md)。

### 工作台

交互式终端执行 `chase` 后会自动打开本地工作台。重新打开最近一次结果：

```bash
gillii open
```

工作台提供架构纵览、源码浏览与本地编辑区、证据及页面内复建蓝图。小程序报告另有功能追踪、符号与引用；Flutter 报告另有 Dart 分析。通过本地查看器可在已安装的 IDE 中打开项目。报告支持中英文，默认跟随系统语言，兜底英文。

保留的 `index.html` 可离线查看，源码加载和 IDE 打开功能通过本地查看器使用。`report.json` 记录阶段状态与覆盖情况。重复执行保留历史结果。缓存与输出位置等可选参数见 `gillii help chase`。

## 能力边界

Gillii 执行静态分析。恢复结果不保证能构建为原工程、保留原始变量名或复现运行时行为。不恢复后端代码，不获取未缓存的小程序页面，不发送业务接口请求。缺失页面及 APK 未支持或失败的阶段会保留在报告中。

APK 退出码为 **0 完成、2 部分成功、1 失败**。部分成功会保留已有成果与诊断日志。小程序报告区分已有缓存恢复成功与声明页面缺失。详见[小程序报告](docs/MINI-PROGRAM-REPORTS.md)和 [APK 工作流](docs/APK.md)。

已验证平台为 macOS，Linux 恢复尚未验证，暂不支持 Windows。macOS 阻止微信缓存访问时，请在系统设置中为终端授予所需权限。

## AI Agent 与开发

Codex、DSH、Claude Code、Gemini CLI、Cursor 和 GitHub Copilot 共用 [AGENTS.md](AGENTS.md)。命令调用与报告处理见 [AI Agent 接入指南](docs/AI-AGENTS.md)。

按变更范围运行 `node --test libexec/providers/*/*.test.mjs`、`python3 -B -m unittest discover -s tests -p 'test_apk*.py'` 和 `bash tests/test.sh`。保留既有格式，增加针对行为的测试。

[手册](man/gillii.1) · [验证记录](docs/VALIDATION.md) · [第三方说明](THIRD-PARTY.md) · [GPL-3.0-or-later](LICENSE)
