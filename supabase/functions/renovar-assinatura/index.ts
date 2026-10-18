import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================
// renovar-assinatura
// Lojista JA LOGADO (trial acabando/expirado, ou assinatura cancelada/em
// atraso) gera o Pix de uma assinatura nova, sem criar conta nem loja nova.
// A liberacao do painel e feita pelo asaas-webhook quando o Pix cai.
//
// Seguranca:
//  - verify_jwt=true: so usuario logado.
//  - A loja e SEMPRE a do usuario autenticado (minha_loja_id, via RLS);
//    nunca vem do corpo da requisicao.
//  - Rate limit por loja (tabela tentativas_cadastro): 5 por hora.
//  - Se a assinatura ja esta ativa, recusa (troca de plano = mudar-plano).
//
// Segredos: ASAAS_API_KEY, ASAAS_AMBIENTE (mesmos das outras funcoes).
// PLANOS precisa bater com criar-assinatura, mudar-plano, admin e landing.
// 14/10/2026 -- anual passou de 499,00 para 297,00.
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

const JANELA_MINUTOS = 60;
const LIMITE_TENTATIVAS = 5;

const ASAAS_BASE_URL = Deno.env.get('ASAAS_AMBIENTE') === 'producao'
  ? 'https://api.asaas.com/v3'
  : 'https://sandbox.asaas.com/api/v3';

function erro(mensagem: string, status = 400) {
  return new Response(JSON.stringify({ erro: mensagem }), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function dormir(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Data UTC nunca fica antes da data do Brasil, entao o Asaas nao recusa por "data passada".
function hoje(): string { return new Date().toISOString().split('T')[0]; }

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const asaasKey = Deno.env.get('ASAAS_API_KEY');
  if (!asaasKey) return erro('Assinaturas ainda não configuradas. Fale com o suporte.', 503);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return erro('Não autenticado.', 401);

  try {
    const { nomeCompleto, cpfCnpj, whatsapp, plano } = await req.json();

    if (!PLANOS[plano]) return erro('Plano inválido.');
    if (!nomeCompleto || String(nomeCompleto).trim().length < 3) return erro('Informe seu nome completo.');
    const cpfCnpjLimpo = String(cpfCnpj || '').replace(/\D/g, '');
    if (cpfCnpjLimpo.length !== 11 && cpfCnpjLimpo.length !== 14) return erro('CPF ou CNPJ inválido. Confira os números e tente de novo.');
    const whatsappLimpo = String(whatsapp || '').replace(/\D/g, '');
    if (whatsappLimpo.length < 10 || whatsappLimpo.length > 11) return erro('WhatsApp inválido. Use DDD + número.');
    const { cycle } = PLANOS[plano];

    // Identifica usuario e loja pelo token de quem chamou (nunca pelo corpo).
    const supabaseComoUsuario = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: dadosUsuario, error: erroUsuario } = await supabaseComoUsuario.auth.getUser();
    const emailUsuario = dadosUsuario?.user?.email;
    if (erroUsuario || !emailUsuario) return erro('Sessão inválida. Entre no painel de novo.', 401);

    const { data: lojaId, error: erroLoja } = await supabaseComoUsuario.rpc('minha_loja_id');
    if (erroLoja || !lojaId) return erro('Não consegui identificar sua loja.', 403);

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Preco desta loja (oferta do fornecedor parceiro, se houver).
    const { data: precos } = await supabaseAdmin.rpc('planos_da_loja', { p_loja: lojaId });
    const valor = Number(precos?.[plano] ?? PLANOS[plano].valor);

    // ---- Rate limit por loja ----
    const chave = 'renov:' + lojaId;
    const desde = new Date(Date.now() - JANELA_MINUTOS * 60 * 1000).toISOString();
    const { count } = await supabaseAdmin
      .from('tentativas_cadastro').select('id', { count: 'exact', head: true })
      .eq('chave', chave).gte('criado_em', desde);
    if ((count ?? 0) >= LIMITE_TENTATIVAS) {
      return erro('Muitas tentativas em pouco tempo. Aguarde um pouco e tente de novo, ou fale com o suporte.', 429);
    }
    await supabaseAdmin.from('tentativas_cadastro').insert({ chave });

    const { data: loja } = await supabaseAdmin.from('lojas').select('id, nome, status').eq('id', lojaId).maybeSingle();
    if (!loja) return erro('Loja não encontrada.', 404);
    if (loja.status === 'ativo') return erro('Sua loja já está ativa.', 409);

    const { data: existente } = await supabaseAdmin
      .from('assinaturas').select('id, status, asaas_customer_id, asaas_subscription_id')
      .eq('loja_id', lojaId).maybeSingle();
    if (existente?.status === 'active') {
      return erro('Sua assinatura já está ativa. Use "Assinatura" no painel para trocar de plano.', 409);
    }

    // ---- Cliente no Asaas (reaproveita se ja existe) ----
    let asaasCustomerId: string | undefined = existente?.asaas_customer_id || undefined;
    if (!asaasCustomerId) {
      const busca = await fetch(`${ASAAS_BASE_URL}/customers?cpfCnpj=${cpfCnpjLimpo}`, { headers: { 'access_token': asaasKey } });
      asaasCustomerId = (await busca.json())?.data?.[0]?.id;
    }
    if (!asaasCustomerId) {
      const cria = await fetch(`${ASAAS_BASE_URL}/customers`, {
        method: 'POST',
        headers: { 'access_token': asaasKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: String(nomeCompleto).trim(), cpfCnpj: cpfCnpjLimpo, email: emailUsuario, mobilePhone: whatsappLimpo }),
      });
      const criaJson = await cria.json();
      if (!cria.ok || !criaJson.id) throw new Error('Asaas recusou o cliente: ' + JSON.stringify(criaJson.errors || criaJson));
      asaasCustomerId = criaJson.id;
    }

    // ---- Assinatura nova (primeira cobranca vence hoje) ----
    const criaAssinatura = await fetch(`${ASAAS_BASE_URL}/subscriptions`, {
      method: 'POST',
      headers: { 'access_token': asaasKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer: asaasCustomerId,
        billingType: 'PIX',
        cycle,
        value: valor,
        nextDueDate: hoje(),
        description: `Assinatura Katalogo Hub (${plano}) - ${loja.nome}`,
      }),
    });
    const assinaturaJson = await criaAssinatura.json();
    if (!criaAssinatura.ok || !assinaturaJson.id) {
      throw new Error('Asaas recusou a assinatura: ' + JSON.stringify(assinaturaJson.errors || assinaturaJson));
    }
    const novaSubscriptionId: string = assinaturaJson.id;

    // Grava ANTES de buscar o QR: se algo falhar depois, o webhook ainda
    // acha a assinatura quando o Pix for pago.
    const registro = {
      asaas_customer_id: asaasCustomerId,
      asaas_subscription_id: novaSubscriptionId,
      status: 'pending',
      valor,
      proximo_vencimento: hoje(),
      updated_at: new Date().toISOString(),
    };
    if (existente) {
      const { error: erroUpd } = await supabaseAdmin.from('assinaturas').update(registro).eq('id', existente.id);
      if (erroUpd) throw new Error('Não consegui salvar a assinatura: ' + erroUpd.message);
    } else {
      const { error: erroIns } = await supabaseAdmin.from('assinaturas').insert({ loja_id: lojaId, ...registro });
      if (erroIns) throw new Error('Não consegui salvar a assinatura: ' + erroIns.message);
    }

    // Cancela a assinatura antiga (pendente/em atraso/cancelada) pra nao cobrar duas vezes.
    // Ja trocamos o id no banco, entao o webhook do cancelamento nao acha mais linha e ignora.
    if (existente?.asaas_subscription_id && existente.asaas_subscription_id !== novaSubscriptionId) {
      try {
        await fetch(`${ASAAS_BASE_URL}/subscriptions/${existente.asaas_subscription_id}`, {
          method: 'DELETE', headers: { 'access_token': asaasKey },
        });
      } catch (e) { console.error('Não consegui cancelar a assinatura antiga (seguindo mesmo assim)', e); }
    }

    // ---- Primeira cobranca + QR Code ----
    let primeiroPagamento: any = null;
    for (let i = 0; i < 4 && !primeiroPagamento; i++) {
      if (i > 0) await dormir(1200);
      const r = await fetch(`${ASAAS_BASE_URL}/payments?subscription=${novaSubscriptionId}`, { headers: { 'access_token': asaasKey } });
      primeiroPagamento = (await r.json())?.data?.[0] || null;
    }
    if (!primeiroPagamento?.id) throw new Error('Assinatura criada, mas não encontrei a cobrança pra gerar o Pix. Tente de novo em instantes.');

    let qr: any = null;
    for (let i = 0; i < 4; i++) {
      if (i > 0) await dormir(1200);
      const r = await fetch(`${ASAAS_BASE_URL}/payments/${primeiroPagamento.id}/pixQrCode`, { headers: { 'access_token': asaasKey } });
      const j = await r.json();
      if (r.ok && j?.encodedImage && j?.payload) { qr = j; break; }
      console.error('pixQrCode sem dados (tentativa ' + i + ')', JSON.stringify(j));
    }
    if (!qr) throw new Error('O QR Code Pix ainda não ficou pronto. Tente de novo em instantes.');

    return new Response(JSON.stringify({
      sucesso: true,
      lojaId,
      valor,
      qrCodeBase64: qr.encodedImage,
      pixCopiaECola: qr.payload,
      expiracao: qr.expirationDate || null,
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } });

  } catch (e) {
    console.error('Erro em renovar-assinatura', e);
    return erro('Não consegui gerar seu Pix agora: ' + (e instanceof Error ? e.message : String(e)), 500);
  }
});
