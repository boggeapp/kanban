import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {emptyGrid} from '../src/domain.js';
let db,upgradeSnapshot,upgradePlan;
const admin='00000000-0000-0000-0000-000000000001',planner='00000000-0000-0000-0000-000000000002',risk='00000000-0000-0000-0000-000000000003',cutter='00000000-0000-0000-0000-000000000004',pending='00000000-0000-0000-0000-000000000005';
const grid=()=>({...emptyGrid(),'38':100});const zero=()=>emptyGrid();
const day='2099-01-01';
async function as(id){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');}
async function plan(){return (await db.query('select * from public.save_plan($1,$2)',[{reference:'BG-001',description:'Calça jeans',responsible:'PCP',combination:'Índigo'},grid()])).rows[0];}
async function stage(p,data,g=p.current_grid,s=zero(),r=zero(),complete=true){return (await db.query('select * from public.save_stage($1,$2,$3,$4,$5,$6,$7)',[p.id,p.version,{confirmed:true,...data},g,s,r,complete])).rows[0];}
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,raw_user_meta_data jsonb);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
 await db.exec(await readFile(new URL('../supabase/migrations/202609180001_kanban.sql',import.meta.url),'utf8'));
 for(const [id,role] of [[admin,'pcp'],[planner,'planejamento'],[risk,'risco'],[cutter,'corte'],[pending,'pendente']]){
  await db.query("insert into auth.users values($1,'{\"name\":\"Teste\",\"role\":\"pcp\"}')",[id]);
  if(role!=='pendente')await db.query('update public.profiles set role=$1,active=true where id=$2',[role,id]);
 }
 await as(admin);upgradePlan=await stage(await plan(),{plotter:'P',start_date:day,end_date:day,responsible:'R'});
 upgradeSnapshot=(await db.query('select to_jsonb(r) as data from public.stage_records r where plan_id=$1',[upgradePlan.id])).rows;
 await db.exec('reset role');await db.exec(await readFile(new URL('../supabase/migrations/202610020001_production_lots.sql',import.meta.url),'utf8'));
});
after(async()=>db?.close());
test('migração preserva integralmente cards e registros de banco já utilizado',async()=>{
 await as(admin);const upgraded=(await db.query('select * from public.plans where id=$1',[upgradePlan.id])).rows[0];
 for(const key of Object.keys(upgradePlan))assert.deepEqual(upgraded[key],upgradePlan[key]);
 assert.deepEqual((await db.query('select to_jsonb(r) as data from public.stage_records r where plan_id=$1',[upgradePlan.id])).rows,upgradeSnapshot);
});
test('cadastro não eleva permissões; anônimo e pendente não leem produção',async()=>{
 await as(pending);const p=(await db.query('select * from public.profiles')).rows;assert.equal(p.length,1);assert.equal(p[0].role,'pendente');assert.equal(p[0].active,false);assert.equal((await db.query('select * from public.plans')).rows.length,0);await assert.rejects(plan,/Sem permissão/);
 await db.exec('reset role;set role anon');await assert.rejects(()=>db.query('select * from public.plans'),/permission denied/);await assert.rejects(plan,/permission denied/);
});
test('criação sequencial, autor, RPC, histórico e concorrência',async()=>{
 await as(planner);let p=await plan();const next=await plan();assert.equal(Number(next.number),Number(p.number)+1);
 await assert.rejects(()=>db.query("update public.plans set stage='concluido' where id=$1",[p.id]),/permission denied/);
 await as(risk);await assert.rejects(plan,/Sem permissão/);
 await assert.rejects(()=>db.query("update public.profiles set role='pcp' where id=$1",[risk]),/permission denied/);
 const old=p;const newGrid={...grid(),'38':105};p=await stage(p,{plotter:'Plotter A',start_date:day},newGrid,zero(),zero(),false);
 assert.equal(p.stage,'risco');assert.equal(p.current_grid['38'],100);
 await assert.rejects(()=>stage(old,{plotter:'P',start_date:day,end_date:day,responsible:'R'}),/atualizado/);
 await as(planner);await assert.rejects(()=>db.query('select * from public.save_plan($1,$2,$3,$4)',[{reference:'R',description:'D',responsible:'X',combination:'C'},grid(),p.id,p.version]),/já iniciado/);
 await as(risk);await assert.rejects(()=>stage(p,{plotter:'P',start_date:'2020-01-01',end_date:day,responsible:'R'},newGrid),/retroativas/);
 p=await stage(p,{plotter:'P',start_date:day,end_date:day,responsible:'R'},newGrid);assert.equal(p.stage,'corte');assert.equal(p.current_grid['38'],105);assert.equal(p.planned_grid['38'],100);
 await assert.rejects(()=>stage(p,{start_date:day,end_date:day,responsible:'R'}),/não pode/);
 const history=(await db.query('select * from public.audit_events where plan_id=$1',[p.id])).rows;assert.equal(history.length,3);assert.equal(history[1].after_data.output_grid['38'],105);
 await assert.rejects(()=>db.query('delete from public.audit_events where plan_id=$1',[p.id]),/permission denied/);
});
test('fluxo completo, OP única, grade bloqueada na separação e perdas incrementais',async()=>{
 await as(admin);let p=await plan();p=await stage(p,{plotter:'P',start_date:day,end_date:day,responsible:'R'});p=await stage(p,{start_date:day,end_date:day,responsible:'R'});
 await assert.rejects(()=>stage(p,{op_number:'OP-1',op_date:day,confirmed:false}),/Confirme/);
 p=await stage(p,{op_number:'OP-1',op_date:day});assert.equal(p.stage,'separacao');
 const pcp=(await db.query("select * from public.stage_records where plan_id=$1 and stage='pcp'",[p.id])).rows[0];assert(pcp.completed_at);
 await assert.rejects(()=>stage(p,{start_date:day,end_date:day,sewing_type:'externa',workshop:'Oficina',expected_date:day},{...grid(),'38':99}),/não permite/);
 await assert.rejects(()=>stage(p,{start_date:day,end_date:day,sewing_type:'externa',expected_date:day}),/workshop/);
 p=await stage(p,{start_date:day,end_date:day,sewing_type:'externa',workshop:'Oficina',expected_date:day});assert.equal(p.workshop,'Oficina');
 await assert.rejects(()=>stage(p,{return_date:day},{...grid(),'38':95},zero()),/saída/);
 await assert.rejects(()=>stage(p,{return_date:day},{...grid(),'38':95},{...zero(),'38':5},{...zero(),'38':2}),/Descreva/);
 p=await stage(p,{return_date:day,repair_notes:'Revisar costura'},{...grid(),'38':95},{...zero(),'38':5},{...zero(),'38':2});
 p=await stage(p,{send_date:day,expected_date:day,return_date:day},{...grid(),'38':92},{...zero(),'38':3});
 p=await stage(p,{start_date:day,end_date:day});p=await stage(p,{start_date:day,end_date:day});assert.equal(p.stage,'concluido');assert.equal(p.current_grid['38'],92);
 const rows=(await db.query('select * from public.stage_records where plan_id=$1',[p.id])).rows;assert.equal(rows.length,8);assert.equal(rows.reduce((n,r)=>n+r.scrap_grid['38'],0),8);
 await assert.rejects(()=>stage(p,{start_date:day,end_date:day}),/não pode/);
 let second=await plan();second=await stage(second,{plotter:'P',start_date:day,end_date:day,responsible:'R'});second=await stage(second,{start_date:day,end_date:day,responsible:'R'});await assert.rejects(()=>stage(second,{op_number:'OP-1',op_date:day}),/duplicate key/);
});
test('administração de acesso exige PCP e impede autoalteração',async()=>{
 await as(risk);await assert.rejects(()=>db.query('select public.set_user_role($1,$2,$3)',[pending,'pcp',true]),/Apenas PCP/);
 await as(admin);await assert.rejects(()=>db.query('select public.set_user_role($1,$2,$3)',[admin,'risco',false]),/próprio/);
 await db.query('select public.set_user_role($1,$2,$3)',[pending,'costura',true]);await as(pending);assert.equal((await db.query('select public.current_role() as role')).rows[0].role,'costura');
});

const qty=n=>({...zero(),'38':n});
const fresh=async p=>(await db.query('select * from public.plans where id=$1',[p.id])).rows[0];
const split=(p,parts)=>db.query('select * from public.split_plan($1,$2,$3,$4)',[p.id,p.version,JSON.stringify(parts),'Divisão por destino']);
const partial=async(p,n,s=0,r=0,data={})=>(await db.query('select * from public.release_partial($1,$2,$3,$4,$5,$6)',[p.id,p.version,{confirmed:true,start_date:day,end_date:day,...data},qty(n),qty(s),qty(r)])).rows[0];
const back=async(p,target)=>(await db.query('select * from public.return_stage($1,$2,$3,$4)',[p.id,p.version,target,'Correção de lançamento'])).rows[0];
const exclude=async(p,deleted=true)=>(await db.query('select * from public.set_plan_deleted($1,$2,$3,$4)',[p.id,p.version,deleted,'Correção administrativa'])).rows[0];
let opSequence=10;
async function throughSewing(){
 await as(admin);let p=await plan();p=await stage(p,{plotter:'P',start_date:day,end_date:day,responsible:'R'});
 p=await stage(p,{start_date:day,end_date:day,responsible:'R'});p=await stage(p,{op_number:'OP-'+opSequence++,op_date:day});
 p=await stage(p,{start_date:day,end_date:day,sewing_type:'interna'});
 return stage(p,{start_date:day,end_date:day},qty(98),qty(2));
}
const throughLaundry=async()=>stage(await throughSewing(),{send_date:day,expected_date:day,return_date:day},qty(95),qty(3));

test('desmembramento conserva cada tamanho, bloqueia acesso indevido e não copia perdas',async()=>{
 let p=await throughSewing();await as(risk);await assert.rejects(()=>split(p,[qty(48),qty(50)]),/Apenas PCP/);await as(admin);
 await assert.rejects(()=>split(p,[qty(49),qty(50)]),/soma/);
 await assert.rejects(()=>split(p,[qty(0),qty(98)]),/ao menos/);
 await assert.rejects(()=>split(p,[{...qty(48),'40':1},qty(50)]),/soma/);
 const children=(await split(p,[qty(48),qty(50)])).rows;assert.equal(children.length,2);
 assert.deepEqual(children.map(c=>c.op_number),[p.op_number+'-A',p.op_number+'-B']);
 assert(children.every(c=>c.parent_id===p.id&&c.stage==='lavanderia'));
 assert.equal((await db.query('select * from public.stage_records where plan_id=$1',[children[0].id])).rows.length,0);
 const source=await fresh(p);assert(source.split_at);assert.equal(source.current_grid['38'],98);
 await assert.rejects(()=>stage(source,{}),/distribuído/);await assert.rejects(()=>back(source,'costura'),/distribuído/);
 await assert.rejects(()=>exclude(source),/destinos/);await assert.rejects(()=>split(p,[qty(48),qty(50)]),/atualizado/);
 let child=await stage(children[0],{send_date:day,expected_date:day,return_date:day});child=await back(child,'lavanderia');assert.equal(child.current_grid['38'],48);
 await assert.rejects(()=>back(child,'costura'),/inválida/);
 const late=await throughSewing();const draft=await stage(late,{send_date:day},late.current_grid,zero(),zero(),false);
 await assert.rejects(()=>split(draft,[qty(48),qty(50)]),/posterior/);
});

test('colisão de OP em desmembramento reverte todos os filhos atomicamente',async()=>{
 const p=await throughSewing(),other=await throughSewing();await db.exec('reset role');
 await db.query('update public.plans set op_number=$1 where id=$2',[p.op_number+'-B',other.id]);await as(admin);
 await assert.rejects(()=>split(p,[qty(48),qty(50)]),/duplicate key/);
 assert.equal((await db.query('select count(*)::int as n from public.plans where parent_id=$1',[p.id])).rows[0].n,0);
 assert.equal((await fresh(p)).split_at,null);assert.equal((await fresh(p)).version,p.version);
});

test('parcelas avançam separadamente e mantêm saldo, consertos, OP e versão',async()=>{
 let p=await throughLaundry();await as(risk);await assert.rejects(()=>partial(p,30),/Sem permissão/);await as(admin);
 await assert.rejects(()=>partial(p,96),/excedem/);await assert.rejects(()=>partial(p,0),/ao menos/);
 await assert.rejects(()=>partial(p,30,0,31),/Consertos/);await assert.rejects(()=>partial(p,30,0,1),/Descreva/);
 await assert.rejects(()=>partial(p,30,0,0,{confirmed:false}),/Confirme/);
 await assert.rejects(()=>partial(p,30,0,0,{start_date:'2020-01-01'}),/retroativas/);
 assert.equal((await db.query('select count(*)::int as n from public.plans where parent_id=$1',[p.id])).rows[0].n,0);
 const original=p;const a=await partial(p,30,2,3,{repair_notes:'Ajuste de barra'});p=await fresh(p);
 assert.equal(a.stage,'embalagem');assert.equal(a.op_number,p.op_number);assert.equal(a.lot_label,'1');assert.equal(p.current_grid['38'],63);assert.equal(p.stage,'acabamento');
 await assert.rejects(()=>partial(original,30),/atualizado/);await assert.rejects(()=>back(p,'lavanderia'),/originou/);await assert.rejects(()=>exclude(p),/destinos/);
 const b=await partial(p,60,3);p=await fresh(p);assert.equal(b.lot_label,'2');assert(p.distributed_at);assert.equal(p.current_grid['38'],0);
 await assert.rejects(()=>stage(p,{start_date:day,end_date:day}),/distribuído/);
 const packed=await partial(a,10);assert.equal(packed.stage,'concluido');assert.equal(packed.lot_label,'1.1');assert.equal(packed.current_grid['38'],10);
 const aBalance=await fresh(a);assert.equal(aBalance.current_grid['38'],20);
 const done=await stage(aBalance,{start_date:day,end_date:day});assert.equal(done.stage,'concluido');
 const losses=(await db.query('select sum((scrap_grid->>\'38\')::int)::int as n from public.stage_records where plan_id=any($1::uuid[]) and completed_at is not null',[[p.id,a.id,b.id,packed.id]])).rows[0].n;
 assert.equal(losses,10); // sewing 2 + laundry 3 + finishing 5; packaging adds none
});

test('retorno preserva histórico, restaura entrada e permite refazer sem duplicar refugos',async()=>{
 let p=await throughLaundry();p=await stage(p,{start_date:day,end_date:day},qty(92),qty(3));
 await as(risk);await assert.rejects(()=>back(p,'costura'),/Apenas PCP/);await as(admin);
 const old=p;p=await back(p,'costura');assert.equal(p.stage,'costura');assert.equal(p.current_grid['38'],100);assert.equal(p.planned_grid['38'],100);
 assert.equal((await db.query('select * from public.stage_archives where plan_id=$1',[p.id])).rows.length,3);
 assert.equal((await db.query('select * from public.stage_records where plan_id=$1',[p.id])).rows.length,4);
 await assert.rejects(()=>back(old,'costura'),/atualizado/);
 await assert.rejects(()=>stage(p,{start_date:'2020-01-01',end_date:day}),/retroativas/);
 p=await stage(p,{start_date:day,end_date:day},qty(99),qty(1));assert.equal(p.current_grid['38'],99);
 p=await back(p,'risco');assert.equal(p.current_grid['38'],100);assert(p.op_number);
 await assert.rejects(()=>db.query('select * from public.save_plan($1,$2,$3,$4)',[{reference:'R',description:'D',responsible:'X',combination:'C'},grid(),p.id,p.version]),/já iniciado/);
 await assert.rejects(()=>db.query('delete from public.stage_archives where plan_id=$1',[p.id]),/permission denied/);
});

test('exclusão é reversível, respeita RLS, reserva OP e não devolve peças à origem',async()=>{
 let p=await throughLaundry();let child=await partial(p,30);const balance=await fresh(p);
 await as(risk);await assert.rejects(()=>exclude(child),/Apenas PCP/);await as(admin);const previous=child;child=await exclude(child);assert(child.deleted_at);
 await assert.rejects(()=>stage(child,{start_date:day,end_date:day}),/excluído/);await assert.rejects(()=>exclude(previous),/atualizado/);
 assert.equal((await fresh(p)).current_grid['38'],balance.current_grid['38']);
 await as(risk);assert.equal(await fresh(child),undefined);
 assert.equal((await db.query('select * from public.stage_records where plan_id=$1',[child.id])).rows.length,0);
 assert.equal((await db.query('select * from public.audit_events where plan_id=$1',[child.id])).rows.length,0);
 await as(admin);child=await exclude(child,false);assert.equal(child.deleted_at,null);assert.equal(child.current_grid['38'],30);
 await assert.rejects(()=>back(child,'lavanderia'),/inválida/);child=await back(child,'acabamento');assert.equal(child.current_grid['38'],30);
 await assert.rejects(async()=>exclude(await fresh(p)),/destinos/);
});

test('implementações privadas não permitem burlar controles de ciclo de vida',async()=>{
 await as(admin);const p=await throughLaundry();
 await assert.rejects(()=>db.query('select public.save_stage_v1($1,$2,$3,$4,$5,$6,false)',[p.id,p.version,{},p.current_grid,zero(),zero()]),/permission denied/);
 await assert.rejects(()=>db.query("select public.archive_stages($1,'risco','apagar')",[p.id]),/permission denied/);
 await assert.rejects(()=>db.query('select public.save_plan_v1($1,$2)',[{},grid()]),/permission denied/);
 await db.exec('reset role;set role anon');await assert.rejects(()=>split(p,[qty(45),qty(50)]),/permission denied/);
});

test('operador correto libera parcelas e preserva início antigo já salvo em rascunho',async()=>{
 let p=await throughLaundry();p=await stage(p,{start_date:day},p.current_grid,zero(),zero(),false);
 await db.exec('reset role');await db.query("update public.stage_records set data=jsonb_set(data,'{start_date}','\"2020-01-01\"') where plan_id=$1 and stage='acabamento'",[p.id]);
 await as(admin);await db.query('select public.set_user_role($1,$2,$3)',[pending,'acabamento',true]);await as(pending);
 const a=await partial(p,20,0,0,{start_date:'2020-01-01'});assert.equal(a.stage,'embalagem');p=await fresh(p);
 const b=await partial(p,25,0,0,{start_date:'2020-01-01'});assert.equal(b.stage,'embalagem');p=await fresh(p);assert.equal(p.current_grid['38'],50);
 await assert.rejects(()=>partial(p,10,0,0,{start_date:'2020-01-02'}),/retroativas/);
 await assert.rejects(()=>partial(a,5),/Sem permissão/);
 await as(admin);await db.query('select public.set_user_role($1,$2,$3)',[pending,'embalagem',true]);await as(pending);
 assert.equal((await partial(a,5)).stage,'concluido');
});

const erpPart=(op,n,reference='REF-NOVA',description='Modelo novo')=>({op_number:op,reference,description,grid:qty(n)});
test('migração ERP preserva desmembramentos anteriores sem renomear ou redistribuir',async()=>{
 await as(admin);const before=(await db.query('select to_jsonb(p) as data from public.plans p order by id')).rows;
 await db.exec('reset role');await db.exec(await readFile(new URL('../supabase/migrations/202610020002_erp_split.sql',import.meta.url),'utf8'));
 await as(admin);assert.deepEqual((await db.query('select to_jsonb(p) as data from public.plans p order by id')).rows,before);
});
test('ERP mantém saldo na OP atual e cria várias OPs com referências e descrições próprias',async()=>{
 let p=await throughSewing();const original=p;
 const children=(await split(p,[erpPart('ERP-100',30,'REF-100','Calça reta'),erpPart('ERP-200',20,'REF-200','Bermuda')])).rows;
 assert.deepEqual(children.map(x=>[x.op_number,x.reference,x.description,x.current_grid['38']]),[['ERP-100','REF-100','Calça reta',30],['ERP-200','REF-200','Bermuda',20]]);
 p=await fresh(p);assert.equal(p.current_grid['38'],48);assert.equal(p.op_number,original.op_number);assert.equal(p.reference,original.reference);assert.equal(p.description,original.description);assert.equal(p.split_at,null);assert.equal(p.stage,'lavanderia');assert.deepEqual(p.planned_grid,original.planned_grid);
 assert.equal((await db.query('select count(*)::int as n from public.stage_records where plan_id=any($1::uuid[])',[children.map(c=>c.id)])).rows[0].n,0);
 await assert.rejects(()=>split(original,[erpPart('ERP-STALE',1)]),/atualizado/);
 const more=(await split(p,[erpPart(' ERP-300 ',10)])).rows[0];assert.equal(more.op_number,'ERP-300');p=await fresh(p);assert.equal(p.current_grid['38'],38);
 await assert.rejects(()=>back(p,'costura'),/originou/);await assert.rejects(()=>exclude(p),/destinos/);
 p=await stage(p,{send_date:day,expected_date:day,return_date:day});assert.equal(p.current_grid['38'],38);assert.equal(p.stage,'acabamento');
 const parcel=await partial(p,10);assert.equal(parcel.stage,'embalagem');assert.equal((await fresh(p)).current_grid['38'],28);
 let child=await stage(children[0],{send_date:day,expected_date:day,return_date:day});child=await back(child,'lavanderia');assert.equal(child.current_grid['38'],30);
 child=await exclude(child);child=await exclude(child,false);assert.equal(child.current_grid['38'],30);
});
test('ERP rejeita números repetidos e entradas inválidas sem alterar saldo ou criar filhos',async()=>{
 const p=await throughSewing();
 await as(risk);await assert.rejects(()=>split(p,[erpPart('ERP-NO',1)]),/Apenas PCP/);await as(admin);
 await assert.rejects(()=>split(p,[qty(30),qty(68)]),/op_number/); // old browser payload must not create suffixes
 await assert.rejects(()=>split(p,[]),/1 a 100/);
 await assert.rejects(()=>split(p,[erpPart('',10)]),/op_number/);
 await assert.rejects(()=>split(p,[erpPart('ERP-X',10,'   ')]),/reference/);
 await assert.rejects(()=>split(p,[erpPart('ERP-X',10,'R','x'.repeat(501))]),/description/);
 await assert.rejects(()=>split(p,[erpPart('ERP-X',0)]),/ao menos/);
 await assert.rejects(()=>split(p,[erpPart('ERP-X',98)]),/Mantenha/);
 await assert.rejects(()=>split(p,[{...erpPart('ERP-X',1),grid:{...qty(1),'40':1}}]),/excedem/);
 await assert.rejects(()=>split(p,[erpPart('ERP-X',99)]),/excedem/);
 await assert.rejects(()=>split(p,[erpPart(p.op_number,1)]),/duplicate key/);
 await assert.rejects(()=>split(p,[erpPart('ERP-DUP',10),erpPart(' ERP-DUP ',10)]),/duplicate key/);
 await assert.rejects(()=>split(p,[erpPart('ERP-NEW',10),erpPart('ERP-100',10)]),/duplicate key/);
 assert.equal((await db.query('select count(*)::int as n from public.plans where parent_id=$1',[p.id])).rows[0].n,0);assert.deepEqual(await fresh(p),p);
 const [child]=(await split(p,[erpPart('ERP-VALID',10)])).rows;await exclude(child);
 const other=await throughSewing();await assert.rejects(()=>split(other,[erpPart('ERP-VALID',10)]),/duplicate key/);
 const draft=await stage(other,{send_date:day},other.current_grid,zero(),zero(),false);await assert.rejects(()=>split(draft,[erpPart('ERP-LATE',10)]),/posterior/);
 await db.exec('reset role;set role anon');await assert.rejects(()=>split(p,[erpPart('ERP-ANON',1)]),/permission denied/);
});

test('migração de distribuição total preserva cards, registros e auditoria existentes',async()=>{
 await db.exec('reset role');
 const snapshot=async()=>Promise.all(['plans','stage_records','audit_events'].map(t=>db.query(`select to_jsonb(r) as data from public.${t} r order by id`).then(r=>r.rows)));
 const before=await snapshot();
 await db.exec(await readFile(new URL('../supabase/migrations/202610020003_full_split.sql',import.meta.url),'utf8'));
 assert.deepEqual(await snapshot(),before);
});
test('distribuir 100% em três lavagens encerra a base e mantém histórico sem duplicar perdas',async()=>{
 let p=await throughSewing();const original=p;
 const previous=(await db.query('select to_jsonb(r) as data from public.stage_records r where plan_id=$1 order by id',[p.id])).rows;
 const children=(await split(p,[erpPart('WASH-1',30,'REF-CLARA','Lavagem clara'),erpPart('WASH-2',40,'REF-ESCURA','Lavagem escura'),erpPart('WASH-3',28,'REF-STONE','Lavagem stone')])).rows;
 p=await fresh(p);assert(p.split_at);assert.equal(p.stage,'lavanderia');assert.deepEqual(p.current_grid,zero());assert.equal(p.deleted_at,null);assert.deepEqual(p.planned_grid,original.planned_grid);
 assert.equal(p.op_number,original.op_number);assert.equal(p.reference,original.reference);
 assert.deepEqual((await db.query('select to_jsonb(r) as data from public.stage_records r where plan_id=$1 order by id',[p.id])).rows,previous);
 assert.equal(children.reduce((n,c)=>n+c.current_grid['38'],0),98);
 assert.equal((await db.query('select count(*)::int as n from public.stage_records where plan_id=any($1::uuid[])',[children.map(c=>c.id)])).rows[0].n,0);
 const audit=(await db.query("select after_data from public.audit_events where plan_id=$1 and action='op_desmembrada' order by id desc limit 1",[p.id])).rows[0].after_data;
 assert.equal(audit.fully_split,true);assert.equal(audit.children.length,3);assert.deepEqual(audit.remaining_grid,zero());
 await assert.rejects(()=>stage(p,{}),/distribuído/);await assert.rejects(()=>back(p,'costura'),/distribuído/);await assert.rejects(()=>exclude(p),/destinos/);
 await assert.rejects(()=>split(p,[erpPart('WASH-4',1)]),/não pode/);
 let child=await stage(children[0],{send_date:day,expected_date:day,return_date:day},qty(29),qty(1));
 assert.equal(child.stage,'acabamento');assert.equal((await partial(child,10)).stage,'embalagem');
 const losses=(await db.query("select sum((scrap_grid->>'38')::int)::int as n from public.stage_records where plan_id=any($1::uuid[]) and completed_at is not null",[[p.id,child.id]])).rows[0].n;assert.equal(losses,3);
 await as(risk);assert.deepEqual((await fresh(p)).split_at,p.split_at);assert.equal((await db.query('select * from public.stage_records where plan_id=$1',[p.id])).rows.length,previous.length);
});
test('saldo parcial pode ser totalmente desmembrado depois, sem permitir excesso por tamanho',async()=>{
 let p=await throughSewing();const [first]=(await split(p,[erpPart('FULL-LATER-1',30)])).rows;p=await fresh(p);assert.equal(p.split_at,null);assert.equal(p.current_grid['38'],68);
 await assert.rejects(()=>split(p,[{...erpPart('FULL-WRONG',67),grid:{...qty(67),'40':1}}]),/excedem/);
 await assert.rejects(()=>split(p,[erpPart('FULL-EMPTY',0)]),/ao menos/);
 await assert.rejects(()=>split(p,[erpPart('FULL-OVER',69)]),/excedem/);
 const version=p.version;const [last]=(await split(p,[erpPart('FULL-LATER-2',68)])).rows;p=await fresh(p);assert(p.split_at);assert.equal(p.version,version+1);assert.deepEqual(p.current_grid,zero());
 assert.equal(first.current_grid['38']+last.current_grid['38'],98);
 const old=p;await exclude(last);assert.deepEqual((await fresh(p)).current_grid,zero());assert.deepEqual((await fresh(p)).split_at,old.split_at);
});
