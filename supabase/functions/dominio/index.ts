// dominio: domínio próprio / subdomínio grátis da loja, registrado na Vercel automaticamente.
//  POST {acao:'status'}            -> domínio atual, situação e registros de DNS (ativa sozinho quando o DNS fica certo)
//  POST {acao:'pedir', dominio}    -> grava o pedido (só plano pago, regras no banco) e registra na Vercel
//  POST {acao:'remover'}           -> tira da Vercel e apaga da loja
// Segredos: VERCEL_TOKEN, VERCEL_PROJECT_ID (id ou nome do projeto) e, se o projeto for de um time, VERCEL_TEAM_ID.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const VERCEL_TOKEN = Deno.env.get('VERCEL_TOKEN') || '';
const VERCEL_PROJECT = Deno.env.get('VERCEL_PROJECT_ID') || '';
const VERCEL_TEAM = Deno.env.get('VERCEL_TEAM_ID') || '';
const VERCEL_API = 'https://api.vercel.com';
const SUB_KH = '.katalogohub.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const configurado = () => !!(VERCEL_TOKEN && VERCEL_PROJECT);
const admin = () => createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function vercel(method: string, caminho: string, body?: unknown) {
  const u = new URL(VERCEL_API + caminho);
  if (VERCEL_TEAM) u.searchParams.set('teamId', VERCEL_TEAM);
  const r = await fetch(u.toString(), {
    method,
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}
const proj = () => `/v9/projects/${encodeURIComponent(VERCEL_PROJECT)}`;

// Usuário logado -> cliente com o login dele (as regras do banco valem) + id da loja.
async function usuario(req: Request) {
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const db = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: auth } },
  });
  const { data: u } = await db.auth.getUser(auth.slice(7));
  if (!u?.user) return null;
  const { data: lojaId } = await db.rpc('minha_loja_id');
  if (!lojaId) return null;
  return { db, lojaId: lojaId as string };
}

async function adicionarNaVercel(nome: string, redirect?: string) {
  const r = await vercel('POST', `/v10/projects/${encodeURIComponent(VERCEL_PROJECT)}/domains`, redirect ? { name: nome, redirect } : { name: nome });
  if (r.ok) return { ok: true };
  // Já está neste projeto: tudo certo.
  const ja = await vercel('GET', `${proj()}/domains/${encodeURIComponent(nome)}`);
  if (ja.ok) return { ok: true };
  console.error('Vercel recusou o domínio', nome, r.status, JSON.stringify(r.data));
  const codigo = r.data?.error?.code || '';
  if (codigo === 'domain_already_in_use' || codigo === 'domain_taken') return { ok: false, erro: 'dominio_em_outra_conta' };
  if (codigo === 'invalid_domain') return { ok: false, erro: 'dominio_invalido' };
  return { ok: false, erro: 'vercel_recusou', detalhe: r.data?.error?.message || null };
}

async function tirarDaVercel(nome: string) {
  const r = await vercel('DELETE', `${proj()}/domains/${encodeURIComponent(nome)}`);
  if (!r.ok && r.status !== 404) console.error('Falha ao tirar da Vercel', nome, r.status, JSON.stringify(r.data));
}

// Confere na Vercel; se estiver tudo certo e a loja em dia, ativa. Devolve os registros de DNS a configurar.
async function conferir(lojaId: string, dominio: string, statusAtual: string | null) {
  const svc = admin();
  const ehSubKh = dominio.endsWith(SUB_KH);
  const d = await vercel('GET', `${proj()}/domains/${encodeURIComponent(dominio)}`);
  if (!d.ok) {
    // Sumiu da Vercel (ou nunca entrou): tenta registrar de novo.
    const add = await adicionarNaVercel(dominio);
    if (!add.ok) return { status: statusAtual, pronto: false, dns: [], erro: add.erro, detalhe: add.detalhe || null };
  }
  let info = d.ok ? d.data : (await vercel('GET', `${proj()}/domains/${encodeURIComponent(dominio)}`)).data;
  if (info && info.verified === false) {
    const v = await vercel('POST', `${proj()}/domains/${encodeURIComponent(dominio)}/verify`);
    if (v.ok) info = v.data;
  }
  const cfg = await vercel('GET', `/v6/domains/${encodeURIComponent(dominio)}/config`);
  const verificado = !!info?.verified;
  const dnsOk = cfg.ok && cfg.data?.misconfigured === false;
  const pronto = verificado && dnsOk;

  const dns: { tipo: string; nome: string; valor: string }[] = [];
  if (!ehSubKh) {
    const apex = info?.apexName || dominio;
    if (dominio === apex) {
      dns.push({ tipo: 'A', nome: '@', valor: '76.76.21.21' });
      dns.push({ tipo: 'CNAME', nome: 'www', valor: 'cname.vercel-dns.com' });
    } else {
      dns.push({ tipo: 'CNAME', nome: dominio.slice(0, -(apex.length + 1)), valor: 'cname.vercel-dns.com' });
    }
  }
  for (const v of (Array.isArray(info?.verification) ? info.verification : [])) {
    if (v?.type && v?.domain && v?.value) dns.push({ tipo: String(v.type), nome: String(v.domain), valor: String(v.value) });
  }

  let status = statusAtual;
  if (pronto && statusAtual !== 'ativo') {
    const { data: loja } = await svc.from('lojas').select('status').eq('id', lojaId).single();
    if (loja?.status === 'ativo') {
      await svc.from('lojas').update({ dominio_status: 'ativo', updated_at: new Date().toISOString() })
        .eq('id', lojaId).eq('dominio_proprio', dominio);
      status = 'ativo';
    }
  }
  return { status, pronto, dns, erro: null };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ erro: 'metodo' }, 405);
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* vazio */ }

  const u = await usuario(req);
  if (!u) return json({ erro: 'nao_autorizado' }, 401);
  const svc = admin();
  const { data: loja } = await svc.from('lojas').select('slug, status, dominio_proprio, dominio_status').eq('id', u.lojaId).single();
  if (!loja) return json({ erro: 'nao_autorizado' }, 401);
  const base = { configurado: configurado(), plano_pago: loja.status === 'ativo', subdominio_gratis: loja.slug + SUB_KH };

  try {
    if (body.acao === 'status') {
      if (!loja.dominio_proprio) return json({ ...base, dominio: null, status: null, dns: [] });
      if (!configurado()) return json({ ...base, dominio: loja.dominio_proprio, status: loja.dominio_status, dns: [] });
      const c = await conferir(u.lojaId, loja.dominio_proprio, loja.dominio_status);
      return json({ ...base, dominio: loja.dominio_proprio, ...c });
    }

    if (body.acao === 'pedir') {
      if (!configurado()) return json({ ...base, erro: 'nao_configurado' }, 503);
      const antigo: string | null = loja.dominio_proprio;
      const { data: r, error } = await u.db.rpc('solicitar_dominio', { p_dominio: String(body.dominio || '').slice(0, 200) });
      if (error) { console.error('solicitar_dominio', error); return json({ ...base, erro: 'falha' }, 500); }
      if (r?.erro) return json({ ...base, erro: r.erro }, 400);
      const novo: string = r.dominio;

      if (antigo && antigo !== novo) {
        await tirarDaVercel(antigo);
        if (!antigo.startsWith('www.') && !antigo.endsWith(SUB_KH)) await tirarDaVercel('www.' + antigo);
      }
      const add = await adicionarNaVercel(novo);
      if (!add.ok) {
        await u.db.rpc('remover_dominio');
        return json({ ...base, erro: add.erro, detalhe: add.detalhe || null }, 400);
      }
      const c = await conferir(u.lojaId, novo, 'pendente');
      // Domínio principal (sem subdomínio): www também abre a loja.
      const info = await vercel('GET', `${proj()}/domains/${encodeURIComponent(novo)}`);
      if (!novo.endsWith(SUB_KH) && info.ok && info.data?.apexName === novo) await adicionarNaVercel('www.' + novo, novo);
      return json({ ...base, dominio: novo, ...c });
    }

    if (body.acao === 'remover') {
      const atual: string | null = loja.dominio_proprio;
      if (atual && configurado()) {
        await tirarDaVercel(atual);
        if (!atual.startsWith('www.') && !atual.endsWith(SUB_KH)) await tirarDaVercel('www.' + atual);
      }
      await u.db.rpc('remover_dominio');
      return json({ ...base, dominio: null, status: null, dns: [] });
    }

    return json({ erro: 'acao_invalida' }, 400);
  } catch (e) {
    console.error('Erro em dominio', e);
    return json({ ...base, erro: 'erro_interno' }, 500);
  }
});
