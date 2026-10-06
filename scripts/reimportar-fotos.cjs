#!/usr/bin/env node
/**
 * reimportar-fotos.cjs — corrige as fotos dos produtos importados em rascunho.
 * Para cada produto (casando pelo título do resultados.jsonl), chama a Edge Function
 * "reimportar-fotos" (só fotos da galeria, sem as camisas "Relacionadas") e troca
 * as linhas de product_images do produto pelas novas.
 *
 * Uso (na raiz do projeto):
 *   node scripts/reimportar-fotos.cjs --limite 3            -> mostra o plano (não grava)
 *   node scripts/reimportar-fotos.cjs --executar --limite 3 -> corrige só 3 produtos (teste)
 *   node scripts/reimportar-fotos.cjs --executar            -> corrige todos (retoma de onde parou)
 *
 * Segurança:
 *  - Só mexe em produtos com disponivel=false (os rascunhos importados). Os públicos ficam intactos.
 *  - Só troca as fotos do produto se a nova importação trouxe pelo menos 1 foto.
 *  - Não apaga nada do Storage (a faxina das fotos antigas é um passo separado).
 *  - Pode parar e rodar de novo: produtos já corrigidos (foto-*) são pulados.
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const DATA = path.join(__dirname, 'data');
const args = process.argv.slice(2);
const EXECUTAR = args.includes('--executar');
const iLim = args.indexOf('--limite');
const LIMITE = iLim >= 0 ? parseInt(args[iLim + 1], 10) : Infinity;

function lerEnv() {
  const f = path.join(RAIZ, '.env');
  if (!fs.existsSync(f)) throw new Error('.env não encontrado na raiz do projeto.');
  const env = {};
  for (const l of fs.readFileSync(f, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}
const ENV = lerEnv();
for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'ADMIN_EMAIL', 'ADMIN_PASSWORD']) if (!ENV[k]) throw new Error(`${k} ausente no .env`);
const URL_BASE = ENV.SUPABASE_URL.replace(/\/+$/, '');

const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (t) => (t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

let TOKEN = null, TOKEN_EM = 0;
async function login() {
  const r = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ENV.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ENV.ADMIN_EMAIL, password: ENV.ADMIN_PASSWORD }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('Login falhou: ' + (j.error_description || j.msg || r.status));
  TOKEN = j.access_token; TOKEN_EM = Date.now();
}
async function api(metodo, caminho, corpo, extra = {}, timeoutMs = 170000) {
  if (!TOKEN || Date.now() - TOKEN_EM > 40 * 60 * 1000) await login();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${URL_BASE}${caminho}`, {
      method: metodo, signal: ctl.signal,
      headers: { apikey: ENV.SUPABASE_ANON_KEY, Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...extra },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const txt = await r.text();
    let d = null; try { d = txt ? JSON.parse(txt) : null; } catch { d = txt; }
    if (!r.ok) throw new Error(`${metodo} ${caminho.slice(0, 60)} -> ${r.status}: ${(d && (d.message || d.error)) || txt}`);
    return d;
  } finally { clearTimeout(t); }
}

(async () => {
  console.log(EXECUTAR ? '== MODO EXECUTAR ==' : '== MODO PLANO (não grava nada) ==');
  const registros = fs.readFileSync(path.join(DATA, 'resultados.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const porTitulo = new Map();
  for (const r of registros) if (r.titulo && r.url && !porTitulo.has(norm(r.titulo))) porTitulo.set(norm(r.titulo), r);

  await login();
  const lojaId = await api('POST', '/rest/v1/rpc/minha_loja_id', {});
  const produtos = await api('GET', `/rest/v1/products?select=id,titulo&loja_id=eq.${lojaId}&disponivel=eq.false&limit=5000`);
  const imgs = await api('GET', `/rest/v1/product_images?select=product_id,url&loja_id=eq.${lojaId}&limit=20000`);
  const jaCorrigidos = new Set(imgs.filter((i) => /\/foto-[^/]+$/.test(i.url)).map((i) => i.product_id));
  console.log('Rascunhos:', produtos.length, '| já corrigidos:', [...jaCorrigidos].filter((id) => produtos.some((p) => p.id === id)).length);

  const fila = [];
  const semUrl = [];
  for (const p of produtos) {
    if (jaCorrigidos.has(p.id)) continue;
    const reg = porTitulo.get(norm(p.titulo));
    if (!reg) { semUrl.push(p.titulo); continue; }
    fila.push({ id: p.id, titulo: p.titulo, url: reg.url });
  }
  console.log('A corrigir:', fila.length, '| sem URL no jsonl:', semUrl.length);
  if (!EXECUTAR) {
    fila.slice(0, Math.min(LIMITE, 5)).forEach((f) => console.log(' -', f.titulo));
    console.log('\nPara corrigir de verdade: acrescente --executar');
    return;
  }

  const logf = path.join(DATA, 'reimportar-fotos.log');
  const resumo = { ok: 0, semFoto: 0, erros: 0, fotosNovas: 0 };
  let n = 0;
  for (const f of fila) {
    if (n >= LIMITE) break;
    n++;
    try {
      let res = null;
      for (let t = 1; t <= 2 && !res; t++) {
        try { res = await api('POST', '/functions/v1/reimportar-fotos', { url: f.url, titulo: f.titulo }); }
        catch (e) { if (t === 2) throw e; await dorme(3000); }
      }
      if (res.error || !res.imagens || !res.imagens.length) {
        resumo.semFoto++;
        fs.appendFileSync(logf, `SEM_FOTO\t${f.titulo}\t${res.error || 'vazio'}\n`);
        continue;
      }
      await api('DELETE', `/rest/v1/product_images?product_id=eq.${encodeURIComponent(f.id)}&loja_id=eq.${lojaId}`);
      await api('POST', '/rest/v1/product_images',
        res.imagens.map((u, i) => ({ product_id: f.id, url: u, ordem: i, loja_id: lojaId })), { Prefer: 'return=minimal' });
      resumo.ok++; resumo.fotosNovas += res.imagens.length;
      fs.appendFileSync(logf, `OK\t${f.titulo}\t${res.imagens.length} fotos\n`);
      if (resumo.ok % 10 === 0) console.log(`... ${resumo.ok} produtos corrigidos`);
      await dorme(300);
    } catch (e) {
      resumo.erros++;
      fs.appendFileSync(logf, `ERRO\t${f.titulo}\t${String(e.message || e).slice(0, 200)}\n`);
      console.warn('erro:', f.titulo, '->', String(e.message || e).slice(0, 120));
    }
  }
  console.log('\n===== RESUMO =====');
  console.table({ 'Produtos corrigidos': resumo.ok, 'Fotos novas gravadas': resumo.fotosNovas, 'Sem foto (mantidos como estavam)': resumo.semFoto, 'Erros': resumo.erros });
  console.log('Log:', logf);
})().catch((e) => { console.error('\nERRO FATAL:', e.message); process.exit(1); });
