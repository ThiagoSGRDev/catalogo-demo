# Rate Limiting Setup Guide

## 🚀 Opção A: Cloudflare (RECOMENDADO)

### Passo 1: Acessar Cloudflare Dashboard
1. Vá para https://dash.cloudflare.com
2. Selecione seu domínio: `katalogohub.com`
3. Vá para **Security** → **Rate Limiting**

### Passo 2: Criar Rule de Rate Limit

**Rule 1: Proteção de Login (Admin)**
```
Match: URI Path contains "/admin.html"
Threshold: 10 requests per 10 seconds
Action: Block for 1 hour
```

**Rule 2: Proteção de API (Supabase)**
```
Match: URI Path contains "/loja/"
Threshold: 100 requests per 60 seconds (por IP)
Action: Challenge (CAPTCHA)
```

**Rule 3: Proteção Global**
```
Match: All incoming requests
Threshold: 1000 requests per 60 seconds (por IP)
Action: Block for 10 minutes
```

### Passo 3: Validar
1. Salve as rules
2. Teste acessando rapidamente `/admin.html` várias vezes
3. Deve bloquear após 10 requisições

---

## 🔧 Opção B: Supabase Edge Function (Mais Controle)

### Passo 1: Criar função no Supabase

```bash
supabase functions new rate-limiter
```

### Passo 2: Implementar lógica de rate limit

```typescript
// supabase/functions/rate-limiter/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

interface RateLimitEntry {
  ip: string;
  endpoint: string;
  count: number;
  resetAt: number;
}

const rateLimits: Map<string, RateLimitEntry> = new Map();

serve(async (req) => {
  const clientIP = req.headers.get('cf-connecting-ip') || 'unknown';
  const endpoint = new URL(req.url).pathname;
  const key = `${clientIP}:${endpoint}`;
  
  const now = Date.now();
  const entry = rateLimits.get(key);
  
  // Check if rate limit exceeded
  if (entry && entry.count >= 100 && now < entry.resetAt) {
    return new Response(
      JSON.stringify({ error: 'Rate limit exceeded' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
  }
  
  // Reset counter if expired
  if (!entry || now >= entry.resetAt) {
    rateLimits.set(key, {
      ip: clientIP,
      endpoint,
      count: 1,
      resetAt: now + 60000 // 1 minute
    });
  } else {
    entry.count++;
  }
  
  return new Response(
    JSON.stringify({ status: 'allowed', remaining: 100 - entry.count }),
    { headers: { 'Content-Type': 'application/json' } }
  );
});
```

### Passo 3: Deploy

```bash
supabase functions deploy rate-limiter
```

---

## 📊 Limites Recomendados

| Endpoint | Limite | Janela |
|----------|--------|--------|
| `/admin.html` | 10 req | 10 seg |
| `/loja/*/` | 100 req | 60 seg |
| API geral | 1000 req | 60 seg |
| Login/registro | 5 req | 60 seg |

---

## ✅ Checklist

- [ ] Cloudflare rate limiting ativado
- [ ] 3 rules configuradas
- [ ] Testar bloqueio
- [ ] Monitorar abuse logs
- [ ] Documentar alertas

---

## 🐛 Troubleshooting

**Bloqueio muito agressivo?**
- Aumente o threshold
- Use "Challenge" em vez de "Block"

**Bot ainda passa?**
- Use Cloudflare Bot Management (pago)
- Combine com CAPTCHA

**IPs legítimos bloqueados?**
- Adicionar whitelist: https://dash.cloudflare.com → Security → Events

