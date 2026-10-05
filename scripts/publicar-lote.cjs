#!/usr/bin/env node
/**
 * publicar-lote.cjs — liga as fotos que já estão no Storage aos produtos do
 * scripts/data/resultados.jsonl e publica TUDO COMO RASCUNHO (disponivel=false).
 *
 * Uso (na raiz do projeto):
 *   node scripts/publicar-lote.cjs                       -> SIMULA (não grava nada)
 *   node scripts/publicar-lote.cjs --limite 10           -> simula só os 10 primeiros válidos
 *   node scripts/publicar-lote.cjs --executar --limite 10   -> grava de verdade (10 produtos)
 *   node scripts/publicar-lote.cjs --executar            -> grava o lote inteiro
 *   (opcional) --sem-criar-times -> NÃO cria times novos (produto sem time é pulado)
 *   Por padrão, time que não existe é criado (nome tirado do título, liga "Seleções" ou "Outros"); você ajusta depois no painel.
 *
 * Segurança:
 *  - Só lê/escreve na loja do ADMIN_EMAIL (as políticas RLS já garantem isso).
 *  - Não baixa nem envia foto nenhuma: só usa as que já estão no bucket "produtos".
 *  - Não duplica: título que já existe na loja é pulado; pode rodar de novo sem medo.
 *  - Produto entra com disponivel=false. Você revisa no painel e publica.
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const DATA = path.join(__dirname, 'data');

// ---------- argumentos ----------
const args = process.argv.slice(2);
const EXECUTAR = args.includes('--executar');
const CRIAR_TIMES = !args.includes('--sem-criar-times'); // por padrão cria os times que faltam
const iLim = args.indexOf('--limite');
const LIMITE = iLim >= 0 ? parseInt(args[iLim + 1], 10) : Infinity;

// ---------- .env (sem dependências) ----------
function lerEnv() {
  const f = path.join(RAIZ, '.env');
  if (!fs.existsSync(f)) throw new Error('.env não encontrado na raiz do projeto.');
  const env = {};
  for (const linha of fs.readFileSync(f, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}
const ENV = lerEnv();
for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'ADMIN_EMAIL', 'ADMIN_PASSWORD']) {
  if (!ENV[k]) throw new Error(`Variável ${k} ausente no .env`);
}
const URL_BASE = ENV.SUPABASE_URL.replace(/\/+$/, '');

// ---------- utilitários ----------
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
function norm(t) {
  return (t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[-_\/]/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
// MESMA função da Edge Function importar-produto (gera o pedaço do nome do arquivo)
function slugify(texto) {
  return ((texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()) || 'produto';
}
function contem(textoNorm, chaveNorm) {
  const i = textoNorm.indexOf(chaveNorm);
  if (i === -1) return false;
  const a = i === 0 || textoNorm[i - 1] === ' ';
  const d = i + chaveNorm.length >= textoNorm.length || textoNorm[i + chaveNorm.length] === ' ';
  return a && d;
}

// ---------- API (fetch puro) ----------
let TOKEN = null;
let TOKEN_EM = 0;
async function login() {
  const r = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ENV.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ENV.ADMIN_EMAIL, password: ENV.ADMIN_PASSWORD }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('Login falhou: ' + (j.error_description || j.msg || r.status));
  TOKEN = j.access_token;
  TOKEN_EM = Date.now();
}
async function api(metodo, caminho, corpo, extra = {}) {
  if (!TOKEN || Date.now() - TOKEN_EM > 40 * 60 * 1000) await login();
  const r = await fetch(`${URL_BASE}${caminho}`, {
    method: metodo,
    headers: {
      apikey: ENV.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...extra,
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const txt = await r.text();
  let dados = null;
  try { dados = txt ? JSON.parse(txt) : null; } catch { dados = txt; }
  if (!r.ok) {
    const msg = (dados && (dados.message || dados.error || dados.msg)) || txt || r.status;
    throw new Error(`${metodo} ${caminho} -> ${r.status}: ${msg}`);
  }
  return dados;
}

// ---------- 1) Storage: agrupa fotos por produto e por lote de upload ----------
async function listarFotos(lojaId) {
  const nomes = [];
  for (let offset = 0; ; offset += 1000) {
    const pagina = await api('POST', '/storage/v1/object/list/produtos', {
      prefix: lojaId, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' },
    });
    if (!pagina.length) break;
    for (const o of pagina) nomes.push(o.name);
    if (pagina.length < 1000) break;
  }
  return nomes;
}
function agruparFotos(nomes) {
  const porSlug = new Map();
  const re = /^importado-(.+)-(\d{13})-(\d+)\.(\w+)$/;
  for (const n of nomes) {
    const m = n.match(re);
    if (!m) continue;
    const [, slug, ts, idx, ext] = m;
    if (!porSlug.has(slug)) porSlug.set(slug, []);
    porSlug.get(slug).push({ nome: n, ts: Number(ts), idx: Number(idx), ext });
  }
  // por slug: separa em lotes (cada execução da importação recomeça no índice 0)
  const lotes = new Map();
  for (const [slug, fotos] of porSlug) {
    fotos.sort((a, b) => a.ts - b.ts || a.idx - b.idx);
    const l = [];
    let atual = null;
    for (const f of fotos) {
      if (!atual || f.idx <= atual.ultimoIdx) { atual = { fotos: [], ultimoIdx: -1 }; l.push(atual); }
      atual.fotos.push(f);
      atual.ultimoIdx = f.idx;
    }
    lotes.set(slug, l);
  }
  return lotes;
}
function escolherLote(lotes, totalEsperado) {
  if (!lotes || !lotes.length) return null;
  const completos = lotes.filter((l) => l.fotos.length === totalEsperado);
  const lista = completos.length ? completos : [...lotes].sort((a, b) => b.fotos.length - a.fotos.length);
  // entre os candidatos, o mais recente
  const escolhido = completos.length ? completos[completos.length - 1] : lista[0];
  return { fotos: escolhido.fotos.sort((a, b) => a.idx - b.idx), completo: escolhido.fotos.length === totalEsperado };
}

// ---------- 2) Regras de produto ----------
function tipoDoProduto(r) {
  if (r.generoDetectado === 'Feminina') return 'Feminina';
  if (r.generoDetectado === 'Infantil') return 'Kit Infantil';
  return r.tipoDetectado || 'Torcedor';
}
function subtituloDoProduto(r, tipo) {
  if (tipo === 'Feminina') return 'Torcedor Feminina';
  if (tipo === 'Kit Infantil') return 'Infantil';
  if (tipo === 'Retrô') return 'Retrô Masculina';
  return null;
}
function tamanhosDoProduto(r, tipo) {
  if (tipo === 'Kit Infantil') return ['16', '18', '20', '22', '24', '26', '28'];
  const t = Array.isArray(r.tamanhosDetectados) ? r.tamanhosDetectados : [];
  return t.length ? t : ['P', 'M', 'G', 'GG', '2XL'];
}


// Tira o nome do time do título quando a detecção não achou (ex.: "Camisa Seleção Cabo Verde Away 2026/27 Mendes 20" -> "Cabo Verde")
function derivarTime(titulo) {
  let t = (titulo || '').replace(/\s+/g, ' ').trim();
  const selecao = /sele[cç][aã]o/i.test(t);
  const prefixos = /^(camisa|camiseta|kit infantil|kit treino|kit|conjunto|jaqueta|agasalho|short|shorts|sele[cç][aã]o|retr[oô]|feminina|feminino|infantil|jogador|torcedor)\s+/i;
  while (prefixos.test(t)) t = t.replace(prefixos, '');
  const corte = t.search(/\s(home|away|third|fourth|goleiro|gk|treino|pr[eé][- ]?jogo|preta|preto|branca|branco|azul|vermelha|vermelho|verde|amarela|amarelo|rosa|laranja|cinza|dourada|especial|edi[cç][aã]o|comemorativ\w*|retr[oô]|feminina|feminino|infantil|\d{2,4}(\/\d{2,4})?)(\s|$)/i);
  if (corte > 0) t = t.slice(0, corte);
  t = t.replace(/[^\p{L}\p{N} .&'-]/gu, '').trim();
  if (!t || t.length < 2) return null;
  return { nome: t, liga: selecao ? 'Seleções' : 'Outros' };
}


// Grafias do título -> nome do time que já existe no banco (evita criar time duplicado)
const ALIAS = {
  'paris saint germain': 'psg', 'paris saint-germain': 'psg', 'tottenham': 'tottenham hotspur',
  'newcastle': 'newcastle united', 'bayern': 'bayern de munique', 'bayern munich': 'bayern de munique',
  'inter': 'inter de milao', 'inter milan': 'inter de milao', 'internazionale': 'inter de milao',
  'ac milan': 'milan', 'atletico madrid': 'atletico de madrid', 'atletico mg': 'atletico mineiro',
  'atletico mineiro': 'atletico mineiro', 'athletico pr': 'athletico paranaense', 'brighton': 'brighton hove albion',
  'bournemouth': 'afc bournemouth', 'west ham': 'west ham united', 'wolves': 'wolverhampton',
  'marseille': 'olympique de marseille', 'vasco': 'vasco da gama', 'gremio': 'gremio',
  'brazil': 'brasil', 'germany': 'alemanha', 'france': 'franca', 'spain': 'espanha', 'england': 'inglaterra',
  'italy': 'italia', 'japan': 'japao', 'mexico': 'mexico', 'usa': 'estados unidos', 'eua': 'estados unidos',
  'united states': 'estados unidos', 'morocco': 'marrocos', 'belgium': 'belgica', 'croatia': 'croacia',
  'netherlands': 'holanda', 'paises baixos': 'holanda', 'sweden': 'suecia', 'switzerland': 'suica',
  'south korea': 'coreia do sul', 'korea republic': 'coreia do sul', 'saudi arabia': 'arabia saudita',
  'egypt': 'egito', 'nigeria': 'nigeria', 'norway': 'noruega', 'australia': 'australia', 'canada': 'canada',
  'colombia': 'colombia', 'uruguay': 'uruguai', 'paraguay': 'paraguai', 'costa rica': 'costa rica',
};

// ---------- principal ----------
(async () => {
  console.log(EXECUTAR ? '== MODO EXECUTAR (grava no banco) ==' : '== MODO SIMULAÇÃO (não grava nada) ==');

  const arq = path.join(DATA, 'resultados.jsonl');
  if (!fs.existsSync(arq)) throw new Error('scripts/data/resultados.jsonl não encontrado.');
  const registros = fs.readFileSync(arq, 'utf8').split(/\r?\n/).filter(Boolean).map((l, i) => {
    try { return JSON.parse(l); } catch { console.warn(`linha ${i + 1} do jsonl inválida, ignorada`); return null; }
  }).filter(Boolean);
  console.log('Registros no jsonl:', registros.length);

  await login();
  const lojaId = await api('POST', '/rest/v1/rpc/minha_loja_id', {});
  if (!lojaId) throw new Error('Não achei a loja do admin.');
  console.log('Loja:', lojaId);

  const nomesStorage = await listarFotos(lojaId);
  const lotes = agruparFotos(nomesStorage);
  console.log('Arquivos no Storage:', nomesStorage.length, '| produtos com fotos (por título):', lotes.size);

  const times = await api('GET', `/rest/v1/teams?select=id,nome,liga&loja_id=eq.${lojaId}&limit=2000`);
  const existentes = await api('GET', `/rest/v1/products?select=id,titulo&loja_id=eq.${lojaId}&limit=5000`);
  const idsUsados = new Set(existentes.map((p) => p.id));
  const titulosExistentes = new Set(existentes.map((p) => norm(p.titulo)));
  const timesIdx = times.map((t) => ({ ...t, chave: norm(t.nome) })).sort((a, b) => b.chave.length - a.chave.length);
  console.log('Times no banco:', times.length, '| produtos já existentes:', existentes.length);

  const rel = { publicados: [], jaExiste: [], semFoto: [], semTime: [], fotosIncompletas: [], erros: [], timesCriados: [] };
  const vistos = new Set();
  let feitos = 0;

  for (const r of registros) {
    if (feitos >= LIMITE) break;
    const titulo = (r.titulo || '').trim();
    if (!titulo || !(r.preco > 0)) { rel.erros.push({ titulo, motivo: 'sem título ou preço', url: r.url }); continue; }
    const tNorm = norm(titulo);
    if (vistos.has(tNorm) || titulosExistentes.has(tNorm)) { rel.jaExiste.push({ titulo, url: r.url }); continue; }
    vistos.add(tNorm);

    // fotos
    const lote = escolherLote(lotes.get(slugify(titulo)), r.totalImagens);
    if (!lote) { rel.semFoto.push({ titulo, url: r.url }); continue; }
    if (!lote.completo) rel.fotosIncompletas.push({ titulo, esperado: r.totalImagens, achadas: lote.fotos.length });

    // time: 1) clube detectado na importação; 2) nome de time do banco dentro do título
    let time = null;
    const nomeDet = r.clubeDetectado && r.clubeDetectado.nome;
    if (nomeDet) { const k = norm(nomeDet); time = timesIdx.find((t) => t.chave === (ALIAS[k] || k)) || null; }
    if (!time) time = timesIdx.find((t) => contem(tNorm, t.chave)) || null;
    if (!time && CRIAR_TIMES) {
      const c = (r.clubeDetectado && r.clubeDetectado.nome) ? r.clubeDetectado : derivarTime(titulo);
      if (c) {
        const nome = c.nome.replace(/\b\p{L}/gu, (x) => x.toUpperCase());
        const chaveNome = norm(nome);
        const existente = timesIdx.find((t) => t.chave === (ALIAS[chaveNome] || chaveNome));
        if (existente) {
          time = existente;
        } else {
          const sigla = nome.replace(/[^\p{L}]/gu, '').slice(0, 3).toUpperCase() || 'TIM';
          if (EXECUTAR) {
            const [novo] = await api('POST', '/rest/v1/teams', {
              nome, liga: c.liga, subliga: c.subliga || null, continente: c.continente || null,
              cor: '#00E5FF', sigla, escudo_url: null, loja_id: lojaId,
            }, { Prefer: 'return=representation' });
            time = { ...novo, chave: norm(novo.nome) };
          } else {
            time = { id: '(novo)', nome, chave: norm(nome) };
          }
          timesIdx.push(time);
          timesIdx.sort((a, b) => b.chave.length - a.chave.length);
          rel.timesCriados.push(nome);
        }
      }
    }
    if (!time) { rel.semTime.push({ titulo, url: r.url, clubeDetectado: nomeDet || null }); continue; }

    const tipo = tipoDoProduto(r);
    const prefixo = `${time.nome}||${tipo}`;
    let id = prefixo;
    for (let n = 2; idsUsados.has(id); n++) id = `${prefixo}||${n}`;
    idsUsados.add(id);

    const linha = {
      id, team_id: time.id, tipo, titulo, subtitulo: subtituloDoProduto(r, tipo),
      descricao: null, preco: r.preco, tamanhos: tamanhosDoProduto(r, tipo), tags: [],
      disponivel: false, destaque: false, lancamento: false, loja_id: lojaId,
    };
    const imagens = lote.fotos.map((f, i) => ({
      product_id: id, ordem: i, loja_id: lojaId,
      url: `${URL_BASE}/storage/v1/object/public/produtos/${lojaId}/${f.nome.replace(lojaId + '/', '')}`,
    }));
    // o nome retornado pela listagem já pode vir sem a pasta; garante o caminho certo
    for (const im of imagens) im.url = im.url.replace(`${lojaId}/${lojaId}/`, `${lojaId}/`);

    if (EXECUTAR) {
      try {
        await api('POST', '/rest/v1/products', linha, { Prefer: 'return=minimal' });
        try {
          await api('POST', '/rest/v1/product_images', imagens, { Prefer: 'return=minimal' });
        } catch (e) {
          await api('DELETE', `/rest/v1/products?id=eq.${encodeURIComponent(id)}&loja_id=eq.${lojaId}`);
          throw e;
        }
        await dorme(Number(ENV.PAUSE_MS) > 0 ? Math.min(Number(ENV.PAUSE_MS), 500) : 150);
      } catch (e) {
        rel.erros.push({ titulo, motivo: String(e.message || e), url: r.url });
        continue;
      }
    }
    rel.publicados.push({ id, titulo, time: time.nome, tipo, fotos: imagens.length });
    feitos++;
    if (feitos % 25 === 0) console.log(`... ${feitos} produtos`);
  }

  const saida = path.join(DATA, EXECUTAR ? 'relatorio-publicar.json' : 'relatorio-simulacao.json');
  fs.writeFileSync(saida, JSON.stringify(rel, null, 2));

  console.log('\n===== RESUMO =====');
  console.table({
    [EXECUTAR ? 'Publicados (rascunho)' : 'Seriam publicados']: rel.publicados.length,
    'Já existem (pulados)': rel.jaExiste.length,
    'Sem foto no Storage': rel.semFoto.length,
    'Sem time identificado': rel.semTime.length,
    'Fotos incompletas (usadas mesmo assim)': rel.fotosIncompletas.length,
    'Times novos (criados/a criar)': rel.timesCriados.length,
    'Erros': rel.erros.length,
  });
  console.log('Relatório completo em:', saida);
  if (rel.publicados[0]) console.log('Exemplo:', JSON.stringify(rel.publicados[0]));
  if (rel.semTime.length) console.log('Exemplos sem time:', rel.semTime.slice(0, 5).map((x) => x.titulo).join(' | '));
  if (rel.timesCriados.length) console.log('Times novos:', rel.timesCriados.join(', '));
  if (rel.erros.length) console.log('Primeiro erro:', JSON.stringify(rel.erros[0]));
})().catch((e) => { console.error('\nERRO FATAL:', e.message); process.exit(1); });
