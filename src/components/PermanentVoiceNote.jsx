import { useEffect, useRef, useState } from "react";
import { formatDuration } from "../permanent/media";
import styles from "../App.module.css";

// Opus/webm recordings often report an unknown duration, so the sender's own length is used for display.
export default function PermanentVoiceNote({ src, seconds }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    return () => audio?.pause();
  }, []);

  function toggle(event) {
    event.stopPropagation();
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) audio.play().catch(() => setPlaying(false));
    else audio.pause();
  }

  function seek(event) {
    const audio = audioRef.current;
    const total = seconds || audio?.duration;
    if (!audio || !Number.isFinite(total)) return;
    const fraction = Number(event.target.value) / 1000;
    audio.currentTime = fraction * total;
    setProgress(fraction);
  }

  function handleTimeUpdate() {
    const audio = audioRef.current;
    const total = seconds || audio.duration;
    if (Number.isFinite(total) && total > 0) setProgress(Math.min(audio.currentTime / total, 1));
  }

  return (
    <div className={styles.voiceNote} onClick={(event) => event.stopPropagation()}>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setProgress(0);
        }}
        onTimeUpdate={handleTimeUpdate}
      />
      <button
        className={styles.voicePlay}
        onClick={toggle}
        title={playing ? "pause" : "play"}
        aria-label={playing ? "pause voice note" : "play voice note"}
      >
        {playing ? (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <rect x="2" y="1.5" width="3" height="9" rx="1" />
            <rect x="7" y="1.5" width="3" height="9" rx="1" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <path d="M3 1.5v9l7.5-4.5L3 1.5z" />
          </svg>
        )}
      </button>
      <input
        className={styles.voiceTrack}
        type="range"
        min={0}
        max={1000}
        value={Math.round(progress * 1000)}
        style={{ "--fill": `${progress * 100}%` }}
        onChange={seek}
        aria-label="seek"
      />
      <span className={styles.voiceTime}>{formatDuration(seconds)}</span>
    </div>
  );
}
