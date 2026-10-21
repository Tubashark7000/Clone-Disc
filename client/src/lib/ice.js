import { SERVER } from "./config";

// STUN padrão; o servidor pode entregar TURN extra em /api/ice (variável ICE_SERVERS).
const DEFAULT_ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
let current = DEFAULT_ICE;

export const getIce = () => current;

// Resolve quando a configuração chegou (ou falhou: aí segue com o padrão).
export const iceReady = fetch(`${SERVER}/api/ice`, { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : null))
  .then((c) => {
    if (Array.isArray(c?.iceServers) && c.iceServers.length) current = { iceServers: c.iceServers };
  })
  .catch(() => {});
