// mp-conectar: liga a conta do Mercado Pago do lojista (OAuth).
//  POST {acao:'iniciar'}      (com login do painel) -> devolve a URL de autorização do Mercado Pago
//  POST {acao:'desconectar'}  (com login do painel) -> apaga os tokens da loja
//  GET  ?code=...&state=...   (volta do Mercado Pago) -> troca o code por tokens e volta pro painel
// Segredos: MP_CLIENT_ID, MP_CLIENT_SECRET (aplicação do Katalogo Hub no Mercado Pago).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  admin, CORS, json, mpConfigurado, MP_API, MP_CLIENT_ID, MP_CLIENT_SECRET,
  REDIRECT_URI, SERVICE_KEY, SITE_URL, SUPABASE_URL,
} from './mp.ts';

function voltarPainel(resultado: string) {
  return new Response(null, { status: 302, headers: { Location: `${SITE_URL}/dashboard/?mp=${encodeURIComponent(resultado)}#checkout` } });
}

async function lojaDoUsuario(req: Request): Promise<string | null> {
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const db = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: auth } },
  });
  const { data: u } = await db.auth.getUser(auth.slice(7));
  if (!u?.user) return null;
  const { data } = await db.rpc('minha_loja_id');
  return data || null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const db = admin();
  const url = new URL(req.url);

  // ---- Volta do Mercado Pago ----
  if (req.method === 'GET') {
    if (url.searchParams.get('error')) return voltarPainel('recusado');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) return voltarPainel('erro');
    const { data: st } = await db.from('mp_oauth_states').select('*').eq('state', state).maybeSingle();
    if (!st) return voltarPainel('expirado');
    await db.from('mp_oauth_states').delete().eq('state', state);
    if (Date.now() - new Date(st.criado_em).getTime() > 30 * 60 * 1000) return voltarPainel('expirado');

    const r = await fetch(`${MP_API}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: MP_CLIENT_ID, client_secret: MP_CLIENT_SECRET,
        grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI,
      }),
    });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.access_token) {
      console.error('OAuth MP falhou', r.status, t);
      return voltarPainel('erro');
    }

    let nomeConta: string | null = null;
    try {
      const me = await fetch(`${MP_API}/users/me`, { headers: { Authorization: `Bearer ${t.access_token}` } });
      const mj = await me.json();
      nomeConta = mj?.email || mj?.nickname || null;
    } catch (_) { /* opcional */ }

    await db.from('mp_contas').upsert({
      loja_id: st.loja_id,
      mp_user_id: t.user_id ? String(t.user_id) : null,
      access_token: t.access_token,
      refresh_token: t.refresh_token || null,
      public_key: t.public_key || null,
      expira_em: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null,
      conectado_em: new Date().toISOString(),
      atualizado_em: new Date().toISOString(),
    });
    await db.from('loja_checkout').upsert({
      loja_id: st.loja_id, conectado: true, ativo: true, mp_conta_nome: nomeConta,
    });
    return voltarPainel('conectado');
  }

  // ---- Ações do painel ----
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* vazio */ }
  const lojaId = await lojaDoUsuario(req);
  if (!lojaId) return json({ erro: 'nao_autorizado' }, 401);

  if (body.acao === 'iniciar') {
    if (!mpConfigurado()) return json({ erro: 'nao_configurado' }, 503);
    const state = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    await db.from('mp_oauth_states').delete().lt('criado_em', new Date(Date.now() - 3600 * 1000).toISOString());
    await db.from('mp_oauth_states').insert({ state, loja_id: lojaId });
    const auth = new URL('https://auth.mercadopago.com.br/authorization');
    auth.searchParams.set('client_id', MP_CLIENT_ID);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('platform_id', 'mp');
    auth.searchParams.set('state', state);
    auth.searchParams.set('redirect_uri', REDIRECT_URI);
    return json({ url: auth.toString() });
  }

  if (body.acao === 'desconectar') {
    await db.from('mp_contas').delete().eq('loja_id', lojaId);
    await db.from('loja_checkout').upsert({ loja_id: lojaId, conectado: false, ativo: false, mp_conta_nome: null });
    return json({ ok: true });
  }

  if (body.acao === 'status') {
    return json({ configurado: mpConfigurado() });
  }

  return json({ erro: 'acao_invalida' }, 400);
});
