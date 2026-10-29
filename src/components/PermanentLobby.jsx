import { useCallback, useEffect, useState } from "react";
import {
  MAX_CODE_LENGTH,
  buildInviteUrl,
  deriveRoomKeys,
  estimateStrength,
  generateCode,
  validateCode,
} from "../permanent/roomKeys";
import {
  createSenderId,
  forgetRoom,
  getRoom,
  listRememberedRooms,
  saveRoom,
} from "../permanent/permanentStore";
import styles from "../App.module.css";

const STRENGTH_TEXT = {
  weak: "weak — anyone could guess this code and read the whole chat. Use a longer one or tap generate.",
  fair: "fair — fine for casual chat; longer is safer.",
  strong: "strong",
};

export default function PermanentLobby({
  onBack,
  onOpenRoom,
  onToast,
  onOpenSettings,
  initialCode = "",
}) {
  const [code, setCode] = useState(initialCode);
  const [showCode, setShowCode] = useState(!!initialCode);
  const [label, setLabel] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [rooms, setRooms] = useState([]);
  const [confirmingForget, setConfirmingForget] = useState(null);

  const refreshRooms = useCallback(async () => {
    setRooms(await listRememberedRooms());
  }, []);

  useEffect(() => {
    refreshRooms();
  }, [refreshRooms]);

  const strength = estimateStrength(code);

  async function openWith({ rawCode, nameOverride, labelOverride, rememberOverride }) {
    const checked = validateCode(rawCode);
    if (!checked.ok) {
      setError(checked.reason);
      return;
    }

    setBusy(true);
    setError("");
    try {
      const { roomId, key } = await deriveRoomKeys(checked.code);
      const existing = await getRoom(roomId);
      const senderId = existing?.senderId || createSenderId();
      const name = (nameOverride ?? existing?.displayName ?? "").trim();
      const roomLabel =
        (labelOverride ?? existing?.label ?? "").trim() || `Room ${roomId.slice(0, 4)}`;
      const keepCode = rememberOverride ?? existing?.remember ?? true;

      await saveRoom({
        roomId,
        code: keepCode ? checked.code : null,
        label: roomLabel,
        senderId,
        displayName: name,
        remember: keepCode,
      });

      onOpenRoom({
        roomId,
        key,
        senderId,
        displayName: name,
        label: roomLabel,
        code: checked.code,
      });
    } catch (openError) {
      setError(openError.message || "could not open this room");
      setBusy(false);
    }
  }

  function handleOpen() {
    openWith({
      rawCode: code,
      nameOverride: displayName,
      labelOverride: label,
      rememberOverride: remember,
    });
  }

  function handleGenerate() {
    setCode(generateCode());
    setShowCode(true);
    setError("");
  }

  function copy(text, message) {
    navigator.clipboard
      .writeText(text)
      .then(() => onToast(message))
      .catch(() => onToast("could not copy"));
  }

  async function handleForget(roomId) {
    await forgetRoom(roomId);
    setConfirmingForget(null);
    refreshRooms();
    onToast("removed from this device");
  }

  const checked = validateCode(code);

  return (
    <main className={styles.contactsWrap}>
      <div className={styles.contactsHeader}>
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
        <span className={styles.legalHeaderTitle}>Permanent rooms</span>
        <div style={{ flex: 1 }} />
        <button className={styles.iconBtn} onClick={onOpenSettings} title="settings">
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

      <div className={styles.contactsBody}>
        <div className={styles.addContactBlock}>
          <h3 className={styles.addContactTitle}>open or create a room</h3>
          <p className={styles.permanentHint}>
            Pick any code — letters, numbers, anything. Everyone who enters the same code
            joins the same room, and the chat is kept on the server so you can come back
            to it any time.
          </p>

          <div className={styles.permanentRow}>
            <input
              className={styles.contactInput}
              type={showCode ? "text" : "password"}
              placeholder="your code"
              value={code}
              maxLength={MAX_CODE_LENGTH + 64}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => {
                setCode(event.target.value);
                setError("");
              }}
              onKeyDown={(event) => event.key === "Enter" && !busy && handleOpen()}
            />
            <button
              className={`${styles.btn} ${styles.btnGhost} ${styles.permanentSmallBtn}`}
              onClick={() => setShowCode((value) => !value)}
              type="button"
            >
              {showCode ? "hide" : "show"}
            </button>
          </div>

          <div className={styles.permanentRow}>
            <button
              className={`${styles.btn} ${styles.btnGhost} ${styles.permanentSmallBtn}`}
              onClick={handleGenerate}
              type="button"
            >
              generate
            </button>
            <button
              className={`${styles.btn} ${styles.btnGhost} ${styles.permanentSmallBtn}`}
              onClick={() => copy(checked.code, "code copied!")}
              disabled={!checked.ok}
              type="button"
            >
              copy code
            </button>
            <button
              className={`${styles.btn} ${styles.btnGhost} ${styles.permanentSmallBtn}`}
              onClick={() => copy(buildInviteUrl(checked.code), "invite link copied!")}
              disabled={!checked.ok}
              type="button"
            >
              copy invite link
            </button>
          </div>

          {strength.level !== "empty" && (
            <p
              className={`${styles.permanentHint} ${
                strength.level === "weak" ? styles.permanentWarn : ""
              }`}
            >
              {STRENGTH_TEXT[strength.level]}
            </p>
          )}

          <input
            className={styles.contactInput}
            placeholder="your name in this room (optional)"
            value={displayName}
            maxLength={30}
            onChange={(event) => setDisplayName(event.target.value)}
          />
          <input
            className={styles.contactInput}
            placeholder="label for this room, only you see it (optional)"
            value={label}
            maxLength={40}
            onChange={(event) => setLabel(event.target.value)}
          />

          <label className={styles.permanentCheck}>
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            remember this room on this device
          </label>

          {error && <p className={`${styles.permanentHint} ${styles.permanentWarn}`}>{error}</p>}

          <button className={styles.btn} onClick={handleOpen} disabled={busy || !checked.ok}>
            {busy ? "opening…" : "open room"}
          </button>

          <p className={styles.permanentHint}>
            Messages are encrypted in your browser before they are sent; the server stores
            only scrambled data and never sees your code.{" "}
            <strong>If you lose the code, nobody can recover the chat.</strong> Anyone who has
            the code can read and write in the room.
          </p>
        </div>

        {rooms.length === 0 ? (
          <p className={styles.emptyContacts}>no rooms saved on this device</p>
        ) : (
          <div className={styles.contactsList}>
            {rooms.map((room) => (
              <div key={room.roomId} className={styles.contactItem}>
                <div className={styles.contactInfo}>
                  <span className={styles.contactNick}>{room.label}</span>
                  <span className={styles.contactHandle}>
                    {room.displayName ? `as ${room.displayName}` : "saved room"}
                  </span>
                </div>
                <div className={styles.contactActions}>
                  {confirmingForget === room.roomId ? (
                    <>
                      <button
                        className={`${styles.btn} ${styles.btnGhost}`}
                        onClick={() => handleForget(room.roomId)}
                        style={{ width: "auto", padding: "6px 12px" }}
                      >
                        forget here
                      </button>
                      <button
                        className={styles.iconBtn}
                        onClick={() => setConfirmingForget(null)}
                        title="cancel"
                      >
                        &times;
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className={`${styles.btn} ${styles.btnGhost}`}
                        disabled={busy}
                        onClick={() =>
                          openWith({
                            rawCode: room.code,
                            nameOverride: room.displayName,
                            labelOverride: room.label,
                            rememberOverride: true,
                          })
                        }
                        style={{ width: "auto", padding: "6px 14px" }}
                      >
                        open
                      </button>
                      <button
                        className={styles.iconBtn}
                        onClick={() => setConfirmingForget(room.roomId)}
                        title="remove from this device (the chat itself is not deleted)"
                      >
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                          <path
                            d="M2 2l10 10M12 2L2 12"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
