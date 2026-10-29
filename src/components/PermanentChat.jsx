import { useEffect, useLayoutEffect, useRef, useState } from "react";
import EMOJI from "../utils/emoji";
import { DELIVERY_STATUS } from "../chat/messageModels";
import { CONNECTION } from "../permanent/permanentClient";
import { buildInviteUrl } from "../permanent/roomKeys";
import { usePermanentRoom } from "../hooks/usePermanentRoom";
import styles from "../App.module.css";

function EmojiPicker({ onPick, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    function handleClick(event) {
      if (ref.current && !ref.current.contains(event.target)) onClose();
    }

    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  return (
    <div className={styles.emojiPicker} ref={ref}>
      {EMOJI.map((category) => (
        <div key={category.name}>
          <div className={styles.emojiCategory}>{category.name}</div>
          <div className={styles.emojiGrid}>
            {category.emojis.map((emoji) => (
              <button
                key={emoji}
                className={styles.emojiBtn}
                onClick={() => onPick(emoji)}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Lightbox({ src, onClose }) {
  if (!src) return null;
  return (
    <div className={styles.lightbox} onClick={onClose}>
      <img src={src} alt="full size" />
    </div>
  );
}

function statusLine(connection, online, typingNames) {
  if (connection === CONNECTION.CONNECTING) return "connecting…";
  if (connection === CONNECTION.RECONNECTING) return "reconnecting…";
  if (connection === CONNECTION.CLOSED) return "disconnected";
  if (typingNames.length === 1) return `${typingNames[0]} is typing…`;
  if (typingNames.length > 1) return "several people are typing…";
  return online > 1 ? `${online} online` : "just you here";
}

export default function PermanentChat({
  room,
  settings,
  onBack,
  onToast,
  onOpenSettings,
}) {
  const {
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
    retry,
    loadOlder,
    notifyTyping,
  } = usePermanentRoom({ room, settings });

  const [input, setInput] = useState("");
  const [showEmoji, setShowEmoji] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState(null);
  const [hoveredMessageId, setHoveredMessageId] = useState(null);

  const messagesRef = useRef(null);
  const endRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);
  const restoreScrollRef = useRef(null);
  const lastMessageIdRef = useRef(null);

  const live = connection === CONNECTION.LIVE;

  // Newest message changed -> follow it. Older page loaded -> keep the viewport still.
  useLayoutEffect(() => {
    const container = messagesRef.current;
    if (restoreScrollRef.current && container) {
      container.scrollTop =
        container.scrollHeight - restoreScrollRef.current.height + restoreScrollRef.current.top;
      restoreScrollRef.current = null;
      return;
    }
    const lastId = messages[messages.length - 1]?.id ?? null;
    if (lastId !== lastMessageIdRef.current) {
      lastMessageIdRef.current = lastId;
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleLoadOlder() {
    const container = messagesRef.current;
    if (container) {
      restoreScrollRef.current = { height: container.scrollHeight, top: container.scrollTop };
    }
    loadOlder();
  }

  async function handleSend() {
    const text = input;
    if (!text.trim()) return;
    setInput("");
    await sendText(text);
    inputRef.current?.focus();
  }

  function handleKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  }

  function handleChange(event) {
    setInput(event.target.value);
    if (event.target.value) notifyTyping();
  }

  async function handleImageSelect(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      await sendImageFile(file);
    } catch {
      onToast("could not send that image");
    }
  }

  function handleEmojiPick(emoji) {
    setInput((value) => `${value}${emoji}`);
    setShowEmoji(false);
    inputRef.current?.focus();
  }

  function copyInvite() {
    if (!room.code) return;
    navigator.clipboard
      .writeText(buildInviteUrl(room.code))
      .then(() => onToast("invite link copied!"))
      .catch(() => onToast("could not copy"));
  }

  return (
    <main className={`${styles.chatWrap} ${settings.compact ? styles.compact : ""}`}>
      <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />

      <div className={styles.chatHeader}>
        <button className={styles.backBtn} onClick={onBack} title="back">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M10 2L4 8l6 6"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <div
          className={styles.connectedDot}
          style={live ? undefined : { background: "var(--muted)", boxShadow: "none" }}
        />
        <div className={styles.chatTitle}>{statusLine(connection, online, typingNames)}</div>
        <div className={styles.chatRoom}>{room.label}</div>
        {room.code && (
          <button className={styles.iconBtn} onClick={copyInvite} title="copy invite link">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M8 1v8M5.5 3.5L8 1l2.5 2.5"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M3 9v5h10V9"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
        <button className={styles.iconBtn} onClick={() => onOpenSettings()} title="settings">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
            <path
              d="M8 1.5v1M8 13.5v1M1.5 8h1M13.5 8h1M3.4 3.4l.7.7M11.9 11.9l.7.7M3.4 12.6l.7-.7M11.9 4.1l.7-.7"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {roomError && <div className={styles.disconnectBanner}>{roomError}</div>}

      <div className={styles.messages} ref={messagesRef}>
        {hasMore && (
          <button className={styles.loadMore} onClick={handleLoadOlder}>
            load earlier messages
          </button>
        )}

        {messages.length === 0 && live && (
          <div className={styles.sysMsg}>
            nothing here yet — say hello. Messages in this room are kept permanently.
          </div>
        )}

        {messages.map((message, index) => {
          const isMine = message.type === "mine";
          const previous = messages[index - 1];
          const next = messages[index + 1];
          const showName = !isMine && (!previous || previous.senderId !== message.senderId);
          const isGroupEnd =
            !next || next.senderId !== message.senderId || next.time !== message.time;
          const isHovered = hoveredMessageId === message.id;
          const failed = message.status === DELIVERY_STATUS.FAILED;
          const waiting = message.status === DELIVERY_STATUS.QUEUED;

          return (
            <div
              key={message.id}
              data-msgid={message.id}
              className={`${styles.msg} ${isMine ? styles.mine : styles.theirs}`}
              onMouseEnter={() => setHoveredMessageId(message.id)}
              onMouseLeave={() => setHoveredMessageId(null)}
              onClick={() =>
                setHoveredMessageId((current) => (current === message.id ? null : message.id))
              }
            >
              {showName && <div className={styles.senderName}>{message.name}</div>}
              <div className={styles.msgBubbleWrap}>
                {isHovered && !message.unreadable && (
                  <button
                    className={styles.replyBtn}
                    onClick={(event) => {
                      event.stopPropagation();
                      setReplyTarget(message);
                      setHoveredMessageId(null);
                      inputRef.current?.focus();
                    }}
                    title="reply"
                  >
                    <svg width="14" height="14" viewBox="0 0 12 12" fill="none">
                      <path
                        d="M1 5l3.5-3v1.8C8 3.8 10 5 10 8c-.8-2-2.5-2.8-5.5-2.8V7L1 5z"
                        stroke="currentColor"
                        strokeWidth="1.1"
                        strokeLinejoin="round"
                        fill="none"
                      />
                    </svg>
                  </button>
                )}
                {message.replyTo && (
                  <div className={styles.replyQuote}>
                    {message.replyTo.image
                      ? "📷 image"
                      : `${message.replyTo.text.slice(0, 80)}${
                          message.replyTo.text.length > 80 ? "…" : ""
                        }`}
                  </div>
                )}
                {message.image ? (
                  <div className={styles.imgBubble} onClick={() => setLightboxSrc(message.image)}>
                    <img src={message.image} alt="shared" />
                  </div>
                ) : (
                  <div className={styles.bubble}>{message.text}</div>
                )}
              </div>
              {failed ? (
                <div className={styles.failedNote}>
                  {message.error || "failed to send"} ·{" "}
                  <button
                    className={styles.legalLink}
                    onClick={(event) => {
                      event.stopPropagation();
                      retry(message.id);
                    }}
                  >
                    retry
                  </button>
                </div>
              ) : (
                (isGroupEnd || waiting) &&
                settings.timestamps && (
                  <div className={styles.msgTime}>
                    {waiting ? "sending…" : message.time}
                  </div>
                )
              )}
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {replyTarget && (
        <div className={styles.replyPreview}>
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            style={{ flexShrink: 0, color: "var(--accent)" }}
          >
            <path
              d="M1 5l3.5-3v1.8C8 3.8 10 5 10 8c-.8-2-2.5-2.8-5.5-2.8V7L1 5z"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
          <span className={styles.replyPreviewText}>
            {replyTarget.image
              ? "📷 image"
              : `${replyTarget.text.slice(0, 60)}${replyTarget.text.length > 60 ? "…" : ""}`}
          </span>
          <button className={styles.imagePreviewCancel} onClick={() => setReplyTarget(null)}>
            &times;
          </button>
        </div>
      )}

      <div className={styles.inputRow}>
        <div className={styles.emojiPickerWrap}>
          <button
            className={styles.iconBtn}
            onClick={() => setShowEmoji((value) => !value)}
            title="emoji"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <circle cx="9" cy="9" r="7.5" stroke="currentColor" strokeWidth="1.2" />
              <circle cx="6.5" cy="7.5" r="1" fill="currentColor" />
              <circle cx="11.5" cy="7.5" r="1" fill="currentColor" />
              <path
                d="M6 11.5c.8 1.2 2.2 1.8 3 1.8s2.2-.6 3-1.8"
                stroke="currentColor"
                strokeWidth="1.1"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
          </button>
          {showEmoji && (
            <EmojiPicker onPick={handleEmojiPick} onClose={() => setShowEmoji(false)} />
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={handleImageSelect}
        />
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={handleImageSelect}
        />
        <button
          className={styles.iconBtn}
          onClick={() => fileInputRef.current?.click()}
          title="send image from gallery"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <rect x="2" y="3" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.2" />
            <circle cx="6.5" cy="7.5" r="1.5" stroke="currentColor" strokeWidth="1" />
            <path
              d="M2 13l4-4 3 3 2-2 5 4"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
        </button>
        <button
          className={styles.iconBtn}
          onClick={() => cameraInputRef.current?.click()}
          title="take photo"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path
              d="M6.8 3h4.4l1.5 2H16a1 1 0 011 1v8a1 1 0 01-1 1H2a1 1 0 01-1-1V6a1 1 0 011-1h3.3L6.8 3z"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="9" cy="9.5" r="2.5" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        </button>

        <textarea
          ref={inputRef}
          className={styles.msgInput}
          placeholder={live ? "Type here..." : "Type here — will send when back online"}
          rows={1}
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
        />

        <button className={styles.sendBtn} onClick={handleSend} disabled={!input.trim()}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M14 8L2 2l2.5 6L2 14l12-6z" fill="currentColor" />
          </svg>
        </button>
      </div>
    </main>
  );
}
