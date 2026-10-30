import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DELIVERY_STATUS, formatMessageTime, generateMessageId } from "../chat/messageModels";
import { getServerConfig } from "../utils/serverConfig";
import { playNotificationSound } from "../utils/sound";
import { CONNECTION, createPermanentClient } from "../permanent/permanentClient";
import { openJson, sealJson } from "../permanent/messageCrypto";
import {
  MAX_IMAGE_FILE_BYTES,
  isAudioDataUrl,
  isImageDataUrl,
  readAsDataUrl,
} from "../permanent/media";

const PERMANENT_URL = getServerConfig()?.permanentUrl || "";
const TYPING_SEND_INTERVAL_MS = 2000;
const TYPING_VISIBLE_MS = 4000;
const READ_RECEIPT_DELAY_MS = 800;
const REPLY_SNIPPET_CHARS = 200;
const UNREADABLE_TEXT = "🔒 this message could not be decrypted";

export const ROOM_ERROR_TEXT = {
  too_large: "message too large",
  quota: "this room is full",
  rate_limited: "slow down a little",
  unavailable: "server is full right now",
  server_error: "server error, try again",
  bad_request: "message rejected",
  closed: "connection closed",
};

function anonymousName(senderId) {
  return `anon-${senderId.slice(-4)}`;
}

function sortMessages(list) {
  return [...list].sort((a, b) => {
    const aPending = a.seq == null;
    const bPending = b.seq == null;
    if (aPending !== bPending) return aPending ? 1 : -1;
    if (aPending) return a.localTs - b.localTs;
    return a.seq - b.seq;
  });
}

// Merge by msgId: server data wins, but a local "failed" mark is not erased by a stale copy.
function mergeMessages(prev, incoming) {
  const byId = new Map(prev.map((message) => [message.id, message]));
  for (const message of incoming) {
    byId.set(message.id, { ...byId.get(message.id), ...message });
  }
  return sortMessages([...byId.values()]);
}

async function decryptItem(key, item, ownSenderId) {
  const base = {
    id: item.msgId,
    seq: item.seq,
    senderId: item.senderId,
    timestamp: item.ts,
    time: formatMessageTime(item.ts),
    type: item.senderId === ownSenderId ? "mine" : "theirs",
    status: DELIVERY_STATUS.SENT,
    // set by the server for our own messages once someone else has read them
    readAt: item.readAt ?? null,
  };
  try {
    const payload = await openJson(key, item);
    return {
      ...base,
      text: typeof payload.text === "string" ? payload.text : "",
      image: isImageDataUrl(payload.image) ? payload.image : null,
      audio: isAudioDataUrl(payload.audio) ? payload.audio : null,
      audioSeconds: Number(payload.audioSeconds) || 0,
      replyTo: payload.replyTo || null,
      name: payload.name || anonymousName(item.senderId),
    };
  } catch {
    return {
      ...base,
      text: UNREADABLE_TEXT,
      image: null,
      audio: null,
      audioSeconds: 0,
      replyTo: null,
      name: anonymousName(item.senderId),
      unreadable: true,
    };
  }
}

export function usePermanentRoom({ room, settings }) {
  const { roomId, key, senderId, displayName } = room;

  const [messages, setMessages] = useState([]);
  const [connection, setConnection] = useState(CONNECTION.CONNECTING);
  const [online, setOnline] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [typers, setTypers] = useState({});
  const [replyTarget, setReplyTarget] = useState(null);
  const [roomError, setRoomError] = useState("");

  const clientRef = useRef(null);
  const messagesRef = useRef([]);
  const framesRef = useRef(new Map()); // msgId -> sent frame, kept for retry
  const lastTypingSentRef = useRef(0);
  const lastReadSentRef = useRef(0);
  const readTimerRef = useRef(null);
  const settingsRef = useRef(settings);
  const displayNameRef = useRef(displayName);
  settingsRef.current = settings;
  displayNameRef.current = displayName;
  messagesRef.current = messages;

  const updateMessage = useCallback((id, patch) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  const deliver = useCallback(
    async (frame) => {
      const client = clientRef.current;
      if (!client) return;
      framesRef.current.set(frame.msgId, frame);
      updateMessage(frame.msgId, { status: DELIVERY_STATUS.QUEUED, error: "" });
      try {
        const { seq, ts } = await client.send(frame);
        framesRef.current.delete(frame.msgId);
        setMessages((prev) =>
          mergeMessages(prev, [
            {
              id: frame.msgId,
              seq,
              timestamp: ts,
              time: formatMessageTime(ts),
              status: DELIVERY_STATUS.SENT,
              error: "",
            },
          ]),
        );
      } catch (error) {
        if (error.code === "closed") return;
        updateMessage(frame.msgId, {
          status: DELIVERY_STATUS.FAILED,
          error: ROOM_ERROR_TEXT[error.code] || "failed to send",
        });
      }
    },
    [updateMessage],
  );

  useEffect(() => {
    if (!PERMANENT_URL) {
      setRoomError("server address is not configured (VITE_SERVER_URL)");
      return undefined;
    }

    let active = true;

    const client = createPermanentClient({
      url: PERMANENT_URL,
      roomId,
      senderId,
      onStatus: (next) => active && setConnection(next),
      onFrame: async (frame) => {
        if (frame.type === "joined") {
          setOnline(frame.online);
        } else if (frame.type === "presence") {
          setOnline(frame.online);
        } else if (frame.type === "messages") {
          const decrypted = await Promise.all(
            frame.items.map((item) => decryptItem(key, item, senderId)),
          );
          if (!active) return;
          if (frame.dir === "initial") {
            // Keep our own not-yet-acked messages; everything else comes from the server.
            setMessages((prev) =>
              mergeMessages(
                prev.filter((m) => m.seq == null),
                decrypted,
              ),
            );
            setHasMore(frame.hasMore);
          } else {
            setMessages((prev) => mergeMessages(prev, decrypted));
            if (frame.dir === "older") setHasMore(frame.hasMore);
          }
        } else if (frame.type === "message") {
          const message = await decryptItem(key, frame.item, senderId);
          if (!active) return;
          setMessages((prev) => mergeMessages(prev, [message]));
          setTypers((prev) => {
            if (!prev[frame.item.senderId]) return prev;
            const next = { ...prev };
            delete next[frame.item.senderId];
            return next;
          });
          if (message.type === "theirs" && settingsRef.current?.sounds) playNotificationSound();
        } else if (frame.type === "receipt") {
          setMessages((prev) =>
            prev.map((m) =>
              m.type === "mine" && m.seq != null && m.seq <= frame.upToSeq && !m.readAt
                ? { ...m, readAt: frame.ts }
                : m,
            ),
          );
        } else if (frame.type === "typing") {
          try {
            const payload = await openJson(key, frame);
            if (!active) return;
            setTypers((prev) => ({
              ...prev,
              [frame.senderId]: {
                name: payload.name || anonymousName(frame.senderId),
                until: Date.now() + TYPING_VISIBLE_MS,
              },
            }));
          } catch {
            // ignore undecryptable typing signals
          }
        } else if (frame.type === "error" && !frame.msgId) {
          setRoomError(ROOM_ERROR_TEXT[frame.code] || "connection problem");
        }
      },
    });
    clientRef.current = client;
    client.start();

    const typingSweep = setInterval(() => {
      setTypers((prev) => {
        const now = Date.now();
        const entries = Object.entries(prev).filter(([, value]) => value.until > now);
        return entries.length === Object.keys(prev).length ? prev : Object.fromEntries(entries);
      });
    }, 1000);

    return () => {
      active = false;
      clearInterval(typingSweep);
      client.stop();
      clientRef.current = null;
    };
  }, [roomId, key, senderId]);

  // Tell the others how far we have read, once the room is open and visible.
  const flushRead = useCallback(() => {
    const client = clientRef.current;
    if (!client || client.getStatus() !== CONNECTION.LIVE) return;
    if (document.visibilityState !== "visible") return;
    let newest = 0;
    for (const m of messagesRef.current) {
      if (m.type === "theirs" && m.seq != null && m.seq > newest) newest = m.seq;
    }
    if (newest <= lastReadSentRef.current) return;
    lastReadSentRef.current = newest;
    client.sendRead(newest);
  }, []);

  useEffect(() => {
    clearTimeout(readTimerRef.current);
    readTimerRef.current = setTimeout(flushRead, READ_RECEIPT_DELAY_MS);
    return () => clearTimeout(readTimerRef.current);
  }, [messages, connection, flushRead]);

  useEffect(() => {
    document.addEventListener("visibilitychange", flushRead);
    return () => document.removeEventListener("visibilitychange", flushRead);
  }, [flushRead]);

  const buildReply = useCallback((target) => {
    if (!target) return null;
    return {
      id: target.id,
      name: target.name,
      text: target.image || target.audio ? "" : (target.text || "").slice(0, REPLY_SNIPPET_CHARS),
      image: !!target.image,
      audio: !!target.audio,
    };
  }, []);

  const sendPayload = useCallback(
    async ({ kind, text = "", image = null, audio = null, audioSeconds = 0 }) => {
      const replyTo = buildReply(replyTarget);
      const payload = {
        v: 1,
        text,
        image,
        audio,
        audioSeconds,
        replyTo,
        name: displayNameRef.current || "",
      };
      const sealed = await sealJson(key, payload);
      const msgId = generateMessageId();
      const now = Date.now();

      setMessages((prev) =>
        mergeMessages(prev, [
          {
            id: msgId,
            seq: null,
            localTs: now,
            timestamp: now,
            time: formatMessageTime(now),
            type: "mine",
            senderId,
            name: displayNameRef.current || anonymousName(senderId),
            text,
            image,
            audio,
            audioSeconds,
            replyTo,
            status: DELIVERY_STATUS.QUEUED,
          },
        ]),
      );
      setReplyTarget(null);
      await deliver({ type: "send", kind, msgId, ...sealed });
    },
    [buildReply, deliver, key, replyTarget, senderId],
  );

  const sendText = useCallback(
    (text) => {
      const trimmed = text.trim();
      if (!trimmed) return Promise.resolve();
      return sendPayload({ kind: "text", text: trimmed });
    },
    [sendPayload],
  );

  // Sent as the file is: no resize or re-encode, so nothing is lost.
  const sendImageFile = useCallback(
    async (file) => {
      if (!file.type.startsWith("image/")) throw new Error("that is not an image");
      if (file.size > MAX_IMAGE_FILE_BYTES) {
        throw new Error(`image is too large (max ${MAX_IMAGE_FILE_BYTES / 1024 / 1024} MB)`);
      }
      const image = await readAsDataUrl(file);
      return sendPayload({ kind: "image", image });
    },
    [sendPayload],
  );

  const sendVoiceNote = useCallback(
    async (blob, seconds) => {
      const audio = await readAsDataUrl(blob);
      return sendPayload({ kind: "audio", audio, audioSeconds: seconds });
    },
    [sendPayload],
  );

  const retry = useCallback(
    (msgId) => {
      const frame = framesRef.current.get(msgId);
      if (frame) deliver(frame);
    },
    [deliver],
  );

  const loadOlder = useCallback(() => {
    const oldest = messagesRef.current.find((m) => m.seq != null);
    if (oldest) clientRef.current?.requestOlder(oldest.seq);
  }, []);

  const notifyTyping = useCallback(async () => {
    const now = Date.now();
    if (now - lastTypingSentRef.current < TYPING_SEND_INTERVAL_MS) return;
    lastTypingSentRef.current = now;
    const sealed = await sealJson(key, { name: displayNameRef.current || "" });
    clientRef.current?.sendTyping(sealed);
  }, [key]);

  const typingNames = useMemo(() => Object.values(typers).map((entry) => entry.name), [typers]);

  return {
    messages,
    connection,
    online,
    hasMore,
    typingNames,
    replyTarget,
    roomError,
    setReplyTarget,
    sendText,
    sendImageFile,
    sendVoiceNote,
    retry,
    loadOlder,
    notifyTyping,
  };
}
