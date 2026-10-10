import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import concurrent.futures
import subprocess
import time
import unittest
from unittest.mock import patch
import zipfile

MODULE = Path(__file__).resolve().parents[1] / 'libexec/providers/apk/deps.py'
spec = importlib.util.spec_from_file_location('apk_deps', MODULE)
deps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deps)


class DependencyTests(unittest.TestCase):
    def test_offline_download_requires_matching_checksum(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            content = b'pinned bytes'
            digest = hashlib.sha256(content).hexdigest()
            spec = {'url': 'https://example.invalid/tool', 'hash': digest}
            cached = root / (digest + '.zip')
            cached.write_bytes(content)
            self.assertEqual(deps._download(spec, root, True), cached)
            cached.write_bytes(b'corrupted')
            with self.assertRaisesRegex(RuntimeError, 'offline'):
                deps._download(spec, root, True)

    def test_network_checksum_mismatch_does_not_promote_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            spec = {'url': 'https://example.invalid/tool', 'hash': '0' * 64}
            with patch.object(deps.urllib.request, 'urlopen', return_value=io.BytesIO(b'wrong')):
                with self.assertRaisesRegex(RuntimeError, 'checksum'):
                    deps._download(spec, Path(temporary), False)
            self.assertEqual(list(Path(temporary).iterdir()), [])

    def test_changed_install_is_rebuilt(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / 'tool'
            calls = []
            def build(directory):
                calls.append(True)
                (directory / 'executable').write_text('good')
            deps._install(target, build)
            deps._install(target, build)
            self.assertEqual(len(calls), 1)
            (target / 'executable').write_text('corrupted')
            deps._install(target, build)
            self.assertEqual(len(calls), 2)
            self.assertEqual((target / 'executable').read_text(), 'good')

    def test_zip_path_traversal_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / 'tool.zip'
            with zipfile.ZipFile(archive, 'w') as bundle:
                bundle.writestr('../outside', 'bad')
            with self.assertRaisesRegex(RuntimeError, 'unsafe'):
                deps._extract(archive, root / 'install')
            self.assertFalse((root / 'outside').exists())

    def test_missing_offline_tool_is_partial_and_override_survives(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tool = root / 'aapt'
            tool.write_text('#!/bin/sh\nexit 0\n')
            tool.chmod(0o755)
            with patch.dict(os.environ, {'GILLII_APK_CACHE': str(root / 'cache'),
                                         'GILLII_APK_AAPT': str(tool)}, clear=True):
                with patch.object(deps, '_android', return_value=None), patch.object(deps.shutil, 'which', return_value=None):
                    result = deps.resolve_tools({'android'}, offline=True)
            self.assertEqual(result['aapt'], str(tool.absolute()))
            self.assertIn('dexdump', result['metadata']['errors'])
            self.assertIn('jadx', result['metadata']['errors'])
            self.assertNotIn('python', result)
            self.assertNotIn('dotnet', result)

    def test_java_version_requires_11_or_later(self):
        with patch.object(deps.shutil, 'which', return_value='/usr/bin/java'):
            for version, accepted in [('1.8.0_400', False), ('11.0.24', True), ('21.0.2', True)]:
                process = subprocess.CompletedProcess([], 0, '', 'openjdk version "' + version + '"')
                with patch.object(deps.subprocess, 'run', return_value=process):
                    if accepted:
                        self.assertIn(version, deps._java_version())
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'Java 11'):
                            deps._java_version()

    def test_concurrent_install_builds_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / 'tool'
            calls = []
            def build(directory):
                calls.append(True)
                time.sleep(0.1)
                (directory / 'executable').write_text('good')
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda _: deps._install(target, build), range(2)))
            self.assertEqual(results, [target, target])
            self.assertEqual(len(calls), 1)
            self.assertTrue(deps._valid(target))

    def test_relative_cache_root_is_absolute(self):
        with patch.dict(os.environ, {'GILLII_APK_CACHE': './relative-cache'}):
            result = deps.resolve_tools(set())
        self.assertTrue(Path(result['metadata']['cache']).is_absolute())
        self.assertTrue(Path(result['metadata']['cache']).is_relative_to(Path.cwd() / 'relative-cache'))

    def test_python_override_preserves_virtualenv_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            python = root / 'python'
            python.symlink_to(os.sys.executable)
            with patch.dict(os.environ, {'GILLII_APK_PYTHON': str(python)}, clear=True), patch.object(deps, '_tool_versions'):
                result = deps.resolve_tools({'unity'}, offline=True)
            self.assertEqual(result['python'], str(python.absolute()))
            self.assertNotEqual(result['python'], str(python.resolve()))

    def test_empty_profile_does_not_prepare_tools(self):
        with patch.object(deps, '_install', side_effect=AssertionError('unexpected install')):
            self.assertEqual(set(deps.resolve_tools(set())), {'metadata'})


if __name__ == '__main__':
    unittest.main()
