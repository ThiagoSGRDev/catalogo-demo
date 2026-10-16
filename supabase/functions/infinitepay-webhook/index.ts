// infinitepay-webhook: a InfinitePay avisa aqui quando um pagamento é aprovado.
// O corpo do aviso NÃO é confiável sozinho: o pedido só vira "pago" depois do
// payment_check na própria InfinitePay (ipConfirmar). Sem segredo; verify_jwt=false.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { ipConfirmar } from './ip.ts';

const db = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const resp = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return resp({ ok: true });
  let b: any = {};
  try { b = await req.json(); } catch (_) { return resp({ erro: 'json_invalido' }, 200); }
  try {
    const r = await ipConfirmar(db(), String(b.order_nsu || ''), String(b.transaction_nsu || ''), String(b.invoice_slug || b.slug || ''), String(b.receipt_url || ''));
    // 400 = "tente de novo mais tarde" (ainda não consta pago na consulta).
    return resp({ resultado: r }, r === 'nao_pago' ? 400 : 200);
  } catch (e) {
    console.error('Erro no webhook InfinitePay', e);
    return resp({ erro: 'interno' }, 400);
  }
});
