// InfinitePay (checkout por link). Mesma cópia em checkout/ e infinitepay-webhook/.
// Não usa segredo: a loja informa só a InfiniteTag (handle). A confirmação do
// pagamento SEMPRE passa pelo payment_check da própria InfinitePay (o aviso do
// webhook e os parâmetros da volta podem ser forjados; a consulta, não).
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const LINKS = ['https://api.checkout.infinitepay.io/links', 'https://api.infinitepay.io/invoices/public/checkout/links'];
const CHECK = ['https://api.checkout.infinitepay.io/payment_check', 'https://api.infinitepay.io/invoices/public/checkout/payment_check'];

async function postJson(urls: string[], body: unknown) {
  let ultimo: any = null;
  for (const url of urls) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) return { ok: true, data: j };
      ultimo = { ok: false, status: r.status, data: j };
    } catch (e) {
      ultimo = { ok: false, status: 0, data: { erro: String(e) } };
    }
  }
  return ultimo || { ok: false, status: 0, data: {} };
}

export async function ipCriarLink(payload: unknown): Promise<{ url: string | null; resposta: any }> {
  const r = await postJson(LINKS, payload);
  const d = r.data || {};
  const url = d.url || d.payment_url || d.link || d.checkout_url || null;
  return { url: r.ok && typeof url === 'string' ? url : null, resposta: r };
}

export async function ipPaymentCheck(handle: string, orderNsu: string, transactionNsu: string, slug: string) {
  const r = await postJson(CHECK, { handle, order_nsu: orderNsu, transaction_nsu: transactionNsu, slug });
  return r.ok ? r.data : null;
}

// Confere na InfinitePay e marca o pedido como pago (baixa estoque pelo pedido_confirmar_pago).
export async function ipConfirmar(db: SupabaseClient, pedidoId: string, transactionNsu: string, slug: string, recibo?: string) {
  if (!/^[0-9a-f-]{36}$/i.test(String(pedidoId || '')) || !transactionNsu || !slug) return 'dados_invalidos';
  const { data: ped } = await db.from('pedidos').select('id, loja_id, status, total, metodo').eq('id', pedidoId).maybeSingle();
  if (!ped || ped.metodo !== 'infinitepay') return 'pedido_invalido';
  if (ped.status === 'pago') return 'pago';
  const { data: ip } = await db.from('loja_infinitepay').select('handle').eq('loja_id', ped.loja_id).maybeSingle();
  if (!ip) return 'sem_conta';
  const chk: any = await ipPaymentCheck(ip.handle, ped.id, String(transactionNsu).slice(0, 80), String(slug).slice(0, 80));
  if (!chk || chk.paid !== true) return 'nao_pago';
  const esperado = Math.round(Number(ped.total) * 100);
  if (Number(chk.amount) + 1 < esperado) {
    await db.from('pedidos').update({ mp_status_detalhe: 'valor_divergente' }).eq('id', ped.id);
    return 'divergente';
  }
  await db.from('pedidos').update({
    ip_slug: String(slug).slice(0, 80), ip_transaction_nsu: String(transactionNsu).slice(0, 80),
    ip_recibo: recibo && /^https:\/\//.test(recibo) ? String(recibo).slice(0, 300) : null,
  }).eq('id', ped.id);
  await db.rpc('pedido_confirmar_pago', {
    p_pedido: ped.id, p_payment_id: 'ip:' + String(transactionNsu).slice(0, 80),
    p_detalhe: 'infinitepay:' + String(chk.capture_method || '').slice(0, 20),
  });
  return 'pago';
}
