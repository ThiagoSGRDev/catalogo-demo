/**
 * TRIAL SYSTEM
 * Gerencia planos de trial de 3 dias para novas lojas
 */

const TrialSystem = (() => {
  /**
   * Verifica status de trial da loja
   * @param {SupabaseClient} supabaseClient
   * @param {string} lojaId - ID da loja
   * @returns {Promise<Object>} { status, diasRestantes, bloqueado, mensagem }
   */
  async function verificarTrial(supabaseClient, lojaId) {
    try {
      const { data: loja, error } = await supabaseClient
        .from('lojas')
        .select('status, trial_expira_em, data_criacao')
        .eq('id', lojaId)
        .single();

      if (error || !loja) {
        return {
          status: 'erro',
          bloqueado: true,
          mensagem: 'Loja não encontrada'
        };
      }

      // Se já é ativo (pagou), sem restrição
      if (loja.status === 'ativo') {
        return {
          status: 'ativo',
          bloqueado: false,
          diasRestantes: null,
          mensagem: 'Plano ativo'
        };
      }

      // Se bloqueado, acesso negado
      if (loja.status === 'bloqueado') {
        return {
          status: 'bloqueado',
          bloqueado: true,
          diasRestantes: 0,
          mensagem: 'Trial expirou. Faça upgrade para continuar',
          urlUpgrade: 'upgrade.html'
        };
      }

      // Trial ainda ativo
      if (loja.status === 'trial') {
        const agora = new Date();
        const expiracao = new Date(loja.trial_expira_em);
        const diasRestantes = Math.ceil((expiracao - agora) / (1000 * 60 * 60 * 24));

        if (diasRestantes <= 0) {
          // Auto-bloquear se expirou
          await supabaseClient
            .from('lojas')
            .update({ status: 'bloqueado' })
            .eq('id', lojaId);

          return {
            status: 'bloqueado',
            bloqueado: true,
            diasRestantes: 0,
            mensagem: 'Trial expirou. Faça upgrade para continuar',
            urlUpgrade: 'upgrade.html'
          };
        }

        return {
          status: 'trial',
          bloqueado: false,
          diasRestantes,
          mensagem: `Trial grátis: ${diasRestantes} dia${diasRestantes !== 1 ? 's' : ''} restante${diasRestantes !== 1 ? 's' : ''}`
        };
      }

      return {
        status: 'desconhecido',
        bloqueado: true,
        mensagem: 'Status desconhecido'
      };
    } catch (err) {
      console.error('Erro ao verificar trial:', err);
      return {
        status: 'erro',
        bloqueado: true,
        mensagem: 'Erro ao verificar status'
      };
    }
  }

  /**
   * Mostra banner de trial no painel
   */
  function mostrarBannerTrial(diasRestantes) {
    const banner = document.createElement('div');
    banner.id = 'banner-trial';
    banner.style.cssText = `
      position: fixed;
      top: 64px;
      left: 0;
      right: 0;
      background: linear-gradient(135deg, #F59E0B 0%, #D97706 100%);
      color: #FFFFFF;
      padding: 16px 20px;
      font-weight: 600;
      text-align: center;
      z-index: 1000;
      box-shadow: 0 4px 12px rgba(245, 158, 11, 0.3);
    `;
    banner.innerHTML = `
      <span>⏰ Trial grátis: <strong>${diasRestantes}</strong> dia${diasRestantes !== 1 ? 's' : ''} restante${diasRestantes !== 1 ? 's' : ''}!</span>
      <a href="upgrade.html" style="margin-left: 16px; color: white; text-decoration: underline; font-weight: bold;">
        Fazer upgrade agora →
      </a>
    `;
    document.body.insertBefore(banner, document.body.firstChild);
  }

  /**
   * Bloqueia acesso ao painel se trial expirou
   */
  function bloquearAcesso(lojaId) {
    document.body.innerHTML = `
      <div style="
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        background: linear-gradient(135deg, #07090C 0%, #161B26 100%);
        color: #FFFFFF;
        padding: 20px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      ">
        <div style="text-align: center; max-width: 500px;">
          <div style="font-size: 64px; margin-bottom: 20px;">🔒</div>
          <h1 style="font-size: 28px; margin-bottom: 16px;">Trial Expirado</h1>
          <p style="font-size: 18px; color: #94A3B8; margin-bottom: 32px;">
            Seu período de teste grátis terminou.
          </p>
          <p style="font-size: 16px; color: #64748B; margin-bottom: 32px;">
            Faça upgrade do seu plano para continuar usando Katalogo Hub.
          </p>
          <a href="upgrade.html" style="
            display: inline-block;
            background: #35FFC0;
            color: #0A0A0A;
            padding: 12px 32px;
            border-radius: 8px;
            text-decoration: none;
            font-weight: 600;
            font-size: 16px;
            margin-bottom: 16px;
            transition: background 0.3s;
          " onmouseover="this.style.background='#22D3A8'" onmouseout="this.style.background='#35FFC0'">
            Fazer Upgrade
          </a>
          <p style="font-size: 14px; color: #64748B;">
            Precisa de ajuda? <a href="mailto:support@katalogohub.com" style="color: #35FFC0; text-decoration: none;">Contate o suporte</a>
          </p>
        </div>
      </div>
    `;
  }

  /**
   * Desabilita inputs de edição durante trial
   */
  function desabilitarEdicao() {
    const inputs = document.querySelectorAll('input[type="text"], input[type="email"], textarea, select');
    const botoes = document.querySelectorAll('button[data-salvar], button.btn-primary');

    inputs.forEach(input => {
      input.disabled = true;
      input.style.opacity = '0.5';
      input.title = 'Só leitura em trial. Faça upgrade para editar.';
    });

    botoes.forEach(btn => {
      btn.disabled = true;
      btn.style.opacity = '0.5';
      btn.style.cursor = 'not-allowed';
      btn.title = 'Só leitura em trial. Faça upgrade para editar.';
    });
  }

  return {
    verificarTrial,
    mostrarBannerTrial,
    bloquearAcesso,
    desabilitarEdicao
  };
})();
