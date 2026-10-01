# Sistema de Trial Grátis

## Implementação

### 1. Migration SQL (executar no Supabase)

```sql
-- Adicionar coluna trial_expira_em na tabela lojas
ALTER TABLE lojas ADD COLUMN trial_expira_em TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '3 days');

-- Adicionar coluna status (ativo, cancelado, bloqueado)
ALTER TABLE lojas ADD COLUMN status TEXT DEFAULT 'trial' CHECK (status IN ('trial', 'ativo', 'cancelado', 'bloqueado'));

-- Adicionar coluna data_criacao
ALTER TABLE lojas ADD COLUMN data_criacao TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- Index para buscar lojas expiradas
CREATE INDEX idx_lojas_trial_expira ON lojas(trial_expira_em) WHERE status = 'trial';
```

### 2. Lógica no Admin

**Ao fazer login:**
- Verifica se loja está em trial
- Se expirou → mostra aviso de upgrade
- Se ativo → acesso liberado
- Se cancelado → bloqueia com opção de reativar

**Ao criar loja:**
- Define `trial_expira_em` = hoje + 7 dias
- Status = 'trial'

### 3. Verificação de Trial

```javascript
async function verificarStatusLoja(supabaseClient, lojaId) {
  const { data: loja, error } = await supabaseClient
    .from('lojas')
    .select('status, trial_expira_em, data_criacao')
    .eq('id', lojaId)
    .single();

  if (!loja) return { status: 'nao_encontrada', dias_restantes: 0 };

  const agora = new Date();
  const expiracao = new Date(loja.trial_expira_em);
  const diasRestantes = Math.ceil((expiracao - agora) / (1000 * 60 * 60 * 24));

  return {
    status: loja.status,
    diasRestantes: Math.max(0, diasRestantes),
    trialExpirou: diasRestantes <= 0 && loja.status === 'trial'
  };
}
```

## Fluxo de Uso

### Cliente novo
1. Acessa katalogohub.com/admin.html
2. Faz login com email
3. Sistema cria loja com trial de 7 dias automaticamente
4. Mostra banner: "Trial grátis: 7 dias restantes"

### Após trial expirar
1. Sistema bloqueia acesso
2. Mostra opção de upgrade (Pix, cartão, etc)
3. Cliente pode ver catálogo público (leia-se: não consegue editar)

### Cliente paga
1. Status muda de 'trial' para 'ativo'
2. trial_expira_em é removido ou atualizado
3. Acesso ilimitado liberado

## Checklist

- [ ] Executar migration SQL no Supabase
- [ ] Adicionar função verificarStatusLoja() ao admin.html
- [ ] Mostrar banner de trial no painel
- [ ] Bloquear edição após expiração
- [ ] Criar página de upgrade
- [ ] Testar com cliente

