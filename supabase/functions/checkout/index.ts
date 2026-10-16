// checkout: pagamento dentro da loja (Mercado Pago, dinheiro direto na conta do lojista).
//  POST {acao:'criar', ...}  -> recalcula TUDO no servidor (preço, personalização, frete, estoque),
//                               cria o pedido e o pagamento (PIX na tela ou cartão no Mercado Pago)
//  POST {acao:'status', pedido_id, token} -> situação do pedido (o catálogo consulta até ficar pago)
// Comissão do Katalogo Hub por loja (1%, teto R$ 10; isentos: 10 fundadores e lojas próprias).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import {
  admin, aplicarPagamento, calcularTaxa, CORS, json, mpGet, mpPost, SERVICE_KEY,
  SITE_URL, SUPABASE_URL, tokenDaLoja,
} from './mp.ts';

const FRETE_PADRAO: Record<string, number> = { motoboy: 15, pac: 24.9, sedex: 39.9, retirar: 0 };
const FRETE_NOMES: Record<string, string> = { motoboy: 'Motoboy', pac: 'PAC', sedex: 'Sedex', retirar: 'Retirar no local' };

const txt = (v: unknown, max = 120) => String(v ?? '').trim().slice(0, max);
const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const dinheiro = (n: number) => Math.round(n * 100) / 100;
// Camisa que já vem com nome e número: preço do tipo + este valor (igual ao catalogo-template.html).
const ACRESCIMO_JA_PERSONALIZADA = 50;

function expiracaoPix(minutos: number) {
  // Formato que o Mercado Pago aceita, no fuso de Brasília.
  const d = new Date(Date.now() + minutos * 60000 - 3 * 3600000);
  return d.toISOString().replace('Z', '-03:00');
}

async function criar(body: any) {
  const db = admin();
  const slug = txt(body.loja_slug, 80).toLowerCase();
  const metodo = body.metodo === 'cartao' ? 'cartao' : 'pix';

  const { data: loja } = await db.from('lojas').select('id, nome, slug, ativa, status, trial_expira_em, usa_catalogo_mestre')
    .eq('slug', slug).maybeSingle();
  const lojaNoAr = loja && loja.ativa && (loja.status === 'ativo' || (loja.status === 'trial' && new Date(loja.trial_expira_em) > new Date()));
  if (!lojaNoAr) return json({ erro: 'loja_indisponivel' }, 404);

  const { data: ck } = await db.from('loja_checkout').select('*').eq('loja_id', loja.id).maybeSingle();
  if (!ck || !ck.ativo || !ck.conectado) return json({ erro: 'checkout_desligado' }, 400);
  if (metodo === 'pix' && !ck.aceita_pix) return json({ erro: 'meio_indisponivel' }, 400);
  if (metodo === 'cartao' && !ck.aceita_cartao) return json({ erro: 'meio_indisponivel' }, 400);

  const token = await tokenDaLoja(db, loja.id);
  if (!token) return json({ erro: 'checkout_desligado' }, 400);

  // ---- Cliente ----
  const cliente = {
    nome: txt(body?.cliente?.nome, 80),
    whats: txt(body?.cliente?.whats, 30).replace(/[^\d+()\s-]/g, ''),
    email: txt(body?.cliente?.email, 120).toLowerCase(),
  };
  if (cliente.nome.length < 3) return json({ erro: 'nome_invalido' }, 400);
  if (!emailOk(cliente.email)) return json({ erro: 'email_invalido' }, 400);

  // ---- Itens: tudo recalculado aqui, o preço do navegador é ignorado ----
  const itensIn = Array.isArray(body.itens) ? body.itens.slice(0, 30) : [];
  if (!itensIn.length) return json({ erro: 'carrinho_vazio' }, 400);

  const lojasVisiveis = [loja.id];
  if (loja.usa_catalogo_mestre) {
    const { data: m } = await db.from('lojas').select('id').eq('eh_catalogo_mestre', true).limit(1).maybeSingle();
    if (m && m.id !== loja.id) lojasVisiveis.push(m.id);
  }
  const ids = [...new Set(itensIn.map((i: any) => txt(i.produtoId, 120)).filter(Boolean))];
  const [{ data: prods }, { data: ocultos }, { data: precos }, { data: precosTipo }, { data: ovs }, { data: cfg }] = await Promise.all([
    db.from('products').select('id, tipo, titulo, subtitulo, preco, preco_manual, ja_personalizada, tamanhos, disponivel, loja_id, team_id').in('id', ids).in('loja_id', lojasVisiveis),
    db.from('loja_produtos_ocultos').select('product_id').eq('loja_id', loja.id).in('product_id', ids),
    db.from('loja_precos_customizados').select('product_id, preco').eq('loja_id', loja.id).in('product_id', ids),
    db.from('loja_precos_por_tipo').select('tipo, preco').eq('loja_id', loja.id),
    db.from('loja_produtos_override').select('product_id, titulo, subtitulo, tamanhos').eq('loja_id', loja.id).in('product_id', ids),
    db.from('store_settings').select('preco_personalizacao, preco_frete, preco_frete_outros_estados, preco_frete_sedex, usa_estoque').eq('loja_id', loja.id).maybeSingle(),
  ]);
  const mapaProd = new Map((prods || []).map((p: any) => [p.id, p]));
  const oculto = new Set((ocultos || []).map((o: any) => o.product_id));
  // Linha só com "De" (promoção) e sem preço próprio continua usando o preço do tipo.
  const precoCustom = new Map((precos || []).filter((p: any) => p.preco != null).map((p: any) => [p.product_id, Number(p.preco)]));
  const precoTipo = new Map((precosTipo || []).map((p: any) => [p.tipo, Number(p.preco)]));
  const override = new Map((ovs || []).map((o: any) => [o.product_id, o]));
  const precoPers = typeof cfg?.preco_personalizacao === 'number' ? Number(cfg.preco_personalizacao) : 60;

  let estoque = new Map<string, number>();
  if (cfg?.usa_estoque) {
    const { data: est } = await db.from('loja_produtos_estoque').select('product_id, tamanho, quantidade').eq('loja_id', loja.id).in('product_id', ids);
    (est || []).forEach((e: any) => estoque.set(`${e.product_id}|${e.tamanho}`, Number(e.quantidade)));
  }

  const itens: any[] = [];
  const pedidoQtd = new Map<string, number>();
  for (const i of itensIn) {
    const p: any = mapaProd.get(txt(i.produtoId, 120));
    if (!p || oculto.has(p.id) || p.disponivel === false) return json({ erro: 'produto_indisponivel', produto: i.produtoId }, 400);
    const ov: any = override.get(p.id) || {};
    const tamanho = txt(i.tamanho, 10);
    const tamanhos: string[] = ov.tamanhos || p.tamanhos || [];
    if (tamanhos.length && !tamanhos.includes(tamanho)) return json({ erro: 'tamanho_invalido', produto: p.id }, 400);
    const qty = Math.max(1, Math.min(20, parseInt(i.qty, 10) || 1));
    const jaPers = !!p.ja_personalizada;
    const nome = jaPers ? '' : txt(i.nome, 20).toUpperCase();
    const numero = jaPers ? '' : txt(i.numero, 3).replace(/\D/g, '');
    // Preço por tipo: vale pro catálogo mestre e pros produtos importados/em lote.
    // Produto cadastrado à mão (preco_manual) usa o preço que o lojista digitou.
    const base = precoCustom.has(p.id) ? precoCustom.get(p.id)!
      : ((p.loja_id !== loja.id || !p.preco_manual) && precoTipo.has(p.tipo))
        ? precoTipo.get(p.tipo)! + (jaPers ? ACRESCIMO_JA_PERSONALIZADA : 0)
      : Number(p.preco);
    const unit = dinheiro(base + ((nome || numero) ? precoPers : 0));
    if (!(unit > 0)) return json({ erro: 'preco_invalido', produto: p.id }, 400);
    if (cfg?.usa_estoque) {
      const k = `${p.id}|${tamanho}`;
      const ja = (pedidoQtd.get(k) || 0) + qty;
      pedidoQtd.set(k, ja);
      if (estoque.has(k) && ja > (estoque.get(k) || 0)) return json({ erro: 'sem_estoque', produto: p.id, tamanho }, 409);
    }
    itens.push({
      produtoId: p.id, titulo: ov.titulo || p.titulo, subtitulo: ov.subtitulo || p.subtitulo || p.tipo,
      tipo: p.tipo, tamanho, qty, nome, numero, preco: unit, subtotal: dinheiro(unit * qty),
    });
  }
  const subtotal = dinheiro(itens.reduce((s, i) => s + i.subtotal, 0));

  // ---- Frete ----
  const freteId = txt(body?.frete?.id, 60) || 'retirar';
  const end = body.endereco || {};
  const endereco = {
    cep: txt(end.cep, 9).replace(/\D/g, ''), rua: txt(end.rua, 120), numero: txt(end.numero, 20),
    complemento: txt(end.complemento, 60), bairro: txt(end.bairro, 60), cidade: txt(end.cidade, 60),
    uf: txt(end.uf, 2).toUpperCase(), obs: txt(end.obs, 300),
  };
  let freteValor = 0, freteNome = FRETE_NOMES.retirar;
  if (freteId !== 'retirar') {
    if (endereco.cep.length !== 8 || !endereco.rua || !endereco.numero) return json({ erro: 'endereco_incompleto' }, 400);
    if (freteId in FRETE_PADRAO) {
      const mapa: Record<string, any> = { motoboy: cfg?.preco_frete, pac: cfg?.preco_frete_outros_estados, sedex: cfg?.preco_frete_sedex };
      freteValor = typeof mapa[freteId] === 'number' ? Number(mapa[freteId]) : FRETE_PADRAO[freteId];
      freteNome = FRETE_NOMES[freteId];
    }
    // Frete real (SuperFrete): consulta de novo aqui, nunca confia no valor do navegador.
    if (!(freteId in FRETE_PADRAO) || freteId === 'pac' || freteId === 'sedex') {
      try {
        const r = await fetch(`${SUPABASE_URL}/functions/v1/calcular-frete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY },
          body: JSON.stringify({ cepDestino: endereco.cep, quantidade: itens.reduce((s, i) => s + i.qty, 0) }),
        });
        const f = await r.json();
        const op = f?.disponivel && Array.isArray(f.opcoes) ? f.opcoes.find((o: any) => o.id === freteId) : null;
        if (op) { freteValor = Number(op.preco); freteNome = op.nome; }
        else if (!(freteId in FRETE_PADRAO)) return json({ erro: 'frete_invalido' }, 400);
      } catch (_) {
        if (!(freteId in FRETE_PADRAO)) return json({ erro: 'frete_invalido' }, 400);
      }
    }
  }
  freteValor = dinheiro(freteValor);
  const total = dinheiro(subtotal + freteValor);
  const taxa = calcularTaxa(total, ck);

  // ---- Pedido ----
  const { data: ped, error: errPed } = await db.from('pedidos').insert({
    loja_id: loja.id, metodo, cliente_nome: cliente.nome, cliente_whats: cliente.whats, cliente_email: cliente.email,
    endereco: freteId === 'retirar' ? { obs: endereco.obs } : endereco, itens, subtotal,
    frete_nome: freteNome, frete_valor: freteValor, total, taxa_plataforma: taxa,
  }).select('id, numero, token_publico').single();
  if (errPed || !ped) { console.error('Erro ao criar pedido', errPed); return json({ erro: 'falha_pedido' }, 500); }

  const descricao = `Pedido #${ped.numero} - ${loja.nome}`.slice(0, 120);
  const notificacao = `${SUPABASE_URL}/functions/v1/mp-webhook?loja=${loja.id}`;
  const [primeiro, ...resto] = cliente.nome.split(/\s+/);

  if (metodo === 'pix') {
    const expira = expiracaoPix(30);
    const r = await mpPost(token, '/v1/payments', {
      transaction_amount: total,
      description: descricao,
      payment_method_id: 'pix',
      external_reference: ped.id,
      notification_url: notificacao,
      ...(taxa > 0 ? { application_fee: taxa } : {}),
      date_of_expiration: expira,
      payer: { email: cliente.email, first_name: primeiro, last_name: resto.join(' ') || primeiro },
    }, `pix-${ped.id}`);
    const td = r.data?.point_of_interaction?.transaction_data;
    if (!r.ok || !td?.qr_code) {
      console.error('MP PIX falhou', r.status, JSON.stringify(r.data));
      await db.from('pedidos').update({ status: 'cancelado', mp_status_detalhe: 'erro_criar_pix' }).eq('id', ped.id);
      return json({ erro: 'falha_pagamento', detalhe: r.data?.message || null }, 502);
    }
    await db.from('pedidos').update({
      mp_payment_id: String(r.data.id), pix_copia_cola: td.qr_code, pix_qr_base64: td.qr_code_base64 || null,
      pix_expira_em: new Date(Date.now() + 30 * 60000).toISOString(), link_pagamento: td.ticket_url || null,
    }).eq('id', ped.id);
    return json({
      pedido_id: ped.id, token: ped.token_publico, numero: ped.numero, total, metodo,
      pix: { copia_cola: td.qr_code, qr_base64: td.qr_code_base64 || null, expira_em: new Date(Date.now() + 30 * 60000).toISOString() },
    });
  }

  // Cartão (parcelado): página segura do Mercado Pago, volta pra loja no fim.
  const volta = `${SITE_URL}/catalogo/loja/${encodeURIComponent(loja.slug)}?pedido=${ped.id}&t=${ped.token_publico}`;
  const r = await mpPost(token, '/checkout/preferences', {
    items: [{ id: ped.id, title: descricao, quantity: 1, unit_price: total, currency_id: 'BRL' }],
    payer: { email: cliente.email, name: primeiro, surname: resto.join(' ') || undefined },
    external_reference: ped.id,
    notification_url: notificacao,
    ...(taxa > 0 ? { marketplace_fee: taxa } : {}),
    back_urls: { success: volta, pending: volta, failure: volta },
    auto_return: 'approved',
    payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }], installments: 12 },
    expires: true,
    expiration_date_to: new Date(Date.now() + 24 * 3600000 - 3 * 3600000).toISOString().replace('Z', '-03:00'),
  }, `pref-${ped.id}`);
  if (!r.ok || !r.data?.init_point) {
    console.error('MP preferência falhou', r.status, JSON.stringify(r.data));
    await db.from('pedidos').update({ status: 'cancelado', mp_status_detalhe: 'erro_criar_preferencia' }).eq('id', ped.id);
    return json({ erro: 'falha_pagamento', detalhe: r.data?.message || null }, 502);
  }
  await db.from('pedidos').update({ mp_preference_id: String(r.data.id), link_pagamento: r.data.init_point }).eq('id', ped.id);
  return json({ pedido_id: ped.id, token: ped.token_publico, numero: ped.numero, total, metodo, link: r.data.init_point });
}

async function status(body: any) {
  const db = admin();
  const id = txt(body.pedido_id, 40);
  const tk = txt(body.token, 100);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !tk) return json({ erro: 'pedido_invalido' }, 400);
  let { data: ped } = await db.from('pedidos').select('id, loja_id, numero, status, total, metodo, token_publico, mp_payment_id, pix_expira_em, criado_em')
    .eq('id', id).maybeSingle();
  if (!ped || ped.token_publico !== tk) return json({ erro: 'pedido_invalido' }, 404);

  // Reserva caso o aviso (webhook) do Mercado Pago atrase: pergunta direto pro Mercado Pago.
  if (ped.status === 'aguardando_pagamento') {
    const token = await tokenDaLoja(db, ped.loja_id);
    if (token) {
      let pag: any = null;
      if (ped.mp_payment_id) {
        const r = await mpGet(token, `/v1/payments/${encodeURIComponent(ped.mp_payment_id)}`);
        if (r.ok) pag = r.data;
      } else {
        const r = await mpGet(token, `/v1/payments/search?external_reference=${ped.id}&sort=date_created&criteria=desc`);
        const lista = r.ok && Array.isArray(r.data?.results) ? r.data.results : [];
        pag = lista.find((p: any) => p.status === 'approved') || lista[0] || null;
      }
      if (pag) await aplicarPagamento(db, ped.loja_id, pag);
    }
    if (ped.metodo === 'pix' && ped.pix_expira_em && new Date(ped.pix_expira_em).getTime() + 5 * 60000 < Date.now()) {
      await db.from('pedidos').update({ status: 'expirado' }).eq('id', ped.id).eq('status', 'aguardando_pagamento');
    }
    const { data: novo } = await db.from('pedidos').select('status').eq('id', ped.id).single();
    if (novo) ped = { ...ped, status: novo.status };
  }
  return json({ pedido_id: ped.id, numero: ped.numero, status: ped.status, total: ped.total, metodo: ped.metodo });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ erro: 'metodo' }, 405);
  let body: any = {};
  try { body = await req.json(); } catch (_) { return json({ erro: 'json_invalido' }, 400); }
  try {
    if (body.acao === 'criar') return await criar(body);
    if (body.acao === 'status') return await status(body);
    return json({ erro: 'acao_invalida' }, 400);
  } catch (e) {
    console.error('Erro no checkout', e);
    return json({ erro: 'erro_interno' }, 500);
  }
});
