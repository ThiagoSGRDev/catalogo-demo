# 🔓 AUDIT DE SEGURANÇA - KATALOGO HUB

## ⚠️ VULNERABILIDADES CRÍTICAS ENCONTRADAS

### 1. **CREDENCIAIS EXPOSTAS NO CÓDIGO** 🔴 CRÍTICO
```
Arquivo: loja/loja.js (linhas 2-3)
const SUPABASE_URL = 'https://qqoepslbisxpswabrkqe.supabase.co';
const SUPABASE_KEY = 'sb_publishable_t-LqIKyLqCT4Kx8Hgi7JcA_tvk3gjsy';
```

**Risco:** Chave Supabase pública exposta no código-fonte
- Qualquer pessoa com a chave pode:
  - Ler TODOS os dados da tabela (produtos, lojas, clientes)
  - Fazer queries SQL arbitrárias
  - Modificar dados se RLS não estiver ativo
  - Deletar informações de clientes

**Prova:** A chave está em:
- `/loja/loja.js` (público)
- `/loja/katalogo-hub/index.html` (público)
- `/loja/manto-dez-sports/index.html` (público)
- Qualquer pessoa com acesso ao GitHub repo vê tudo

---

### 2. **SQL INJECTION via SUPABASE QUERIES** 🔴 CRÍTICO
```javascript
// loja/loja.js linha 24
.eq('slug', storeSlug)  // storeSlug vem direto da URL!
```

**Risco:** Se o slug não for sanitizado corretamente:
- URL: `/loja/"; DELETE FROM lojas; --/`
- Poderia tentar injetar comandos SQL

**Verificação:** 
- `getStoreSlugFromURL()` apenas faz `.split('/')` — não valida conteúdo
- PostgREST usa prepared statements (mais seguro), mas ainda é risco

---

### 3. **ACESSO CRUZADO ENTRE LOJAS** 🔴 CRÍTICO
**Cenário:** Usuário B logado como "outro-usuario" consegue acessar dados de Manto Dez Sports

```javascript
// loja.js validação é FRACA:
if (user.id === storeData.user_id) {
  window.ADMIN_LOJA_ID = storeData.id;
}
```

**Problema:** 
- Se `ADMIN_LOJA_ID` não for setado, o catálogo AINDA carrega
- `resolverLoja()` faz query por slug (não por ID)
- Usuário B vê dados que não deveria

**Prova de Conceito:**
```javascript
// No console, qualquer um pode fazer:
window.ADMIN_LOJA_ID = '8a4cc84b-cec5-4d51-9cca-90915f7b3d79'; // ID do Manto
// Agora vê dados reais mesmo sem validação
```

---

### 4. **DADOS DE CLIENTES EXPOSTOS NO BANCO** 🔴 CRÍTICO
**Arquivo não compartilhado, mas precisa verificar:**

Se a tabela `eventos` tem informações de clientes (email, telefone, endereço), está exposta porque:
- Qualquer pessoa com a chave Supabase consegue ler
- Row Level Security (RLS) não está visível no código

```javascript
// loja/manto-dez-sports/index.html linha 2837
await supabaseClient.from('eventos').insert({
  loja_id: LOJA_ID, 
  tipo: 'visita' 
});
// Quais outros dados são gravados aqui?
```

---

### 5. **CHAVE PUBLICÁVEL MUITO PERMISSIVA** 🟡 ALTO
```
sb_publishable_t-LqIKyLqCT4Kx8Hgi7JcA_tvk3gjsy
           ^^^^^^^^^^^
         PUBLICÁVEL = risco
```

**O que pode fazer com chave `publishable`:**
- Ler: ✅ qualquer tabela (sem RLS)
- Escrever: ✅ inserir/atualizar/deletar (sem RLS)
- Invocar funções: ✅ `estoque_publico`, `calcular-frete`
- Fazer auth: ✅ login/signup
- Chamar Edge Functions: ✅

Se RLS não estiver ATIVO, é disaster.

---

### 6. **VALIDAÇÃO FRACA DE OWNERSHIP** 🟡 ALTO
```javascript
// Catalogo só valida se estiver logado
if (!user) {
  // Catálogo abre mesmo assim!
}
```

**Novo risco:** Qualquer um pode:
- Ver catálogo público ✅ OK
- Ver produtos de qualquer loja (sem restrição de RLS)
- Ver preços customizados (se não filtrados por LOJA_ID)
- Ver estoque (se não privado)

---

### 7. **GITHUB REPO PÚBLICO COM CREDENCIAIS** 🔴 CRÍTICO
```
https://github.com/ThiagoSGRDev/catalogo-demo
```

**Verificação:**
- ✅ `loja.js` está no repo público
- ✅ Chaves Supabase visíveis no histórico do Git
- ✅ Mesmo após deletar, Git history mantém (git log)

**Como explorar:**
```bash
git log --all --grep="SUPABASE" 
git log -p | grep -i "key"
git show <commit-hash>
```

---

### 8. **SESSION HIJACKING POSSÍVEL** 🟡 ALTO
```javascript
// Qualquer pessoa no mesmo WiFi pode interceptar:
const { data: { session } } = await supabaseClient.auth.getSession();
// Se não usar HTTPS, sessão fica exposta
```

**Verificação:** O domínio usa HTTPS? Sim. Mas:
- Cookies de sessão podem ser roubados via XSS
- Session storage é localStorage (vulnerável a XSS)

---

### 9. **XSS (Cross-Site Scripting)** 🟡 ALTO
**Risco:** Se lojista conseguir injetar código no título/descrição

```javascript
// loja/manto-dez-sports/index.html tem sanitização:
function esc(v){ return String(v ?? '').replace(/[&<>"']/g, ...) }
```

✅ BOM: Tem `esc()` função
⚠️ MAS: É preciso garantir que TUDO passa por `esc()`
- Nomes de times
- Descrições de produtos
- Configurações de loja
- Upload de imagens (banners)

---

### 10. **RATE LIMITING INEXISTENTE** 🟡 MÉDIO
**Ataque possível:**
```bash
for i in {1..10000}; do
  curl "https://katalogohub.com/loja/manto-dez-sports/?type=produto" 
done
```

**Risco:** 
- DDoS
- Enumeração de slugs
- Bruteforce de IDs

---

## 🔧 REMEDIAÇÕES IMEDIATAS

### 1️⃣ **REMOVER CHAVE SUPABASE DO CÓDIGO**
```bash
# Gerar chave anônima nova (sem poderes de admin)
# Guardar em:
# - Variável de ambiente (process.env.SUPABASE_KEY)
# - Arquivo .env (NÃO commitar)
# - Supabase Dashboard → Settings → API Keys
```

### 2️⃣ **ATIVAR ROW LEVEL SECURITY (RLS) NO SUPABASE**
```sql
-- Para cada tabela:
ALTER TABLE lojas ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventos ENABLE ROW LEVEL SECURITY;

-- Criar policies:
CREATE POLICY "lojas_readable_by_owner"
  ON lojas FOR SELECT
  USING (auth.uid() = user_id);
```

### 3️⃣ **VALIDAÇÃO RIGOROSA DE SLUG**
```javascript
const validSlug = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
if (!validSlug.test(storeSlug)) {
  throw new Error('Slug inválido');
}
```

### 4️⃣ **REMOVER HISTÓRICO DO GIT COM CHAVES**
```bash
git filter-branch --force --index-filter \
  'git rm --cached --ignore-unmatch loja/loja.js' \
  --prune-empty --tag-name-filter cat -- --all
git push origin --force --all
```

### 5️⃣ **IMPLEMENTAR RATE LIMITING**
- Usar Supabase Edge Function com rate limit
- Ou Cloudflare/nginx rate limiting

### 6️⃣ **USAR SUPABASE REALTIME COM SEGURANÇA**
- Validar quem pode se inscrever em eventos
- Usar token JWT ao invés de chave pública

---

## 📊 SCORE DE SEGURANÇA

| Área | Status | Risco |
|------|--------|-------|
| Credenciais | 🔴 EXPOSTO | CRÍTICO |
| Autenticação | 🟡 FRACO | ALTO |
| Autorização | 🟡 FRACO | ALTO |
| Validação | 🟡 PARCIAL | MÉDIO |
| Encryção | ✅ HTTPS | OK |
| RLS | ❓ DESCONHECIDO | CRÍTICO |
| XSS Protection | ✅ PRESENTE | OK |
| CSRF | ❓ DESCONHECIDO | MÉDIO |
| Rate Limiting | 🔴 AUSENTE | MÉDIO |

**SCORE GERAL: 3/10 🔴**

---

## ⚡ AÇÕES URGENTES (HOJE)

1. ✅ Regenerar chave Supabase
2. ✅ Ativar RLS em todas tabelas
3. ✅ Remover chaves do Git history
4. ✅ Adicionar .env ao .gitignore
5. ✅ Usar variáveis de ambiente no build

