export const SIZES = ['34','36','38','40','42','44','46','48','50','52','54','56','P','M','G','GG','G1','G2','G3'];
export const STAGES = ['risco','corte','pcp','separacao','costura','lavanderia','acabamento','embalagem','concluido'];
export const LABELS = {risco:'Risco',corte:'Corte',pcp:'PCP',separacao:'Separação',costura:'Costura',lavanderia:'Lavanderia',acabamento:'Acabamento',embalagem:'Embalagem',concluido:'Concluído',planejamento:'Planejamento',pendente:'Aguardando aprovação'};
export const ROLES = ['pcp','planejamento','risco','corte','separacao','costura','lavanderia','acabamento','embalagem'];
export const LOSS_STAGES = ['costura','lavanderia','acabamento','embalagem'];
export const REPAIR_STAGES = ['costura','acabamento','embalagem'];
export const emptyGrid = () => Object.fromEntries(SIZES.map(s => [s,0]));
export const total = g => SIZES.reduce((n,s) => n + Number(g?.[s] || 0),0);
export const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export const canOperate = (profile,stage) => profile?.active && (profile.role === 'pcp' || profile.role === stage);
export const canPlan = p => p?.active && ['pcp','planejamento'].includes(p.role);
export function validateGrid(g) {
  if (!g || Object.keys(g).length !== SIZES.length || SIZES.some(s => !Number.isInteger(g[s]) || g[s]<0 || g[s]>1000000)) throw new Error('Preencha a grade com quantidades inteiras de 0 a 1.000.000.');
  return g;
}
export function validateProduction(input, output, scrap, repairs) {
  [input,output,scrap,repairs].forEach(validateGrid);
  for (const s of SIZES) {
    if(output[s]+scrap[s]!==input[s]) throw new Error(`Tamanho ${s}: saída + refugos deve ser igual à entrada.`);
    if(repairs[s]>output[s]) throw new Error(`Tamanho ${s}: consertos não podem superar a saída.`);
  }
}
export function fieldsFor(stage, sewing='interna') {
  const date=(name,label)=>({name,label,type:'date',required:true});
  const text=(name,label)=>({name,label,type:'text',required:true});
  const range=[date('start_date','Data de início'),date('end_date','Data de fim')];
  switch(stage){
    case 'risco': return [text('plotter','Plotter'),...range,text('responsible','Responsável')];
    case 'corte': return [...range,text('responsible','Responsável')];
    case 'pcp': return [text('op_number','Número da OP'),date('op_date','Data de criação da OP')];
    case 'separacao': return [...range,{name:'sewing_type',label:'Tipo de costura',type:'select',required:true},...(sewing==='externa'?[text('workshop','Nome da oficina'),date('expected_date','Retorno previsto')]:[])];
    case 'costura': return sewing==='externa'?[date('return_date','Data de retorno')]:range;
    case 'lavanderia': return [date('send_date','Data de envio'),date('expected_date','Retorno previsto'),date('return_date','Data de retorno')];
    default:return range;
  }
}
