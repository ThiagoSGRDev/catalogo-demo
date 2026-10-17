/**
 * Pixel da Meta (Facebook/Instagram Ads) das páginas de venda do Katalogo Hub.
 * Usado só em landing-vendas.html, register.html e upgrade.html. NUNCA no catálogo das lojas.
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
 *
 * Deduplicação com a API de Conversões (servidor): o Purchase leva um event_id fixo,
 * 'purchase_<id do usuário>', lido da sessão do Supabase no navegador. A função do
 * servidor (webhook do Asaas) envia o mesmo event_id; a Meta conta a compra uma vez só.
 */
(function () {
  var PIXEL_ID = '1851397046180782';

  // Id do usuário logado (sessão do Supabase guardada pelo próprio supabase-js no navegador).
  function idDoUsuario() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (/^sb-.+-auth-token$/.test(k)) {
          var s = JSON.parse(localStorage.getItem(k) || 'null');
          var u = s && (s.user || (s.currentSession && s.currentSession.user));
          if (u && u.id) return String(u.id);
        }
      }
    } catch (e) { /* sem sessão: segue sem event_id */ }
    return null;
  }

  window.khTrack = function (evento, dados, opcoes) {
    try {
      if (!window.fbq) return;
      if (evento === 'Purchase' && !(opcoes && opcoes.eventID)) {
        var uid = idDoUsuario();
        if (uid) opcoes = { eventID: 'purchase_' + uid };
      }
      if (opcoes) window.fbq('track', evento, dados || {}, opcoes);
      else window.fbq('track', evento, dados || {});
    } catch (e) { /* nunca quebra a página */ }
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
