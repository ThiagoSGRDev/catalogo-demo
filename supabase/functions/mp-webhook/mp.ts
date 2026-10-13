// Utilidades compartilhadas do checkout próprio (Mercado Pago).
// Mesma cópia em mp-conectar/, checkout/ e mp-webhook/ (cada função é empacotada sozinha).
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export const SITE_URL = 'https://www.katalogohub.com';
export const MP_API = 'https://api.mercadopago.com';
export const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
export const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
export const MP_CLIENT_ID = Deno.env.get('MP_CLIENT_ID') || '';
export const MP_CLIENT_SECRET = Deno.env.get('MP_CLIENT_SECRET') || '';
export const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/mp-conectar`;

// Comissão da plataforma: DESLIGADA (o Katalogo Hub cobra só a mensalidade).
// O lojista paga apenas a tarifa do próprio Mercado Pago.
export const TAXA_PERCENTUAL = 0;
export const TAXA_TETO = 0;
export function calcularTaxa(total: number): number {
  return Math.min(TAXA_TETO, Math.round(total * TAXA_PERCENTUAL * 100) / 100);
}

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

export function admin(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function mpConfigurado() {
  return !!(MP_CLIENT_ID && MP_CLIENT_SECRET);
}

// Token de acesso da loja; renova sozinho quando está perto de vencer.
export async function tokenDaLoja(db: SupabaseClient, lojaId: string): Promise<string | null> {
  const { data: c } = await db.from('mp_contas').select('*').eq('loja_id', lojaId).maybeSingle();
  if (!c) return null;
  const venceLogo = c.expira_em && new Date(c.expira_em).getTime() - Date.now() < 7 * 24 * 3600 * 1000;
  if (!venceLogo || !c.refresh_token || !mpConfigurado()) return c.access_token;
  try {
    const r = await fetch(`${MP_API}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: MP_CLIENT_ID, client_secret: MP_CLIENT_SECRET,
        grant_type: 'refresh_token', refresh_token: c.refresh_token,
      }),
    });
    const t = await r.json();
    if (!r.ok || !t.access_token) { console.error('Falha ao renovar token MP', r.status, t); return c.access_token; }
    await db.from('mp_contas').update({
      access_token: t.access_token,
      refresh_token: t.refresh_token || c.refresh_token,
      public_key: t.public_key || c.public_key,
      expira_em: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : c.expira_em,
      atualizado_em: new Date().toISOString(),
    }).eq('loja_id', lojaId);
    return t.access_token;
  } catch (e) {
    console.error('Erro ao renovar token MP', e);
    return c.access_token;
  }
}

export async function mpGet(token: string, caminho: string) {
  const r = await fetch(`${MP_API}${caminho}`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: j };
}

export async function mpPost(token: string, caminho: string, body: unknown, idem?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (idem) headers['X-Idempotency-Key'] = idem;
  const r = await fetch(`${MP_API}${caminho}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: j };
}

// Aplica o status de um pagamento do Mercado Pago no pedido (usado pelo webhook e pela consulta).
export async function aplicarPagamento(db: SupabaseClient, lojaId: string, pag: any) {
  const pedidoId = pag?.external_reference;
  if (!pedidoId) return null;
  const { data: ped } = await db.from('pedidos').select('id, loja_id, status, total').eq('id', pedidoId).maybeSingle();
  if (!ped || ped.loja_id !== lojaId) return null;
  const st = pag.status;
  if (st === 'approved') {
    // Confere valor: protege contra pagamento de valor diferente do pedido.
    if (Math.abs(Number(pag.transaction_amount) - Number(ped.total)) > 0.01) {
      console.error('Valor pago difere do pedido', pedidoId, pag.transaction_amount, ped.total);
      await db.from('pedidos').update({ mp_status_detalhe: 'valor_divergente', mp_payment_id: String(pag.id) }).eq('id', pedidoId);
      return 'divergente';
    }
    await db.rpc('pedido_confirmar_pago', { p_pedido: pedidoId, p_payment_id: String(pag.id), p_detalhe: pag.status_detail || 'approved' });
    return 'pago';
  }
  if ((st === 'refunded' || st === 'charged_back') && ped.status === 'pago') {
    await db.from('pedidos').update({ status: 'estornado', mp_status_detalhe: st }).eq('id', pedidoId);
    return 'estornado';
  }
  if (st === 'cancelled' && ped.status === 'aguardando_pagamento') {
    await db.from('pedidos').update({ status: 'expirado', mp_status_detalhe: pag.status_detail || st, mp_payment_id: String(pag.id) }).eq('id', pedidoId);
    return 'expirado';
  }
  await db.from('pedidos').update({ mp_status_detalhe: pag.status_detail || st }).eq('id', pedidoId);
  return st;
}
