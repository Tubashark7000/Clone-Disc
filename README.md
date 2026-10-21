Feito no Claude!

# Voidisce — salas de voz, câmera e compartilhamento de tela

## Rodar (desenvolvimento)
```bash
cd server && npm install && npm run dev     # http://localhost:3001
cd client && npm install && npm run dev     # http://localhost:5173
```

## Hospedar grátis e app para Windows
Veja o **[DEPLOY.md](DEPLOY.md)**: o servidor (que também serve o site) vai para o Render e o app de Windows é um Electron em `desktop/`.
1. Informe seu nome → **Criar sala** (gera um código) ou **Entrar** com o código/link.
2. Na chamada: microfone, supressão de ruído (IA ou desligada), câmera, compartilhar tela (com botão de qualidade) e sair, centralizados embaixo. O código da sala (ou o link) pode ser copiado no topo e colado no campo de entrada.
3. Quem compartilha a tela aparece com um ícone de tela no quadro; os **outros** participantes ganham o botão de **tela cheia** (a tela é mostrada inteira, sem cortes) e a barra de controles continua embaixo. `Esc` sai.
4. Os quadros se ajustam sozinhos: um participante fica centralizado e grande; conforme entram outros, todos se encaixam na tela.

Câmera, microfone e tela exigem `localhost` ou HTTPS.

## Estrutura
- `server/index.js` — Socket.io: salas com código, lista de participantes e sinalização WebRTC. Também serve o cliente compilado (`client/dist`), `/health` e `/api/ice`.
- `desktop/` — app Electron para Windows (abre o site hospedado, seletor de tela próprio, instalador via electron-builder).
- `render.yaml` — blueprint de deploy no Render.
- `client/src/hooks/useSocket.js` — conexão. `useVoice.js` — WebRTC em malha P2P (voz, câmera, tela).
- `client/src/components/` — `Home` (criar/entrar) e `VoiceStage` (grade, tela cheia, controles).

## Limites conhecidos
- Malha P2P: máximo de 6 por sala (configurável em `MAX_PER_ROOM`). Para mais, use um SFU (LiveKit, mediasoup).
- Sem TURN, algumas redes (NAT simétrico/corporativas) não conectam. Defina a variável `ICE_SERVERS` no servidor (veja o DEPLOY.md).
- Sem autenticação nem banco de dados; as salas somem quando ficam vazias.
- O áudio da tela segue como uma segunda faixa de áudio, separada do microfone. Depende do navegador (Chrome/Edge sim; Firefox não) e de marcar "compartilhar áudio" na janela de seleção. No Windows captura o som do sistema ou da guia; no macOS, só o de guias do Chrome.
- Supressão "Forte (IA)": usa RNNoise (WASM + AudioWorklet) via `@sapphi-red/web-noise-suppressor`, a 48 kHz. Se não carregar, o microfone segue sem supressão. Ela reduz ruído de fundo constante e teclado, mas não separa outras vozes; fone de ouvido continua sendo o melhor contra eco.
- O anel verde no quadro/avatar indica quem está falando (medido no navegador, sem enviar nada ao servidor). Se a IA travar, o app desliga a supressão sozinho para manter a voz.
- Qualidade do compartilhamento de tela: resolução 720p/1080p, 30/60 fps e bitrate Baixo 700 kbps / Médio 2 Mbps / Alto 4 Mbps / Ultra 8 Mbps. O bitrate é um teto: o navegador reduz se a rede não aguentar. Em malha P2P o upload é multiplicado pelo número de espectadores.
