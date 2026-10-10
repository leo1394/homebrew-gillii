"""Synthetic APK security and static pipeline regression tests."""
import importlib.util
import io
import json
import os
import stat
import struct
import sys
import tempfile
import unittest
import types
import warnings
import zipfile
from pathlib import Path
from unittest import mock

MODULES = Path(__file__).resolve().parents[1] / 'libexec/providers/apk'
if not MODULES.is_dir():
    MODULES = Path(__file__).resolve().parent
sys.path.insert(0, str(MODULES))
import pipeline
import cclient
import unity_export
from report import write_report, application_name


class APKTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.apk = self.root / 'app.apk'

    def test_application_name_uses_labels_and_rejects_unresolved_resources(self):
        (self.root / 'evidence').mkdir()
        (self.root / 'extracted').mkdir()
        manifest = self.root / 'extracted/AndroidManifest.xml'
        manifest.write_text('<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="@string/app_name" /></manifest>')
        self.assertEqual(application_name(self.root), '')
        manifest.write_text('<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="CClient中控" /></manifest>')
        self.assertEqual(application_name(self.root), 'CClient中控')
        (self.root / 'evidence/metadata.txt').write_text("application-label:'正式名称'\n")
        self.assertEqual(application_name(self.root), '正式名称')

    def tearDown(self):
        self.temporary.cleanup()

    def test_missing_input_cli_error_and_color(self):
        for tty, no_color, term, colored in [(False, False, 'xterm', False), (True, False, 'xterm', True), (True, True, 'xterm', False), (True, False, 'dumb', False)]:
            output = self.root / ('out-' + str(tty) + str(no_color) + term)
            stderr = io.StringIO()
            stderr.isatty = lambda: tty
            env = {'TERM': term}
            if no_color:
                env['NO_COLOR'] = ''
            with mock.patch.dict(os.environ, env, clear=True), mock.patch('sys.stderr', stderr), mock.patch('sys.stdout', io.StringIO()):
                code = pipeline.main(['--input', str(self.apk), '--output', str(output)])
            self.assertEqual(code, 1)
            self.assertIn('APK file not found: ' + str(self.apk.resolve()), stderr.getvalue())
            self.assertEqual('\x1b[1;31m' in stderr.getvalue(), colored)
            self.assertIn('APK file not found:', json.loads((output / 'report.json').read_text())['errors'][0])

    def archive(self, entries=()):
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', UserWarning)
            with zipfile.ZipFile(self.apk, 'w') as archive:
                archive.writestr('AndroidManifest.xml', '<manifest package="example.test"/>')
                for name, value in entries:
                    archive.writestr(name, value)
        return self.apk

    def extract(self):
        destination = self.root / 'extracted'
        destination.mkdir()
        return pipeline.extract_apk(self.apk, destination)

    def test_valid_archive_hashes(self):
        self.archive([('assets/data.txt', b'hello')])
        inventory = self.extract()
        self.assertEqual(len(inventory), 2)
        self.assertTrue(all(row['verified'] for row in inventory))
        self.assertEqual(inventory[1]['sha256'], pipeline.sha256(self.root / 'extracted/assets/data.txt'))

    def test_complete_removes_real_tool_logs_after_preserving_evidence(self):
        self.archive()
        tool = self.root / 'aapt-stub'
        tool.write_text('#!/bin/sh\nprintf "manifest evidence\\n"\n')
        tool.chmod(0o755)
        code, root = pipeline.analyze(self.apk, self.root / 'output', resolver=lambda *a, **k: {'aapt': str(tool)})
        report = json.loads((root / 'report.json').read_text())
        self.assertEqual(code, 0)
        self.assertFalse((root / 'logs').exists())
        self.assertTrue(all(c['log_retained'] is False for c in report['commands']))
        self.assertIn('manifest evidence', (root / 'evidence/manifest.txt').read_text())
        self.assertNotIn('href="logs/execution.log"', (root / 'index.html').read_text())
        self.assertFalse((root / 'evidence/cclient.json').exists())
        self.assertNotIn('cclient', report)
        self.assertFalse(any(stage['name'] == 'cclient' for stage in report['stages']))
        self.assertFalse((root / 'unity-export').exists())
        self.assertFalse((root / 'decompiled').exists())
        self.assertNotIn('<li>unity-export:', (root / 'index.html').read_text())
        self.assertNotIn('<li>decompiled:', (root / 'index.html').read_text())
        self.assertNotIn('<li>logs:', (root / 'index.html').read_text())

    def test_pipeline_cclient_output_requires_recognized_schema(self):
        for recognized in (False, True):
            data = {name: [] for name in cclient.TABLES} if recognized else {'name': 'unrelated app'}
            self.archive([('assets/data.json', json.dumps(data))])
            code, root = pipeline.analyze(self.apk, self.root / str(recognized), resolver=lambda *a, **k: {})
            report = json.loads((root / 'report.json').read_text())
            self.assertEqual((root / 'evidence/cclient.json').exists(), recognized)
            self.assertEqual('cclient' in report, recognized)
            self.assertEqual(any(stage['name'] == 'cclient' for stage in report['stages']), recognized)

    def test_case_colliding_resources_preserved(self):
        self.archive([('res/2I.png', b'upper'), ('res/2i.png', b'lower')])
        inventory = self.extract()
        resources = [row for row in inventory if row['archive_path'].startswith('res/')]
        self.assertEqual(len({row['path'].casefold() for row in resources}), 2)
        for row, content in zip(resources, [b'upper', b'lower']):
            self.assertEqual((self.root / 'extracted' / row['path']).read_bytes(), content)
            self.assertTrue(row['verified'])

    def test_exact_duplicates_still_rejected_by_extraction(self):
        self.archive([('res/a', b'first'), ('res/a', b'second')])
        with self.assertRaises(pipeline.InvalidAPK):
            self.extract()

    def test_unsafe_paths_and_collisions(self):
        cases = [[('../escape', b'bad')], [('/absolute', b'bad')], [('foo\\bar', b'bad')],
                 [('C:/file', b'bad')], [('foo/./bar', b'bad')], [('foo//bar', b'bad')],
                 [('foo.', b'bad')], [('foo\0ignored', b'bad')],
                 [('a', b'a'), ('a', b'b')], [('A', b'a'), ('a', b'b')],
                 [('a', b'a'), ('a/b', b'b')], [('Foo/a', b'a'), ('foo/b', b'b')],
                 [('Foo/', b''), ('foo/b', b'b')], [('caf\u00e9/a', b'a'), ('cafe\u0301/b', b'b')]]
        for entries in cases:
            with self.subTest(entries=entries):
                self.archive(entries)
                with zipfile.ZipFile(self.apk) as archive:
                    # ZipFile.writestr truncates NUL names before serialization.
                    if '\0' in entries[0][0]:
                        entry = archive.infolist()[1]
                        entry.orig_filename = entries[0][0]
                    with self.assertRaises(pipeline.InvalidAPK):
                        pipeline.validate_entries(archive)
        self.assertFalse((self.root / 'escape').exists())

    def test_symlink_rejected(self):
        entry = zipfile.ZipInfo('link')
        entry.create_system = 3
        entry.external_attr = (stat.S_IFLNK | 0o777) << 16
        self.archive([(entry, '../../outside')])
        with self.assertRaises(pipeline.InvalidAPK):
            self.extract()

    def test_limits(self):
        self.archive([('payload', b'x' * 100)])
        for constant, value in [('MAX_ENTRIES', 1), ('MAX_FILE', 50), ('MAX_TOTAL', 60)]:
            with self.subTest(constant=constant), mock.patch.object(pipeline, constant, value):
                with zipfile.ZipFile(self.apk) as archive, self.assertRaises(pipeline.InvalidAPK):
                    pipeline.validate_entries(archive)
        with zipfile.ZipFile(self.apk, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('AndroidManifest.xml', '<manifest/>')
            archive.writestr('bomb', b'0' * 1024 * 1024)
        with zipfile.ZipFile(self.apk) as archive, self.assertRaises(pipeline.InvalidAPK):
            pipeline.validate_entries(archive)

    def test_manifest_required_and_validated(self):
        with zipfile.ZipFile(self.apk, 'w') as archive:
            archive.writestr('arbitrary', b'file')
        with self.assertRaises(pipeline.InvalidAPK):
            self.extract()
        for content in (b'not xml', b'<wrong/>', b'\x03\x00\x08\x00' + struct.pack('<I', 200)):
            manifest = self.root / 'manifest'
            manifest.write_bytes(content)
            with self.assertRaises(pipeline.InvalidAPK):
                pipeline.validate_manifest(manifest)

    def test_failed_run_retains_report_and_original(self):
        self.apk.write_bytes(b'not a zip')
        code, root = pipeline.analyze(self.apk, self.root / 'output', resolver=lambda *a, **k: {})
        self.assertEqual(code, 1)
        report = json.loads((root / 'report.json').read_text())
        self.assertEqual(report['status'], 'failed')
        self.assertTrue(report['logs_retained'])
        self.assertIn('FINISH status=failed', (root / 'logs/execution.log').read_text())
        self.assertEqual((root / 'raw/original.apk').read_bytes(), b'not a zip')
        self.assertTrue((root / 'index.html').is_file())
        with self.assertRaises(FileExistsError):
            pipeline.analyze(self.apk, root)

    def test_missing_tools_partial_and_mixed_detection(self):
        self.archive([('classes.dex', b'dex'), ('classes2.dex', b'dex'),
                      ('assets/bin/Data/Managed/Assembly-CSharp.dll', b'dll'),
                      ('lib/arm64-v8a/libil2cpp.so', b'native'),
                      ('assets/flutter_assets/data', b'flutter')])
        code, root = pipeline.analyze(self.apk, self.root / 'out', resolver=lambda *a, **k: {})
        report = json.loads((root / 'report.json').read_text())
        self.assertEqual(code, 2)
        self.assertTrue(report['logs_retained'])
        self.assertIn('FINISH status=partial', (root / 'logs/execution.log').read_text())
        self.assertEqual(len(report['detected']['dex']), 2)
        self.assertTrue(all(report['detected'][k] for k in ('managed', 'il2cpp', 'flutter', 'native', 'unity')))

    def test_commands_all_dex_and_business_assemblies(self):
        self.archive([('classes.dex', b'dex'), ('classes2.dex', b'dex'),
                      ('assets/bin/Data/Managed/Assembly-CSharp.dll', b'dll'),
                      ('assets/bin/Data/Managed/Vendor.Business.dll', b'dll'),
                      ('assets/bin/Data/Managed/System.dll', b'dll'),
                      ('assets/bin/Data/Managed/UnityEngine.CoreModule.dll', b'dll')])
        tools = {k: '/tools/' + k for k in ('aapt', 'dexdump', 'jadx', 'dotnet', 'ilspy', 'python')}
        def run(runner, stage, argv):
            log = runner.root / 'logs' / (stage + '.log')
            log.write_text('evidence')
            if stage == 'dex-decompile' or stage.startswith('managed-'):
                flag = '-d' if stage == 'dex-decompile' else '-o'
                destination = Path(argv[argv.index(flag) + 1])
                destination.mkdir(parents=True, exist_ok=True)
                (destination / ('Test.java' if flag == '-d' else 'Test.cs')).write_text('source')
            if stage == 'unity-export':
                Path(argv[argv.index('--evidence') + 1]).write_text(json.dumps({'counts': {}, 'unity_versions': [], 'objects': [], 'errors': []}))
            runner.report['commands'].append({'stage': stage, 'argv': argv, 'cwd': str(runner.root), 'returncode': 0})
            runner.report['stages'].append({'name': stage, 'status': 'complete'})
            return True, log
        with mock.patch.object(pipeline.Runner, 'run', run):
            code, root = pipeline.analyze(self.apk, self.root / 'out', resolver=lambda *a, **k: tools)
        report = json.loads((root / 'report.json').read_text())
        commands = report['commands']
        self.assertEqual(code, 0)
        self.assertFalse(report['logs_retained'])
        self.assertIsNone(report['execution_log'])
        self.assertFalse((root / 'logs').exists())
        self.assertTrue((root / 'evidence/manifest.txt').is_file())
        self.assertEqual(sum(c['stage'] == 'dex-decompile' for c in commands), 1)
        self.assertEqual(sum(c['stage'].startswith('dexdump-') for c in commands), 2)
        managed = [c for c in commands if c['stage'].startswith('managed-')]
        self.assertEqual(len(managed), 2)
        self.assertTrue(all('-r' in c['argv'] for c in managed))
        self.assertEqual(sum(a['skipped'] for a in report['assemblies']), 2)
        self.assertIn('/tools/jadx', (root / 'docs/reproduction.md').read_text())

    def test_failed_jadx_keeps_normal_output_and_tries_simple_once(self):
        self.archive([('classes.dex', b'dex')])
        calls = []
        def run(runner, stage, argv):
            calls.append((stage, argv))
            log = runner.root / 'logs' / (stage + '.log')
            log.write_text('ERROR - Method: example.Test.broken():void\nERROR - finished with errors, count: 3\n')
            destination = Path(argv[argv.index('-d') + 1])
            destination.mkdir(parents=True)
            (destination / 'Test.java').write_text(stage)
            ok = stage == 'dex-simple'
            runner.report['stages'].append({'name': stage, 'status': 'complete' if ok else 'partial', 'returncode': 0 if ok else 1, 'log': log.relative_to(runner.root).as_posix()})
            return ok, log
        with mock.patch.object(pipeline.Runner, 'run', run):
            code, root = pipeline.analyze(self.apk, self.root / 'out', resolver=lambda *a, **k: {'jadx': '/tools/jadx'})
        self.assertEqual(code, 2)
        self.assertEqual([c[0] for c in calls], ['dex-decompile', 'dex-simple'])
        self.assertIn('simple', calls[1][1])
        self.assertEqual((root / 'decompiled/java/Test.java').read_text(), 'dex-decompile')
        self.assertEqual((root / 'decompiled/java-simple/Test.java').read_text(), 'dex-simple')
        self.assertTrue((root / 'logs/execution.log').is_file())

        report = json.loads((root / 'report.json').read_text())
        modes = {item['mode']: item for item in report['decompilation']}
        self.assertEqual(modes['normal']['source_files'], 1)
        self.assertEqual(modes['normal']['error_count'], 3)
        self.assertEqual(modes['simple']['source_files'], 1)
        self.assertIn('example.Test.broken', modes['normal']['diagnostics'][0])
        self.assertIn('1 Java files retained', next(stage for stage in report['stages'] if stage['name'] == 'dex-decompile')['error'])

    def test_diagnostic_summary_failure_does_not_discard_report(self):
        self.archive([('classes.dex', b'dex')])
        with mock.patch.object(pipeline, 'summarize_decompilation', side_effect=PermissionError('unreadable diagnostic log')):
            code, root = pipeline.analyze(self.apk, self.root / 'out', resolver=lambda *a, **k: {})
        report = json.loads((root / 'report.json').read_text())
        self.assertEqual(code, 2)
        self.assertIn('unreadable', report['diagnostic_summary_error'])
        self.assertTrue((root / 'index.html').is_file())

    def test_successful_tools_without_source_are_partial(self):
        self.archive([('classes.dex', b'dex'), ('assets/Managed/Business.dll', b'dll')])
        tools = {k: '/tools/' + k for k in ('aapt', 'dexdump', 'jadx', 'dotnet', 'ilspy')}
        def run(runner, stage, argv):
            log = runner.root / 'logs' / (stage + '.log')
            log.write_text('tool claims success')
            runner.report['stages'].append({'name': stage, 'status': 'complete'})
            return True, log
        with mock.patch.object(pipeline.Runner, 'run', run):
            code, root = pipeline.analyze(self.apk, self.root / 'out', resolver=lambda *a, **k: tools)
        report = json.loads((root / 'report.json').read_text())
        self.assertEqual(code, 2)
        stages = {s['name']: s['status'] for s in report['stages']}
        self.assertEqual(stages['dex-output'], 'partial')
        self.assertEqual(stages['managed-output-Business.dll'], 'partial')

    def test_crc_corruption_is_failed(self):
        self.archive([('payload', b'content')])
        with zipfile.ZipFile(self.apk) as archive:
            entry = archive.getinfo('payload')
            offset = entry.header_offset + 30 + len(entry.filename.encode()) + len(entry.extra)
        data = bytearray(self.apk.read_bytes())
        data[offset] ^= 1
        self.apk.write_bytes(data)
        code, root = pipeline.analyze(self.apk, self.root / 'out', resolver=lambda *a, **k: {})
        self.assertEqual(code, 1)
        self.assertIn('CRC', json.loads((root / 'report.json').read_text())['errors'][0])

    def test_timeout_and_nonzero_recorded(self):
        root = self.root / 'run'
        (root / 'logs').mkdir(parents=True)
        report = {'commands': [], 'stages': []}
        runner = pipeline.Runner(root, report, timeout=0.05)
        ok, log = runner.run('timeout', [sys.executable, '-c', 'import time; time.sleep(10)'])
        self.assertFalse(ok)
        self.assertEqual(report['commands'][0]['returncode'], 124)
        ok, log = runner.run('failure', [sys.executable, '-c', 'raise SystemExit(7)'])
        self.assertFalse(ok)
        self.assertEqual(report['commands'][1]['returncode'], 7)

    def test_offline_escaped_html(self):
        payload = '</pre><script src="https://host.invalid/x">alert(1)</script>'
        write_report(self.root, {'status': 'partial', 'error': payload, 'commands': []})
        document = (self.root / 'index.html').read_text()
        self.assertNotIn('<script src=', document)
        self.assertNotIn(payload, document)
        self.assertIn('default-src', document)
        self.assertIn("script-src 'sha256-", document)
        self.assertIn('id="report-language"', document)
        self.assertIn('data-zh="下一步调查"', document)
        self.assertEqual(json.loads((self.root / 'report.json').read_text())['error'], payload)

    def test_workbench_maps_declared_entrypoints_to_exact_source_paths(self):
        manifest = self.root / 'extracted/AndroidManifest.xml'
        manifest.parent.mkdir()
        manifest.write_text('<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="example.test"><application android:name=".App"><activity android:name=".MainActivity"/><activity-alias android:name=".Launcher" android:targetActivity=".MainActivity"/><service android:name="elsewhere.Sync"/></application></manifest>')
        source = self.root / 'decompiled/java/example/test'
        source.mkdir(parents=True)
        (source / 'MainActivity.java').write_text('class MainActivity {}')
        (source / 'App.java').write_text('class App {}')
        (source / 'Other.java').write_text('class Other {}')
        (source / 'Launcher.java').write_text('class Launcher {}')
        fallback = self.root / 'decompiled/java-simple/elsewhere'
        fallback.mkdir(parents=True)
        (fallback / 'Sync.kt').write_text('class Sync')
        write_report(self.root, {'status': 'partial', 'commands': [], 'detected': {'dex': ['classes.dex'], 'native': ['lib/arm64/libx.so']}})
        work = json.loads((self.root / 'report.json').read_text())['workbench']
        entries = {entry['qualifiedName']: entry for entry in work['entrypoints']}
        self.assertEqual(entries['example.test.MainActivity']['sourcePaths'], ['decompiled/java/example/test/MainActivity.java'])
        self.assertEqual(entries['example.test.App']['mapping'], 'filename-match')
        self.assertEqual(entries['example.test.Launcher']['targetQualifiedName'], 'example.test.MainActivity')
        self.assertEqual(entries['example.test.Launcher']['sourcePaths'], ['decompiled/java/example/test/MainActivity.java'])
        self.assertEqual(entries['elsewhere.Sync']['sourcePaths'], ['decompiled/java-simple/elsewhere/Sync.kt'])
        self.assertEqual([group['kind'] for group in work['payloadGroups']], ['dex', 'native'])
        self.assertIn('MainActivity', (self.root / 'docs/rebuild.md').read_text())
        document = (self.root / 'index.html').read_text()
        self.assertIn('data-source-path="decompiled/java/example/test/MainActivity.java"', document)
        self.assertIn('connect-src \'self\'', document)
        self.assertIn('Find in file', document)

    def test_workbench_ignores_symlinks_and_caps_inventory(self):
        source = self.root / 'decompiled/java'
        source.mkdir(parents=True)
        for index in range(3):
            (source / ('File' + str(index) + '.java')).write_text('class File {}')
        outside = self.root / 'outside.java'
        outside.write_text('secret')
        (source / 'Link.java').symlink_to(outside)
        manifest = self.root / 'extracted/AndroidManifest.xml'
        manifest.parent.mkdir()
        manifest.symlink_to(outside)
        with mock.patch('workbench.MAX_SOURCES', 2):
            write_report(self.root, {'status': 'partial', 'commands': []})
        work = json.loads((self.root / 'report.json').read_text())['workbench']
        self.assertEqual(len(work['sourceFiles']), 2)
        self.assertTrue(work['sourceTruncated'])
        self.assertEqual(work['entrypoints'], [])
        self.assertNotIn('Link.java', [item['path'] for item in work['sourceFiles']])

    def test_workbench_reads_aapt_manifest_when_extracted_manifest_is_binary(self):
        evidence = self.root / 'evidence'
        evidence.mkdir()
        (evidence / 'manifest.txt').write_text('E: manifest\n  A: package="example.test"\n  E: application\n    E: activity\n      A: android:name=".Main"\n    E: activity-alias\n      A: android:name=".Launcher"\n      A: android:targetActivity=".Main"\n')
        source = self.root / 'decompiled/java/example/test'
        source.mkdir(parents=True)
        (source / 'Main.java').write_text('class Main {}')
        write_report(self.root, {'status': 'partial', 'commands': []})
        entries = json.loads((self.root / 'report.json').read_text())['workbench']['entrypoints']
        entry = entries[0]
        self.assertEqual(entry['qualifiedName'], 'example.test.Main')
        self.assertEqual(entry['evidence'], 'evidence/manifest.txt:4')
        self.assertEqual(entries[1]['qualifiedName'], 'example.test.Launcher')
        self.assertEqual(entries[1]['targetQualifiedName'], 'example.test.Main')
        self.assertEqual(entries[1]['sourcePaths'], ['decompiled/java/example/test/Main.java'])

    def test_investigation_distinguishes_artifacts_identification_and_runtime(self):
        report = {'status': 'partial', 'commands': [],
                  'detected': {'dex': ['classes.dex'], 'native': ['lib/a/libunity.so'], 'unity': True},
                  'assemblies': [{'path': 'Managed/Game.dll', 'output': 'decompiled/managed/Game', 'status': 'complete'}],
                  'stages': [{'name': 'dex', 'status': 'partial', 'error': 'missing tool'}]}
        write_report(self.root, report)
        result = json.loads((self.root / 'report.json').read_text())['investigation']
        self.assertEqual(result['evidence'][0]['evidence'], 'local-observed')
        self.assertEqual(result['evidence'][-1]['evidence'], 'static-inferred')
        self.assertEqual(result['relationships'][0]['to'], 'decompiled/managed/Game')
        self.assertEqual(result['nextSteps'][0]['reason'], 'missing tool')
        self.assertEqual(result['nextSteps'][-1]['evidence'], 'unverified')
        self.assertIn('Investigation next steps', (self.root / 'index.html').read_text())

    def test_report_language_uses_system_preference_and_english_fallback(self):
        from report import system_language
        with mock.patch('report.sys.platform', 'darwin'), mock.patch('report.subprocess.run', return_value=types.SimpleNamespace(returncode=0, stdout='(\n "zh-Hans-CN",\n "en-CN"\n)')):
            self.assertEqual(system_language(), 'zh')
        with mock.patch('report.sys.platform', 'linux'), mock.patch.dict(os.environ, {'LANG': 'fr_FR.UTF-8'}, clear=True):
            self.assertEqual(system_language(), 'en')
        with mock.patch('report.sys.platform', 'linux'), mock.patch.dict(os.environ, {'LC_ALL': 'zh_CN.UTF-8'}, clear=True):
            self.assertEqual(system_language(), 'zh')

    def test_cclient_schema_and_reference_audit(self):
        directory = self.root / 'project'
        directory.mkdir()
        data = {'SocketHosts': [{'Id': 1}], 'Views': [{'Id': 1, 'ParentId': 0}], 'Macros': [],
                'RelayCommands': [], 'QueryCommands': [], 'TglGroups': [],
                'Actions': [{'ActionType': 1, 'SocketHostId': 2, 'CmdRefId': 3}]}
        (directory / 'data.json').write_text(json.dumps(data))
        result = cclient.analyze(self.root, self.root / 'cclient.json')
        self.assertEqual(len(result['projects']), 1)
        self.assertEqual(len(result['issues']), 2)
        self.assertEqual(result['errors'], [])
        data['Views'] = 'invalid'
        (directory / 'data.json').write_text(json.dumps(data))
        result = cclient.analyze(self.root, self.root / 'cclient.json')
        self.assertTrue(result['errors'])

    def test_unity_empty_input_is_partial(self):
        with mock.patch.dict(sys.modules, {'UnityPy': types.SimpleNamespace()}):
            code = unity_export.export(self.root, self.root / 'unity-export', self.root / 'unity.json')
        self.assertEqual(code, 2)
        self.assertEqual(json.loads((self.root / 'unity.json').read_text())['errors'][0]['phase'], 'discovery')

    def test_generated_tree_patch_is_pinned_and_header_verified(self):
        child = types.SimpleNamespace(m_Level=1, m_Type='UInt8', m_Name='m_Enabled', m_MetaFlag=0)
        nodes = types.SimpleNamespace(traverse=lambda: [child])
        pointer = types.SimpleNamespace(m_FileID=0, m_PathID=12)
        head = types.SimpleNamespace(m_GameObject=pointer, m_Script=pointer, m_Name='name', m_Enabled=1)
        tree = {'m_GameObject': {'m_FileID': 0, 'm_PathID': 12},
                'm_Script': {'m_FileID': 0, 'm_PathID': 12}, 'm_Name': 'name', 'm_Enabled': 1}
        obj = mock.Mock()
        obj.parse_monobehaviour_head.return_value = head
        obj.generate_monobehaviour_node.return_value = nodes
        obj.read_typetree.return_value = tree
        factory = mock.Mock()
        factory.from_list.side_effect = lambda fields: fields
        module = types.SimpleNamespace(TypeTreeNode=factory)
        with mock.patch.dict(sys.modules, {'UnityPy.helpers.TypeTreeNode': module}):
            result, patched = unity_export.verified_tree(obj, '0.0.10')
            self.assertTrue(patched)
            self.assertEqual(factory.from_list.call_args.args[0][0]['m_MetaFlag'], 0x4000)
            factory.reset_mock()
            result, patched = unity_export.verified_tree(obj, '0.0.11')
            self.assertFalse(patched)
            factory.from_list.assert_not_called()
            tree['m_Name'] = 'wrong'
            with self.assertRaisesRegex(ValueError, 'header verification failed'):
                unity_export.verified_tree(obj, '0.0.11')

    def test_generic_managed_and_extension_names_do_not_trigger_unity(self):
        folder = self.root / 'assets/Managed'
        folder.mkdir(parents=True)
        (folder / 'Business.dll').write_bytes(b'managed')
        for name in ('data.bundle', 'data.assets', 'level0', 'globalgamemanagers'):
            (self.root / name).write_bytes(b'ordinary unrelated data')
        detected = pipeline.detect(self.root)
        self.assertTrue(detected['managed'])
        self.assertFalse(detected['unity'])
        self.assertEqual(detected['unity_inputs'], [])

    def test_serialized_unity_header_without_special_filename(self):
        source = self.root / 'unknown.dat'
        source.write_bytes(struct.pack('>IIII', 4, 32, 17, 24) + bytes(16))
        self.assertIn(source, list(unity_export.candidates(self.root)))
        source.write_bytes(struct.pack('>IIII', 0, 0, 22, 0) + bytes(4) + struct.pack('>IQQQ', 4, 64, 52, 0) + bytes(16))
        self.assertIn(source, list(unity_export.candidates(self.root)))

    def test_unrelated_json_does_not_pollute_cclient_audit(self):
        for name, value in [('good', {k: [] for k in cclient.TABLES}), ('unrelated', {'Views': [], 'SocketHosts': [], 'Macros': []}), ('broken', None)]:
            folder = self.root / name
            folder.mkdir()
            (folder / 'data.json').write_text(json.dumps(value) if value is not None else '{invalid')
        result = cclient.analyze(self.root)
        self.assertEqual(len(result['projects']), 1)
        self.assertEqual(len(result['skipped']), 2)
        self.assertEqual(result['errors'], [])

    def test_unity_generic_candidates_and_safe_names(self):
        source = self.root / 'renamed.data'
        source.write_bytes(b'UnityFS\0rest')
        self.assertIn(source, list(unity_export.candidates(self.root)))
        self.assertTrue(pipeline.detect(self.root)['unity'])
        self.assertNotIn('/', unity_export.safe('../../evil'))
        self.assertTrue(unity_export.safe('...'))


if __name__ == '__main__':
    unittest.main()
