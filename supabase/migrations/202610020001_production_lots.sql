-- Additive upgrade: existing plans and finished stages are kept unchanged.
begin;
alter table public.plans
 add column parent_id uuid references public.plans(id),
 add column lineage_kind text check(lineage_kind in ('split','partial')),
 add column lot_label text,
 add column origin_stage public.production_stage not null default 'risco',
 add column partial_count integer not null default 0,
 add column split_at timestamptz,
 add column distributed_at timestamptz,
 add column deleted_at timestamptz,
 add column deleted_by uuid references public.profiles(id),
 add column deletion_reason text;
alter table public.plans add constraint plans_lineage_consistent check ((parent_id is null and lineage_kind is null) or (parent_id is not null and lineage_kind is not null));
create index plans_parent_idx on public.plans(parent_id);
drop index public.plans_op_unique;
-- Parcels share their OP; the original OP and each manually split OP remain unique,
-- including excluded cards. Numbers are never released by exclusion.
create unique index plans_op_unique on public.plans(op_number) where op_number is not null and lineage_kind is distinct from 'partial';

create table public.stage_archives (
 id uuid primary key default gen_random_uuid(),
 plan_id uuid not null references public.plans(id),
 stage public.production_stage not null,
 record jsonb not null,
 reason text not null,
 actor_id uuid not null references public.profiles(id),
 archived_at timestamptz not null default now()
);
create index stage_archives_plan on public.stage_archives(plan_id,archived_at desc);
alter table public.stage_archives enable row level security;
revoke all on public.stage_archives from anon,authenticated;
grant select on public.stage_archives to authenticated;
drop policy plans_read on public.plans;
create policy plans_read on public.plans for select to authenticated using (public.current_role() is not null and (deleted_at is null or public.current_role()='pcp'));
create policy archives_read on public.stage_archives for select to authenticated using (public.current_role() is not null and exists(select 1 from public.plans p where p.id=plan_id));
drop policy records_read on public.stage_records;
create policy records_read on public.stage_records for select to authenticated using (public.current_role() is not null and exists(select 1 from public.plans p where p.id=plan_id));
drop policy audit_read on public.audit_events;
create policy audit_read on public.audit_events for select to authenticated using (public.current_role() is not null and (plan_id is null or exists(select 1 from public.plans p where p.id=plan_id)));

create function public.grid_math(a jsonb,b jsonb,sign integer default 1) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_object_agg(k,to_jsonb((a->>k)::integer + (b->>k)::integer * sign)) from jsonb_object_keys(a) as t(k);
$$;
create function public.grid_total(g jsonb) returns bigint language sql immutable set search_path='' as $$
 select sum(value::text::integer) from jsonb_each(g);
$$;
create function public.archive_stages(p_id uuid,p_from public.production_stage,p_reason text) returns void language plpgsql security definer set search_path='' as $$
begin
 insert into public.stage_archives(plan_id,stage,record,reason,actor_id)
 select plan_id,stage,to_jsonb(r),p_reason,auth.uid() from public.stage_records r where plan_id=p_id and stage>=p_from;
 delete from public.stage_records where plan_id=p_id and stage>=p_from;
end $$;

-- Keep the already validated implementation private and add lifecycle guards.
alter function public.save_stage(uuid,integer,jsonb,jsonb,jsonb,jsonb,boolean) rename to save_stage_v1;
alter function public.save_plan(jsonb,jsonb,uuid,integer) rename to save_plan_v1;
revoke all on function public.save_stage_v1(uuid,integer,jsonb,jsonb,jsonb,jsonb,boolean),public.save_plan_v1(jsonb,jsonb,uuid,integer) from public,anon,authenticated;

create function public.save_stage(p_id uuid,p_version integer,p_data jsonb,p_grid jsonb,p_scrap jsonb,p_repairs jsonb,p_complete boolean default false) returns public.plans language plpgsql security definer set search_path='' as $$
declare p public.plans;
begin
 select * into p from public.plans where id=p_id for update;
 if not found then raise exception 'Card não encontrado'; end if;
 if p.deleted_at is not null or p.split_at is not null or p.distributed_at is not null then raise exception 'Card excluído ou distribuído: opere os cards de destino'; end if;
 return public.save_stage_v1(p_id,p_version,p_data,p_grid,p_scrap,p_repairs,p_complete);
end $$;
create function public.save_plan(p_data jsonb,p_grid jsonb,p_id uuid default null,p_version integer default null) returns public.plans language plpgsql security definer set search_path='' as $$
declare p public.plans;
begin
 if p_id is not null then
  select * into p from public.plans where id=p_id for update;
  if not found then raise exception 'Planejamento não encontrado'; end if;
  if p.deleted_at is not null or p.split_at is not null or p.distributed_at is not null or p.parent_id is not null then raise exception 'Este planejamento não pode ser editado'; end if;
  if exists(select 1 from public.stage_archives where plan_id=p_id) then raise exception 'Planejamento já iniciado: consulte o histórico'; end if;
 end if;
 return public.save_plan_v1(p_data,p_grid,p_id,p_version);
end $$;

create function public.split_plan(p_id uuid,p_version integer,p_parts jsonb,p_reason text) returns setof public.plans language plpgsql security definer set search_path='' as $$
declare p public.plans; child public.plans; g jsonb; assigned jsonb; idx integer:=0; children jsonb:='[]'::jsonb;
begin
 if public.current_role() is distinct from 'pcp' then raise exception 'Apenas PCP pode desmembrar OP'; end if;
 if coalesce(length(trim(p_reason)),0) not between 3 and 1000 then raise exception 'Informe um motivo de 3 a 1000 caracteres'; end if;
 select * into p from public.plans where id=p_id for update;
 if not found then raise exception 'Card não encontrado'; end if;
 if p.version is distinct from p_version then raise exception 'Este card foi atualizado. Feche e abra novamente.'; end if;
 if p.deleted_at is not null or p.split_at is not null or p.distributed_at is not null or p.parent_id is not null then raise exception 'Este card não pode ser desmembrado'; end if;
 if p.stage<>'lavanderia' or p.op_number is null or not exists(select 1 from public.stage_records where plan_id=p.id and stage='costura' and completed_at is not null) then raise exception 'Desmembre após finalizar Costura, antes de iniciar Lavanderia'; end if;
 if exists(select 1 from public.stage_records where plan_id=p.id and stage>='lavanderia') or exists(select 1 from public.plans where parent_id=p.id) then raise exception 'O card já possui produção posterior ou desmembramento'; end if;
 if p_parts is null or jsonb_typeof(p_parts)<>'array' then raise exception 'Partes inválidas'; end if;
 if jsonb_array_length(p_parts) not between 2 and 26 then raise exception 'Distribua entre 2 e 26 partes'; end if;
 assigned:=public.grid_math(p.current_grid,p.current_grid,-1);
 for g in select value from jsonb_array_elements(p_parts) loop
  perform public.check_grid(g);
  if public.grid_total(g)=0 then raise exception 'Cada parte deve conter ao menos uma peça'; end if;
  assigned:=public.grid_math(assigned,g);
 end loop;
 if assigned<>p.current_grid then raise exception 'A soma das partes deve ser igual ao saldo, em cada tamanho'; end if;
 for g in select value from jsonb_array_elements(p_parts) loop
  idx:=idx+1;
  insert into public.plans(created_by,reference,description,responsible,combination,notes,planned_grid,current_grid,stage,sewing_type,workshop,op_number,parent_id,lineage_kind,origin_stage)
  values(p.created_by,p.reference,p.description,p.responsible,p.combination,p.notes,g,g,'lavanderia',p.sewing_type,p.workshop,p.op_number||'-'||chr(64+idx),p.id,'split','lavanderia') returning * into child;
  children:=children||jsonb_build_array(jsonb_build_object('id',child.id,'op_number',child.op_number,'grid',g));
  insert into public.audit_events(plan_id,actor_id,action,after_data) values(child.id,auth.uid(),'op_derivada_criada',jsonb_build_object('parent_id',p.id,'reason',trim(p_reason),'plan',to_jsonb(child)));
  return next child;
 end loop;
 update public.plans set split_at=now(),version=version+1,updated_at=now() where id=p.id;
 insert into public.audit_events(plan_id,actor_id,action,before_data,after_data) values(p.id,auth.uid(),'op_desmembrada',to_jsonb(p),jsonb_build_object('reason',trim(p_reason),'children',children));
end $$;

create function public.release_partial(p_id uuid,p_version integer,p_data jsonb,p_grid jsonb,p_scrap jsonb,p_repairs jsonb) returns public.plans language plpgsql security definer set search_path='' as $$
declare p public.plans; child public.plans; consumed jsonb; remaining jsonb; k text; r text:=public.current_role();
begin
 select * into p from public.plans where id=p_id for update;
 if not found then raise exception 'Card não encontrado'; end if;
 if r is null or (r<>'pcp' and r<>p.stage::text) or p.stage not in ('acabamento','embalagem') then raise exception 'Sem permissão para liberar parcela nesta etapa'; end if;
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

create function public.return_stage(p_id uuid,p_version integer,p_target public.production_stage,p_reason text) returns public.plans language plpgsql security definer set search_path='' as $$
declare p public.plans; old_plan jsonb; target_record public.stage_records;
begin
 if public.current_role() is distinct from 'pcp' then raise exception 'Apenas PCP pode voltar etapa'; end if;
 if coalesce(length(trim(p_reason)),0) not between 3 and 1000 then raise exception 'Informe um motivo de 3 a 1000 caracteres'; end if;
 select * into p from public.plans where id=p_id for update;
 if not found then raise exception 'Card não encontrado'; end if;
 if p.version is distinct from p_version then raise exception 'Este card foi atualizado. Feche e abra novamente.'; end if;
 if p.deleted_at is not null or p.split_at is not null or p.distributed_at is not null then raise exception 'Card excluído ou distribuído'; end if;
 if p_target is null or p_target>=p.stage or p_target<p.origin_stage then raise exception 'Etapa de retorno inválida para este card'; end if;
 if exists(select 1 from public.plans where parent_id=p.id) then raise exception 'Este card originou outros cards. Retorne os cards de destino para não duplicar peças'; end if;
 select * into target_record from public.stage_records where plan_id=p.id and stage=p_target and completed_at is not null;
 if not found then raise exception 'Não existe etapa concluída correspondente neste card'; end if;
 old_plan:=to_jsonb(p);
 perform public.archive_stages(p.id,p_target,trim(p_reason));
 update public.plans set stage=p_target,current_grid=target_record.input_grid,version=version+1,updated_at=now(),expected_date=null,
  sewing_type=case when p_target<='separacao' then null else sewing_type end,
  workshop=case when p_target<='separacao' then null else workshop end
 where id=p.id returning * into p;
 insert into public.audit_events(plan_id,actor_id,action,before_data,after_data) values(p.id,auth.uid(),'etapa_retornada',old_plan,jsonb_build_object('reason',trim(p_reason),'target',p_target::text,'plan',to_jsonb(p)));
 return p;
end $$;

create function public.set_plan_deleted(p_id uuid,p_version integer,p_deleted boolean,p_reason text) returns public.plans language plpgsql security definer set search_path='' as $$
declare p public.plans; old_plan jsonb;
begin
 if public.current_role() is distinct from 'pcp' then raise exception 'Apenas PCP pode excluir ou restaurar cards'; end if;
 if p_deleted is null or coalesce(length(trim(p_reason)),0) not between 3 and 1000 then raise exception 'Informe um motivo de 3 a 1000 caracteres'; end if;
 select * into p from public.plans where id=p_id for update;
 if not found then raise exception 'Card não encontrado'; end if;
 if p.version is distinct from p_version then raise exception 'Este card foi atualizado. Feche e abra novamente.'; end if;
 if (p.deleted_at is not null)=p_deleted then raise exception 'O card já está nessa situação'; end if;
 if exists(select 1 from public.plans where parent_id=p.id) then raise exception 'Este card possui destinos vinculados; opere cada card de destino'; end if;
 old_plan:=to_jsonb(p);
 update public.plans set deleted_at=case when p_deleted then now() end,deleted_by=case when p_deleted then auth.uid() end,deletion_reason=case when p_deleted then trim(p_reason) end,version=version+1,updated_at=now() where id=p.id returning * into p;
 insert into public.audit_events(plan_id,actor_id,action,before_data,after_data) values(p.id,auth.uid(),case when p_deleted then 'card_excluido' else 'card_restaurado' end,old_plan,jsonb_build_object('reason',trim(p_reason),'plan',to_jsonb(p)));
 return p;
end $$;

revoke all on function public.grid_math(jsonb,jsonb,integer),public.grid_total(jsonb),public.archive_stages(uuid,public.production_stage,text),public.save_stage(uuid,integer,jsonb,jsonb,jsonb,jsonb,boolean),public.save_plan(jsonb,jsonb,uuid,integer),public.split_plan(uuid,integer,jsonb,text),public.release_partial(uuid,integer,jsonb,jsonb,jsonb,jsonb),public.return_stage(uuid,integer,public.production_stage,text),public.set_plan_deleted(uuid,integer,boolean,text) from public,anon,authenticated;
grant execute on function public.save_stage(uuid,integer,jsonb,jsonb,jsonb,jsonb,boolean),public.save_plan(jsonb,jsonb,uuid,integer),public.split_plan(uuid,integer,jsonb,text),public.release_partial(uuid,integer,jsonb,jsonb,jsonb,jsonb),public.return_stage(uuid,integer,public.production_stage,text),public.set_plan_deleted(uuid,integer,boolean,text) to authenticated;
commit;
