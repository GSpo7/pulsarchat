import { useState } from "react";
import { SOURCE_URL } from "../utils/sourceUrl";
import styles from "../App.module.css";

export default function Lobby({
  onCreate,
  onJoin,
  onContacts,
  onSavedMode,
  onPermanentMode,
  onOpenSettings,
  initialCode,
}) {
  const [code, setCode] = useState(initialCode || "");

  function handleJoin() {
    const trimmed = code.trim().toUpperCase();
    if (trimmed.length >= 4) onJoin(trimmed);
  }

  return (
    <main className={styles.lobby}>
      {/* ── Hero ──────────────────────────────────────── */}
      <div className={styles.hero}>
        <div className={styles.pulsarLogoWrap}>
          <img src="/logo.svg" width="200" alt="" fetchpriority="high" />
        </div>
        <h1 className={styles.logo}>
          Pul<span>sar</span>
        </h1>

        <a
          href={SOURCE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.openSourceBadge}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
          </svg>
          open source
        </a>

        <div className={styles.cardRow}>
          <div className={styles.card}>
            <h2>Start a room</h2>
            <p>Get a code and share it with someone</p>
            <button className={styles.btn} onClick={onCreate}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path
                  d="M7 1v12M1 7h12"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
              Create room
            </button>
          </div>

          <div className={styles.card}>
            <h2>Join a room</h2>
            <p>Enter the code you received</p>
            <input
              className={styles.codeInput}
              placeholder="enter code"
              value={code}
              maxLength={6}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && handleJoin()}
            />
            <button
              className={`${styles.btn} ${styles.btnGhost}`}
              onClick={handleJoin}
            >
              Join
            </button>
          </div>
        </div>

        <div className={styles.heroQuickActions}>
          <button className={styles.contactsBtn} onClick={onContacts}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path
                d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            contacts
          </button>
          <button className={styles.savedModeBtn} onClick={onSavedMode}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path
                d="M7 4h10a2 2 0 012 2v12l-4-2-3 2-3-2-4 2V6a2 2 0 012-2z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            saved chats
          </button>
        </div>

        <div className={styles.heroQuickActions}>
          <button className={styles.permanentModeBtn} onClick={onPermanentMode}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5l3 2"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            permanent rooms
          </button>
        </div>
      </div>
      <button
        className={styles.floatingSettings}
        onClick={onOpenSettings}
        title="settings"
      >
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
    </main>
  );
}
