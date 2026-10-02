// Isolated browser QA: replaces the API module; never connects to Supabase.
// Run: node tests/ui-preview.mjs; open http://127.0.0.1:5174/kanban/
import {createServer} from 'vite';
import {emptyGrid} from '../src/domain.js';
const grid=n=>({...emptyGrid(),'38':n});
const profile={id:'fixture-pcp',name:'PCP · Prévia local',role:'pcp',additional_roles:[],access_version:1,active:true};
const plan=(id,stage,n,extra={})=>({id,number:id,reference:'QA-001',description:'Calça jeans · Teste local',combination:'Índigo',responsible:'Equipe QA',notes:'Dados fictícios. Nenhuma gravação externa.',created_at:new Date().toISOString(),created_by:profile.id,version:1,stage,planned_grid:grid(n),current_grid:grid(n),op_number:'QA-'+id,origin_stage:'risco',...extra});
const plans=[plan('1','lavanderia',98),plan('2','acabamento',95),plan('3','embalagem',30,{origin_stage:'acabamento',parent_id:'2',lineage_kind:'partial',lot_label:'1',op_number:'QA-2'})];
const record=(id,stage,n)=>({id:id+stage,plan_id:id,stage,data:{},input_grid:grid(n),output_grid:grid(n),scrap_grid:emptyGrid(),repair_grid:emptyGrid(),completed_at:new Date().toISOString(),actor_id:profile.id});
const tables={profiles:[profile,{...profile,id:'fixture-worker',name:'Operador de produção',role:'separacao',additional_roles:['costura','lavanderia','acabamento']}],plans,stage_records:[record('1','costura',98),record('2','lavanderia',95),record('3','acabamento',30)],stage_archives:[],audit_events:[]};
const server=await createServer({server:{host:'127.0.0.1',port:5174,strictPort:true},plugins:[{name:'isolated-qa-api',enforce:'pre',load(id){if(!id.replaceAll('\\','/').endsWith('/src/api.js'))return;return `
 const tables=${JSON.stringify(tables)};const user=${JSON.stringify(profile)};
 export const passwordSetupRequested=false;
 export const result=async request=>{const r=await request;if(r.error)throw r.error;return r.data};
 export const allRows=async(table,configure)=>{const q=supabase.from(table).select('*');return result(configure(q))};
 export const supabase={auth:{getSession:async()=>({data:{session:{user}}}),getUser:async()=>({data:{user}}),onAuthStateChange:()=>{}},
 from(table){let rows=[...(tables[table]||[])],one=false;const q={select(){return q},eq(key,value){rows=rows.filter(r=>r[key]===value);return q},order(){return q},single(){one=true;return q},then(resolve){resolve({data:one?rows[0]:rows})}};return q},
 rpc:async()=>({error:new Error('Prévia local: gravação bloqueada. Nenhum dado foi enviado ao Supabase.')})};`;
 }}]});await server.listen();console.log('QA isolado: http://127.0.0.1:5174/kanban/');
