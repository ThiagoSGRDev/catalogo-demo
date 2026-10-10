// Manifesto do app instalável de CADA loja, servido em URL real (/api/manifest?slug=...).
// O Chrome do Android só instala como app (WebAPK) quando o manifesto tem URL http(s);
// manifesto "blob:" montado no navegador cai em "criar atalho" ou "já instalado".
// Só lê dados públicos (nome e cor da loja) com a chave publicável do Supabase.

const SUPABASE_URL = 'https://qqoepslbisxpswabrkqe.supabase.co';
const SUPABASE_KEY = 'sb_publishable_vN1Q4fw4uTm1sflUx8KmCQ_eVrIoCzr';

const COR_PADRAO = '#0A0D10';

function corValida(c) {
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : COR_PADRAO;
}

async function consultar(caminho) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + caminho, {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
  });
  if (!r.ok) return null;
  const j = await r.json();
  return Array.isArray(j) && j.length ? j[0] : null;
}

module.exports = async (req, res) => {
  const slug = String((req.query && req.query.slug) || '').toLowerCase();
  const slugOk = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);

  let nome = 'Katalogo Hub';
  let cor = COR_PADRAO;
  if (slugOk) {
    try {
      const loja = await consultar('lojas?select=id,nome,ativa&slug=eq.' + encodeURIComponent(slug) + '&limit=1');
      if (loja && loja.ativa) {
        nome = loja.nome || nome;
        const cfg = await consultar('store_settings?select=cor_primaria&loja_id=eq.' + encodeURIComponent(loja.id) + '&limit=1');
        if (cfg) cor = corValida(cfg.cor_primaria);
      }
    } catch (e) { /* cai no padrão */ }
  }

  const raiz = slugOk ? '/catalogo/loja/' + slug + '/' : '/';
  const manifesto = {
    name: nome,
    short_name: nome.slice(0, 12),
    id: raiz,
    start_url: raiz,
    scope: raiz,
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0A0D10',
    theme_color: cor,
    lang: 'pt-BR',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  };

  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  res.status(200).send(JSON.stringify(manifesto));
};
