[English](README.md)

![gillii 横幅](assets/banner.svg)

<img src="assets/logo.svg" width="64" alt="gillii 扫描框与代码标志">

# gillii

用一个 Shell 命令查找微信小程序缓存、解密包文件，并还原可阅读的客户端代码。

- 只读查找，仅列出 AppID 和时间；info 查看缓存详情。
- 分别保留原包、解包文件和还原代码。
- 每个阶段都有日志，静态校验检查页面缺失、语法和样式引用。

## 安装

需要 Bash 3.2+、Node.js 22+；setup 需要 npm 和 npm 仓库网络访问。
已在当前 macOS 主机验证；Linux 恢复流程尚未验证。旧版 macOS 是否可用取决于 Node.js 的系统支持。

当前为 **0.1.0-dev 未发布开发版**。仓库地址为 https://github.com/leo1394/homebrew-gillii ，未验证远端发布状态。没有声称 GitHub Release 或公开校验和已可下载。

```bash
# 在源码目录中安装，不依赖 Homebrew：
bash install.sh --prefix "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
export MANPATH="$HOME/.local/share/man:${MANPATH:-}"
gillii --version

# 本地开发 Formula 对应真实本地源码包：
brew tap --custom gillii/local "$PWD"
brew install gillii/local/gillii
```

公开发布前需将 Formula URL 更新为不可变的发布包地址，并使用对应 SHA256。计划中的公开命令是 `brew install leo1394/gillii/gillii`，目前未验证可用。

## 第一次还原

主要只需三个命令：

```bash
gillii list
gillii clean
gillii chase wx0123456789abcdef
```

不知道 AppID 时，先退出桌面微信，执行 `gillii clean`，重新打开微信并只访问目标小程序。再用 `gillii list` 获取 AppID，执行 `gillii chase <AppID>`。

`list` 和 `clean --dry-run` 仅显示 `appid`、`modified`；每个 AppID 一行，时间取最新包。需要包路径、版本、大小及访问详情时，执行 `gillii info <AppID>`。

`modified` 统一按本机时区显示为 `YYYY-MM-DD HH:mm:ss`。

`clean` 永久删除发现的 `.wxapkg` 包，保留其他数据。`chase` 自动选择最新可读主包、拷贝、解密和逆向；首次执行自动通过 npm 安装依赖，无需单独 setup。结果位于当前目录的 `./<AppID>-<唯一后缀>/source`，同时保留原包、日志和 report.json。重复执行会创建新目录。

macOS 权限受限时，在系统设置中授权终端后重试。手动复制缓存或指定输出位置的可选参数可通过 `gillii help chase` 查看。

## 补全启用

Bash：`source "$HOME/.local/share/bash-completion/completions/gillii"`。
Zsh：将 `$HOME/.local/share/zsh/site-functions` 加入 fpath，然后执行 `autoload -Uz compinit; compinit`。
Fish：`source ~/.local/share/fish/vendor_completions.d/gillii.fish`。
Homebrew 安装到其标准目录；仍需启用对应 Shell 的补全功能。按 Tab 不会安装依赖或下载内容。

## 限制与开发

支持已验证的 V1MMWX 格式、主包、插件及本机测试过的编译模板格式，自动合并同版本已缓存分包。未缓存页面会在 report.json 中列出，状态为 `complete_cached`，表示已有缓存恢复成功。不恢复服务端代码、原始变量名，也不保证运行和渲染等价。不发送业务接口请求。重复运行安装器可升级；最终替换前失败会保留既有可执行文件，配套文件安装并非整体原子事务。

运行 `bash tests/test.sh` 检查命令、安装器和补全；运行 gillii setup 后，可执行 `node --test "${XDG_CACHE_HOME:-$HOME/.cache}/gillii/0.1.0-dev/"*.test.mjs` 检查恢复逻辑。参见[第三方说明](THIRD-PARTY.md)、[手册](man/gillii.1)和[验证记录](docs/VALIDATION.md)。贡献时保留格式并增加针对行为的测试。采用 GPL-3.0-or-later，[许可证](LICENSE)。不添加赞助入口。
