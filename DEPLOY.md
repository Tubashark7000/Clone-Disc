# Deploy grátis + app para Windows

O caminho é: **GitHub → Render (servidor + site) → app Electron que abre o seu site**.
O servidor também entrega o cliente compilado, então é um serviço só e não há CORS para configurar.

> Antes de começar: teste tudo localmente (seção 1).

---

## 1. Testar em modo produção na sua máquina

```bash
cd client && npm install && npm run build
cd ../server && npm install && npm start
```

Abra http://localhost:3001 (o mesmo processo serve o site e o Socket.io).

---

## 2. Publicar no Render (grátis)

1. **Gere os lockfiles uma vez** (deixa os builds reproduzíveis):
   `cd client && npm install` e `cd ../server && npm install` — commite os `package-lock.json`.
2. Crie um repositório no GitHub e envie o projeto (`client/`, `server/`, `desktop/`, `render.yaml`).
3. No [Render](https://render.com): **New → Blueprint**, escolha o repositório e confirme.
   O `render.yaml` já define build, start, health check e Node 22 no plano `free`.
   - Sem Blueprint? Crie um **Web Service** manualmente, com:
     - Build Command: `npm --prefix client install --include=dev && npm --prefix client run build && npm --prefix server install`
     - Start Command: `node server/index.js`
     - Health Check Path: `/health`
     - Environment: `NODE_VERSION=22`
4. Quando terminar, abra a URL `https://SEU-APP.onrender.com`. Se a tela de nome aparecer, está no ar.

### Hibernação (plano grátis)

O Render hiberna o serviço após ~15 min sem tráfego; a próxima conexão leva cerca de 1 min para acordar.
- Enquanto o app está aberto ele faz um ping em `/health` a cada 4 min, então **uma chamada em andamento mantém o servidor acordado**.
- Para o servidor ficar acordado mesmo sem ninguém, cadastre um monitor HTTP gratuito (ex.: UptimeRobot, a cada 5 min) em `https://SEU-APP.onrender.com/health`.
- As salas ficam em memória: se o servidor reiniciar ou for reimplantado, as salas abertas somem.

---

## 3. TURN (para redes restritivas)

Só com STUN, algumas redes (NAT simétrico, corporativas, 4G/5G de certas operadoras) não conectam.
Crie uma conta em um provedor de TURN com plano gratuito (por exemplo Metered ou Cloudflare) e, no Render,
em **Environment**, adicione `ICE_SERVERS` com um array JSON:

```json
[
  { "urls": "stun:stun.l.google.com:19302" },
  {
    "urls": ["turn:SEU-HOST:80", "turn:SEU-HOST:443?transport=tcp", "turns:SEU-HOST:443?transport=tcp"],
    "username": "SEU-USUARIO",
    "credential": "SUA-SENHA"
  }
]
```

O servidor entrega isso aos clientes em `/api/ice`; não precisa recompilar nada. Se o JSON for inválido,
o log do Render avisa e o app volta ao STUN padrão. Use os hosts/portas que o seu provedor indicar.

> As credenciais TURN ficam visíveis para quem abrir o site (é assim com qualquer TURN no navegador).
> Use as credenciais do plano gratuito e não reutilize senhas.

---

## 4. App para Windows (Electron)

O app é uma janela que abre o seu site hospedado. Vantagens: todo update do site chega a todos **sem novo instalador**,
e tela/microfone/câmera funcionam por ser um app confiável. Ele também mostra "Acordando o servidor…" enquanto o Render acorda.

### 4.1 Configurar o endereço

Edite `desktop/config.json`:

```json
{ "appUrl": "https://SEU-APP.onrender.com" }
```

(Depois de instalado, dá para sobrescrever em `%APPDATA%\Conversa\config.json` com o mesmo formato, ou com a variável `APP_URL`.)

### 4.2 Testar

```bash
cd desktop
npm install
npm start
```

Para desenvolver com o servidor/Vite locais: rode `server` (porta 3001) e `client` (`npm run dev`, porta 5173) e use `npm run dev` em `desktop/`.

### 4.3 Gerar o instalador `.exe`

Faça isso **no Windows**:

```bash
cd desktop
npm run dist            # instalador:  desktop/dist/Conversa-Setup-1.0.0.exe
npm run dist:portable   # sem instalar: desktop/dist/Conversa-Portable.exe
```

### 4.4 Aviso do SmartScreen

O instalador não é assinado digitalmente, então o Windows mostra "O Windows protegeu o computador".
Clique em **Mais informações → Executar assim mesmo**. Para eliminar o aviso é preciso um certificado de assinatura de código (pago).

### 4.5 Compartilhar tela no app

Ao clicar em compartilhar tela, o app abre o seletor próprio (telas e janelas, com miniaturas).
A opção **"Compartilhar o som do computador"** captura o áudio de todo o sistema, **incluindo as vozes da chamada**;
por isso vem desmarcada. Se marcar, teste com um amigo para ver se há eco; se houver, compartilhe sem som.

### 4.6 Atualização automática do app (.exe)

Mudanças só no site/servidor chegam a todos sem novo `.exe` (seção 4). Quando a mudança exigir um `.exe` novo
(janela, bandeja, captura de tela…), use o release, que também publica o aviso de atualização:

```bash
cd desktop
npm run release                       # sobe a versão (1.0.0 -> 1.0.1), gera instalador + portátil e publica o manifesto
npm run release -- --minor            # 1.0.5 -> 1.1.0   (ou --major)
npm run release -- --notes="o que mudou"
```

Isso gera `desktop/dist/Conversa-Setup-X.exe` e `desktop/dist/Conversa-Portable.exe`, copia os dois para
`server/updates/` (apagando as versões antigas de lá) e escreve `server/updates/latest.json` com versão e SHA-512.
Depois: `git add -A && git commit && git push`. O Render reimplanta e os apps passam a avisar.

**Como o app atualiza** (bandeja > *Atualizar app*, ou o botão *atualizar app* na tela inicial; ele também confere
sozinho ao abrir e a cada 30 min e mostra uma notificação):
- **Instalador:** baixa o novo Setup, confere o SHA-512, roda em modo silencioso (ele remove a versão antiga, instala a
  nova e reabre o app).
- **Portátil:** baixa o novo `.exe` ao lado do atual, o app fecha e o arquivo antigo é substituído pelo novo (mesmo
  nome, então atalhos continuam valendo) e reaberto. A pasta do portátil precisa permitir gravação.
- **Automático sem perguntar:** coloque `"autoUpdate": true` em `desktop/config.json` (ou em
  `%APPDATA%\Conversa\config.json`). Só instala quando não há chamada ativa.

**Arquivos grandes:** cada `.exe` tem dezenas de MB e o GitHub recusa arquivos acima de 100 MB. Se preferir não
guardá-los no repositório, publique os dois no GitHub Releases e gere o manifesto apontando para lá:
`npm run release -- --base-url=https://github.com/USUARIO/REPO/releases/download/v1.0.1` (o script diz quais
arquivos enviar e com qual nome). Só o `latest.json` vai para o servidor.

> A versão **instalada hoje** não tem o atualizador: instale/abra o `.exe` novo manualmente **uma vez**. Dali em diante
> as atualizações são pelo próprio app.

---

## Checklist de teste (no Windows, com 2 pessoas)

- [ ] O app abre, mostra "Acordando…" e depois a tela de nome.
- [ ] Microfone e câmera funcionam; o anel verde aparece em quem fala.
- [ ] Compartilhar tela abre o seletor, a outra pessoa vê a tela.
- [ ] Compartilhar com o som do computador: sem eco para quem assiste.
- [ ] Copiar código/link da sala funciona.
- [ ] Em redes diferentes (ex.: Wi-Fi e 4G) conecta; se não, configure o TURN.
