import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import { SERVER } from "../lib/config";

// Hospedagens gratuitas hibernam o servidor sem tráfego; um ping HTTP periódico o mantém
// acordado enquanto o app estiver aberto (inclusive durante uma chamada).
const KEEPALIVE_MS = 4 * 60 * 1000;

export function useSocket(name) {
  const [socket, setSocket] = useState(null);
  const [me, setMe] = useState(null);

  useEffect(() => {
    const s = io(SERVER, { auth: { name } });
    s.on("init", (d) => setMe(d.me));
    setSocket(s);
    const ping = setInterval(() => fetch(`${SERVER}/health`, { cache: "no-store" }).catch(() => {}), KEEPALIVE_MS);
    return () => {
      clearInterval(ping);
      s.disconnect();
    };
  }, [name]);

  return { socket, me };
}
