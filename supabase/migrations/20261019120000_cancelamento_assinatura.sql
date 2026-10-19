alter table public.assinaturas
  add column if not exists primeiro_pagamento_em timestamptz,
  add column if not exists asaas_payment_id      text,
  add column if not exists acesso_ate            date,
  add column if not exists cancelamento_em       timestamptz,
  add column if not exists reembolsada_em        timestamptz;

create or replace function public.expirar_acessos_cancelados() returns integer
language plpgsql security definer set search_path to 'public' as $$
declare n integer;
begin
  with vencidas as (
    update public.assinaturas set status='cancelled', updated_at=now()
     where status='cancelling' and acesso_ate is not null
       and acesso_ate <= (now() at time zone 'America/Sao_Paulo')::date
    returning loja_id)
  update public.lojas set ativa=false, status='cancelado' where id in (select loja_id from vencidas);
  get diagnostics n = row_count; return n;
end; $$;
revoke all on function public.expirar_acessos_cancelados() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname='expirar-acessos-cancelados';
select cron.schedule('expirar-acessos-cancelados','5 * * * *',$job$select public.expirar_acessos_cancelados()$job$);
