# Como Gerar Cards para Stories

## 📱 Você tem 3 designs prontos

1. **stories-card.html** — Design verde/ciano (tema padrão)
2. **stories-card-2.html** — Design laranja (urgência)
3. **stories-card-3.html** — Design verde neon (chamada simples)

---

## 🖼️ Como Converter em Imagem

### Opção 1: Chrome/Edge (Mais Fácil)

1. Abra `stories-card.html` no navegador
2. **Windows**: Pressione `Print Screen` → Abra Paint → `Ctrl+V` → Salve
3. **Mac**: Pressione `Cmd+Shift+4` → Arraste para a área → Clique
4. **Linux**: Abra Flameshot ou `gnome-screenshot`

### Opção 2: Usando Python (Se tiver instalado)

```bash
# Instalar biblioteca
pip install selenium pillow

# Rodar script
python gerar-cards.py
```

### Opção 3: Usar Site Online

1. Abra https://www.screenshotapp.com/
2. Cole a URL local: `file:///home/you/catalogo-demo/stories-card.html`
3. Defina tamanho: **1080x1920** (Stories do Instagram)
4. Download

---

## 📸 Dimensões Corretas

- **Instagram Stories**: 1080x1920px
- **Quadrado (Feed)**: 1080x1080px
- **Landscape (Reels)**: 1920x1080px

Os cards já estão em 9:16 (Stories) — perfeito!

---

## 🚀 Usando nos Stories

### Método 1: Upload de Imagem

1. Gere as 3 imagens (veja acima)
2. Abra Instagram no celular
3. Toque em **+ → Stories**
4. Clique no ícone de galeria
5. Selecione a imagem gerada
6. Adicione texto: "Teste grátis → Link na bio 👇"
7. Compartilhe

### Método 2: Direct na Web

1. Abra cada `stories-card-X.html` em aba separada
2. F11 (modo fullscreen)
3. Print Screen / Screenshot
4. Crop pra aparecer só o card
5. Upload no Instagram Web

---

## 💡 Dica de Uso

**Não precisa ser perfeito!** Screenshots naturais às vezes convertem melhor do que imagens profissionais. Se quiser, deixe bem direto mesmo.

---

## 📊 Sequência de Posts Sugerida

**Dia 1**: Card #1 (verde) — Apresentação
**Dia 2**: Story com video demo do painel funcionando
**Dia 3**: Card #2 (laranja) — Urgência (faltam poucos dias!)
**Dia 4**: Card #3 (simples) — Reels mostrando resultado final
**Dia 5**: Repita com novo cliente ou case study

---

## 🎯 Checklist

- [ ] Gerar image do stories-card.html
- [ ] Gerar image do stories-card-2.html
- [ ] Gerar image do stories-card-3.html
- [ ] Postar stories-card.html primeira
- [ ] Postar stories-card-2.html depois (urgência)
- [ ] Postar reels com demo
- [ ] Medir: quantos entram? De onde vêm?

---

## 📝 Copy para Acompanhar

### Com Card #1
"Criei algo que pode ser útil pra você 👇 Teste 3 dias grátis, sem cartão"

### Com Card #2
"Falta pouco! Teste grátis antes que acabe 👉"

### Com Card #3
"Seu catálogo no celular — teste agora 💚"

---

## ❓ Troubleshooting

**"A imagem ficou pequena na story"**
- Use screenshot do tamanho cheio da tela (1080x1920)

**"Ficou com background estranho"**
- Abra em fullscreen (F11) antes de screenshot

**"O texto está ilegível"**
- Aumente o zoom do navegador (Ctrl+Mouse Wheel) antes de screenshot

