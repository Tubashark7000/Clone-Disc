import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";

const PORT = process.env.PORT ?? 3001;
// Origens extras permitidas (separadas por vírgula). Quando o cliente é servido por este
// mesmo servidor (produção) é mesma origem e nada disso é necessário.
const ORIGINS = (process.env.CLIENT_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const MAX_PER_ROOM = 6; // malha P2P: acima disso use um SFU

// Servidores STUN/TURN entregues aos clientes em /api/ice. Para redes restritivas defina
// ICE_SERVERS (JSON) no ambiente, ex.: [{"urls":"turn:host:443","username":"u","credential":"c"}]
const DEFAULT_ICE = [{ urls: "stun:stun.l.google.com:19302" }];
function loadIce() {
  if (!process.env.ICE_SERVERS) return DEFAULT_ICE;
  try {
    const parsed = JSON.parse(process.env.ICE_SERVERS);
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {}
  console.warn("ICE_SERVERS inválido (precisa ser um array JSON); usando só o STUN padrão.");
  return DEFAULT_ICE;
}
const ICE_SERVERS = loadIce();

const app = express();
app.use(cors({ origin: ORIGINS }));
app.get("/health", (_, res) => res.set("Cache-Control", "no-store").json({ ok: true }));
app.get("/api/ice", (_, res) => res.set("Cache-Control", "no-store").json({ iceServers: ICE_SERVERS }));
app.use("/api", (_, res) => res.status(404).json({ error: "not found" }));

// Atualizações do app de desktop: latest.json + instaladores (gerados por `npm run release` em desktop/).
const UPDATES = fileURLToPath(new URL("./updates", import.meta.url));
if (existsSync(UPDATES)) {
  app.use("/updates", express.static(UPDATES, { index: false, setHeaders: (res) => res.set("Cache-Control", "no-cache") }));
}
app.use("/updates", (_, res) => res.status(404).json({ error: "not found" }));

// Em produção o servidor também entrega o cliente compilado (client/dist).
const DIST = fileURLToPath(new URL("../client/dist", import.meta.url));
if (existsSync(join(DIST, "index.html"))) {
  app.use("/assets", express.static(join(DIST, "assets"), { maxAge: "1y", immutable: true }));
  app.use(express.static(DIST, { index: false }));
  app.get("*", (_, res) => res.set("Cache-Control", "no-cache").sendFile(join(DIST, "index.html")));
} else {
  console.log("client/dist não encontrado: só a API/Socket.io está ativa (use o Vite em dev).");
}

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: ORIGINS } });

const rooms = new Map(); // código -> Map(socketId -> { name, video })
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => {
  let c;
  do c = Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
  while (rooms.has(c));
  return c;
};
const list = (code) => [...rooms.get(code)].map(([id, u]) => ({ id, name: u.name, video: u.video }));
const broadcast = (code) => io.to(`room:${code}`).emit("room:participants", list(code));

// Uma sala que fica vazia (ex.: o único participante atualizou a página) só some depois deste prazo,
// para que ele consiga voltar para o mesmo código.
const EMPTY_ROOM_GRACE_MS = 60_000;
const emptyTimers = new Map();
function scheduleRoomCleanup(code) {
  clearTimeout(emptyTimers.get(code));
  const t = setTimeout(() => {
    emptyTimers.delete(code);
    if (rooms.get(code)?.size === 0) rooms.delete(code);
  }, EMPTY_ROOM_GRACE_MS);
  t.unref?.();
  emptyTimers.set(code, t);
}

function leaveRoom(socket) {
  const code = socket.data.room;
  if (!code) return;
  const room = rooms.get(code);
  room?.delete(socket.id);
  socket.leave(`room:${code}`);
  socket.data.room = null;
  socket.to(`room:${code}`).emit("voice:peer-left", socket.id);
  if (room?.size === 0) scheduleRoomCleanup(code);
  else if (room) broadcast(code);
}

io.on("connection", (socket) => {
  const name = String(socket.handshake.auth?.name ?? "").trim().slice(0, 32) || `visitante-${socket.id.slice(0, 4)}`;
  socket.data.name = name;
  socket.emit("init", { me: { id: socket.id, name } });

  socket.on("voice:join", ({ code, create } = {}, ack) => {
    leaveRoom(socket);
    let id = String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (create) {
      id = newCode();
      rooms.set(id, new Map());
    }
    const room = rooms.get(id);
    if (!room) return ack?.({ ok: false, error: "Sala não encontrada." });
    if (room.size >= MAX_PER_ROOM) return ack?.({ ok: false, error: `Sala cheia (máximo ${MAX_PER_ROOM}).` });

    clearTimeout(emptyTimers.get(id));
    emptyTimers.delete(id);
    const peers = [...room.keys()]; // quem já estava; o novato envia as ofertas
    room.set(socket.id, { name, video: null });
    socket.join(`room:${id}`);
    socket.data.room = id;
    ack?.({ ok: true, code: id, peers });
    broadcast(id);
  });

  // "camera" | "screen" | null — permite que todos saibam quem compartilha tela
  socket.on("voice:video", (kind) => {
    const code = socket.data.room;
    const user = rooms.get(code)?.get(socket.id);
    if (!user) return;
    user.video = kind === "camera" || kind === "screen" ? kind : null;
    broadcast(code);
  });

  // O servidor só repassa a sinalização; áudio/vídeo vão direto entre os navegadores.
  socket.on("voice:signal", ({ to, data } = {}) => {
    if (rooms.get(socket.data.room)?.has(to)) io.to(to).emit("voice:signal", { from: socket.id, data });
  });

  socket.on("voice:leave", () => leaveRoom(socket));
  socket.on("disconnect", () => leaveRoom(socket));
});

httpServer.listen(PORT, () => console.log(`Servidor em http://localhost:${PORT}`));
