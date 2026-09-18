import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyGrid,total,validateGrid,validateProduction,canOperate,fieldsFor} from '../src/domain.js';
test('grade tem todos os tamanhos e rejeita valores inválidos',()=>{
 const g=emptyGrid();g['38']=50;g.G3=20;assert.equal(total(g),70);assert.equal(Object.keys(g).length,19);
 assert.throws(()=>validateGrid({...g,P:-1}));assert.throws(()=>validateGrid({...g,P:1.5}));assert.throws(()=>validateGrid({...g,P:'1'}));assert.throws(()=>validateGrid({...g,XXL:1}));
});
test('conservação de peças impede contabilizar a mesma perda em etapas seguintes',()=>{
 const entry=emptyGrid(),out=emptyGrid(),scrap=emptyGrid(),repairs=emptyGrid();entry['38']=100;out['38']=97;scrap['38']=3;repairs['38']=4;
 validateProduction(entry,out,scrap,repairs);
 const next={...out,'38':95},nextScrap={...scrap,'38':2};validateProduction(out,next,nextScrap,emptyGrid());
 assert.throws(()=>validateProduction(out,next,scrap,emptyGrid()));assert.throws(()=>validateProduction(entry,out,scrap,{...repairs,'38':98}));
});
test('permissões e campos dependem da etapa e tipo de costura',()=>{
 assert.equal(canOperate({active:true,role:'risco'},'corte'),false);assert.equal(canOperate({active:true,role:'pcp'},'corte'),true);assert.equal(canOperate({active:false,role:'pcp'},'corte'),false);
 assert(fieldsFor('separacao','externa').some(f=>f.name==='workshop'));
 assert(!fieldsFor('separacao','interna').some(f=>f.name==='workshop'));
 assert.deepEqual(fieldsFor('costura','externa').map(f=>f.name),['return_date']);
});
