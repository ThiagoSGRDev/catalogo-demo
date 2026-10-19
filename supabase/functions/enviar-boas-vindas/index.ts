import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

// ============================================================
// enviar-boas-vindas
// Chamada pelo register.html logo depois de criar a loja.
// Seguranca:
//  - verify_jwt=true: so usuario logado chama.
//  - o destinatario e SEMPRE o email do proprio usuario logado (nunca vem do body),
//    entao a funcao nao serve para mandar spam para terceiros.
//  - envia no maximo 1x por usuario (flag em app_metadata + Idempotency-Key no Resend).
//  - nome da loja e escapado (e texto digitado pelo usuario).
// Logo: vai EMBUTIDA no email (anexo inline, cid:), porque Gmail/Outlook bloqueiam
// imagens remotas em emails que caem no spam. Se o download falhar, usa a URL do site.
// Segredos: RESEND_API_KEY (obrigatorio), EMAIL_FROM (opcional; sem dominio verificado
// o Resend so aceita onboarding@resend.dev enviando para o dono da conta Resend).
// 19/10/2026: tambem avisa o dono do Katalogo Hub (ALERTA_EMAIL, padrao
// contato@katalogohub.com) que um teste gratis foi criado.
// ============================================================

const SITE = "https://katalogohub.com";
const LOGO_URL = `${SITE}/assets/email/logo-email.png`;
const LOGO_CID = "logo-katalogohub";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function esc(s: string) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

async function carregarLogo(): Promise<string | null> {
  try {
    const r = await fetch(LOGO_URL, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length < 1000 || buf.length > 400_000) return null;
    return encodeBase64(buf);
  } catch (e) {
    console.error("Nao consegui baixar a logo:", e);
    return null;
  }
}

// Aviso para o dono do Katalogo Hub. Melhor esforco: nunca impede o email de boas-vindas.
async function avisarDonoTeste(resendKey: string, from: string, userId: string, email: string, loja: any) {
  try {
    const expira = new Date(loja.trial_expira_em).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    const fornecedor = loja.catalogo_mestre_id && loja.catalogo_mestre_id !== loja.id ? " (veio por link de fornecedor)" : "";
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5">
      <h2 style="margin:0 0 12px">🆕 Novo teste grátis${esc(fornecedor)}</h2>
      <p><b>Loja:</b> ${esc(loja.nome)} (${esc(loja.slug)})<br>
      <b>Email:</b> ${esc(email)}<br>
      <b>Teste até:</b> ${esc(expira)}<br>
      <b>Catálogo:</b> <a href="${SITE}/loja/${esc(loja.slug)}">katalogohub.com/loja/${esc(loja.slug)}</a></p>
      <p>Dica: mande uma mensagem hoje oferecendo ajuda para montar a loja.</p></div>`;
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json", "Idempotency-Key": `alerta-teste-${userId}` },
      body: JSON.stringify({
        from,
        to: [Deno.env.get("ALERTA_EMAIL") || "contato@katalogohub.com"],
        reply_to: email,
        subject: `Novo teste grátis: ${loja.nome}`,
        html,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error("Falha ao avisar o dono (ignorada):", e);
  }
}

function montarEmail(nomeLoja: string, expiraEm: Date, logoSrc: string) {
  const nome = esc(nomeLoja);
  const data = expiraEm.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Sao_Paulo" });
  const hora = expiraEm.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
  const painel = `${SITE}/admin.html`;
  // Revendedor de fornecedor parceiro pode ter teste maior (ex.: Mic = 10 dias).
  const dias = Math.max(1, Math.round((expiraEm.getTime() - Date.now()) / 86400000));

  const passo = (n: string, titulo: string, texto: string) => `
    <tr>
      <td width="44" valign="top" style="padding:0 0 18px 0;">
        <div style="width:32px;height:32px;line-height:32px;text-align:center;border-radius:50%;background:#0F2A24;border:1px solid #1E6B58;color:#35FFC0;font-weight:700;font-size:14px;">${n}</div>
      </td>
      <td valign="top" style="padding:0 0 18px 0;">
        <div style="color:#FFFFFF;font-size:15px;font-weight:700;line-height:1.3;">${titulo}</div>
        <div style="color:#94A3B8;font-size:14px;line-height:1.5;margin-top:2px;">${texto}</div>
      </td>
    </tr>`;

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<title>Bem-vindo ao Katalogo Hub</title>
</head>
<body style="margin:0;padding:0;background:#07090C;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#07090C;">Sua loja ${nome} está criada. Você tem ${dias} dias de teste grátis.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07090C;">
<tr><td align="center" style="padding:28px 14px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#121722;border:1px solid #1F2A3A;border-radius:20px;overflow:hidden;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <tr><td align="center" style="background:#0B0F17;padding:30px 24px 22px 24px;border-bottom:2px solid #35FFC0;">
      <img src="${logoSrc}" width="260" alt="KatalogoHub" style="display:block;width:260px;max-width:100%;height:auto;border:0;">
    </td></tr>

    <tr><td style="padding:34px 32px 8px 32px;">
      <div style="color:#35FFC0;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Conta criada</div>
      <div style="color:#FFFFFF;font-size:28px;font-weight:800;line-height:1.2;margin-top:8px;">Sua loja está no ar.</div>
      <div style="color:#B6C2D4;font-size:15px;line-height:1.6;margin-top:12px;">A loja <strong style="color:#FFFFFF;">${nome}</strong> já foi criada e está pronta para receber seus produtos. Você tem <strong style="color:#FFFFFF;">${dias} dias de teste grátis</strong>, com tudo liberado.</div>
    </td></tr>

    <tr><td style="padding:18px 32px 6px 32px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1A1608;border:1px solid #5C4410;border-radius:14px;">
        <tr><td style="padding:16px 18px;">
          <div style="color:#F59E0B;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">Teste grátis até</div>
          <div style="color:#FFFFFF;font-size:20px;font-weight:800;margin-top:4px;">${data} às ${hora}</div>
          <div style="color:#C9B07A;font-size:13px;line-height:1.5;margin-top:4px;">Depois dessa data, o painel pede a assinatura para continuar. Seus produtos e configurações ficam guardados.</div>
        </td></tr>
      </table>
    </td></tr>

    <tr><td align="center" style="padding:26px 32px 10px 32px;">
      <a href="${painel}" style="display:inline-block;background:#35FFC0;color:#07090C;text-decoration:none;font-weight:800;font-size:15px;letter-spacing:.5px;padding:16px 40px;border-radius:999px;">ACESSAR MEU PAINEL</a>
    </td></tr>

    <tr><td style="padding:26px 32px 6px 32px;">
      <div style="color:#FFFFFF;font-size:16px;font-weight:800;margin-bottom:16px;">Comece em 3 passos</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${passo("1", "Deixe com a sua cara", "Escolha a cor do painel e coloque a logo da sua loja.")}
        ${passo("2", "Monte o catálogo", "Use os produtos do catálogo mestre ou cadastre os seus, com preços e tamanhos.")}
        ${passo("3", "Compartilhe com os clientes", "Mande o link do catálogo no WhatsApp e no Instagram e receba os pedidos.")}
      </table>
    </td></tr>

    <tr><td style="padding:8px 32px 30px 32px;">
      <div style="color:#64748B;font-size:12px;line-height:1.6;border-top:1px solid #1F2A3A;padding-top:18px;">Você recebeu este email porque criou uma conta no Katalogo Hub. Por segurança, nunca enviamos senhas por email.<br>© 2026 Katalogo Hub — catálogo digital para lojistas.</div>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;

  const texto = `Sua loja está no ar.\n\nA loja ${nomeLoja} foi criada. Você tem ${dias} dias de teste grátis, até ${data} às ${hora}.\n\nAcesse o painel: ${painel}\n\nComece em 3 passos:\n1. Deixe com a sua cara: cor do painel e logo.\n2. Monte o catálogo: use o catálogo mestre ou cadastre seus produtos.\n3. Compartilhe o link com seus clientes no WhatsApp e Instagram.\n\nPor segurança, nunca enviamos senhas por email.\nKatalogo Hub`;
  return { html, texto };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false }, 405);

  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (!resendKey) {
    console.error("RESEND_API_KEY nao configurada");
    return json({ ok: false, motivo: "email nao configurado" }, 503);
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const authHeader = req.headers.get("Authorization") ?? "";

  // quem esta chamando (pelo JWT) -- o email de destino sai daqui, nao do body
  const comoUsuario = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
  const { data: ud, error: ue } = await comoUsuario.auth.getUser();
  const user = ud?.user;
  if (ue || !user?.email) return json({ ok: false, motivo: "nao autenticado" }, 401);

  if (user.app_metadata?.boas_vindas_enviado) return json({ ok: true, ja_enviado: true });

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: vinculo } = await admin.from("loja_usuarios").select("loja_id").eq("user_id", user.id).limit(1).maybeSingle();
  if (!vinculo) return json({ ok: false, motivo: "loja nao encontrada" }, 404);

  const { data: loja } = await admin.from("lojas").select("id, nome, slug, status, trial_expira_em, catalogo_mestre_id").eq("id", vinculo.loja_id).maybeSingle();
  if (!loja) return json({ ok: false, motivo: "loja nao encontrada" }, 404);
  if (loja.status !== "trial") return json({ ok: true, ignorado: "loja nao esta em trial" });

  const from = Deno.env.get("EMAIL_FROM") ?? "Katalogo Hub <onboarding@resend.dev>";
  await avisarDonoTeste(resendKey, from, user.id, user.email, loja);

  const logoB64 = await carregarLogo();
  const { html, texto } = montarEmail(loja.nome, new Date(loja.trial_expira_em), logoB64 ? `cid:${LOGO_CID}` : LOGO_URL);

  const corpo: Record<string, unknown> = {
    from,
    to: [user.email],
    subject: `Sua loja ${loja.nome} está no ar — ${Math.max(1, Math.round((new Date(loja.trial_expira_em).getTime() - Date.now()) / 86400000))} dias grátis`,
    html,
    text: texto,
  };
  if (logoB64) corpo.attachments = [{ filename: "logo.png", content: logoB64, content_type: "image/png", content_id: LOGO_CID }];

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `boas-vindas-${user.id}`,
    },
    body: JSON.stringify(corpo),
  });

  if (!r.ok) {
    console.error("Resend recusou o envio:", r.status, await r.text());
    return json({ ok: false, motivo: "falha ao enviar" }, 502);
  }

  await admin.auth.admin.updateUserById(user.id, {
    app_metadata: { ...(user.app_metadata ?? {}), boas_vindas_enviado: new Date().toISOString() },
  });

  return json({ ok: true, logo_embutida: !!logoB64 });
});
