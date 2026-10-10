# Reverse-engineering providers

The CLI parses arguments in `libexec/gillii.mjs` and selects an implementation through `libexec/providers/index.mjs`. Providers expose an `id` and `execute(command, options)` entry point; existing CLI arguments and output contracts remain unchanged.

| Location | Responsibility |
| --- | --- |
| `libexec/providers/miniprogram/` | WeChat cache discovery, cleanup, package selection, decryption, reconstruction, static analysis and mini-program reports |
| `libexec/providers/miniprogram/tools/` | Vendored mini-program unpacker and its npm dependencies |
| `libexec/providers/apk/` | APK launch, extraction, payload analysis, dependency preparation and APK reports |
| `libexec/providers/workbench/` | Shared workbench UI, language controls, local viewer and IDE integration |
| `libexec/cli-output.mjs` | Shared terminal presentation |

`chase` keeps its existing routing: an AppID selects the mini-program provider; an input without an AppID selects the APK provider. `list`, `info`, `clean` and `setup` use the mini-program provider. `open` selects the shared workbench provider. Package-specific report generation remains with its reverse-engineering provider and embeds the shared report assets.

Future IPA or AAB support should add a sibling provider directory and extend the central selection rule. Each provider owns its package detection, pipeline and dependencies; workbench components remain shared. IPA and AAB are not implemented by this restructuring.

The shell launcher, installer and Homebrew formula retain their existing entry points. They copy the `libexec` tree recursively. The ignored local `.publish.json` uses the provider's npm directory when preparing release archives.

Tests are discovered through (`libexec/providers/*/*.test.mjs` and `tests/test_apk*.py`) and import the provider modules directly. Mini-program reproduction commands still invoke the common CLI entry point.
