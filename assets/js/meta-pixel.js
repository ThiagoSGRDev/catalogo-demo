/**
 * Pixel da Meta (Facebook/Instagram Ads) das páginas de venda do Katalogo Hub.
 * Usado só em landing-vendas.html e register.html. NUNCA no catálogo das lojas.
 *
 * Enquanto PIXEL_ID estiver vazio, nada é carregado e khTrack() não faz nada.
 * O ID vem do Gerenciador de Eventos da Meta (não é segredo: aparece no navegador).
 *
 * Eventos usados:
 *   PageView             -> toda página que inclui este arquivo
 *   Contact              -> clique no WhatsApp
 *   InitiateCheckout     -> abriu "Quero ativar agora" (plano pago)
 *   CompleteRegistration -> criou a conta do teste grátis (register.html)
 *   Purchase             -> Pix da assinatura confirmado (valor do plano)
 */
(function () {
  var PIXEL_ID = '';

  window.khTrack = function (evento, dados) {
    try { if (window.fbq) window.fbq('track', evento, dados || {}); } catch (e) { /* nunca quebra a página */ }
  };

  if (!PIXEL_ID) return;

  !function (f, b, e, v, n, t, s) {
    if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
    if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
    t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
  }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');

  window.fbq('init', PIXEL_ID);
  window.fbq('track', 'PageView');
})();
