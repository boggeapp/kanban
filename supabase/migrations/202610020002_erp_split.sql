-- ERP supplies new OP numbers. Keep the original OP active with its remaining grid.
begin;
create or replace function public.split_plan(p_id uuid,p_version integer,p_parts jsonb,p_reason text) returns setof public.plans language plpgsql security definer set search_path='' as $$
declare p public.plans; child public.plans; part jsonb; assigned jsonb; remaining jsonb; k text; field text; children jsonb:='[]'::jsonb;
begin
 if public.current_role() is distinct from 'pcp' then raise exception 'Apenas PCP pode desmembrar OP'; end if;
 if coalesce(length(trim(p_reason)),0) not between 3 and 1000 then raise exception 'Informe um motivo de 3 a 1000 caracteres'; end if;
 select * into p from public.plans where id=p_id for update;
 if not found then raise exception 'Card não encontrado'; end if;
 if p.version is distinct from p_version then raise exception 'Este card foi atualizado. Feche e abra novamente.'; end if;
 if p.deleted_at is not null or p.split_at is not null or p.distributed_at is not null or p.parent_id is not null then raise exception 'Este card não pode ser desmembrado'; end if;
 if p.stage<>'lavanderia' or p.op_number is null or not exists(select 1 from public.stage_records where plan_id=p.id and stage='costura' and completed_at is not null) then raise exception 'Desmembre após finalizar Costura, antes de iniciar Lavanderia'; end if;
 if exists(select 1 from public.stage_records where plan_id=p.id and stage>='lavanderia') then raise exception 'O card já possui produção posterior'; end if;
 if p_parts is null or jsonb_typeof(p_parts)<>'array' then raise exception 'Novas OPs inválidas'; end if;
 if jsonb_array_length(p_parts) not between 1 and 100 then raise exception 'Informe de 1 a 100 novas OPs por operação'; end if;
 assigned:=public.grid_math(p.current_grid,p.current_grid,-1);
 for part in select value from jsonb_array_elements(p_parts) loop
  if jsonb_typeof(part) is distinct from 'object' then raise exception 'Cada nova OP deve conter número do ERP, referência, descrição e grade'; end if;
  foreach field in array array['op_number','reference','description'] loop
   if jsonb_typeof(part->field) is distinct from 'string' or coalesce(length(trim(part->>field)),0) not between 1 and 500 then raise exception 'Preencha % da nova OP (até 500 caracteres)',field; end if;
  end loop;
  perform public.check_grid(part->'grid');
  if public.grid_total(part->'grid')=0 then raise exception 'Cada nova OP deve conter ao menos uma peça'; end if;
  assigned:=public.grid_math(assigned,part->'grid');
 end loop;
 remaining:=public.grid_math(p.current_grid,assigned,-1);
 for k in select jsonb_object_keys(remaining) loop
  if (remaining->>k)::integer<0 then raise exception 'Tamanho %: novas OPs excedem o saldo disponível',k; end if;
 end loop;
 if public.grid_total(remaining)=0 then raise exception 'Mantenha ao menos uma peça na OP atual'; end if;
 -- Unique index rejects reused numbers, including the current OP and excluded OPs.
 -- Any conflict rolls back the entire operation, not only the conflicting child.
 for part in select value from jsonb_array_elements(p_parts) loop
  insert into public.plans(created_by,reference,description,responsible,combination,notes,planned_grid,current_grid,stage,sewing_type,workshop,op_number,parent_id,lineage_kind,origin_stage)
  values(p.created_by,trim(part->>'reference'),trim(part->>'description'),p.responsible,p.combination,p.notes,part->'grid',part->'grid','lavanderia',p.sewing_type,p.workshop,trim(part->>'op_number'),p.id,'split','lavanderia') returning * into child;
  children:=children||jsonb_build_array(jsonb_build_object('id',child.id,'op_number',child.op_number,'reference',child.reference,'description',child.description,'grid',child.current_grid));
  insert into public.audit_events(plan_id,actor_id,action,after_data) values(child.id,auth.uid(),'op_derivada_criada',jsonb_build_object('parent_id',p.id,'reason',trim(p_reason),'plan',to_jsonb(child)));
  return next child;
 end loop;
 update public.plans set current_grid=remaining,version=version+1,updated_at=now() where id=p.id;
 insert into public.audit_events(plan_id,actor_id,action,before_data,after_data) values(p.id,auth.uid(),'op_desmembrada',to_jsonb(p),jsonb_build_object('reason',trim(p_reason),'children',children,'remaining_grid',remaining));
end $$;
revoke all on function public.split_plan(uuid,integer,jsonb,text) from public,anon,authenticated;
grant execute on function public.split_plan(uuid,integer,jsonb,text) to authenticated;
commit;
