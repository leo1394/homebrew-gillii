# Gillii

![gillii 横幅](assets/banner.svg)

<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>

用一个 Shell 命令查找微信小程序缓存、解密包文件，并还原可阅读的客户端代码。

- 只读查找，仅列出 AppID 和时间；info 查看缓存详情。
- 分别保留原包、解包文件和还原代码。
- 每个阶段都有日志，静态校验检查页面缺失、语法和样式引用。

## 安装

### Homebrew（推荐）

```bash
brew install leo1394/gillii/gillii
```

Homebrew 自动安装 Node.js 和 Shell 补全。发布包自带恢复依赖，无需本地编译。

### Bash (Linux / macOS)

需要 Bash 3.2+、Node.js 22+。

```bash
curl -fsSL https://raw.githubusercontent.com/leo1394/homebrew-gillii/master/install.sh | bash
```

安装器自动下载最新正式版并校验 SHA256，默认安装到 `~/.local`。如果 `~/.local/bin` 不在 PATH 中，按安装提示添加。再次运行安装器即可升级。已在 macOS 验证；Linux 恢复流程尚未验证。

## 快速上手

主要只需三个命令：

```bash
gillii list
gillii clean
gillii chase wx0123456789abcdef
```

不知道 AppID 时，先退出桌面微信，执行 `gillii clean`，重新打开微信并只访问目标小程序。再用 `gillii list` 获取 AppID，执行 `gillii chase <AppID>`。

`clean` 永久删除发现的 `.wxapkg` 包，保留其他数据。`chase` 自动选择最新可读主包、拷贝、解密和逆向；发布包自带依赖，源码安装首次执行会通过 npm 准备依赖，无需单独 setup。结果位于当前目录的 `./<AppID>-<唯一后缀>/source`，同时保留原包、日志和 report.json。重复执行会创建新目录。

macOS 权限受限时，在系统设置中授权终端后重试。手动复制缓存或指定输出位置的可选参数可通过 `gillii help chase` 查看。

## 限制与开发

支持已验证的 V1MMWX 格式、主包、插件及本机测试过的编译模板格式，自动合并同版本已缓存分包。未缓存页面会在 report.json 中列出，状态为 `complete_cached`，表示已有缓存恢复成功。不恢复服务端代码、原始变量名，也不保证运行和渲染等价。不发送业务接口请求。重复运行安装器可升级；最终替换前失败会保留既有可执行文件，配套文件安装并非整体原子事务。

运行 `bash tests/test.sh` 检查命令、安装器和补全；`publish.sh --prepare` 也会使用发布包内的依赖检查恢复逻辑。参见[第三方说明](THIRD-PARTY.md)、[手册](man/gillii.1)和[验证记录](docs/VALIDATION.md)。贡献时保留格式并增加针对行为的测试。采用 GPL-3.0-or-later，[许可证](LICENSE)。不添加赞助入口。
