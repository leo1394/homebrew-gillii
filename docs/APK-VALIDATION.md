# APK integration validation — 2026-10-10

Validated locally on macOS arm64 with Node 26.10.0, Python 3.14.7 and Java 17.0.18. No APK was installed or executed. No release was published.

## CClient 1.0.9

Input SHA-256: `443052ce9e2c205dc6e03dc3f01c7972608f23bee903ce53f0de81a469249a3f`.

The full CLI was exercised with both the original prepared tools and a freshly provisioned Gillii tool cache, then offline cache reuse. Both runs retained the APK and produced:

- 538 extracted files; every file verified against its extracted bytes; original-copy SHA-256 matches.
- 164 Java files; 15 non-framework managed assemblies producing 2,928 C# files. 108 framework assemblies are explicitly skipped. This is broader than the old four-assembly export.
- 11,444 Unity objects, 11,443 decoded trees and 2,811 verified MonoBehaviour headers.
- 8 CClient project configurations and 158 configuration reference issues, matching the old audit.
- Six Unity export issues matching the original workflow: one PlayerSettings tree, four audio conversions, one texture with missing external data.
- Correct exit status 2 (`partial`), reflecting those six issues and unsupported native source recovery. Decompiled outputs are not claimed to be buildable projects.

Local evidence is retained outside the repository; input APKs and generated user data are not distributed.

## Native Android sample

`CClient-1.1.29-m1-wake-sequence-b15b920.apk` produced 5,350 Java files. JADX reported 25 decompilation errors; the pipeline preserved output and correctly returned partial status. Manifest and both DEX inventories completed.

## Automated verification

- 26 Python tests: APK validation, traversal/symlinks/case collisions, CRC corruption, overwrite protection, runtime detection, missing dependencies, empty output, timeout/error handling, Unity header checks, configuration audit, HTML escaping, pinned download checks, cache locking, relative cache paths and virtualenv overrides.
- 20 Node tests passed, including APK argument dispatch and existing mini-program recovery.
- Existing CLI/install/upgrade/manual tests and Bash/Zsh completion checks passed. Fresh-source snapshot and installed-dependency cases were exercised.
- Formula Ruby syntax and Bash syntax checks passed; staged package contents include APK helpers and dependency lock.
- Independent review findings (empty Unity success, relative cache path, initial reproduction link) corrected.

## Verification boundaries

Android tools were discovered from the local SDK; the fallback SDK archive download was not executed. Automatic .NET/JADX/Unity setup was exercised from an empty cache. Linux, Windows, actual Homebrew formula installation and Fish behavior were not exercised. The browser tool rejected local `file:` navigation; HTML generation, escaping and local link targets were checked statically, without claiming visual browser QA.
