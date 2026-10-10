"""Static mapping and conservative control-flow regressions."""
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'libexec/providers/apk'))
from dart_aot import lift_instruction, enrich, symbol_evidence
from dart_flow import analyze


def rows(instructions):
    return [lift_instruction('// ' + address + ': ' + instruction, number + 1) for number, (address, instruction) in enumerate(instructions)]


class DartFlowTests(unittest.TestCase):
    def test_mapping_keeps_shared_stub_and_alias_distinct(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); path = root / 'decompiled/dart/ida_script'; path.mkdir(parents=True)
            (path / 'addNames.py').write_text('\n'.join([
                'idaapi.set_name(0x2000, "lib_C::foo_1000_check")',
                'idaapi.set_name(0x3000, "lib_C::foo_1000_check")',
                'idaapi.set_name(0x3000, "lib_C::bar_4000_check")',
                'idaapi.set_name(0x3000, "UnknownDartCodeStub_3000")',
                'ida_funcs.add_func(0x3000, 0x3020)',
                '__import__("os").system("touch /tmp/never-run-gillii")']))
            symbols, ranges, pool = symbol_evidence(root)
            records = [{'address': '0x1000', 'name': 'foo', 'assembly_available': True, 'file': 'foo.dart', 'line': 1,
                        'calls': [{'address': address, 'line': 2} for address in ('0x2000', '0x3000', '0x3010', '0x9999')], 'indirect_calls': []}]
            graph = enrich(records, symbols, ranges)
            self.assertEqual([edge['resolution'] for edge in graph['edges']], ['entry_alias', 'runtime_stub', 'unknown', 'unknown'])
            self.assertEqual(graph['resolved_edges'], 0)
            self.assertEqual(graph['symbol_resolved_edges'], 2)
            self.assertEqual(graph['body_resolved_edges'], 0)
            self.assertEqual(records[0]['called_by'][0]['target'], '0x2000')
            self.assertEqual(next(node for node in graph['nodes'] if node['address'] == '0x3000')['alias_count'], 3)

    def test_anonymous_export_patch_is_inert_and_bounded(self):
        import deps
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); path = root / 'blutter/src'; path.mkdir(parents=True)
            source = path / 'DartDumper.cpp'
            source.write_text('void DartDumper::DumpCode(const char* out_dir)\n{\n}\n')
            deps._patch_blutter_exports(root)
            text = source.read_text()
            self.assertIn('app.nativeLib.topClass->Functions()', text)
            self.assertIn('256 * 1024', text)
            self.assertIn('_snapshot_raw_{}.dart', text)
            self.assertNotIn('asm2il', text)
            source.write_text('unexpected')
            with self.assertRaises(RuntimeError):
                deps._patch_blutter_exports(root)

    def test_generated_workbench_javascript_is_valid(self):
        import re
        import subprocess
        from report import write_report
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_report(root, {'status': 'partial', 'detected': {'flutter': ['libapp.so']}})
            scripts = re.findall(r'<script>(.*?)</script>', (root / 'index.html').read_text(), re.S)
            self.assertTrue(scripts)
            for number, script in enumerate(scripts):
                path = root / ('script' + str(number) + '.js'); path.write_text(script)
                result = subprocess.run(['node', '--check', str(path)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_diamond_phi_and_register_aliases(self):
        flow = analyze(rows([
            ('0x1000', 'cbz x0, #0x1010'), ('0x1004', 'mov w1, #1'), ('0x1008', 'b #0x1020'),
            ('0x1010', 'mov x1, #2'), ('0x1014', 'b #0x1020'), ('0x1020', 'add x2, x1, #3'), ('0x1024', 'ret')]))
        self.assertTrue(flow['complete'])
        self.assertEqual(flow['regions'][0]['kind'], 'if')
        join = next(block for block in flow['blocks'] if block['id'] == '0x1020')
        self.assertEqual(set(join['phis']['x1'].values()), {'x1@0x1004', 'x1@0x1010'})
        self.assertEqual(flow['ssa'][-2]['uses']['x1'], 'x1@phi:0x1020')

    def test_dart_stack_alias_is_distinct_from_native_stack(self):
        row = lift_instruction('// 0x1000: add x0, SP, #8', 1)
        self.assertEqual(row['uses'], ['x15'])
        self.assertEqual(lift_instruction('// 0x1004: mov x0, sp', 2)['uses'], ['sp'])
        self.assertEqual(lift_instruction('// 0x1008: ldr x0, [PP, #0x18]', 3)['uses'], ['x27'])
        self.assertIn('x24', lift_instruction('// 0x100c: bl #0x2000', 4)['defs'])

    def test_loop_has_exit_and_loop_carried_phi(self):
        flow = analyze(rows([('0x1000', 'mov x1, #0'), ('0x1004', 'cmp x1, #10'), ('0x1008', 'b.ge #0x1020'),
                             ('0x100c', 'add x1, x1, #1'), ('0x1010', 'b #0x1004'), ('0x1020', 'ret')]))
        loop = next(region for region in flow['regions'] if region['kind'] == 'loop')
        self.assertEqual(loop['exits'], ['0x1020'])
        self.assertIn('while (true)', loop['text'])
        self.assertIn('break;', loop['text'])
        self.assertIn('continue;', loop['text'])
        self.assertIn('x1', next(block for block in flow['blocks'] if block['id'] == '0x1004')['phis'])

    def test_switch_equality_chain_and_unresolved_branch(self):
        flow = analyze(rows([('0x1000', 'cmp x0, #1'), ('0x1004', 'b.eq #0x1020'),
                             ('0x1008', 'cmp x0, #2'), ('0x100c', 'b.eq #0x1024'),
                             ('0x1010', 'br x9'), ('0x1020', 'ret'), ('0x1024', 'ret')]))
        switch = next(region for region in flow['regions'] if region['kind'] == 'switch')
        self.assertEqual(switch['default'], '0x1010')
        self.assertEqual([case['value'] for case in switch['cases']], ['1', '2'])
        self.assertEqual(next(block for block in flow['blocks'] if block['id'] == '0x1010')['successors'], [])
        self.assertFalse(analyze(rows([('0x1000', 'ret')]), truncated=True)['complete'])

    def test_opaque_instruction_clobbers_prior_register_values(self):
        flow = analyze(rows([('0x1000', 'mov x1, #3'), ('0x1004', 'unknown x9'), ('0x1008', 'mov x0, x1'), ('0x100c', 'ret')]))
        self.assertEqual(flow['ssa'][2]['uses']['x1'], 'x1@0x1004')
        self.assertTrue(flow['ssa'][1]['opaque'])


if __name__ == '__main__':
    unittest.main()
