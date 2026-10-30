import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_VOICE_SECONDS } from "../permanent/media";

// First one the browser supports: Chrome/Firefox/Edge record webm/ogg opus, Safari records mp4.
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
// Speech only: ~4 KB/s keeps a five-minute note around 1.2 MB.
const AUDIO_BITS_PER_SECOND = 32000;

function pickMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

/**
 * Tap-to-record voice notes. start() asks for the microphone; finish() resolves
 * with { blob, seconds } (or null if nothing usable was recorded); cancel() discards.
 * onLimit runs when the length cap is reached; the owner decides to finish() (send) or cancel().
 */
export function useVoiceRecorder({ onLimit } = {}) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);

  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef(null);
  const onLimitRef = useRef(onLimit);
  onLimitRef.current = onLimit;

  const release = useCallback(() => {
    clearInterval(timerRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setRecording(false);
    setSeconds(0);
  }, []);

  useEffect(
    () => () => {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stop();
      }
      clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  const start = useCallback(async () => {
    if (recorderRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      throw new Error("voice notes are not supported in this browser");
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      throw new Error("microphone access was blocked");
    }

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    });
    chunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };

    streamRef.current = stream;
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    recorder.start(1000);
    setRecording(true);
    setSeconds(0);
    timerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);
      setSeconds(elapsed);
      if (elapsed >= MAX_VOICE_SECONDS) {
        clearInterval(timerRef.current);
        onLimitRef.current?.();
      }
    }, 250);
  }, []);

  const finish = useCallback(
    () =>
      new Promise((resolve) => {
        const recorder = recorderRef.current;
        if (!recorder) return resolve(null);
        const elapsed = (Date.now() - startedAtRef.current) / 1000;
        recorder.onstop = () => {
          const type = (recorder.mimeType || "audio/webm").split(";")[0];
          const blob = new Blob(chunksRef.current, { type });
          release();
          resolve(blob.size > 0 && elapsed >= 0.5 ? { blob, seconds: Math.round(elapsed) } : null);
        };
        recorder.stop();
      }),
    [release],
  );

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }
    release();
  }, [release]);

  return { recording, seconds, start, finish, cancel };
}
