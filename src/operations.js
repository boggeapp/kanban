import {SIZES,STAGES,LABELS,emptyGrid,total,today,fieldsFor,validateGrid,canOperate} from './domain.js';

export const isContainer = p => Boolean(p.split_at || p.distributed_at);
export const isLive = p => !p.deleted_at && !isContainer(p);
export function partialBalance(entry, output, scrap, repairs) {
  [entry,output,scrap,repairs].forEach(validateGrid);
  if(!total(output)) throw new Error('Informe ao menos uma peça pronta para avançar.');
  const balance=emptyGrid();
  for(const s of SIZES){
    balance[s]=entry[s]-output[s]-scrap[s];
    if(balance[s]<0)throw new Error(`Tamanho ${s}: parcela e refugos excedem o saldo.`);
    if(repairs[s]>output[s])throw new Error(`Tamanho ${s}: consertos excedem as peças prontas.`);
  }
  return balance;
}

// All writes go through versioned database transactions; these controls are previews.
export function mountOperations(ctx) {
 const {d,plan:p,records,archives,state,dialog,esc,input,gridTable,readGrid,wireGrid,submitForm,rpc,refresh,toast,openCard}=ctx;
 const children=state.plans.filter(x=>x.parent_id===p.id),parent=state.plans.find(x=>x.id===p.parent_id);
 const host=document.createElement('section');host.className='production-actions';
 host.innerHTML=`${p.op_number?`<strong>OP ${esc(p.op_number)}${p.lot_label?` · Parcela ${esc(p.lot_label)}`:''}</strong>`:''}${p.deleted_at?'<p>Card excluído. Histórico preservado; não participa dos totais de produção.</p>':isContainer(p)?'<p>Saldo distribuído entre os cards de destino. Este card mantém o histórico anterior.</p>':p.partial_count?'<p>Este card contém o saldo que ainda não avançou.</p>':''}${p.parent_id?`<p>Grade inicial deste lote: ${total(p.planned_grid)} peças. O planejamento e o corte anteriores estão no card de origem.</p><button type="button" class="secondary" data-relative="${esc(p.parent_id)}">Consultar origem${parent?.op_number?` · OP ${esc(parent.op_number)}`:''}</button>`:''}${children.length?`<details><summary>${children.length} cards de destino</summary><div class="operation-buttons">${children.map(c=>`<button class="secondary" type="button" data-relative="${c.id}">${esc(c.op_number)}${c.lot_label?` · Parcela ${esc(c.lot_label)}`:''} · ${LABELS[c.stage]}${c.deleted_at?' · Excluído':''}</button>`).join('')}</div></details>`:''}<div class="operation-buttons" id="lot-buttons"></div>`;
 d.querySelector('.card-summary').after(host);
 host.querySelectorAll('[data-relative]').forEach(b=>b.onclick=()=>openCard(state.plans.find(x=>x.id===b.dataset.relative)||{id:b.dataset.relative,number:'',stage:p.stage,reference:'Origem'}));
 if(state.demo)return;
 const buttons=host.querySelector('#lot-buttons');
 const add=(label,action)=>{const b=document.createElement('button');b.type='button';b.className='secondary';b.textContent=label;b.onclick=action;buttons.append(b);};
 const shell=(title,body,submit)=>{
  const modal=dialog(title,`OP ${p.op_number||'não emitida'}${p.lot_label?' · Parcela '+p.lot_label:''}`,`<form class="sheet-body">${body}<p class="form-error" role="alert"></p><footer class="sheet-actions"><button type="button" class="secondary" data-cancel>Voltar ao card</button><button class="primary" type="submit">${submit}</button></footer></form>`);
  modal.querySelector('[data-cancel]').onclick=()=>openCard(p);
  return {modal,form:modal.querySelector('form')};
 };
 const reason='<label>Motivo<textarea name="reason" required minlength="3" maxlength="1000" rows="2"></textarea></label>';
 const run=(form,modal,name,values,message)=>submitForm(form,async()=>{await rpc(name,{p_id:p.id,p_version:p.version,...values});modal.close();toast(message);await refresh();});

 if(isLive(p)&&['acabamento','embalagem'].includes(p.stage)&&p.op_number&&canOperate(state.profile,p.stage))add('Liberar parcela pronta',()=>{
  const data=records.find(r=>r.stage===p.stage)?.data||{};
  const {modal,form}=shell('Liberar parcela pronta',`<p>Apenas as peças prontas avançam para ${LABELS[STAGES[STAGES.indexOf(p.stage)+1]]}. O saldo permanece em ${LABELS[p.stage]}. Refugos são baixados uma única vez; consertos fazem parte da saída.</p><div class="form-grid">${fieldsFor(p.stage).map(f=>input(f.name,f.label,data[f.name]||'',f.type,true,`min="${esc(data[f.name]&&data[f.name]<today()?data[f.name]:today())}"`)).join('')}</div>${gridTable(emptyGrid(),{editable:true,baseline:p.current_grid,scrap:emptyGrid(),repairs:emptyGrid()})}<p class="info-note" id="parcel-preview" aria-live="polite"></p><label>Observação<textarea name="notes" maxlength="5000"></textarea></label><label>Descrição dos consertos<textarea name="repair_notes" maxlength="5000"></textarea></label><label class="checkbox-label"><input name="confirmed" type="checkbox" required>Conferi a parcela e o saldo que permanecerá nesta etapa.</label>`,'Liberar e avançar parcela');
  wireGrid(form,p.current_grid);
  form.querySelector('.grade thead tr').insertAdjacentHTML('beforeend','<th>Saldo</th>');
  form.querySelectorAll('.grade tbody tr').forEach(row=>row.insertAdjacentHTML('beforeend',`<td data-balance="${row.dataset.size}">${p.current_grid[row.dataset.size]}</td>`));
  form.querySelector('.grade tfoot tr').insertAdjacentHTML('beforeend',`<td data-balance-total>${total(p.current_grid)}</td>`);
  form.addEventListener('input',()=>{const output=readGrid(form),scrap=readGrid(form,'scrap');for(const s of SIZES)form.querySelector(`[data-balance="${s}"]`).textContent=p.current_grid[s]-output[s]-scrap[s];form.querySelector('[data-balance-total]').textContent=total(p.current_grid)-total(output)-total(scrap);});
  const preview=()=>{try{const output=readGrid(form),scrap=readGrid(form,'scrap'),repair=readGrid(form,'repair');const balance=partialBalance(p.current_grid,output,scrap,repair);form.querySelector('#parcel-preview').textContent=`Avançam ${total(output)} peças · ${total(scrap)} refugos · Saldo: ${total(balance)} peças.${total(balance)===0?' O card de origem ficará disponível em “Cards distribuídos”.':''}`;}catch(e){form.querySelector('#parcel-preview').textContent=e.message;}};
  form.addEventListener('input',preview);preview();
  form.onsubmit=e=>{e.preventDefault();submitForm(form,async()=>{const output=readGrid(form),scrap=readGrid(form,'scrap'),repairs=readGrid(form,'repair');partialBalance(p.current_grid,output,scrap,repairs);const fd=new FormData(form);await rpc('release_partial',{p_id:p.id,p_version:p.version,p_data:{start_date:fd.get('start_date'),end_date:fd.get('end_date'),notes:fd.get('notes'),repair_notes:fd.get('repair_notes'),confirmed:fd.has('confirmed')},p_grid:output,p_scrap:scrap,p_repairs:repairs});modal.close();toast('Parcela avançou. O saldo permanece no card de origem.');await refresh();});};
 });
 if(state.profile.role!=='pcp')return;
 if(isLive(p)&&!p.parent_id&&p.stage==='lavanderia'&&p.op_number&&!children.length&&!records.some(r=>STAGES.indexOf(r.stage)>=5)&&records.some(r=>r.stage==='costura'&&r.completed_at))add('Desmembrar OP',()=>{
  const {modal,form}=shell('Desmembrar OP',`<p>Distribua todo o saldo por tamanho. Serão criadas OPs ${esc(p.op_number)}-A, -B e seguintes na Lavanderia. O card de origem ficará disponível no filtro “Cards distribuídos”, com seu histórico preservado.</p>${input('parts','Número de partes',2,'number',true,'min="2" max="26" step="1"')}<div id="split-grids"></div><p id="split-preview" aria-live="polite"></p>${reason}<label class="checkbox-label"><input type="checkbox" required>Conferi a distribuição integral da OP.</label>`,'Confirmar desmembramento');
  const readParts=()=>Array.from({length:Math.max(2,Math.min(26,Math.trunc(Number(form.elements.parts.value)||2)))},(_,i)=>readGrid(form,'part'+i));
  const render=()=>{
   const count=Number(form.elements.parts.value);if(!Number.isInteger(count)||count<2||count>26)return;
   form.querySelector('#split-grids').innerHTML=`<div class="table-scroll"><table class="grade"><thead><tr><th>Tamanho</th><th>Disponível</th>${Array.from({length:count},(_,i)=>`<th>${String.fromCharCode(65+i)}</th>`).join('')}<th>A distribuir</th></tr></thead><tbody>${SIZES.map(s=>`<tr><th>${s}</th><td>${p.current_grid[s]}</td>${Array.from({length:count},(_,i)=>`<td><input aria-label="Parte ${String.fromCharCode(65+i)} tamanho ${s}" name="part${i}_${s}" type="number" min="0" max="${p.current_grid[s]}" step="1" value="0" required></td>`).join('')}<td data-remaining="${s}">${p.current_grid[s]}</td></tr>`).join('')}</tbody></table></div>`;
   preview();
  };
  const preview=()=>{const parts=readParts();for(const s of SIZES){const cell=form.querySelector(`[data-remaining="${s}"]`);if(cell)cell.textContent=p.current_grid[s]-parts.reduce((n,g)=>n+g[s],0);}form.querySelector('#split-preview').textContent=parts.map((g,i)=>`${String.fromCharCode(65+i)}: ${total(g)} peças`).join(' · ');};
  form.elements.parts.onchange=render;form.addEventListener('input',preview);render();
  form.onsubmit=e=>{e.preventDefault();submitForm(form,async()=>{const parts=readParts();parts.forEach(validateGrid);if(parts.some(g=>!total(g))||SIZES.some(s=>parts.reduce((n,g)=>n+g[s],0)!==p.current_grid[s]))throw new Error('Distribua exatamente o saldo de cada tamanho, com ao menos uma peça em cada parte.');await rpc('split_plan',{p_id:p.id,p_version:p.version,p_parts:parts,p_reason:form.elements.reason.value});modal.close();toast('OP desmembrada. Os novos cards estão na Lavanderia.');await refresh();});};
 });
 const targets=records.filter(r=>r.completed_at&&STAGES.indexOf(r.stage)<STAGES.indexOf(p.stage)&&STAGES.indexOf(r.stage)>=STAGES.indexOf(p.origin_stage||'risco'));
 if(isLive(p)&&!children.length&&targets.length)add('Voltar etapa',()=>{
  const {modal,form}=shell('Voltar etapa',`<p>O retorno restaura a grade de entrada da etapa escolhida. Registros dessa etapa e das seguintes saem dos totais atuais e ficam preservados no histórico. A produção deverá ser conferida novamente.</p><label>Retornar para<select name="target">${targets.map(r=>`<option value="${r.stage}">${LABELS[r.stage]}</option>`).join('')}</select></label><p id="return-preview" class="info-note"></p>${reason}<label class="checkbox-label"><input type="checkbox" required>Confirmei a necessidade de refazer esta parte do fluxo.</label>`,'Confirmar retorno');
  const preview=()=>{const record=targets.find(r=>r.stage===form.elements.target.value);form.querySelector('#return-preview').textContent=`Grade atual: ${total(p.current_grid)} peças → grade restaurada: ${total(record.input_grid)} peças. OP ${p.op_number||'não emitida'} permanece reservada.`;};form.elements.target.onchange=preview;preview();
  form.onsubmit=e=>{e.preventDefault();run(form,modal,'return_stage',{p_target:form.elements.target.value,p_reason:form.elements.reason.value},'Etapa retornada. Histórico anterior preservado.');};
 });
 if(!children.length)add(p.deleted_at?'Restaurar card':'Excluir card',()=>{
  const restore=Boolean(p.deleted_at);
  const {modal,form}=shell(restore?'Restaurar card':'Excluir card',`<p>${restore?'O card voltará ao painel na mesma etapa, com suas quantidades e registros.':'O card sairá do painel e dos totais atuais. Seus dados e sua OP serão preservados; o PCP poderá restaurá-lo pelo filtro “Excluídos”.'}${p.parent_id?' A quantidade não será devolvida ao card de origem.':''}</p>${reason}<label class="checkbox-label"><input type="checkbox" required>Confirmo ${restore?'a restauração':'a exclusão'} deste card.</label>`,restore?'Restaurar card':'Confirmar exclusão');
  form.onsubmit=e=>{e.preventDefault();run(form,modal,'set_plan_deleted',{p_deleted:!restore,p_reason:form.elements.reason.value},restore?'Card restaurado.':'Card excluído. Disponível para restauração pelo PCP.');};
 });
 if(children.length)host.insertAdjacentHTML('beforeend','<p class="help">Cards que originaram outros cards não podem retornar nem ser excluídos. Opere os destinos para preservar o saldo já distribuído.</p>');
}
