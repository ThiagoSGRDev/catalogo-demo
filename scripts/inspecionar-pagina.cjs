#!/usr/bin/env node
/**
 * inspecionar-pagina.cjs — só LÊ uma página do fornecedor e mostra, de forma compacta,
 * onde ficam as fotos do produto e onde começam as "outras camisas" (relacionados).
 * Não grava nada no banco nem no Storage.
 *
 * Uso: node scripts/inspecionar-pagina.cjs <url-do-produto>
 * Saída também salva em scripts/data/inspecao.txt
 */
const fs = require('fs');
const path = require('path');

const url = process.argv[2];
if (!url) { console.error('Uso: node scripts/inspecionar-pagina.cjs <url>'); process.exit(1); }

(async () => {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36' } });
  const html = await r.text();
  const out = [];
  const p = (s = '') => out.push(s);

  p(`URL: ${url}`);
  p(`HTTP ${r.status} | HTML ${html.length} bytes`);

  // JSON-LD
  const ld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  p(`\n== JSON-LD (${ld.length} blocos) ==`);
  for (const m of ld) {
    try {
      let j = JSON.parse(m[1].trim());
      const lista = Array.isArray(j) ? j : j['@graph'] ? j['@graph'] : [j];
      for (const b of lista) {
        const t = JSON.stringify(b['@type']);
        const img = b.image ? (Array.isArray(b.image) ? b.image : [b.image]).map((x) => (typeof x === 'string' ? x : x.url)) : [];
        p(`- @type=${t} name=${(b.name || '').toString().slice(0, 60)} imagens=${img.length}`);
        img.slice(0, 15).forEach((u) => p(`    ${u}`));
      }
    } catch { p('- bloco JSON-LD inválido'); }
  }

  // og:image
  const og = [...html.matchAll(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/gi)].map((m) => m[1]);
  p(`\n== og:image (${og.length}) ==`);
  og.forEach((u) => p(`  ${u}`));

  // marcadores de seção
  const marcadores = ['relacionad', 'recomend', 'voc[eê] tamb[eé]m', 'veja tamb[eé]m', 'related', 'mais vendidos', 'quem viu', 'outros produtos', 'produtos similares', 'similares', 'tamb[eé]m (?:comprou|gostou)'];
  p('\n== Marcadores de seção (posição no HTML) ==');
  for (const mk of marcadores) {
    const re = new RegExp(mk, 'gi');
    const pos = [];
    let m;
    while ((m = re.exec(html)) && pos.length < 5) pos.push(m.index);
    if (pos.length) p(`  ${mk}: ${pos.join(', ')}`);
  }

  // imagens <img> com posição e classe/atributos
  p('\n== <img> no HTML (posição | src | classe/alt) ==');
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)];
  let n = 0;
  for (const m of imgs) {
    const tag = m[0];
    const src = (tag.match(/\b(?:data-src|data-original|src)=["']([^"']+)["']/i) || [])[1] || '';
    if (!src || src.startsWith('data:')) continue;
    if (/logo|icon|sprite|favicon|payment|bandeira|whatsapp|instagram|facebook/i.test(src)) continue;
    const cls = (tag.match(/class=["']([^"']*)["']/i) || [])[1] || '';
    const alt = (tag.match(/alt=["']([^"']*)["']/i) || [])[1] || '';
    p(`  ${String(m.index).padStart(6)} | ${src.replace(/^https?:\/\/[^/]+/, '').slice(0, 90)} | ${cls.slice(0, 40)} | ${alt.slice(0, 40)}`);
    if (++n >= 45) { p('  ... (cortado em 45)'); break; }
  }

  // trecho de HTML ao redor do primeiro marcador de "relacionados"
  const mrel = html.search(/relacionad|related|voc[eê] tamb[eé]m/i);
  if (mrel > 0) {
    p('\n== HTML em volta do 1º marcador de relacionados (300 chars antes) ==');
    p(html.slice(Math.max(0, mrel - 300), mrel + 80).replace(/\s+/g, ' '));
  }

  const texto = out.join('\n');
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'data', 'inspecao.txt'), texto);
  console.log(texto);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
