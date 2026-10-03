import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const kind of ['plain', 'lazy', 'plugin']) {
  test(`isolates ${kind} WXML closures and restores template paths`, () => {
    const root = mkdtempSync(join(tmpdir(), 'gillii-wxml-'));
    try {
      const output = join(root, 'source'); mkdirSync(output);
      const alias = kind === 'plugin' ? '$gwx_wx0123456789abcdef' : kind === 'lazy' ? '$gwx0_XC_2' : '$gwx';
      const nv = kind === 'lazy' ? '' : '\nvar nv_require=function(){var nnm={};return function(){}}()\n';
      const code = `${alias}=function(path,global){
var z=[];
(function(z){var a=11;function Z(ops){z.push(ops)}Z([3,'view'])})(z);__WXML_GLOBAL__.ops_set.${alias}=z;
${nv}
var x=['./pages/index.wxml'];
d_[x[0]]={};
var m0=function(e,s,r,gg){
var node=_n('view');
_(r,node);
return r;
};
e_[x[0]]={f:m0};
if(path&&e_[path]){}
};`;
      const frame = join(root, 'frame.js'); writeFileSync(frame, code);
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('./restore-wxml.cjs', import.meta.url)), output, frame], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const prefix = kind === 'plugin' ? '__plugin__/wx0123456789abcdef' : '';
      assert.match(readFileSync(join(output, prefix, 'pages/index.wxml'), 'utf8'), /<view/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
