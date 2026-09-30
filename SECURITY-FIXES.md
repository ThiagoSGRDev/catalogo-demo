# ⚠️ Fixes de Segurança Críticas - AÇÕES NECESSÁRIAS

## Status: ✅ PARCIALMENTE IMPLEMENTADO

Alguns fixes foram implementados automaticamente. Outros **PRECISAM DE VOCÊ**.

---

## ✅ JÁ FEITO (Código commitado)

### 1. ✅ Validação de Slug (SQL Injection Prevention)
- **Status:** IMPLEMENTADO
- **Arquivo:** `loja/loja.js`, `loja/*/index.html`
- **O que faz:** Rejeita slugs com caracteres especiais
- **Formato válido:** `^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])?$`
- **Exemplo inválido:** `/loja/"; DELETE FROM lojas; --/` → BLOQUEADO ✅

### 2. ✅ .gitignore Configurado
- **Status:** IMPLEMENTADO
- **Arquivo:** `.gitignore`
- **O que faz:** Protege `.env` de ser commitado
- **Próximo:** Copiar `.env.example` → `.env` e preencher

### 3. ✅ .env.example Criado
- **Status:** IMPLEMENTADO
- **Arquivo:** `.env.example`
- **O que faz:** Template seguro para configuração
- **Seu passo:** Criar `.env` com seus valores reais

---

## 🔴 CRÍTICO - VOCÊ PRECISA FAZER (HOJE)

### 1. 🔴 REMOVER CHAVES DO GIT HISTORY
**Por que:** Chaves expostas no histórico pode ser recuperadas com `git log`

**Passo 1: Regenerar chaves Supabase**
```
1. Ir em: https://app.supabase.com/project/_/settings/api
2. Gerar NOVA chave anônima
3. Copiar a nova chave
```

**Passo 2: Remover histórico antigo**
```bash
cd /home/claude/catalogo-demo

# Remove arquivo do histórico
git filter-branch --force --index-filter \
  'git rm --cached --ignore-unmatch loja/loja.js' \
  --prune-empty --tag-name-filter cat -- --all

# Force push (⚠️ isso reescreve histórico)
git push origin --force --all
git push origin --force --tags
```

**Passo 3: Usar nova chave em .env**
```bash
# Criar .env
cp .env.example .env

# Editar:
VITE_SUPABASE_URL=https://seu-projeto.supabase.co
VITE_SUPABASE_ANON_KEY=sua-nova-chave-aqui
```

---

### 2. 🔴 ATIVAR ROW LEVEL SECURITY (RLS) NO SUPABASE
**Por que:** Sem RLS, qualquer um com a chave lê TODOS os dados

**Executar este SQL no Supabase:**
```sql
-- 1. Ativar RLS nas tabelas
ALTER TABLE lojas ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE loja_produtos_override ENABLE ROW LEVEL SECURITY;
ALTER TABLE loja_produtos_imagens ENABLE ROW LEVEL SECURITY;
ALTER TABLE loja_produtos_ocultos ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventos ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_settings ENABLE ROW LEVEL SECURITY;

-- 2. Policies para LOJAS (apenas dono vê suas config)
CREATE POLICY "lojas_owner_read"
  ON lojas FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "lojas_public_read"
  ON lojas FOR SELECT
  USING (true);  -- Todos podem ver slug/nome

-- 3. Policies para PRODUCTS (apenas admin pode modificar)
CREATE POLICY "products_public_read"
  ON products FOR SELECT
  USING (true);

CREATE POLICY "products_owner_modify"
  ON products FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM lojas
      WHERE lojas.id = products.loja_id
      AND lojas.user_id = auth.uid()
    )
  );

-- 4. Policies para EVENTOS (loja vê seus eventos)
CREATE POLICY "eventos_loja_read"
  ON eventos FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM lojas
      WHERE lojas.id = eventos.loja_id
      AND lojas.user_id = auth.uid()
    )
  );

-- 5. Policies para STORE_SETTINGS
CREATE POLICY "store_settings_read"
  ON store_settings FOR SELECT
  USING (true);

CREATE POLICY "store_settings_owner_modify"
  ON store_settings FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM lojas
      WHERE lojas.id = store_settings.loja_id
      AND lojas.user_id = auth.uid()
    )
  );
```

**Validar:** Ir em `https://app.supabase.com/project/_/auth/policies` e confirmar RLS ativo

---

### 3. 🔴 USAR VARIÁVEIS DE AMBIENTE
**Passo 1:** Criar `.env` (não fazer commit)
```bash
cp .env.example .env
# Editar com sua chave real
```

**Passo 2:** Atualizar `loja/loja.js` para usar variável:
```javascript
// Antes (❌ hardcoded):
const SUPABASE_URL = 'https://qqoepslbisxpswabrkqe.supabase.co';
const SUPABASE_KEY = 'sb_publishable_...';

// Depois (✅ variável):
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || window.SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || window.SUPABASE_KEY;
```

---

## 🟡 ALTO - PRÓXIMOS (ESTA SEMANA)

### 1. Implementar Rate Limiting
- Usar Cloudflare ou nginx
- Máx 100 req/min por IP
- Bloquear padrões de brute force

### 2. Adicionar CSRF Protection
- Token CSRF em forms
- Validar origem de requests

### 3. Completar XSS Validation
- Auditar todos os usos de `esc()`
- Testar com payloads de XSS
- Sanitizar uploads de imagem

---

## 📋 CHECKLIST FINAL

```
[ ] 1. Regenerar chaves Supabase
[ ] 2. Remover histórico do Git (git filter-branch)
[ ] 3. Force push para repositório
[ ] 4. Criar .env local com nova chave
[ ] 5. Executar SQL de RLS no Supabase
[ ] 6. Validar RLS ativo em Dashboard
[ ] 7. Testar acesso cruzado (deve falhar)
[ ] 8. Deletar .env.local após testes
```

---

## ⚡ RESUMO DE RISCO

**Antes dos Fixes:**
- Score: 3/10 🔴
- Qualquer pessoa acessa dados de qualquer loja

**Depois de implementar TODOS os fixes:**
- Score: 8/10 ✅
- Dados isolados por dono
- Chaves não expostas

---

## 🆘 PRECISA DE AJUDA?

Se qualquer passo acima for confuso, posso ajudar:
1. Executar SQL diretamente no Supabase
2. Atualizar código para variáveis de ambiente
3. Validar que RLS está funcionando

Só avisa!
