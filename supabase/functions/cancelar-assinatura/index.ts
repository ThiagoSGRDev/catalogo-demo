import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================
// cancelar-assinatura
// O LOJISTA JA LOGADO cancela a propria assinatura pelo painel.
//
// Regra (a mesma dos Termos de Uso, secao 5):
//  - Ate 7 dias depois do PRIMEIRO pagamento: reembolso integral. Estorna a
//    cobranca no Asaas, apaga a assinatura e a loja sai do ar na hora.
//  - Depois de 7 dias: cancela sem reembolso. Apaga a assinatura no Asaas (nao
//    cobra mais), e a loja continua no ar ate o fim do periodo ja pago
//    (assinaturas.acesso_ate). O job expirar_acessos_cancelados() (pg_cron,
//    de hora em hora) encerra o acesso depois disso.
//  - Reembolso so uma vez por loja (assinaturas.reembolsada_em).
//
// Corpo opcional: { simular: true } -> nao muda nada, so devolve o que
// aconteceria ({ reembolso, acessoAte }). O painel usa isso na confirmacao.
//
// Seguranca:
//  - verify_jwt=true: so usuario logado.
//  - A loja e SEMPRE a do usuario autenticado (minha_loja_id, via RLS); nunca
//    vem do corpo da requisicao.
//  - A checagem dos 7 dias e feita aqui, no servidor, nunca no navegador.
//  - cancelamento_em funciona como trava: duplo clique nao estorna duas vezes.
//  - Rate limit por loja (tabela tentativas_cadastro): 20 por hora.
//
// Segredos: ASAAS_API_KEY, ASAAS_AMBIENTE (mesmos das outras funcoes).
// ============================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const JANELA_DIAS = 7;
const JANELA_MINUTOS = 60;
const LIMITE_TENTATIVAS = 20;

const MESES_POR_CICLO: Record<string, number> = {
  MONTHLY: 1, BIMONTHLY: 2, QUARTERLY: 3, SEMIANNUALLY: 6, YEARLY: 12,
};

const ASAAS_BASE_URL = Deno.env.get('ASAAS_AMBIENTE') === 'producao'
  ? 'https://api.asaas.com/v3'
  : 'https://sandbox.asaas.com/api/v3';

function resp(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
function erro(mensagem: string, status = 400) { return resp({ erro: mensagem }, status); }

function dormir(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// Data (AAAA-MM-DD) no horario de Brasilia.
function dataBR(d: Date): string {
  return new Date(d.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function diasEntre(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}
// Soma meses a uma data AAAA-MM-DD sem estourar o fim do mes (31/01 + 1 mes = 28/02).
function somarMeses(iso: string, meses: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const alvo = new Date(Date.UTC(y, m - 1 + meses, 1));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(d, ultimoDia));
  return alvo.toISOString().slice(0, 10);
}
function fmtBR(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

async function asaas(path: string, init: RequestInit = {}) {
  const r = await fetch(`${ASAAS_BASE_URL}${path}`, {
    ...init,
    headers: {
      'access_token': Deno.env.get('ASAAS_API_KEY')!,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  let json: any = null;
  try { json = await r.json(); } catch (_) { /* corpo vazio */ }
  return { ok: r.ok, status: r.status, json };
}

// Apaga a assinatura no Asaas (para de cobrar). 404 = ja estava apagada = ok.
async function apagarAssinaturaAsaas(subscriptionId: string): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    if (i > 0) await dormir(900);
    try {
      const r = await asaas(`/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: 'DELETE' });
      if (r.ok || r.status === 404) return true;
      console.error('Asaas recusou apagar a assinatura (tentativa ' + i + ')', r.status, JSON.stringify(r.json?.errors ?? r.json));
    } catch (e) {
      console.error('Falha de rede ao apagar a assinatura (tentativa ' + i + ')', e);
    }
  }
  return false;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return erro('Método não permitido.', 405);

  if (!Deno.env.get('ASAAS_API_KEY')) return erro('Assinaturas ainda não configuradas. Fale com o suporte.', 503);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return erro('Não autenticado.', 401);

  let supabaseAdmin: any = null;
  let assinaturaTravadaId: string | null = null; // trava de cancelamento ainda nao concluido

  try {
    const corpo = await req.json().catch(() => ({}));
    const simular = corpo?.simular === true;

    // Identifica usuario e loja pelo token de quem chamou (nunca pelo corpo).
    const supabaseComoUsuario = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: dadosUsuario, error: erroUsuario } = await supabaseComoUsuario.auth.getUser();
    if (erroUsuario || !dadosUsuario?.user) return erro('Sessão inválida. Entre no painel de novo.', 401);

    const { data: lojaId, error: erroLoja } = await supabaseComoUsuario.rpc('minha_loja_id');
    if (erroLoja || !lojaId) return erro('Não consegui identificar sua loja.', 403);

    supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // ---- Rate limit por loja ----
    const chave = 'cancel:' + lojaId;
    const desde = new Date(Date.now() - JANELA_MINUTOS * 60 * 1000).toISOString();
    const { count } = await supabaseAdmin
      .from('tentativas_cadastro').select('id', { count: 'exact', head: true })
      .eq('chave', chave).gte('criado_em', desde);
    if ((count ?? 0) >= LIMITE_TENTATIVAS) {
      return erro('Muitas tentativas em pouco tempo. Aguarde um pouco e tente de novo, ou fale com o suporte.', 429);
    }
    await supabaseAdmin.from('tentativas_cadastro').insert({ chave });

    // ---- Assinatura da loja ----
    const { data: ass } = await supabaseAdmin
      .from('assinaturas')
      .select('id, status, asaas_subscription_id, asaas_payment_id, primeiro_pagamento_em, proximo_vencimento, acesso_ate, cancelamento_em, reembolsada_em')
      .eq('loja_id', lojaId).maybeSingle();

    if (!ass?.asaas_subscription_id) return erro('Você ainda não tem uma assinatura para cancelar.', 404);
    if (ass.status === 'cancelling') {
      return erro(`Sua assinatura já está cancelada. O acesso continua até ${fmtBR(ass.acesso_ate)}.`, 409);
    }
    if (ass.status === 'cancelled') return erro('Sua assinatura já foi cancelada.', 409);
    if (ass.status !== 'active') {
      return erro('Só dá para cancelar uma assinatura ativa (já paga). Se tem um Pix pendente, é só não pagar.', 409);
    }

    // ---- Primeiro pagamento (banco; se faltar, busca no Asaas) ----
    let primeiroEm: string | null = ass.primeiro_pagamento_em;
    let primeiraCobranca: string | null = ass.asaas_payment_id;
    if (!primeiroEm || !primeiraCobranca) {
      const r = await asaas(`/payments?subscription=${encodeURIComponent(ass.asaas_subscription_id)}&limit=100`);
      if (!r.ok) throw new Error('Não consegui consultar seu pagamento agora. Tente de novo em instantes.');
      const dia = (p: any) => String(p.paymentDate ?? p.confirmedDate ?? p.dateCreated ?? '');
      const pagas = (r.json?.data ?? [])
        .filter((p: any) => ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(p.status))
        .sort((a: any, b: any) => dia(a).localeCompare(dia(b)));
      if (pagas[0]) {
        primeiraCobranca = pagas[0].id;
        const d = dia(pagas[0]);
        primeiroEm = new Date(d.length === 10 ? d + 'T12:00:00-03:00' : d).toISOString();
      }
    }

    // ---- Tem direito a reembolso? ----
    const jaReembolsou = !!ass.reembolsada_em;
    const dentroDoPrazo = !!primeiroEm &&
      diasEntre(dataBR(new Date(primeiroEm)), dataBR(new Date())) <= JANELA_DIAS;
    const reembolsar = !jaReembolsou && dentroDoPrazo && !!primeiraCobranca;
    const motivoSemReembolso = reembolsar ? null
      : jaReembolsou ? 'ja_reembolsou'
      : !primeiraCobranca ? 'sem_cobranca'
      : 'fora_do_prazo';

    // ---- Ate quando o acesso continua (so quando nao ha reembolso) ----
    let acessoAte: string | null = null;
    if (!reembolsar) {
      const s = await asaas(`/subscriptions/${encodeURIComponent(ass.asaas_subscription_id)}`);
      if (!s.ok && s.status !== 404) throw new Error('Não consegui consultar sua assinatura agora. Tente de novo em instantes.');
      const meses = MESES_POR_CICLO[String(s.json?.cycle)] ?? 1;
      const hoje = dataBR(new Date());
      // proximo_vencimento guarda o vencimento da ultima cobranca PAGA; o periodo pago vai ate esse dia + 1 ciclo.
      const base = ass.proximo_vencimento ?? (primeiroEm ? dataBR(new Date(primeiroEm)) : hoje);
      acessoAte = somarMeses(String(base), meses);
      if (acessoAte < hoje) acessoAte = hoje;
    }

    if (simular) {
      return resp({ sucesso: true, simulacao: true, reembolso: reembolsar, motivoSemReembolso, acessoAte });
    }

    // ---- Trava contra duplo clique / chamadas paralelas ----
    const agoraISO = new Date().toISOString();
    const { data: trava } = await supabaseAdmin
      .from('assinaturas')
      .update({
        cancelamento_em: agoraISO, updated_at: agoraISO,
        ...(primeiroEm ? { primeiro_pagamento_em: primeiroEm } : {}),
        ...(primeiraCobranca ? { asaas_payment_id: primeiraCobranca } : {}),
      })
      .eq('id', ass.id).eq('status', 'active').is('cancelamento_em', null)
      .select('id');
    if (!trava?.length) return erro('Seu cancelamento já está em andamento ou concluído.', 409);
    assinaturaTravadaId = ass.id;

    // ================= COM REEMBOLSO =================
    if (reembolsar) {
      const rf = await asaas(`/payments/${encodeURIComponent(primeiraCobranca!)}/refund`, {
        method: 'POST',
        body: JSON.stringify({ description: 'Reembolso (garantia de 7 dias) - Katalogo Hub' }),
      });
      if (!rf.ok) {
        console.error('Asaas recusou o estorno', rf.status, JSON.stringify(rf.json?.errors ?? rf.json));
        await supabaseAdmin.from('assinaturas').update({ cancelamento_em: null }).eq('id', ass.id);
        assinaturaTravadaId = null;
        return erro('Não consegui estornar o pagamento automaticamente. Fale com o suporte pelo WhatsApp que a gente resolve na hora.', 502);
      }

      // O dinheiro ja voltou: fecha o estado local antes de qualquer outra coisa.
      await supabaseAdmin.from('assinaturas').update({
        status: 'cancelled', reembolsada_em: agoraISO, acesso_ate: null, updated_at: agoraISO,
      }).eq('id', ass.id);
      await supabaseAdmin.from('lojas').update({ ativa: false, status: 'cancelado' }).eq('id', lojaId);
      assinaturaTravadaId = null;

      const apagou = await apagarAssinaturaAsaas(ass.asaas_subscription_id);
      if (!apagou) console.error('ATENCAO: reembolso feito, mas a assinatura no Asaas NAO foi apagada. Apagar na mao:', ass.asaas_subscription_id);
      return resp({ sucesso: true, reembolso: true, acessoAte: null });
    }

    // ================= SEM REEMBOLSO =================
    // Marca 'cancelling' ANTES de apagar no Asaas: apagar gera PAYMENT_DELETED das
    // cobrancas futuras, e o webhook usa esse status para nao bloquear a loja.
    await supabaseAdmin.from('assinaturas').update({
      status: 'cancelling', acesso_ate: acessoAte, updated_at: agoraISO,
    }).eq('id', ass.id);

    const apagou = await apagarAssinaturaAsaas(ass.asaas_subscription_id);
    if (!apagou) {
      await supabaseAdmin.from('assinaturas').update({
        status: 'active', acesso_ate: null, cancelamento_em: null, updated_at: new Date().toISOString(),
      }).eq('id', ass.id);
      assinaturaTravadaId = null;
      return erro('Não consegui cancelar agora. Nada foi alterado. Tente de novo em instantes ou fale com o suporte.', 502);
    }
    assinaturaTravadaId = null;
    return resp({ sucesso: true, reembolso: false, acessoAte });

  } catch (e) {
    console.error('Erro em cancelar-assinatura', e);
    if (assinaturaTravadaId && supabaseAdmin) {
      try {
        await supabaseAdmin.from('assinaturas').update({
          status: 'active', acesso_ate: null, cancelamento_em: null, updated_at: new Date().toISOString(),
        }).eq('id', assinaturaTravadaId).in('status', ['active', 'cancelling']);
      } catch (_) { /* melhor esforco */ }
    }
    return erro('Não consegui cancelar agora: ' + (e instanceof Error ? e.message : String(e)), 500);
  }
});
