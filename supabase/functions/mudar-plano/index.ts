import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================
// mudar-plano
// Deixa o LOJISTA JA LOGADO trocar de plano sozinho (mensal <-> trimestral
// <-> anual), sem precisar falar com o suporte. Muda o valor/ciclo da
// assinatura JA EXISTENTE no Asaas -- nao cria assinatura nova, nao cobra
// nada na hora. A mudanca vale a partir da PROXIMA cobranca (o Asaas nao
// cobra retroativo quando voce muda ciclo/valor no meio do caminho).
//
// Seguranca: precisa de login valido (verify_jwt=true). A loja que vai ser
// alterada e SEMPRE a do usuario autenticado (via minha_loja_id(), que usa
// RLS) -- nunca vem do que o front-end manda, entao ninguem consegue trocar
// o plano de uma loja que nao e a sua.
//
// Segredos necessarios: os mesmos de criar-assinatura (ASAAS_API_KEY,
// ASAAS_AMBIENTE). SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY ja vem prontos.
//
// PLANOS precisa bater com criar-assinatura, com o admin e com o JS da landing page.
// 22/09/2026 -- anual passou de 419,90 para 499,00 (= 2 meses gratis).
// 14/10/2026 -- anual passou de 499,00 para 297,00 (preco de mercado).
// 18/10/2026 -- valor vem de planos_da_loja(): revendedor de fornecedor
//               parceiro (ex.: Mic) paga o preco especial do fornecedor.
// ============================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const PLANOS: Record<string, { valor: number; cycle: string }> = {
  mensal:     { valor: 49.90,  cycle: 'MONTHLY' },
  trimestral: { valor: 134.90, cycle: 'QUARTERLY' },
  anual:      { valor: 297.00, cycle: 'YEARLY' },
};

const ASAAS_BASE_URL = Deno.env.get('ASAAS_AMBIENTE') === 'producao'
  ? 'https://api.asaas.com/v3'
  : 'https://sandbox.asaas.com/api/v3';

function erro(mensagem: string, status = 400) {
  return new Response(JSON.stringify({ erro: mensagem }), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const asaasKey = Deno.env.get('ASAAS_API_KEY');
  if (!asaasKey) return erro('Assinaturas ainda não configuradas. Fale com o suporte.', 503);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return erro('Não autenticado.', 401);

  try {
    const { plano } = await req.json();
    if (!PLANOS[plano]) return erro('Plano inválido.');
    const { cycle } = PLANOS[plano];

    // Cliente COM o token de quem chamou -- pra descobrir a loja dele com
    // segurança de verdade (passa pelo RLS, nunca confia em loja_id vindo
    // do corpo da requisição).
    const supabaseComoUsuario = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: lojaId, error: erroLoja } = await supabaseComoUsuario.rpc('minha_loja_id');
    if (erroLoja || !lojaId) return erro('Não consegui identificar sua loja.', 403);

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Preco desta loja (oferta do fornecedor parceiro, se houver).
    const { data: precos } = await supabaseAdmin.rpc('planos_da_loja', { p_loja: lojaId });
    const valor = Number(precos?.[plano] ?? PLANOS[plano].valor);

    const { data: assinatura } = await supabaseAdmin
      .from('assinaturas').select('id, asaas_subscription_id').eq('loja_id', lojaId).maybeSingle();
    if (!assinatura?.asaas_subscription_id) return erro('Você ainda não tem uma assinatura pra mudar.', 404);

    const respAsaas = await fetch(`${ASAAS_BASE_URL}/subscriptions/${assinatura.asaas_subscription_id}`, {
      method: 'PUT',
      headers: { 'access_token': asaasKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: valor, cycle }),
    });
    const jsonAsaas = await respAsaas.json();
    if (!respAsaas.ok) {
      throw new Error('Asaas recusou a mudança de plano: ' + JSON.stringify(jsonAsaas.errors || jsonAsaas));
    }

    await supabaseAdmin.from('assinaturas').update({
      valor, updated_at: new Date().toISOString(),
    }).eq('id', assinatura.id);

    return new Response(JSON.stringify({ sucesso: true, novoPlano: plano, valor }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });

  } catch (e) {
    console.error('Erro em mudar-plano', e);
    return erro('Não consegui mudar seu plano agora: ' + (e instanceof Error ? e.message : String(e)), 500);
  }
});
