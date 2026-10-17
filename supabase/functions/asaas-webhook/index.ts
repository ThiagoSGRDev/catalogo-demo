import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================
// asaas-webhook
// O Asaas chama esse endereco toda vez que algo muda numa cobranca
// (pagou, venceu, foi cancelada). A gente reage:
//   PAYMENT_RECEIVED / PAYMENT_CONFIRMED -> lojas.ativa = true, lojas.status = 'ativo'
//   PAYMENT_OVERDUE                      -> lojas.ativa = false, lojas.status = 'bloqueado'
//   PAYMENT_DELETED / SUBSCRIPTION_DELETED / PAYMENT_REFUNDED
//                                        -> lojas.ativa = false, lojas.status = 'cancelado'
//
// (alteracao 01/10/2026: passou a mexer tambem em lojas.status, porque o
// painel/TrialSystem decide o acesso por status -- sem isso, quem pagava
// continuava bloqueado ou caia no bloqueio do trial de 3 dias.)
//
// (alteracao 17/10/2026: quando a assinatura passa a ativa pela primeira vez,
// manda o Purchase para a Meta pelo servidor (API de Conversoes). Assim a venda
// e medida mesmo que o cliente feche a aba antes do Pix confirmar. O envio e
// "melhor esforco": se falhar ou faltar o token, a ativacao da loja NAO e afetada.)
//
// Seguranca: o Asaas manda de volta, em todo webhook, o "Webhook Token"
// que voce configurar no painel dele -- comparamos com ASAAS_WEBHOOK_TOKEN
// aqui. Sem bater, a chamada e recusada -- e o que impede qualquer pessoa
// de simplesmente chamar essa URL de fora fingindo ser o Asaas pra liberar
// uma loja de graca.
//
// Segredos (Project Settings > Edge Functions > Secrets):
//   ASAAS_WEBHOOK_TOKEN  -> um token que VOCE escolhe, cola aqui E no
//                           painel do Asaas (Configuracoes > Webhooks > "Token de autenticacao")
//   META_CAPI_TOKEN      -> token de acesso da API de Conversoes (Gerenciador de Eventos
//                           > conjunto de dados > Configuracoes). Sem ele, nao envia nada a Meta.
//   META_PIXEL_ID        -> opcional; padrao 1851397046180782 (conjunto de dados Katalogo Hub)
//   META_TEST_EVENT_CODE -> opcional; so para testar na aba "Eventos de teste". Remova depois.
//   ASAAS_API_KEY / ASAAS_AMBIENTE -> ja existem; usados para ler o WhatsApp e o nome do cliente
//                           no Asaas (o WhatsApp so fica guardado la).
// ============================================================

function resposta(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

// ---------- API de Conversoes da Meta (Purchase pelo servidor) ----------
async function sha256(valor: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(valor));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function normalizarTelefone(bruto: unknown): string | null {
  const d = String(bruto ?? '').replace(/\D/g, '');
  if (d.length < 10) return null;
  return d.startsWith('55') && d.length >= 12 ? d : '55' + d;
}

// Le o cadastro do cliente no Asaas (WhatsApp e nome so ficam guardados la). Nunca lanca erro.
async function clienteAsaas(customerId: string | undefined): Promise<any | null> {
  const chave = Deno.env.get('ASAAS_API_KEY');
  if (!chave || !customerId) return null;
  try {
    const base = Deno.env.get('ASAAS_AMBIENTE') === 'producao'
      ? 'https://api.asaas.com/v3' : 'https://sandbox.asaas.com/api/v3';
    const r = await fetch(`${base}/customers/${encodeURIComponent(customerId)}`, {
      headers: { 'access_token': chave }, signal: AbortSignal.timeout(4000),
    });
    return r.ok ? await r.json() : null;
  } catch (_) { return null; }
}

function normalizarNome(s: unknown): string | null {
  const t = String(s ?? '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
  return t || null;
}

// Nunca lanca erro: qualquer falha aqui so vira log.
async function enviarPurchaseParaMeta(supabaseAdmin: any, lojaId: string, payment: any) {
  const token = Deno.env.get('META_CAPI_TOKEN');
  if (!token) {
    console.log('META_CAPI_TOKEN nao configurado -- Purchase nao enviado a Meta.');
    return;
  }
  try {
    const pixelId = Deno.env.get('META_PIXEL_ID') || '1851397046180782';
    const { data: loja } = await supabaseAdmin.from('lojas').select('user_id').eq('id', lojaId).maybeSingle();
    const userId: string | undefined = loja?.user_id;
    if (!userId) return;

    const { data: u } = await supabaseAdmin.auth.admin.getUserById(userId);
    const user = u?.user;
    const cliente = await clienteAsaas(payment?.customer);
    const email = (user?.email || cliente?.email || '').trim().toLowerCase() || null;
    const telefone = normalizarTelefone(cliente?.mobilePhone || cliente?.phone || user?.phone);
    const partesNome = String(cliente?.name ?? '').trim().split(/\s+/).filter(Boolean);
    const primeiroNome = normalizarNome(partesNome[0]);
    const sobrenome = partesNome.length > 1 ? normalizarNome(partesNome[partesNome.length - 1]) : null;

    // Dados pessoais vao SEMPRE em hash SHA-256 (padrao da Meta); nada em texto puro.
    const userData: Record<string, unknown> = {
      external_id: [await sha256(String(userId))],
      country: [await sha256('br')],
    };
    if (email) userData.em = [await sha256(email)];
    if (telefone) userData.ph = [await sha256(telefone)];
    if (primeiroNome) userData.fn = [await sha256(primeiroNome)];
    if (sobrenome) userData.ln = [await sha256(sobrenome)];

    const valor = Number(payment?.value);
    const corpo: Record<string, unknown> = {
      data: [{
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        // Mesmo id que o navegador usa (assets/js/meta-pixel.js): a Meta conta a compra uma vez so.
        event_id: 'purchase_' + userId,
        action_source: 'website',
        event_source_url: 'https://katalogohub.com/landing-vendas.html',
        user_data: userData,
        custom_data: {
          currency: 'BRL',
          ...(valor > 0 ? { value: valor } : {}),
          content_name: 'Assinatura Katalogo Hub',
        },
      }],
    };
    const codigoTeste = Deno.env.get('META_TEST_EVENT_CODE');
    if (codigoTeste) corpo.test_event_code = codigoTeste;

    const r = await fetch(`https://graph.facebook.com/v21.0/${pixelId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(5000),
    });
    const txt = await r.text();
    if (!r.ok) console.error('Meta CAPI recusou o Purchase:', r.status, txt.slice(0, 300));
    else console.log('Meta CAPI ok:', txt.slice(0, 200));
  } catch (e) {
    console.error('Falha ao enviar Purchase a Meta (ignorada):', e);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return resposta({ ok: false }, 405);

  const tokenEsperado = Deno.env.get('ASAAS_WEBHOOK_TOKEN');
  const tokenRecebido = req.headers.get('asaas-access-token');

  if (!tokenEsperado) {
    console.error('ASAAS_WEBHOOK_TOKEN nao configurado -- recusando por seguranca.');
    return resposta({ ok: false, motivo: 'webhook nao configurado' }, 503);
  }
  if (tokenRecebido !== tokenEsperado) {
    console.error('Token de webhook nao bateu -- chamada recusada.');
    return resposta({ ok: false, motivo: 'token invalido' }, 401);
  }

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  try {
    const body = await req.json();
    const evento: string = body?.event;
    const payment = body?.payment;
    if (!evento || !payment) return resposta({ ok: true }); // formato inesperado, so confirma recebimento

    const subscriptionId: string | undefined = payment.subscription;
    const customerId: string | undefined = payment.customer;

    // Acha a assinatura correspondente no nosso banco (por subscription,
    // com fallback pra customer se por algum motivo subscription vier vazio).
    let query = supabaseAdmin.from('assinaturas').select('id, loja_id, status');
    query = subscriptionId ? query.eq('asaas_subscription_id', subscriptionId) : query.eq('asaas_customer_id', customerId);
    const { data: assinatura } = await query.maybeSingle();

    if (!assinatura) {
      console.error('Webhook recebido, mas nao achei assinatura correspondente:', subscriptionId, customerId);
      return resposta({ ok: true }); // confirma recebimento mesmo assim, senao o Asaas fica tentando de novo
    }

    const eventosAtivam = ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'];
    const eventosBloqueiam = ['PAYMENT_OVERDUE', 'PAYMENT_DELETED', 'SUBSCRIPTION_DELETED', 'PAYMENT_REFUNDED'];

    if (eventosAtivam.includes(evento)) {
      // So conta como venda quando a assinatura ESTAVA fora de 'active' (primeira ativacao ou
      // reativacao). Renovacao mensal e o 2o aviso do mesmo pagamento (CONFIRMED + RECEIVED) nao reenviam.
      const virouAtiva = assinatura.status !== 'active';

      await supabaseAdmin.from('lojas').update({ ativa: true, status: 'ativo' }).eq('id', assinatura.loja_id);
      await supabaseAdmin.from('assinaturas').update({
        status: 'active', updated_at: new Date().toISOString(),
        ...(payment.dueDate ? { proximo_vencimento: payment.dueDate } : {}),
      }).eq('id', assinatura.id);

      if (virouAtiva) await enviarPurchaseParaMeta(supabaseAdmin, assinatura.loja_id, payment);
    } else if (eventosBloqueiam.includes(evento)) {
      await supabaseAdmin.from('lojas').update({
        ativa: false,
        status: evento === 'PAYMENT_OVERDUE' ? 'bloqueado' : 'cancelado',
      }).eq('id', assinatura.loja_id);
      await supabaseAdmin.from('assinaturas').update({
        status: evento === 'PAYMENT_OVERDUE' ? 'overdue' : 'cancelled',
        updated_at: new Date().toISOString(),
      }).eq('id', assinatura.id);
    }
    // Outros eventos (ex.: PAYMENT_CREATED, PAYMENT_UPDATED) sao ignorados de
    // proposito -- so os que decidem acesso e que mexem em lojas.ativa/status.

    return resposta({ ok: true });
  } catch (e) {
    console.error('Erro ao processar webhook do Asaas', e);
    return resposta({ ok: false }, 500);
  }
});
