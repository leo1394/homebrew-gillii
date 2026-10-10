# Dart AOT static analysis / Dart AOT 静态分析

Default: `gillii chase app.apk` performs static analysis. No APK is launched and no instrumentation is attached.
默认 `gillii chase app.apk` 只执行静态分析，不启动 APK，不附加插桩。

## Current phase / 当前阶段

1. Function mapping diagnostics: separate assembly entries, declarations without code, entry aliases, runtime stubs, symbol-only targets and unknown addresses. Read `mapping_diagnostics` in `evidence/dart-callgraph.json`.
2. Anonymous Code export: obfuscated owners are stored in Blutter's `nativeLib`, outside `app.libs`. Gillii exports these verified Code ranges as `_snapshot_raw_*.dart`, without inventing names or passing them through named-function semantic analysis.
3. CFG / register SSA: branch/fallthrough/return boundaries, reachability, dominators, register definitions and merge inputs. Unknown operations are barriers. Memory, exceptions and types remain opaque.
4. Local control regions: simple `if/else` diamonds, natural loops and immediate equality-chain `switch`. Preserve labels and jumps when structure is not proven.
5. Dart evidence: object-pool references and named async/type-test/runtime stubs. These are evidence annotations, not high-level Dart source.

依次实现函数映射诊断、混淆匿名 Code 导出、CFG/寄存器 SSA、局部控制结构和 Dart 语义证据。符号匹配与函数体恢复分别计数；未知地址不使用邻近地址猜测。复杂结构、异常、内存别名和类型恢复仍有边界。

## Next phase: optional dynamic collection / 下一阶段：可选动态采集

**Deferred; not implemented in this phase. / 已记录，本次不实现。**

- Separate explicit opt-in, preserving the default static command.
- Identify the authorized device/process and exact APK/library hash before attaching.
- Collect timestamped indirect targets, dispatch sites and isolate/thread identity; normalize ASLR addresses against loaded ELF mappings.
- Merge observed runtime edges with static candidate edges while retaining provenance and execution coverage. Observed edges do not prove all possible paths.
- Install dynamic dependencies only when that future mode is explicitly requested. No Frida/ADB/device setup is added to installation, mini-program commands or static APK analysis.

动态采集未来独立启用，记录间接调用与执行覆盖，再合并到静态图。完整动态调用图无法由有限运行保证；未观察到的路径仍需标记为未知。

## REDx regression evidence / REDx 回归证据

The previous 4,088 edges matched only two assembly declarations. IDA data identifies 2,883 target edges, dominated by runtime stubs; anonymous Code export adds 1,619 entries. On those same original edges, 218 now match indexed functions (216 targets have assembly), and 3,099 have a known function or symbol. The remaining 989 edges have no verified target identity. No containing exported range or uniform address offset explains them; they remain unknown rather than guessed.

原始 4,088 条关系的函数匹配从 2 条增至 218 条；其中 216 条目标具备汇编，包含 runtime 符号后识别 3,099 条。剩余 989 条没有已验证的身份，仍保留为未知。新增函数也产生更多调用，因此全图统计与原始基线必须分开比较。指令和调用索引达到上限时，报告标记截断。
