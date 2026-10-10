"""Flutter adapter and lazy capability preparation regression tests."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'libexec/providers/apk'))
import deps
import flutter
from workbench import workbench


class FlutterTests(unittest.TestCase):
    def test_profiles_never_prepare_flutter_for_other_payloads(self):
        with patch.object(deps, '_blutter') as prepare, patch.object(deps, '_android', return_value='/local/tool'), patch.object(deps, '_tool_versions'):
            deps.resolve_tools('basic', offline=True)
            prepare.assert_not_called()
        with patch.object(deps, '_blutter', return_value=('/isolated/python', '/cache/blutter.py')) as prepare, patch.object(deps, '_tool_versions'):
            result = deps.resolve_tools('flutter', offline=True)
            prepare.assert_called_once()
            self.assertEqual(result['flutter_python'], '/isolated/python')
            self.assertNotIn('jadx', result)
            self.assertNotIn('python', result)  # Unity dependencies stay isolated.

    def test_only_arm64_elf_pair_is_eligible(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base = root / 'extracted/lib/arm64-v8a'
            base.mkdir(parents=True)
            header = bytearray(20); header[:6] = b'\x7fELF\x02\x01'; header[18:20] = (183).to_bytes(2, 'little')
            (base / 'libflutter.so').write_bytes(header)
            self.assertIsNone(flutter.aot_input(root))
            (base / 'libapp.so').write_bytes(header)
            self.assertEqual(flutter.aot_input(root), base)
            (base / 'libapp.so').unlink()
            (base / 'libapp.so').symlink_to(base / 'libflutter.so')
            self.assertIsNone(flutter.aot_input(root))

    def test_index_has_evidence_locations_and_direct_calls(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); (root / 'evidence').mkdir()
            asm = root / 'decompiled/dart/asm'; asm.mkdir(parents=True)
            (asm / 'business.dart').write_text('  dynamic submit() {\n    // ** addr: 0x1234, size: 0x20\n    // 0x1238: bl #0x5678\n  }\n')
            result = flutter.index_output(root)
            self.assertEqual(result['function_count'], 1)
            data = json.loads((root / result['evidence']).read_text())
            self.assertEqual(data['functions'][0]['line'], 1)
            self.assertEqual(data['functions'][0]['calls'][0]['address'], '0x5678')
            self.assertIn('not recovered', data['scope'])
            (asm / 'declaration.dart').write_text('  void hidden() {\n    // ** addr: 0x5678, size: -0x1\n  }\n')
            flutter.index_output(root)
            data = json.loads((root / result['evidence']).read_text())
            declaration = next(item for item in data['functions'] if item['address'] == '0x5678')
            self.assertFalse(declaration['assembly_available'])
            java = root / 'decompiled/java'; java.mkdir()
            (java / 'Main.java').write_text('class Main {}')
            files = {item['path'] for item in workbench(root, {})['sourceFiles']}
            self.assertIn('decompiled/java/Main.java', files)
            self.assertTrue(all(item['file'] in files for item in data['functions']))

    def test_callgraph_reverse_tail_indirect_and_pseudocode(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); (root / 'evidence').mkdir()
            asm = root / 'decompiled/dart/asm'; asm.mkdir(parents=True)
            (asm / 'flow.dart').write_text('\n'.join([
                '  void caller() {', '    // ** addr: 0x1000, size: 0x40',
                '    // 0x1000: r0 = 3', '    // 0x1000: branch IfSmi(r0, 0x1014)', '    // 0x1000: r3 as int',
                '    //     0x1000: mov x0, #3',
                '    //     0x1004: cmp x0, x1',
                '    //     0x1008: cbz x0, #0x1014',
                '    //     0x100c: bl #0x2000 ; business target',
                '    //     0x1010: blr x9',
                '    //     0x1014: b #0x101c',
                '    //     0x1018: stur w0, [x1, #-4]',
                '    //     0x101c: unknown x2',
                '    //     0x1020: b #0x3000', '  }',
                '  void target() {', '    // ** addr: 0x2000, size: 0x8',
                '    //     0x2000: ldr x0, [PP, #0x18]',
                '    //     0x2004: ret', '  }',
                '  void declaration() {', '    // ** addr: 0x3000, size: -0x1', '  }']))
            result = flutter.index_output(root)
            data = json.loads((root / result['evidence']).read_text())
            caller, target, declaration = data['functions']
            self.assertEqual([call['kind'] for call in caller['calls']], ['direct', 'tail'])
            self.assertEqual(target['called_by'][0]['source'], '0x1000')
            self.assertEqual(declaration['called_by'][0]['kind'], 'tail')
            self.assertEqual(caller['indirect_calls'][0]['register'], 'x9')
            pseudo = caller['pseudocode']
            self.assertEqual(len(pseudo), 9)  # annotation is not a machine instruction
            self.assertEqual(pseudo[0]['text'], 'x0 = 3;')
            self.assertEqual(pseudo[0]['line'], 6)
            self.assertIn('goto L_1014', pseudo[2]['text'])
            self.assertIn('store_u32(x1 + (-4), w0)', pseudo[6]['text'])
            self.assertFalse(pseudo[7]['lifted'])
            self.assertTrue(pseudo[7]['text'].startswith('asm('))
            self.assertEqual(pseudo[-1]['text'], 'tail_call_at(0x3000);')
            self.assertEqual(declaration['pseudocode'], [])
            graph = json.loads((root / result['callgraph']).read_text())
            self.assertEqual(len(graph['edges']), 2)
            self.assertTrue(all(edge['resolved'] for edge in graph['edges']))
            self.assertEqual(graph['unresolved_indirect_calls'], 1)
            self.assertEqual(result['pseudocode_functions'], 2)

    def test_formula_only_requires_node_at_install(self):
        formula = (Path(__file__).resolve().parents[1] / 'Formula/gillii.rb').read_text()
        self.assertNotIn('depends_on "python', formula)
        self.assertNotIn('depends_on "openjdk', formula)
        self.assertNotIn('depends_on "capstone', formula)


if __name__ == '__main__':
    unittest.main()
