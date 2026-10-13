// mp-webhook: aviso do Mercado Pago quando um pagamento muda.
// Nunca confia no conteúdo do aviso: pega só o ID e consulta o pagamento no Mercado Pago
// com o token da própria loja. Se aprovado -> pedido PAGO + baixa de estoque (uma vez só).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { admin, aplicarPagamento, CORS, mpGet, tokenDaLoja } from './mp.ts';

const ok = () => new Response('ok', { status: 200, headers: CORS });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return ok();
  try {
    const url = new URL(req.url);
    const lojaId = url.searchParams.get('loja') || '';
    if (!/^[0-9a-f-]{36}$/i.test(lojaId)) return ok();

    let body: any = {};
    try { body = await req.json(); } catch (_) { /* aviso no formato antigo vem só na URL */ }
    const tipo = body?.type || body?.topic || url.searchParams.get('type') || url.searchParams.get('topic');
    const id = body?.data?.id || url.searchParams.get('data.id') || url.searchParams.get('id');
    if (tipo !== 'payment' || !id) return ok();

    const db = admin();
    const token = await tokenDaLoja(db, lojaId);
    if (!token) return ok();
    const r = await mpGet(token, `/v1/payments/${encodeURIComponent(String(id))}`);
    if (!r.ok) { console.error('Webhook: pagamento não encontrado', id, r.status); return ok(); }
    const res = await aplicarPagamento(db, lojaId, r.data);
    console.log('Webhook MP', id, r.data?.status, '->', res);
  } catch (e) {
    console.error('Erro no webhook MP', e);
  }
  return ok();
});
