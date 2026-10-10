# Third-party code

`libexec/tools/wxappUnpacker` is vendored from https://github.com/cqg21/wxappUnpacker,
commit `f5f0a5d9aaf082654ba46d05ae099e7725cf8727`, licensed GPL-3.0-or-later.
Original source and license are retained. npm dependencies remain governed by
their respective licenses and are pinned by package-lock.json.
The Shell wrapper and recovery helpers are distributed under GPL-3.0-or-later.

## APK tools downloaded at runtime

The APK helper uses external tools selected by `libexec/apk/toolchain-lock.json`.
They are cached on the user's machine, not vendored in the Gillii release archive.
The versions and checksum sources below describe that lock; user overrides may
select different versions. Upstream notices and transitive licenses continue to
apply independently of Gillii's GPL-3.0-or-later license.

| Component | Locked version | Upstream and license provenance |
| --- | --- | --- |
| Android SDK Build Tools (`aapt`, `dexdump`) | 35.0.0 | Google [SDK distribution terms](https://developer.android.com/studio/terms) and the licenses/notices in the downloaded SDK archive. Do not assume the complete binary distribution shares a single AOSP license. |
| JADX | 1.5.3 | [skylot/jadx](https://github.com/skylot/jadx), [Apache-2.0](https://github.com/skylot/jadx/blob/master/LICENSE). |
| ILSpy / ilspycmd | 9.1.0.7988 | [icsharpcode/ILSpy](https://github.com/icsharpcode/ILSpy), [MIT and third-party notices](https://github.com/icsharpcode/ILSpy/blob/master/doc/ILSpyAboutPage.txt). Distributed via NuGet. |
| .NET runtime | 8.0.20 | [dotnet/runtime](https://github.com/dotnet/runtime/tree/v8.0.20), [MIT](https://github.com/dotnet/runtime/blob/v8.0.20/LICENSE.TXT) and bundled third-party notices. macOS arm64 bundles are downloaded from NuGet; other supported hosts use official Microsoft runtime archives. |
| UnityPy | 1.25.3 | [K0lb3/UnityPy](https://github.com/K0lb3/UnityPy), [MIT](https://github.com/K0lb3/UnityPy/blob/master/LICENSE). Distributed via PyPI. |
| TypeTreeGeneratorAPI | 0.0.10 | [UnityPy-Org/TypeTreeGeneratorAPI](https://github.com/UnityPy-Org/TypeTreeGeneratorAPI), [MIT package metadata](https://pypi.org/project/TypeTreeGeneratorAPI/0.0.10/). Distributed via PyPI. |

The lock also records pinned Python dependencies: archspec, astc_encoder_py,
attrs, brotli, dnfile, etcpak, fmod_toolkit, fsspec, lz4, Markdown, pefile, pillow,
pyfmodex, texture2ddecoder and tpk_ar. Their own package metadata and license files
are authoritative; UnityPy's MIT license does not relicense these dependencies.
Java and Python runtimes supplied by the user are not redistributed by Gillii.

Android archives are verified against the SHA-1 published in Google's SDK
repository XML; JADX uses the upstream release SHA-256. ILSpy and .NET SHA-256
values were recorded from the original NuGet bundles used by the CClient
reference workflow. Other supported .NET runtime archives use SHA-512 values
from Microsoft release metadata. Python wheel hashes are checked against the pinned version's
PyPI metadata at setup time. The lock links the checksum sources; it does not
claim all checksums were independently published upstream.
