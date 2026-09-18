import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {emptyGrid} from '../src/domain.js';
let db;
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
});
after(async()=>db?.close());
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
