/**
 * chave-produto.cjs — gera uma "chave canônica" para detectar camisas iguais
 * escritas de jeitos diferentes.
 *
 *   "Camisa Real Madrid Home 2026/2027 - Torcedor"
 *   "Camisa Real Madrid l 2026/27 - Masculino torcedor"
 *   -> as duas viram: "real madrid|torcedor|kit1|2627"
 *
 * Equivalências:
 *   Home = I = l = 1      Away = II = ll = 2
 *   Third = III = lll = 3 Fourth = IV = lV = 4
 *   Temporada: 2026/27 = 26/27 = 2026/2027 = 2026-27 -> "2627"
 *
 * O que NÃO é igual (continua separado): manga longa, goleiro, modelo jogador,
 * retrô, feminina, infantil/kit, treino, pré-jogo, edição especial, cores.
 */

function norm(t) {
  return (t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[-_]/g, ' ').replace(/[^a-z0-9/ ]/g, ' ').replace(/\s+/g, ' ').trim();
}

const KIT = {
  home: 'kit1', i: 'kit1', l: 'kit1', '1': 'kit1',
  away: 'kit2', ii: 'kit2', ll: 'kit2', '2': 'kit2',
  third: 'kit3', iii: 'kit3', lll: 'kit3', '3': 'kit3',
  fourth: 'kit4', iv: 'kit4', lv: 'kit4', '4': 'kit4',
};

// palavras que não mudam o produto
const RUIDO = new Set([
  'camisa', 'camiseta', 'masculina', 'masculino', 'torcedor', 'torcedora', 'modelo', 'versao',
  'fan', 'selecao', 'uniforme', 'de', 'do', 'da', 'e', 'the', 'oficial', 'nova', 'novo', 'temporada', 'season', 'kit',
]);

// sinais de versão no título (têm prioridade sobre o campo tipo)
function versaoDoTitulo(tokens) {
  const s = ' ' + tokens.join(' ') + ' ';
  if (/ (jogador|player) /.test(s)) return 'jogador';
  if (/ retro /.test(s)) return 'retro';
  if (/ (feminina|feminino|women|woman) /.test(s)) return 'feminina';
  if (/ (infantil|kids|crianca) /.test(s)) return 'infantil';
  return null;
}
const PALAVRAS_VERSAO = new Set(['jogador', 'player', 'retro', 'feminina', 'feminino', 'women', 'woman', 'infantil', 'kids', 'crianca']);

function versaoDoTipo(tipo) {
  const t = norm(tipo);
  if (!t) return null;
  if (t.includes('jogador')) return 'jogador';
  if (t.includes('retro')) return 'retro';
  if (t.includes('femin')) return 'feminina';
  if (t.includes('infantil')) return 'infantil';
  return 'torcedor';
}

// "2026/27", "26/27", "2026/2027", "2026 27" -> "2627"; "2026" sozinho -> "26"
function extrairTemporada(texto) {
  const m = texto.match(/\b(?:20)?(\d{2})\s*[/ ]\s*(?:20)?(\d{2})\b/);
  if (m && Number(m[2]) === (Number(m[1]) + 1) % 100) return { temp: m[1] + m[2], resto: texto.replace(m[0], ' ') };
  const a = texto.match(/\b20(\d{2})\b/);
  if (a) return { temp: a[1], resto: texto.replace(a[0], ' ') };
  return { temp: null, resto: texto };
}

/**
 * @param {string} titulo
 * @param {string|null} timeNome  nome do time (do banco ou detectado)
 * @param {string|null} tipo      campo tipo do produto (Torcedor, Jogador, Retrô, Feminina, Kit Infantil)
 */
function chaveProduto(titulo, timeNome, tipo) {
  const { temp, resto } = extrairTemporada(norm(titulo).replace(/\//g, ' / '));
  let tokens = resto.replace(/\//g, ' ').split(' ').filter(Boolean);

  const versao = versaoDoTitulo(tokens) || versaoDoTipo(tipo) || 'torcedor';

  const timeTokens = new Set(norm(timeNome).split(' ').filter(Boolean));
  let kit = null;
  const extras = [];
  for (const tk of tokens) {
    if (timeTokens.has(tk) || RUIDO.has(tk) || PALAVRAS_VERSAO.has(tk)) continue;
    if (!kit && KIT[tk]) { kit = KIT[tk]; continue; }
    extras.push(tk);
  }
  const time = timeTokens.size ? [...timeTokens].join(' ') : '?';
  return [time, versao, kit || '-', temp || '-', extras.sort().join(' ')].join('|').replace(/\|$/, '');
}

module.exports = { chaveProduto, norm };
