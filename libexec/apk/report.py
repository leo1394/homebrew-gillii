"""Offline, escaped reports for static APK analysis."""
import html
import json
import shlex
from pathlib import Path


def write_report(root, report):
    root = Path(root)
    (root / 'docs').mkdir(exist_ok=True)
    payload = json.dumps(report, ensure_ascii=True, indent=2)
    (root / 'report.json').write_text(payload + '\n', encoding='utf-8')
    title = 'APK static analysis: ' + report.get('status', 'failed')
    escape = lambda value: html.escape(str(value), quote=True)
    stages = ''.join('<tr><td>' + escape(stage['name']) + '</td><td>' + escape(stage['status'])
                     + '</td><td>' + escape(stage.get('error') or '') + '</td></tr>'
                     for stage in report.get('stages', []))
    links = [('logs/execution.log', 'Execution log'), ('report.json', 'Machine-readable report'), ('docs/reproduction.md', 'Reproduction commands'),
             ('evidence/files.json', 'Verified APK file inventory'), ('evidence/manifest.txt', 'Android manifest'),
             ('evidence/metadata.txt', 'Package metadata'), ('evidence/unity-objects.json', 'Unity object coverage'),
             ('evidence/cclient.json', 'CClient configuration audit')]
    navigation = ''.join('<li><a href="' + escape(path) + '">' + escape(label) + '</a></li>'
                         for path, label in links if path == 'docs/reproduction.md' or (root / path).is_file())
    directories = ''.join('<li>' + escape(name) + ': ' + str(sum(1 for p in (root / name).rglob('*') if p.is_file()))
                          + ' files</li>' for name in ('raw', 'extracted', 'decompiled', 'unity-export', 'logs')
                          if (root / name).is_dir())
    document = ('<!doctype html><html lang="en"><meta charset="utf-8">'
                '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
                'style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">'
                '<meta name="viewport" content="width=device-width,initial-scale=1">'
                '<title>' + html.escape(title) + '</title>'
                '<style>body{font:16px system-ui;max-width:1100px;margin:3em auto;padding:0 1em}'
                'table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.6em;border-bottom:1px solid #ddd}a{color:#155cb0}'
                'pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f4f6;padding:1em}'
                '</style><h1>' + html.escape(title) + '</h1>'
                '<p>Static evidence only. No application code was executed. Decompiled source '
                'is an approximation and does not guarantee a buildable original project.</p>'
                '<p>All evidence is local. See report.json, logs/, evidence/ and docs/reproduction.md.</p>'
                '<p><b>Input:</b> ' + escape(report.get('input', '')) + '</p>'
                '<p><b>SHA-256:</b> <code>' + escape(report.get('input_sha256', 'unavailable')) + '</code></p>'
                '<h2>Evidence</h2><ul>' + navigation + '</ul><h2>Outputs</h2><ul>' + directories + '</ul>'
                '<h2>Stages</h2><table><tr><th>Stage</th><th>Status</th><th>Issue</th></tr>' + stages + '</table>'
                '<details><summary>Full report</summary><pre>' + html.escape(payload) + '</pre></details></html>')
    (root / 'index.html').write_text(document, encoding='utf-8')
    lines = ['# Reproduction', '', 'These are the exact argument vectors invoked, quoted for a POSIX shell.',
             'Paths refer to this retained analysis run. No application entrypoint is executed.', '']
    for command in report.get('commands', []):
        lines += ['## ' + command['stage'].replace('\n', ' '), '',
                  '```sh', 'cd ' + shlex.quote(command['cwd']),
                  shlex.join(command['argv']).replace('```', '` ` `'), '```', '',
                  'Result: ' + str(command.get('returncode', command.get('error', 'unknown'))), '']
    if not report.get('commands'):
        lines += ['No external commands were invoked.', '']
    (root / 'docs/reproduction.md').write_text('\n'.join(lines), encoding='utf-8')
