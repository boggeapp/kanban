import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyGrid,total,validateGrid,validateProduction,canOperate,fieldsFor} from '../src/domain.js';
import {partialBalance,isLive} from '../src/operations.js';
test('parcela conserva saldo por tamanho e containers não contam como produção',()=>{
 const entry={...emptyGrid(),'38':100},out={...emptyGrid(),'38':30},scrap={...emptyGrid(),'38':2};
 assert.equal(partialBalance(entry,out,scrap,emptyGrid())['38'],68);
 assert.throws(()=>partialBalance(entry,{...out,'40':1},scrap,emptyGrid()));
 assert.throws(()=>partialBalance(entry,out,scrap,{...emptyGrid(),'38':31}));
 assert.throws(()=>partialBalance(entry,emptyGrid(),scrap,emptyGrid()));
 assert.equal(isLive({split_at:'today'}),false);assert.equal(isLive({distributed_at:'today'}),false);assert.equal(isLive({deleted_at:'today'}),false);assert.equal(isLive({}),true);
});
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

test('múltiplas responsabilidades só autorizam etapas selecionadas de usuários ativos',()=>{
 const user={active:true,role:'separacao',additional_roles:['costura','lavanderia','acabamento']};
 for(const stage of ['separacao','costura','lavanderia','acabamento'])assert.equal(canOperate(user,stage),true);
 for(const stage of ['risco','corte','pcp','embalagem','planejamento'])assert.equal(canOperate(user,stage),false);
 assert.equal(canOperate({...user,active:false},'costura'),false);
 assert.equal(canOperate({...user,role:'pendente'},'costura'),false);
});
