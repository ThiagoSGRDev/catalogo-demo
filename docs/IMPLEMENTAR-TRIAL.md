# Como Implementar Trial de 7 Dias

## Passo 1: Executar Migration no Supabase

1. Abra https://supabase.com/dashboard
2. Vá para seu projeto **katalogohub**
3. Menu **SQL Editor** (lado esquerdo)
4. Cole o conteúdo de `docs/TRIAL-MIGRATION.sql`
5. Clique em **"Run"** (botão azul)

Pronto! Suas tabelas agora têm:
- `trial_expira_em` (data de expiração)
- `status` (trial, ativo, bloqueado, cancelado)
- `data_criacao` (quando a loja foi criada)

## Passo 2: Adicionar Script no Admin

No seu `admin.html`, adicione no `<head>`:

```html
<script src="loja/security/trial-system.js"></script>
```

## Passo 3: Verificar Trial ao Fazer Login

Procure no `admin.html` onde faz `onAuthStateChange` e adicione:

```javascript
supabaseClient.auth.onAuthStateChange(async (event, session) => {
  if (event === 'SIGNED_IN') {
    // Seu código existente...
    
    // NOVO: Verificar trial
    const statusTrial = await TrialSystem.verificarTrial(supabaseClient, ADMIN_LOJA_ID);
    
    if (statusTrial.bloqueado) {
      // Bloquear acesso
      TrialSystem.bloquearAcesso(ADMIN_LOJA_ID);
      return;
    }
    
    if (statusTrial.status === 'trial' && statusTrial.diasRestantes <= 3) {
      // Mostrar aviso (faltam 3 dias ou menos)
      TrialSystem.mostrarBannerTrial(statusTrial.diasRestantes);
    }
  }
});
```

## Passo 4: Auto-Criar Trial ao Registrar

Quando um novo usuário se registra, a coluna `trial_expira_em` já vem preenchida com hoje + 7 dias.

## Passo 5: Criar Página de Upgrade

Crie arquivo `/upgrade.html` com opções de pagamento (Pix, cartão, etc).

## Resultado

| Dia | O que Acontece |
|-----|---------------|
| 1-3 | ✅ Acesso liberado (trial) |
| 2 | 🔔 Banner aviso aparece |
| 3 | 🔒 Acesso bloqueado |
| Paga | ✅ Status muda para 'ativo' |

## Teste

1. Crie uma nova conta
2. Verifique no Supabase se `trial_expira_em` foi preenchido
3. Mude manualmente para 1 dia atrás
4. Recarregue o admin.html
5. Deve bloquear com tela de upgrade

---

## Próximos Passos

- [ ] Executar migration SQL
- [ ] Adicionar script trial-system.js no admin
- [ ] Integrar verificação ao login
- [ ] Criar página /upgrade.html
- [ ] Testar com cliente real

