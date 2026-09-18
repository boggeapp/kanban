-- BOGGE: all business writes are transactional RPCs; clients have SELECT only.
begin;
create type public.production_stage as enum ('risco','corte','pcp','separacao','costura','lavanderia','acabamento','embalagem','concluido');
create table public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 name text not null check(length(name) between 1 and 150),
 role text not null default 'pendente' check(role in ('pendente','planejamento','pcp','risco','corte','separacao','costura','lavanderia','acabamento','embalagem')),
 active boolean not null default false,
 created_at timestamptz not null default now()
);
create sequence public.planning_number;
create table public.plans (
 id uuid primary key default gen_random_uuid(),
 number bigint not null unique default nextval('public.planning_number'),
 created_at timestamptz not null default now(),
 created_by uuid not null references public.profiles,
 reference text not null,
 description text not null,
 responsible text not null,
 combination text not null,
 notes text not null default '',
 planned_grid jsonb not null,
 current_grid jsonb not null,
 stage public.production_stage not null default 'risco',
 version integer not null default 1,
 updated_at timestamptz not null default now(),
 sewing_type text check(sewing_type in ('interna','externa')),
 workshop text,
 expected_date date,
 op_number text
);
create unique index plans_op_unique on public.plans(op_number) where op_number is not null;
create index plans_stage_updated on public.plans(stage,updated_at desc);
create table public.stage_records (
 id uuid primary key default gen_random_uuid(),
 plan_id uuid not null references public.plans(id),
 stage public.production_stage not null,
 data jsonb not null default '{}',
 input_grid jsonb not null,
 output_grid jsonb not null,
 scrap_grid jsonb not null,
 repair_grid jsonb not null,
 completed_at timestamptz,
 updated_at timestamptz not null default now(),
 actor_id uuid not null references public.profiles,
 unique(plan_id,stage)
);
create table public.audit_events (
 id bigint generated always as identity primary key,
 plan_id uuid references public.plans(id),
 actor_id uuid not null references public.profiles,
 action text not null,
 before_data jsonb,
 after_data jsonb not null,
 created_at timestamptz not null default now()
);
create index audit_plan_time on public.audit_events(plan_id,created_at desc);
create index records_plan on public.stage_records(plan_id);

create function public.current_role() returns text language sql stable security definer set search_path='' as $$
 select role from public.profiles where id=auth.uid() and active;
$$;
create function public.on_new_user() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.profiles(id,name) values(new.id,left(coalesce(nullif(trim(new.raw_user_meta_data->>'name'),''),'Novo usuário'),150));
 return new;
end $$;
create trigger new_auth_user after insert on auth.users for each row execute function public.on_new_user();
insert into public.profiles(id,name) select id,left(coalesce(nullif(trim(raw_user_meta_data->>'name'),''),'Usuário'),150) from auth.users on conflict do nothing;

alter table public.profiles enable row level security;
alter table public.plans enable row level security;
alter table public.stage_records enable row level security;
alter table public.audit_events enable row level security;
revoke all on public.profiles,public.plans,public.stage_records,public.audit_events from anon,authenticated;
grant select on public.profiles,public.plans,public.stage_records,public.audit_events to authenticated;
create policy profiles_read on public.profiles for select to authenticated using (id=auth.uid() or public.current_role() is not null);
create policy plans_read on public.plans for select to authenticated using (public.current_role() is not null);
create policy records_read on public.stage_records for select to authenticated using (public.current_role() is not null);
create policy audit_read on public.audit_events for select to authenticated using (public.current_role() is not null);

create function public.check_grid(g jsonb) returns void language plpgsql immutable set search_path='' as $$
declare s text; sizes text[]:=array['34','36','38','40','42','44','46','48','50','52','54','56','P','M','G','GG','G1','G2','G3'];
begin
 if g is null or jsonb_typeof(g)<>'object' then raise exception 'Grade inválida'; end if;
 if (select count(*) from jsonb_object_keys(g))<>19 then raise exception 'A grade deve conter os 19 tamanhos'; end if;
 foreach s in array sizes loop
  if not (g?s) or jsonb_typeof(g->s)<>'number' or (g->>s)!~'^[0-9]+$' then raise exception 'Quantidade inválida: %',s; end if;
  if (g->>s)::numeric>1000000 then raise exception 'Quantidade excede o limite: %',s; end if;
 end loop;
end $$;

create function public.save_plan(p_data jsonb,p_grid jsonb,p_id uuid default null,p_version integer default null) returns public.plans
language plpgsql security definer set search_path='' as $$
declare p public.plans; old_data jsonb; k text; r text:=public.current_role();
begin
 if r is null or r not in ('pcp','planejamento') then raise exception 'Sem permissão para planejamento'; end if;
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

create function public.save_stage(p_id uuid,p_version integer,p_data jsonb,p_grid jsonb,p_scrap jsonb,p_repairs jsonb,p_complete boolean default false) returns public.plans
language plpgsql security definer set search_path='' as $$
declare p public.plans; old_record public.stage_records; rec public.stage_records; r text:=public.current_role(); k text; v text; req text[]; d date; business_today date:=(now() at time zone 'America/Sao_Paulo')::date; stages public.production_stage[]:=array['risco','corte','pcp','separacao','costura','lavanderia','acabamento','embalagem','concluido']::public.production_stage[]; loss boolean;
begin
 select * into p from public.plans where id=p_id for update;
 if not found then raise exception 'Card não encontrado'; end if;
 if r is null or (r<>'pcp' and r<>p.stage::text) or p.stage='concluido' then raise exception 'Você não pode alterar esta etapa'; end if;
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

create function public.set_user_role(p_user uuid,p_role text,p_active boolean) returns void language plpgsql security definer set search_path='' as $$
declare old_profile public.profiles; new_profile public.profiles;
begin
 if public.current_role() is distinct from 'pcp' then raise exception 'Apenas PCP pode administrar usuários'; end if;
 if p_user=auth.uid() then raise exception 'Você não pode alterar seu próprio acesso'; end if;
 if p_role not in ('planejamento','pcp','risco','corte','separacao','costura','lavanderia','acabamento','embalagem') or p_role is null or p_active is null then raise exception 'Perfil inválido'; end if;
 select * into old_profile from public.profiles where id=p_user for update;
 if not found then raise exception 'Usuário não encontrado'; end if;
 update public.profiles set role=p_role,active=p_active where id=p_user returning * into new_profile;
 insert into public.audit_events(actor_id,action,before_data,after_data) values(auth.uid(),'permissao_alterada',to_jsonb(old_profile),to_jsonb(new_profile));
end $$;
revoke all on function public.current_role(),public.on_new_user(),public.check_grid(jsonb),public.save_plan(jsonb,jsonb,uuid,integer),public.save_stage(uuid,integer,jsonb,jsonb,jsonb,jsonb,boolean),public.set_user_role(uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.current_role(),public.save_plan(jsonb,jsonb,uuid,integer),public.save_stage(uuid,integer,jsonb,jsonb,jsonb,jsonb,boolean),public.set_user_role(uuid,text,boolean) to authenticated;
revoke all on sequence public.planning_number,public.audit_events_id_seq from anon,authenticated;
commit;
