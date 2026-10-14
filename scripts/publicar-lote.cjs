#!/usr/bin/env node
/**
 * publicar-lote.cjs — liga as fotos que já estão no Storage aos produtos do
 * scripts/data/resultados.jsonl e publica TUDO COMO RASCUNHO (disponivel=false).
 *
 * Uso (na raiz do projeto):
 *   node scripts/publicar-lote.cjs                          -> SIMULA (não grava nada)
 *   node scripts/publicar-lote.cjs --limite 10              -> simula só os 10 primeiros válidos
 *   node scripts/publicar-lote.cjs --executar --limite 10   -> grava de verdade (10 produtos)
 *   node scripts/publicar-lote.cjs --executar               -> grava o lote inteiro
 *   (opcional) --sem-criar-times -> NÃO cria times novos (produto sem time é pulado)
 *
 * Anti-duplicata (chave canônica, ver scripts/lib/chave-produto.cjs):
 *   "Camisa Real Madrid Home 2026/2027 - Torcedor" == "Camisa Real Madrid l 2026/27 - Masculino torcedor"
 *   Home=I=l, Away=II=ll, Third=III=lll, Fourth=IV=lV; 2026/27 = 26/27 = 2026/2027.
 *   Compara com: (1) produtos já no catálogo, (2) import_progress com status 'ok', (3) o próprio lote.
 *   URL já marcada 'ok' em import_progress também é pulada.
 *
 * Segurança:
 *  - Só lê/escreve na loja do ADMIN_EMAIL (RLS).
 *  - Não baixa nem envia foto: só usa as que já estão no bucket "produtos".
 *  - Produto entra com disponivel=false. Você revisa no painel e publica.
 */
const fs = require('fs');
const path = require('path');
const { chaveProduto } = require('./lib/chave-produto.cjs');

const RAIZ = path.resolve(__dirname, '..');
const DATA = path.join(__dirname, 'data');

// ---------- argumentos ----------
const args = process.argv.slice(2);
const EXECUTAR = args.includes('--executar');
const CRIAR_TIMES = !args.includes('--sem-criar-times');
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
// O PostgREST corta em 1000 linhas por resposta: busca em páginas até acabar.
async function buscarTudo(caminho) {
  const todos = [];
  const sep = caminho.includes('?') ? '&' : '?';
  for (let offset = 0; ; offset += 1000) {
    const pagina = await api('GET', `${caminho}${sep}limit=1000&offset=${offset}`);
    todos.push(...pagina);
    if (pagina.length < 1000) break;
  }
  return todos;
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
  const escolhido = completos.length ? completos[completos.length - 1] : lista[0];
  return { fotos: escolhido.fotos.sort((a, b) => a.idx - b.idx), completo: escolhido.fotos.length === totalEsperado };
}

// ---------- 2) Regras de produto ----------
function tipoDoProduto(r) {
  if (/manga\s*longa|long\s*sleeve/i.test(r.titulo || '')) return 'Long Sleeve';
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
// Camisa que já vem com nome e número (ex.: "... 2026/27 Haaland 9", "... 2014 Klose 11 Modelo Retrô").
// O catálogo esconde a personalização e cobra preço do tipo + R$ 50. Mesma regra usada no backfill do banco.
const RE_JA_PERSONALIZADA = /(^|\s)\d{2,4}(\/\d{2,4})?\s+(.*\s)?[#\p{L}][^\s]*\s\d{1,3}(\s|$)/iu;

function tamanhosDoProduto(r, tipo) {
  if (tipo === 'Kit Infantil') return ['16', '18', '20', '22', '24', '26', '28'];
  if (tipo === 'Long Sleeve') return ['P', 'M', 'G', 'GG', '2XL'];
  const t = Array.isArray(r.tamanhosDetectados) ? r.tamanhosDetectados : [];
  return t.length ? t : ['P', 'M', 'G', 'GG', '2XL'];
}

// Tira o nome do time do título quando a detecção não achou
function derivarTime(titulo) {
  let t = (titulo || '').split(',')[0].replace(/\s+/g, ' ').trim();
  const selecao = /sele[cç][aã]o/i.test(t);
  const prefixos = /^(camisa|camiseta|kit infantil|kit treino|kit|conjunto|jaqueta|agasalho|short|shorts|sele[cç][aã]o|retr[oô]|feminina|feminino|infantil|jogador|torcedor)\s+/i;
  while (prefixos.test(t)) t = t.replace(prefixos, '');
  const corte = t.search(/\s(home|away|third|fourth|i{1,3}|l{1,3}|iv|lv|goleiro|gk|treino|pr[eé][- ]?jogo|preta|preto|branca|branco|azul|vermelha|vermelho|amarela|amarelo|rosa|laranja|cinza|dourada|especial|edi[cç][aã]o|comemorativ\w*|retr[oô]|feminina|feminino|infantil|\d{2,4}(\/\d{2,4})?)(\s|$)/i);
  if (corte > 0) t = t.slice(0, corte);
  t = t.replace(/[^\p{L}\p{N} .&'-]/gu, '').trim();
  if (!t || t.length < 2) return null;
  return { nome: t, liga: selecao ? 'Seleções' : 'Outros' };
}

const ALIAS = {
  'the reds': 'liverpool', 'the gunners': 'arsenal',
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

const NOMES_CERTOS = ['Irã','Jordânia','Bósnia e Herzegovina','República Democrática do Congo','Iraque','Costa do Marfim','Islândia',
  'Nova Zelândia','Jamaica','Áustria','Gana','Polônia','República Tcheca','Hungria','Ucrânia','África do Sul','Argélia','Grécia',
  'Curaçao','Emirados Árabes','Albânia','Chile','Catar','Panamá','Venezuela','Tunísia','Honduras','Irlanda','Turquia','Guatemala',
  'Eslovênia','Dinamarca','Indonésia','Uzbequistão','Senegal','Equador','Guiné','Escócia','Gales','Israel','Cabo Verde','Peru',
  'Camarões','Mali','Angola','Moçambique','Sérvia','Suíça','Finlândia','Romênia','Eslováquia','Rússia','Bolívia','Líbano','Síria',
  'Tailândia','Vietnã','China','Índia','Coreia do Norte','Irlanda do Norte','Macedônia do Norte','Montenegro','Kosovo','Geórgia'];
const MAPA_NOMES = new Map(NOMES_CERTOS.map((n) => [norm(n), n]));
const MINUSCULAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'la', 'del']);
function titleCase(t) {
  return t.split(' ').map((w, i) => {
    const l = w.toLowerCase();
    if (i > 0 && MINUSCULAS.has(l)) return l;
    return l.charAt(0).toUpperCase() + l.slice(1);
  }).join(' ');
}
function nomeFinal(nome, veioDoDetector) {
  const certo = MAPA_NOMES.get(norm(nome));
  if (certo) return certo;
  return veioDoDetector ? titleCase(nome) : nome;
}
function ligaDaLoja(c) {
  if (c.liga !== 'Europa') return c.liga;
  const m = { 'Bundesliga': 'Bundesliga', 'La Liga': 'La Liga', 'Ligue 1': 'Ligue 1', 'Premier League': 'Premier League',
    'Serie A': 'Série A', 'Primeira Liga': 'Liga Portugal' };
  return m[c.subliga] || 'Outros';
}

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

  const times = await buscarTudo(`/rest/v1/teams?select=id,nome,liga&loja_id=eq.${lojaId}&order=id`);
  const existentes = await buscarTudo(`/rest/v1/products?select=id,titulo,tipo,teams(nome)&loja_id=eq.${lojaId}&order=id`);
  const progresso = await buscarTudo('/rest/v1/import_progress?select=url,status,titulo,clube_detectado&order=url');
  const idsUsados = new Set(existentes.map((p) => p.id));
  const timesIdx = times.map((t) => ({ ...t, chave: norm(t.nome) })).sort((a, b) => b.chave.length - a.chave.length);

  // chave canônica -> título que já ocupa essa chave (para o relatório)
  const chaves = new Map();
  for (const p of existentes) {
    const k = chaveProduto(p.titulo, p.teams && p.teams.nome, p.tipo);
    if (!chaves.has(k)) chaves.set(k, `catálogo: ${p.titulo}`);
  }
  const urlsOk = new Set();
  for (const ip of progresso) {
    if (ip.status !== 'ok') continue;
    urlsOk.add(ip.url);
    if (ip.titulo) {
      const k = chaveProduto(ip.titulo, ip.clube_detectado, null);
      if (!chaves.has(k)) chaves.set(k, `import_progress: ${ip.titulo}`);
    }
  }
  console.log('Times:', times.length, '| produtos no catálogo:', existentes.length,
    '| import_progress ok:', urlsOk.size, '| chaves únicas:', chaves.size);

  const rel = { publicados: [], jaProcessado: [], duplicados: [], semFoto: [], semTime: [], fotosIncompletas: [], erros: [], timesCriados: [] };
  let feitos = 0;

  async function marcar(r, status, titulo, clube, erro) {
    if (!EXECUTAR || !r.url) return;
    try {
      await api('POST', '/rest/v1/import_progress?on_conflict=url', {
        url: r.url, status, titulo: titulo || null, clube_detectado: clube || null,
        erro_mensagem: erro || null, processado_em: new Date().toISOString(),
      }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
    } catch (e) {
      console.warn('aviso: não gravou import_progress para', r.url, '-', e.message);
    }
  }

  // acha time existente (sem criar)
  function timeExistente(r, tNorm) {
    const nomeDet = r.clubeDetectado && r.clubeDetectado.nome;
    if (nomeDet) {
      const k = norm(nomeDet);
      const t = timesIdx.find((x) => x.chave === (ALIAS[k] || k));
      if (t) return t;
    }
    return timesIdx.find((x) => contem(tNorm, x.chave)) || null;
  }

  for (const r of registros) {
    if (feitos >= LIMITE) break;
    const titulo = (r.titulo || '').trim();
    if (r.url && urlsOk.has(r.url)) { rel.jaProcessado.push({ titulo, url: r.url }); continue; }
    if (!titulo || !(r.preco > 0)) {
      rel.erros.push({ titulo, motivo: 'sem título ou preço', url: r.url });
      await marcar(r, 'erro', titulo, null, 'sem título ou preço');
      continue;
    }
    const tNorm = norm(titulo);
    const tipo = tipoDoProduto(r);

    // time: existente, ou candidato a ser criado (ainda NÃO cria)
    let time = timeExistente(r, tNorm);
    let novoTime = null;
    if (!time && CRIAR_TIMES) {
      const c = (r.clubeDetectado && r.clubeDetectado.nome) ? r.clubeDetectado : derivarTime(titulo);
      if (c) {
        const nome = nomeFinal(c.nome, !!(r.clubeDetectado && r.clubeDetectado.nome));
        const chaveNome = norm(nome);
        time = timesIdx.find((t) => t.chave === (ALIAS[chaveNome] || chaveNome)) || null;
        if (!time) novoTime = { nome, c };
      }
    }
    const nomeTime = time ? time.nome : novoTime ? novoTime.nome : null;
    if (!nomeTime) {
      rel.semTime.push({ titulo, url: r.url, clubeDetectado: (r.clubeDetectado && r.clubeDetectado.nome) || null });
      await marcar(r, 'erro', titulo, null, 'sem time identificado');
      continue;
    }

    // duplicata: mesma camisa já no catálogo, no import_progress ou no próprio lote
    const chave = chaveProduto(titulo, nomeTime, tipo);
    if (chaves.has(chave)) {
      rel.duplicados.push({ titulo, igualA: chaves.get(chave), chave, url: r.url });
      await marcar(r, 'ok', titulo, nomeTime, `duplicata de ${chaves.get(chave)}`);
      continue;
    }

    // fotos
    const lote = escolherLote(lotes.get(slugify(titulo)), r.totalImagens);
    if (!lote) {
      rel.semFoto.push({ titulo, url: r.url });
      await marcar(r, 'erro', titulo, nomeTime, 'sem foto no Storage');
      continue;
    }
    if (!lote.completo) rel.fotosIncompletas.push({ titulo, esperado: r.totalImagens, achadas: lote.fotos.length });

    // agora sim cria o time, se precisar
    if (!time && novoTime) {
      const { nome, c } = novoTime;
      const sigla = nome.replace(/[^\p{L}]/gu, '').slice(0, 3).toUpperCase() || 'TIM';
      if (EXECUTAR) {
        try {
          const [novo] = await api('POST', '/rest/v1/teams', {
            nome, liga: ligaDaLoja(c), subliga: null, continente: c.continente || null,
            cor: '#00E5FF', sigla, escudo_url: null, loja_id: lojaId,
          }, { Prefer: 'return=representation' });
          time = { ...novo, chave: norm(novo.nome) };
        } catch (e) {
          rel.erros.push({ titulo, motivo: 'criar time: ' + String(e.message || e), url: r.url });
          await marcar(r, 'erro', titulo, nome, 'falha ao criar time');
          continue;
        }
      } else {
        time = { id: '(novo)', nome, chave: norm(nome) };
      }
      timesIdx.push(time);
      timesIdx.sort((a, b) => b.chave.length - a.chave.length);
      rel.timesCriados.push(nome);
    }

    const prefixo = `${time.nome}||${tipo}`;
    let id = prefixo;
    for (let n = 2; idsUsados.has(id); n++) id = `${prefixo}||${n}`;

    const linha = {
      id, team_id: time.id, tipo, titulo, subtitulo: subtituloDoProduto(r, tipo),
      descricao: null, preco: r.preco, tamanhos: tamanhosDoProduto(r, tipo), tags: [],
      disponivel: false, destaque: false, lancamento: false, loja_id: lojaId,
      ja_personalizada: RE_JA_PERSONALIZADA.test(titulo),
    };
    const imagens = lote.fotos.map((f, i) => ({
      product_id: id, ordem: i, loja_id: lojaId,
      url: `${URL_BASE}/storage/v1/object/public/produtos/${lojaId}/${f.nome.replace(lojaId + '/', '')}`,
    }));
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
        await marcar(r, 'erro', titulo, time.nome, String(e.message || e).slice(0, 500));
        continue;
      }
      await marcar(r, 'ok', titulo, time.nome, null);
    }
    idsUsados.add(id);
    chaves.set(chave, `este lote: ${titulo}`);
    rel.publicados.push({ id, titulo, time: time.nome, tipo, fotos: imagens.length, chave });
    feitos++;
    if (feitos % 25 === 0) console.log(`... ${feitos} produtos`);
  }

  const saida = path.join(DATA, EXECUTAR ? 'relatorio-publicar.json' : 'relatorio-simulacao.json');
  fs.writeFileSync(saida, JSON.stringify(rel, null, 2));

  console.log('\n===== RESUMO =====');
  console.table({
    [EXECUTAR ? 'Publicados (rascunho)' : 'Seriam publicados']: rel.publicados.length,
    'Já processados (import_progress ok)': rel.jaProcessado.length,
    'Duplicados (mesma camisa)': rel.duplicados.length,
    'Sem foto no Storage': rel.semFoto.length,
    'Sem time identificado': rel.semTime.length,
    'Fotos incompletas (usadas mesmo assim)': rel.fotosIncompletas.length,
    'Times novos (criados/a criar)': rel.timesCriados.length,
    'Erros': rel.erros.length,
  });
  console.log('Relatório completo em:', saida);
  if (rel.duplicados.length) {
    console.log('Exemplos de duplicados:');
    for (const d of rel.duplicados.slice(0, 5)) console.log(`  ${d.titulo}  ==  ${d.igualA}`);
  }
  if (rel.semTime.length) console.log('Exemplos sem time:', rel.semTime.slice(0, 5).map((x) => x.titulo).join(' | '));
  if (rel.timesCriados.length) console.log('Times novos:', rel.timesCriados.join(', '));
  if (rel.erros.length) console.log('Primeiro erro:', JSON.stringify(rel.erros[0]));
})().catch((e) => { console.error('\nERRO FATAL:', e.message); process.exit(1); });
