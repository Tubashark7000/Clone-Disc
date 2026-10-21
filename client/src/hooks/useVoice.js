import { useCallback, useEffect, useRef, useState } from "react";
import { createMicPipeline } from "../lib/micPipeline";
import { getIce, iceReady } from "../lib/ice";

export const BITRATES = { low: 700_000, medium: 2_000_000, high: 4_000_000, ultra: 8_000_000 };
const RES = { 720: [1280, 720], 1080: [1920, 1080] };
const DEFAULT_QUALITY = { res: 720, fps: 30, bitrate: "medium" };

// Servidores STUN/TURN vêm do servidor (/api/ice); veja ICE_SERVERS no DEPLOY.md.

/**
 * Malha P2P: quem entra na sala é o "initiator" e envia uma oferta para cada
 * participante existente. Cada conexão tem 1 transceiver de áudio e 1 de vídeo;
 * ligar/desligar câmera ou tela usa replaceTrack, então não há renegociação.
 */
export function useVoice(socket) {
  const [roomCode, setRoomCode] = useState(null);
  const [participants, setParticipants] = useState([]); // [{ id, name, video }]
  const [remotes, setRemotes] = useState({}); // peerId -> MediaStream
  const [mics, setMics] = useState({}); // peerId -> MediaStream só com o microfone (para detectar fala)
  const [localMic, setLocalMic] = useState(null);
  const [screenQuality, setScreenQualityState] = useState(DEFAULT_QUALITY);
  const [muted, setMuted] = useState(false);
  const [videoKind, setVideoKind] = useState(null); // "camera" | "screen" | null
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [noiseMode, setNoiseModeState] = useState("ai"); // "ai" | "off"

  const peers = useRef(new Map()); // peerId -> { pc, queue }
  const audioRef = useRef(null);
  const modeRef = useRef("ai"); // preferência de supressão de ruído (vale para as próximas salas)
  const micRef = useRef(null); // pipeline do microfone (Web Audio)
  const qualityRef = useRef(DEFAULT_QUALITY);
  const kindRef = useRef(null); // "camera" | "screen" | null (espelha videoKind)
  const videoRef = useRef(null);
  const screenAudioRef = useRef(null); // áudio do sistema/guia capturado junto com a tela

  const signal = useCallback((to, data) => socket?.emit("voice:signal", { to, data }), [socket]);

  const closePeer = useCallback((id) => {
    peers.current.get(id)?.pc.close();
    peers.current.delete(id);
    setRemotes(({ [id]: _gone, ...rest }) => rest);
    setMics(({ [id]: _gone, ...rest }) => rest);
  }, []);

  // Limita bitrate/fps do vídeo enviado quando é compartilhamento de tela; câmera usa o padrão do navegador.
  const tuneSender = useCallback(async (pc) => {
    const sender = pc.getTransceivers().find((t) => t.receiver.track.kind === "video")?.sender;
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings?.length) return; // ainda sem negociação; é reaplicado ao conectar
    const enc = params.encodings[0];
    if (kindRef.current === "screen") {
      enc.maxBitrate = BITRATES[qualityRef.current.bitrate];
      enc.maxFramerate = qualityRef.current.fps;
    } else {
      delete enc.maxBitrate;
      delete enc.maxFramerate;
    }
    await sender.setParameters(params).catch(() => {});
  }, []);

  const createPeer = useCallback(
    (id) => {
      const pc = new RTCPeerConnection(getIce());
      const remote = new MediaStream();
      const peer = { pc, queue: Promise.resolve() };
      pc.onicecandidate = (e) => e.candidate && signal(id, { candidate: e.candidate });
      pc.ontrack = (e) => {
        remote.addTrack(e.track);
        setRemotes((r) => ({ ...r, [id]: remote }));
        // o primeiro transceiver é sempre o microfone (o áudio da tela vem depois)
        if (pc.getTransceivers().indexOf(e.transceiver) === 0) setMics((m) => ({ ...m, [id]: new MediaStream([e.track]) }));
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") tuneSender(pc);
        if (pc.connectionState === "failed") closePeer(id);
      };
      peers.current.set(id, peer);
      return peer;
    },
    [signal, closePeer, tuneSender]
  );

  const onSignal = useCallback(
    ({ from, data }) => {
      const peer = peers.current.get(from) ?? createPeer(from);
      // fila por peer: candidatos ICE só entram depois da descrição remota
      peer.queue = peer.queue
        .then(async () => {
          const { pc } = peer;
          if (data.sdp) {
            await pc.setRemoteDescription(data.sdp);
            if (data.sdp.type === "offer") {
              // a ordem dos transceivers é a da oferta: [mic, vídeo, áudio da tela]
              const mine = [audioRef.current, videoRef.current, screenAudioRef.current];
              for (const [i, t] of pc.getTransceivers().entries()) {
                t.direction = "sendrecv";
                await t.sender.replaceTrack(mine[i] ?? null);
              }
              await pc.setLocalDescription(await pc.createAnswer());
              signal(from, { sdp: pc.localDescription });
            }
          } else if (data.candidate) {
            await pc.addIceCandidate(data.candidate).catch(() => {});
          }
        })
        .catch(console.error);
    },
    [createPeer, signal]
  );

  const setVideo = useCallback(
    async (kind) => {
      videoRef.current?.stop();
      screenAudioRef.current?.stop();
      let track = null;
      let sound = null;
      setNotice(null);
      try {
        if (kind === "camera") track = (await navigator.mediaDevices.getUserMedia({ video: true })).getVideoTracks()[0];
        if (kind === "screen") {
          const display = await navigator.mediaDevices.getDisplayMedia({
            video: {
              width: { ideal: RES[qualityRef.current.res][0], max: RES[qualityRef.current.res][0] },
              height: { ideal: RES[qualityRef.current.res][1], max: RES[qualityRef.current.res][1] },
              frameRate: { ideal: qualityRef.current.fps, max: qualityRef.current.fps },
            },
            // sem processamento de voz: o som da tela pode ser música/vídeo
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: true },
          });
          track = display.getVideoTracks()[0];
          // 60 fps prioriza fluidez (jogos/vídeo); 30 fps prioriza nitidez (texto/slides)
          track.contentHint = qualityRef.current.fps === 60 ? "motion" : "detail";
          sound = display.getAudioTracks()[0] ?? null;
          track.onended = () => setVideo(null); // "parar de compartilhar" do navegador
          if (!sound) {
            setNotice(
              "Tela compartilhada sem áudio. Na janela de seleção, marque a opção de compartilhar o áudio (Chrome/Edge; depende da fonte escolhida)."
            );
          }
        }
      } catch {
        kind = null;
        track = sound = null;
      }
      videoRef.current = track;
      kindRef.current = track ? kind : null;
      screenAudioRef.current = sound;
      setVideoKind(track ? kind : null);
      setPreview(track ? new MediaStream([track]) : null); // sem o áudio: evita eco local
      socket?.emit("voice:video", track ? kind : null);
      for (const { pc } of peers.current.values()) {
        const ts = pc.getTransceivers();
        ts.find((t) => t.receiver.track.kind === "video")?.sender.replaceTrack(track);
        ts[2]?.sender.replaceTrack(sound);
        tuneSender(pc);
      }
    },
    [socket, tuneSender]
  );

  const leave = useCallback(() => {
    for (const id of [...peers.current.keys()]) closePeer(id);
    audioRef.current?.stop();
    videoRef.current?.stop();
    screenAudioRef.current?.stop();
    audioRef.current = videoRef.current = screenAudioRef.current = null;
    micRef.current?.close();
    micRef.current = null;
    setNotice(null);
    socket?.emit("voice:leave");
    setRoomCode(null);
    setParticipants([]);
    setLocalMic(null);
    kindRef.current = null;
    setVideoKind(null);
    setPreview(null);
    setMuted(false);
  }, [socket, closePeer]);

  // { create: true } cria uma sala nova; { code } entra numa existente. Retorna true/false.
  const join = useCallback(
    async ({ code, create } = {}) => {
      setError(null);
      leave();
      try {
        const mic = await createMicPipeline(modeRef.current);
        micRef.current = mic;
        audioRef.current = mic.track;
        setLocalMic(new MediaStream([mic.track]));
        mic.onFallback = (m) => {
          modeRef.current = m;
          setNoiseModeState(m);
          setNotice("A supressão por IA parou de responder; desliguei a supressão para manter sua voz.");
        };
        if (mic.mode !== modeRef.current) {
          modeRef.current = mic.mode;
          setNoiseModeState(mic.mode);
          setNotice("A supressão por IA não pôde ser carregada; o microfone está sem supressão de ruído.");
        }
      } catch {
        setError("Não foi possível acessar o microfone. Verifique a permissão do navegador.");
        return false;
      }
      await iceReady; // garante a config TURN antes de criar as conexões
      const res = await new Promise((resolve) => socket.emit("voice:join", { code, create }, resolve));
      if (!res.ok) {
        micRef.current?.close();
        micRef.current = audioRef.current = null;
        setError(res.error);
        return false;
      }
      setRoomCode(res.code);
      for (const pid of res.peers) {
        const { pc } = createPeer(pid);
        pc.addTransceiver(audioRef.current, { direction: "sendrecv" });
        pc.addTransceiver("video", { direction: "sendrecv" }).sender.replaceTrack(videoRef.current);
        pc.addTransceiver("audio", { direction: "sendrecv" }).sender.replaceTrack(screenAudioRef.current);
        await pc.setLocalDescription(await pc.createOffer());
        signal(pid, { sdp: pc.localDescription });
      }
      return true;
    },
    [socket, leave, createPeer, signal]
  );

  const setNoiseMode = useCallback(async (next) => {
    const actual = micRef.current ? await micRef.current.setMode(next) : next;
    modeRef.current = actual;
    setNoiseModeState(actual);
    setNotice(actual !== next ? "A supressão por IA não está disponível neste navegador." : null);
  }, []);

  // Muda a qualidade; durante um compartilhamento vale na hora, sem pedir a tela de novo.
  const setScreenQuality = useCallback(
    async (patch) => {
      const next = { ...qualityRef.current, ...patch };
      qualityRef.current = next;
      setScreenQualityState(next);
      const track = videoRef.current;
      if (kindRef.current !== "screen" || !track) return;
      const [w, h] = RES[next.res];
      await track
        .applyConstraints({ width: { ideal: w, max: w }, height: { ideal: h, max: h }, frameRate: { ideal: next.fps, max: next.fps } })
        .catch(() => {});
      track.contentHint = next.fps === 60 ? "motion" : "detail";
      for (const { pc } of peers.current.values()) tuneSender(pc);
    },
    [tuneSender]
  );

  const toggleMute = useCallback(() => {
    if (!audioRef.current) return;
    audioRef.current.enabled = !audioRef.current.enabled;
    setMuted(!audioRef.current.enabled);
  }, []);

  useEffect(() => {
    if (!socket) return;
    socket.on("voice:signal", onSignal);
    socket.on("voice:peer-left", closePeer);
    socket.on("room:participants", setParticipants);
    return () => {
      socket.off("voice:signal", onSignal);
      socket.off("voice:peer-left", closePeer);
      socket.off("room:participants", setParticipants);
    };
  }, [socket, onSignal, closePeer]);

  useEffect(() => leave, [leave]);

  return { roomCode, participants, remotes, mics, localMic, muted, noiseMode, setNoiseMode, screenQuality, setScreenQuality, videoKind, preview, error, notice, join, leave, toggleMute, setVideo };
}
