# APK analysis

Available since Gillii v0.2.0 through Homebrew, the release installer or a source checkout. Source examples below use `./bin/gillii`; after installation use `gillii`.

## Run

Requires Bash 3.2+, Node.js 22+ and Python 3.10+ with `venv` and `pip`. Ordinary Android decompilation additionally needs Java 11+ available as `java` on PATH; Gillii does not install Java. macOS is the initial target. Linux APK recovery is unverified and Windows is unsupported.

```bash
./bin/gillii chase /absolute/path/app.apk
./bin/gillii chase /absolute/path/app.apk --output ./apk-result
```

An APK path selects APK analysis; an AppID still selects the existing mini-program workflow. `--output` must name a directory that does not yet exist, with an existing parent. Without `--output`, Gillii creates `<input-stem>-apk-<unique suffix>` in the current directory. Use a fresh path for every run. Gillii preserves extracted evidence and available stage results when later stages are incomplete.

With Homebrew Python 3.13 installed, a source invocation can select its versioned executable:

```bash
GILLII_APK_LAUNCHER_PYTHON="$(brew --prefix python@3.13)/bin/python3.13" ./bin/gillii chase ./app.apk
```

## Supported results

| Detected payload | Analysis and limits |
| --- | --- |
| Ordinary Android | Manifest/package inspection, DEX inventory and JADX decompilation. Decompiled Java and resources are a reconstruction, not the original project. |
| Unity Mono | Managed assembly decompilation using ILSpy, Unity asset export using UnityPy and type-tree support. Exported code and assets require manual reconstruction. |
| Unity IL2CPP | Identifies native/metadata artifacts and preserves raw extraction. Full native-to-C# reconstruction is unsupported; result is partial. |
| Flutter | Identifies the Flutter/native payload and preserves raw extraction. Original Dart/project reconstruction is unsupported; result is partial. |
| Other native payloads | Native artifacts are retained and reported. Native source restoration is unsupported; result is partial. |

No result promises the original build, original identifiers, backend services, signing keys, scene behavior or runtime equivalence. Read the report before using exported code.

## Output and exit codes

The output keeps the original APK at `raw/original.apk` and unpacked files under `extracted/`. `evidence/` contains inventories and inspection results. Generated code goes to `decompiled/java/` or `decompiled/managed/`; exported Unity assets go to `unity-export/`. The output also includes `docs/reproduction.md`, `logs/`, `report.json` and `index.html`. Stage-specific folders are created only when needed: non-Unity APKs do not get a `unity-export/` directory, and the report lists only existing output directories. Open `index.html` for the overview, `report.json` for machine-readable status, and `docs/reproduction.md` for reconstruction steps and unresolved work. Logs retain tool failures and dependency errors.

| Status | Exit code | Meaning |
| --- | --- | --- |
| `complete` | 0 | Supported analysis stages completed. This is not a successful application build. |
| `partial` | 2 | Some artifacts were recovered, but a payload or required stage is unsupported, unavailable or unsuccessful. |
| `failed` | 1 | Input or analysis failed. Inspect available logs and report; invalid input can fail before an output report exists. |

These APK statuses do not replace mini-program statuses such as `complete_cached`.

When normal JADX decompilation returns a nonzero code, Gillii makes one additional simplified-instruction pass into `decompiled/java-simple/`, keeping the normal output separate. This helps inspect difficult methods but does not erase the original failure or turn partial recovery into complete recovery. JADX logs include detailed diagnostics.

## Format-specific analysis boundaries

Unity detection uses bundle signatures, validated SerializedFile headers (versions 9–22), or Unity runtime/assembly markers. An arbitrary `.bundle`/`.assets` filename, `bin/Data` folder or non-Unity `Managed` DLL does not activate the Unity profile. Managed assemblies can use ILSpy independently. The MonoBehaviour alignment workaround is limited to TypeTreeGeneratorAPI 0.0.10 and verifies parsed object headers; it contains no fixed CClient object IDs or Unity version.

The CClient configuration adapter requires all six characteristic table keys (`SocketHosts`, `Views`, `Macros`, `RelayCommands`, `QueryCommands`, `TglGroups`). It only emits `evidence/cclient.json` and a report stage when a matching configuration was analyzed. Invalid unrelated `data.json` files are skipped rather than counted as CClient errors. Matching configurations with invalid tables still receive diagnostics.

CClient references in dependency checksum provenance and historical validation records document where evidence came from; they do not select applications or supply runtime configuration. General usage examples use `app.apk`.

## Execution logs and resource names

`logs/execution.log` records extraction, dependency preparation, tool argument vectors, exit codes, durations and final issues as the run progresses. Tool stdout/stderr is retained in separate numbered files under `logs/`. A failed or partial run prints the reasons and the absolute log paths; the offline report links to the execution log. On a fully `complete` run, the process log directory is removed after evidence/report generation. Manifest and metadata evidence, command metadata and reproduction instructions remain; `logs_retained` is false and `execution_log` is null. Non-complete runs retain both kinds of logs. Failures before an output directory can be created are reported directly on stderr.

APK resource names can differ only by case. Extraction gives colliding files distinct deterministic names to avoid overwrites on case-insensitive filesystems. `evidence/files.json` records `archive_path` (original ZIP name), `path` (exported name) and verified hashes; `extraction.renamed` counts remapped files. Exact duplicate entries, unsafe paths, links and conflicting directory structures remain rejected. Use the original APK and this mapping when interpreting resource references; the exported tree is evidence, not a drop-in replacement APK.

## Automatic dependencies

`libexec/apk/deps.py` selects tools by detected type. Versions, download URLs and checksum provenance live in [`toolchain-lock.json`](../libexec/apk/toolchain-lock.json). Tools are downloaded into a user cache rather than bundled into the CLI archive.

| Tool | Preparation |
| --- | --- |
| Android Build Tools 35.0.0 (`aapt`, `dexdump`) | Reuses `ANDROID_SDK_ROOT`, `ANDROID_HOME` or PATH first; otherwise downloads the Google macOS or Linux x86_64 archive. Checks its published SHA-1 from Google's SDK repository metadata. |
| JADX 1.5.3 | Downloads the upstream release and checks SHA-256; requires an existing Java 11+ runtime. |
| ILSpy command line 9.1.0.7988 | Downloads the NuGet bundle and verifies the SHA-256 recorded in the lock. |
| .NET runtime 8.0.20 | Automatic bootstrap uses locked NuGet bundles on macOS arm64 and official runtime archives on macOS x64 and Linux x64/arm64. Runtime archives use SHA-512 from Microsoft release metadata. Other hosts require `GILLII_APK_DOTNET` pointing to a compatible .NET 8 executable. |
| UnityPy 1.25.3 and TypeTreeGeneratorAPI 0.0.10 | Creates an isolated Python environment with the transitive versions recorded in the lock. Checks downloaded binary wheels against PyPI's published SHA-256. The pinned pure-Python tpk_ar 0.2.4 archive is the exception: its SHA-256 is locked and only module files, license and static metadata are copied, without running build scripts. Missing compatible wheels leave the stage incomplete. |

NuGet bundle hashes were recorded from the original bundles used by the CClient reference workflow; they are not claimed to be separately published upstream checksums. Existing SDK tools and explicit overrides are user-selected paths whose versions are not pinned or verified by Gillii. Dependency preparation failures are recorded per capability so other available stages can continue.

The default APK cache is `~/.cache/gillii/apk/<system>-<arch>/<lock-digest>/`, with separate tool/version directories and a shared download cache. `GILLII_APK_CACHE` overrides the APK cache root. This path is separate from the mini-program dependency cache. Cached installations are checked against their saved file hashes before reuse.

## Offline and tool overrides

Set `GILLII_APK_OFFLINE=1` to prevent dependency downloads. Populate the cache through a successful online run first, or supply the required local tools. A missing offline capability produces a partial result when other analysis can proceed.

```bash
GILLII_APK_OFFLINE=1 ./bin/gillii chase ./app.apk --output ./offline-result
```

| Variable | Value |
| --- | --- |
| `GILLII_APK_LAUNCHER_PYTHON` | Python 3.10+ executable for the APK helper (default `python3`). |
| `GILLII_APK_PYTHON` | Explicitly prepared Unity Python interpreter with UnityPy and TypeTreeGeneratorAPI installed; bypasses the automatic Unity environment. |
| `GILLII_APK_AAPT` | Path to the `aapt` executable. |
| `GILLII_APK_DEXDUMP` | Path to the `dexdump` executable. |
| `GILLII_APK_JADX` | Path to the JADX command line executable. |
| `GILLII_APK_DOTNET` | Path to a compatible .NET 8 executable. |
| `GILLII_APK_ILSPY` | Path to `ilspycmd.dll`, invoked through .NET; not a shell launcher. |
| `GILLII_APK_CACHE` | APK dependency cache directory. |

See [third-party notices](../THIRD-PARTY.md) for upstream sources and licenses. This dependency setup does not alter mini-program discovery, cleanup or recovery.
