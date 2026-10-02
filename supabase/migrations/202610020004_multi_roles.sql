-- Preserve the primary role; additional responsibilities never grant PCP administration.
begin;
alter table public.profiles add column additional_roles text[] not null default '{}', add column access_version integer not null default 1;
alter table public.profiles add constraint additional_roles_valid check (additional_roles <@ array['planejamento','risco','corte','separacao','costura','lavanderia','acabamento','embalagem']::text[] and array_position(additional_roles,null) is null);
create function public.has_responsibility(p_role text) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles p where p.id=auth.uid() and p.active and p.role<>'pendente' and (p.role='pcp' or p.role=p_role or p_role=any(p.additional_roles)));
$$;
revoke all on function public.has_responsibility(text) from public,anon,authenticated;
grant execute on function public.has_responsibility(text) to authenticated;

create function public.set_user_roles(p_user uuid,p_roles text[],p_active boolean,p_version integer) returns void language plpgsql security definer set search_path='' as $$
declare old_profile public.profiles; new_profile public.profiles; selected text[];
begin
 if public.current_role() is distinct from 'pcp' then raise exception 'Apenas PCP pode administrar usuários'; end if;
 if p_user=auth.uid() then raise exception 'Você não pode alterar seu próprio acesso'; end if;
 if p_roles is null or cardinality(p_roles) not between 1 and 9 or array_ndims(p_roles)<>1 or array_position(p_roles,null) is not null or not (p_roles <@ array['pcp','planejamento','risco','corte','separacao','costura','lavanderia','acabamento','embalagem']::text[]) or p_active is null then raise exception 'Selecione responsabilidades válidas'; end if;
 select array_agg(r order by r) into selected from (select distinct unnest(p_roles) as r) v;
 if 'pcp'=any(selected) and cardinality(selected)>1 then raise exception 'PCP já possui acesso total; selecione apenas PCP'; end if;
 select * into old_profile from public.profiles where id=p_user for update;
 if not found then raise exception 'Usuário não encontrado'; end if;
 if old_profile.access_version is distinct from p_version then raise exception 'O acesso deste usuário foi atualizado. Atualize a página e tente novamente.'; end if;
 update public.profiles set role=selected[1],additional_roles=coalesce(selected[2:cardinality(selected)],'{}'::text[]),active=p_active,access_version=access_version+1 where id=p_user returning * into new_profile;
 insert into public.audit_events(actor_id,action,before_data,after_data) values(auth.uid(),'permissao_alterada',to_jsonb(old_profile),to_jsonb(new_profile));
end $$;
revoke all on function public.set_user_roles(uuid,text[],boolean,integer) from public,anon,authenticated;
grant execute on function public.set_user_roles(uuid,text[],boolean,integer) to authenticated;

-- Old clients cannot silently discard multiple responsibilities.
create or replace function public.set_user_role(p_user uuid,p_role text,p_active boolean) returns void language plpgsql security definer set search_path='' as $$
declare p public.profiles;
begin
 if public.current_role() is distinct from 'pcp' then raise exception 'Apenas PCP pode administrar usuários'; end if;
 if p_user=auth.uid() then raise exception 'Você não pode alterar seu próprio acesso'; end if;
 select * into p from public.profiles where id=p_user for update;
 if not found then raise exception 'Usuário não encontrado'; end if;
 if cardinality(p.additional_roles)>0 then raise exception 'Este usuário possui múltiplas responsabilidades. Recarregue a página para editar.'; end if;
 perform public.set_user_roles(p_user,array[p_role],p_active,p.access_version);
end $$;

create or replace function public.save_plan_v1(p_data jsonb,p_grid jsonb,p_id uuid default null,p_version integer default null) returns public.plans
language plpgsql security definer set search_path='' as $$
declare p public.plans; old_data jsonb; k text; r text:=public.current_role();
begin
 if not public.has_responsibility('planejamento') then raise exception 'Sem permissão para planejamento'; end if;
 perform public.check_grid(p_grid);
 if (select sum(value::text::integer) from jsonb_each(p_grid))=0 then raise exception 'Informe ao menos uma peça'; end if;
 foreach k in array array['reference','description','responsible','combination'] loop
  if coalesce(length(trim(p_data->>k)),0)=0 or length(p_data->>k)>500 then raise exception 'Campo obrigatório ou muito longo: %',k; end if;
 end loop;
 if length(coalesce(p_data->>'notes',''))>5000 then raise exception 'Observação muito longa'; end if;
 if p_id is null then
  insert into public.plans(created_by,reference,description,responsible,combination,notes,planned_grid,current_grid)
  values(auth.uid(),trim(p_data->>'reference'),trim(p_data->>'description'),trim(p_data->>'responsible'),trim(p_data->>'combination'),coalesce(p_data->>'notes',''),p_grid,p_grid) returning * into p;
 else
  select * into p from public.plans where id=p_id for update;
  if not found then raise exception 'Planejamento não encontrado'; end if;
  if p.version is distinct from p_version then raise exception 'Este card foi atualizado. Feche e abra novamente.'; end if;
  if p.created_by<>auth.uid() and r<>'pcp' then raise exception 'Somente o criador pode editar o planejamento'; end if;
  if p.stage<>'risco' or exists(select 1 from public.stage_records where plan_id=p.id) then raise exception 'Planejamento já iniciado: consulte o histórico'; end if;
  old_data:=to_jsonb(p);
  update public.plans set reference=trim(p_data->>'reference'),description=trim(p_data->>'description'),responsible=trim(p_data->>'responsible'),combination=trim(p_data->>'combination'),notes=coalesce(p_data->>'notes',''),planned_grid=p_grid,current_grid=p_grid,version=version+1,updated_at=now() where id=p_id returning * into p;
 end if;
 insert into public.audit_events(plan_id,actor_id,action,before_data,after_data) values(p.id,auth.uid(),case when p_id is null then 'planejamento_criado' else 'planejamento_editado' end,old_data,to_jsonb(p));
 return p;
end $$;

create or replace function public.save_stage_v1(p_id uuid,p_version integer,p_data jsonb,p_grid jsonb,p_scrap jsonb,p_repairs jsonb,p_complete boolean default false) returns public.plans
language plpgsql security definer set search_path='' as $$
declare p public.plans; old_record public.stage_records; rec public.stage_records; r text:=public.current_role(); k text; v text; req text[]; d date; business_today date:=(now() at time zone 'America/Sao_Paulo')::date; stages public.production_stage[]:=array['risco','corte','pcp','separacao','costura','lavanderia','acabamento','embalagem','concluido']::public.production_stage[]; loss boolean;
begin
 select * into p from public.plans where id=p_id for update;
 if not found then raise exception 'Card não encontrado'; end if;
 if not public.has_responsibility(p.stage::text) or p.stage='concluido' then raise exception 'Você não pode alterar esta etapa'; end if;
 if p.version is distinct from p_version then raise exception 'Este card foi atualizado. Feche e abra novamente.'; end if;
 if p_complete is null or p_data is null or jsonb_typeof(p_data)<>'object' then raise exception 'Dados inválidos'; end if;
 select * into old_record from public.stage_records where plan_id=p.id and stage=p.stage;
 if old_record.completed_at is not null then raise exception 'Etapa já finalizada'; end if;
 if pg_column_size(p_data)>20000 then raise exception 'Dados muito extensos'; end if;
 perform public.check_grid(p_grid); perform public.check_grid(p_scrap); perform public.check_grid(p_repairs);
 if p.stage='separacao' and p_grid<>p.current_grid then raise exception 'A separação não permite edição da grade'; end if;
 loss:=p.stage in ('costura','lavanderia','acabamento','embalagem');
 for k in select jsonb_object_keys(p_grid) loop
  if loss and (p_grid->>k)::integer+(p_scrap->>k)::integer<>(p.current_grid->>k)::integer then raise exception 'Tamanho %: saída + refugos deve ser igual à entrada',k; end if;
  if not loss and (p_scrap->>k)::integer<>0 then raise exception 'Refugos não permitidos nesta etapa'; end if;
  if p.stage not in ('costura','acabamento','embalagem') and (p_repairs->>k)::integer<>0 then raise exception 'Consertos não permitidos nesta etapa'; end if;
  if (p_repairs->>k)::integer>(p_grid->>k)::integer then raise exception 'Consertos excedem saída: %',k; end if;
 end loop;
 if p_complete and exists(select 1 from jsonb_each(p_repairs) where value::text::integer>0) and coalesce(trim(p_data->>'repair_notes'),'')='' then raise exception 'Descreva os consertos'; end if;
 req:=case p.stage
  when 'risco' then array['plotter','start_date','end_date','responsible']
  when 'corte' then array['start_date','end_date','responsible']
  when 'pcp' then array['op_number','op_date']
  when 'separacao' then case when p_data->>'sewing_type'='externa' then array['start_date','end_date','sewing_type','workshop','expected_date'] else array['start_date','end_date','sewing_type'] end
  when 'costura' then case when p.sewing_type='externa' then array['return_date'] else array['start_date','end_date'] end
  when 'lavanderia' then array['send_date','expected_date','return_date']
  else array['start_date','end_date'] end;
 if p_complete then
  foreach k in array req loop
   if coalesce(trim(p_data->>k),'')='' then raise exception 'Preencha o campo: %',k; end if;
  end loop;
  if p.stage<>'separacao' and p_data->>'confirmed' is distinct from 'true' then raise exception 'Confirme a conferência da grade'; end if;
 end if;
 if p.stage='separacao' and coalesce(p_data->>'sewing_type','') not in ('','interna','externa') then raise exception 'Tipo de costura inválido'; end if;
 foreach k in array array['start_date','end_date','op_date','expected_date','return_date','send_date'] loop
  v:=nullif(p_data->>k,'');
  if v is not null then
   if v!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'Data inválida'; end if;
   d:=v::date;
   -- Dates already saved retain their validity on subsequent working days.
   if d<business_today and v is distinct from old_record.data->>k then raise exception 'Datas novas não podem ser retroativas: %',k; end if;
  end if;
 end loop;
 if nullif(p_data->>'end_date','')::date<nullif(p_data->>'start_date','')::date then raise exception 'Fim anterior ao início'; end if;
 if nullif(p_data->>'return_date','')::date<nullif(p_data->>'send_date','')::date then raise exception 'Retorno anterior ao envio'; end if;
 if nullif(p_data->>'expected_date','')::date<coalesce(nullif(p_data->>'send_date','')::date,nullif(p_data->>'end_date','')::date) then raise exception 'Previsão anterior ao envio/preparação'; end if;
 if p.stage='costura' and p.sewing_type='externa' and nullif(p_data->>'return_date','')::date<(select nullif(data->>'end_date','')::date from public.stage_records where plan_id=p.id and stage='separacao') then raise exception 'Retorno anterior à preparação'; end if;
 insert into public.stage_records(plan_id,stage,data,input_grid,output_grid,scrap_grid,repair_grid,completed_at,actor_id)
 values(p.id,p.stage,p_data,p.current_grid,p_grid,p_scrap,p_repairs,case when p_complete then now() end,auth.uid())
 on conflict(plan_id,stage) do update set data=excluded.data,output_grid=excluded.output_grid,scrap_grid=excluded.scrap_grid,repair_grid=excluded.repair_grid,completed_at=excluded.completed_at,actor_id=excluded.actor_id,updated_at=now() returning * into rec;
 insert into public.audit_events(plan_id,actor_id,action,before_data,after_data) values(p.id,auth.uid(),case when p_complete then 'etapa_finalizada' else 'rascunho_salvo' end,case when old_record.id is not null then to_jsonb(old_record) end,to_jsonb(rec));
 update public.plans set
  current_grid=case when p_complete then p_grid else current_grid end,
  stage=case when p_complete then stages[array_position(stages,p.stage)+1] else stage end,
  sewing_type=case when p.stage='separacao' and p_complete then p_data->>'sewing_type' else sewing_type end,
  workshop=case when p.stage='separacao' and p_complete then case when p_data->>'sewing_type'='externa' then trim(p_data->>'workshop') end else workshop end,
  expected_date=case when p.stage='separacao' and p_complete then case when p_data->>'sewing_type'='externa' then (p_data->>'expected_date')::date end when p.stage='costura' and p_complete then null when p.stage='lavanderia' then nullif(p_data->>'expected_date','')::date else expected_date end,
  op_number=case when p.stage='pcp' and p_complete then trim(p_data->>'op_number') else op_number end,
  version=version+1,updated_at=now() where id=p.id returning * into p;
 return p;
end $$;

create or replace function public.release_partial(p_id uuid,p_version integer,p_data jsonb,p_grid jsonb,p_scrap jsonb,p_repairs jsonb) returns public.plans language plpgsql security definer set search_path='' as $$
declare p public.plans; child public.plans; consumed jsonb; remaining jsonb; k text; r text:=public.current_role();
begin
 select * into p from public.plans where id=p_id for update;
 if not found then raise exception 'Card não encontrado'; end if;
 if not public.has_responsibility(p.stage::text) or p.stage not in ('acabamento','embalagem') then raise exception 'Sem permissão para liberar parcela nesta etapa'; end if;
 if p.version is distinct from p_version then raise exception 'Este card foi atualizado. Feche e abra novamente.'; end if;
 if p.deleted_at is not null or p.split_at is not null or p.distributed_at is not null then raise exception 'Card excluído ou distribuído'; end if;
 if p.op_number is null then raise exception 'O card precisa de uma OP'; end if;
 perform public.check_grid(p_grid);perform public.check_grid(p_scrap);perform public.check_grid(p_repairs);
 if public.grid_total(p_grid)=0 then raise exception 'Informe ao menos uma peça pronta para avançar'; end if;
 consumed:=public.grid_math(p_grid,p_scrap);
 remaining:=public.grid_math(p.current_grid,consumed,-1);
 for k in select jsonb_object_keys(remaining) loop
  if (remaining->>k)::integer<0 then raise exception 'Tamanho %: parcela e refugos excedem o saldo disponível',k; end if;
 end loop;
 insert into public.plans(created_by,reference,description,responsible,combination,notes,planned_grid,current_grid,stage,sewing_type,workshop,op_number,parent_id,lineage_kind,lot_label,origin_stage)
 values(p.created_by,p.reference,p.description,p.responsible,p.combination,p.notes,consumed,consumed,p.stage,p.sewing_type,p.workshop,p.op_number,p.id,'partial',coalesce(p.lot_label||'.','')||(p.partial_count+1)::text,p.stage) returning * into child;
 -- Preserve dates already accepted in the source draft (e.g. work started yesterday).
 insert into public.stage_records(plan_id,stage,data,input_grid,output_grid,scrap_grid,repair_grid,actor_id)
 select child.id,p.stage,r.data,consumed,consumed,public.grid_math(consumed,consumed,-1),public.grid_math(consumed,consumed,-1),auth.uid()
 from public.stage_records r where r.plan_id=p.id and r.stage=p.stage and r.completed_at is null;
 -- The ordinary finalization validates dates, mandatory fields, repairs and conservation.
 child:=public.save_stage(child.id,child.version,p_data,p_grid,p_scrap,p_repairs,true);
 perform public.archive_stages(p.id,p.stage,'Rascunho substituído por liberação de parcela');
 if public.grid_total(remaining)>0 then
  insert into public.stage_records(plan_id,stage,data,input_grid,output_grid,scrap_grid,repair_grid,actor_id)
  values(p.id,p.stage,jsonb_build_object('start_date',p_data->>'start_date'),remaining,remaining,public.grid_math(remaining,remaining,-1),public.grid_math(remaining,remaining,-1),auth.uid());
 end if;
 update public.plans set current_grid=remaining,partial_count=partial_count+1,distributed_at=case when public.grid_total(remaining)=0 then now() end,version=version+1,updated_at=now() where id=p.id;
 insert into public.audit_events(plan_id,actor_id,action,before_data,after_data) values(p.id,auth.uid(),'parcela_liberada',to_jsonb(p),jsonb_build_object('child_id',child.id,'op_number',child.op_number,'lot_label',child.lot_label,'output_grid',p_grid,'scrap_grid',p_scrap,'repair_grid',p_repairs,'remaining_grid',remaining,'stage',p.stage::text));
 insert into public.audit_events(plan_id,actor_id,action,after_data) values(child.id,auth.uid(),'parcela_recebida',jsonb_build_object('parent_id',p.id,'plan',to_jsonb(child)));
 return child;
end $$;
revoke all on function public.save_plan_v1(jsonb,jsonb,uuid,integer),public.save_stage_v1(uuid,integer,jsonb,jsonb,jsonb,jsonb,boolean) from public,anon,authenticated;
commit;
