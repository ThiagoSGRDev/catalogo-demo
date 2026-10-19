# Cancelamento e reembolso

## Regra
- Teste grátis de 3 dias, sem cartão. Depois, painel e catálogo ficam bloqueados até assinar.
- Até 7 dias após o PRIMEIRO pagamento: reembolso integral (estorno no Asaas), loja sai do ar na hora.
- Depois de 7 dias: cancela sem reembolso; acesso até o fim do período já pago (`assinaturas.acesso_ate`).
- Reembolso só uma vez por loja (`assinaturas.reembolsada_em`).

## Peças
- Painel (`dashboard/index.html`): botão "Cancelar assinatura" em "Minha assinatura". Primeiro chama a função com `{simular:true}` para mostrar se há reembolso.
- Edge function `cancelar-assinatura` (verify_jwt): valida o prazo no servidor, estorna, apaga a assinatura no Asaas.
- `asaas-webhook`: grava `primeiro_pagamento_em`/`asaas_payment_id` na 1ª ativação (status anterior `pending`); ignora PAYMENT_DELETED/OVERDUE quando a assinatura está `cancelling`; marca `reembolsada_em` em PAYMENT_REFUNDED.
- pg_cron `expirar-acessos-cancelados` (de hora em hora, minuto 5): encerra quem está `cancelling` com `acesso_ate` vencido.

## Estados de `assinaturas.status`
`pending` → `active` → `cancelling` (sem reembolso, ainda com acesso) → `cancelled`; `active` → `cancelled` (reembolso); `overdue`.

## Se algo falhar
- Reembolso feito mas assinatura não apagada no Asaas: o log da função traz o ID para apagar à mão no painel do Asaas.
- Estorno recusado: nada é alterado e o lojista é orientado a falar com o suporte.
