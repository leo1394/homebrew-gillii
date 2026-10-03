import test from 'node:test';
import assert from 'node:assert/strict';
import { modernTemplates } from './restore-modern-wxml.mjs';

function compiled(operation = '') {
  return `__wxCodeSpace__.batchAddCompiledTemplate(function() {
    return {'components/example': (() => {
      var H = {};
      H[''] = (R,C,D,U) => {
        var L=R.c, O=R.r, K=U===true, shown,
        empty=(C)=>{},
        child=(C,T,E,B,F,S)=>{ S(''); C||K||U.label ? T(Y(D.label)) : T(); },
        branch=(C,T,E)=>{ if(shown===1) E('view',{},(N,C)=>{ if(C)L(N,'example'); if(C||K||U.title)O(N,'title',D.title); if(C)R.v(N,'tap','onTap',false); },child); },
        root=(C,T,E,B)=>{ shown=D.visible?1:0; B(shown,branch); ${operation} C=false; };
        return {C:root,B:{}};
      };
      return Object.assign(function(R){ return H[R]; },{_:H});
    })()};
  });
  throw new Error('Package code must not run');`;
}

test('restores Skyline visibility, bindings, events and slots statically', () => {
  const template = modernTemplates(compiled()).get('components/example');
  assert.match(template, /wx:if="{{visible}}"/);
  assert.match(template, /class="example"/);
  assert.match(template, /title="{{title}}"/);
  assert.match(template, /bind:tap="onTap"/);
  assert.match(template, /<slot\/>{{label}}/);
});

test('unsupported Skyline operations fail rather than producing partial success', () => {
  assert.throws(() => modernTemplates(compiled('F([]);')), /Unsupported template call/);
});
