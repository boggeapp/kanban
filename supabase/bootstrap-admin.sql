-- Execute apenas depois de cadastrar e confirmar o e-mail do primeiro PCP.
-- Troque o valor abaixo pelo e-mail explicitamente escolhido pelo responsável.
-- Não executar com o placeholder.
do $$
declare target_email text := 'SUBSTITUA_PELO_EMAIL_DO_PCP'; target_id uuid;
begin
 if target_email='SUBSTITUA_PELO_EMAIL_DO_PCP' then raise exception 'Informe o e-mail do primeiro PCP'; end if;
 select id into target_id from auth.users where lower(email)=lower(target_email) and email_confirmed_at is not null;
 if target_id is null then raise exception 'Conta não encontrada ou e-mail não confirmado'; end if;
 if exists(select 1 from public.profiles where active and role='pcp') then raise exception 'Já existe PCP. Use a gestão de usuários da aplicação.'; end if;
 update public.profiles set role='pcp',active=true where id=target_id;
 if not found then raise exception 'Perfil não encontrado; aplique a migração primeiro'; end if;
 insert into public.audit_events(actor_id,action,after_data) values(target_id,'primeiro_pcp_configurado',jsonb_build_object('id',target_id,'role','pcp','active',true));
end $$;
