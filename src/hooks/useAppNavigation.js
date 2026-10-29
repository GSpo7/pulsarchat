import { useCallback, useState } from "react";

export const APP_MODE = {
  GHOST: "ghost",
  SAVED: "saved",
  PERMANENT: "permanent",
};

export const APP_VIEW = {
  LOBBY: "lobby",
  CONTACTS: "contacts",
  LEGAL: "legal",
  FEEDBACK: "feedback",
  CONVERSATIONS: "conversationList",
  SAVED_CHAT: "savedChat",
  PROFILE_EDIT: "profileEdit",
  PERMANENT_LOBBY: "permanentLobby",
  PERMANENT_CHAT: "permanentChat",
};

export function useAppNavigation() {
  const [mode, setMode] = useState(APP_MODE.GHOST);
  const [view, setView] = useState(APP_VIEW.LOBBY);
  const [savedChatContact, setSavedChatContact] = useState(null);
  const [permanentRoom, setPermanentRoom] = useState(null);

  const switchToSavedMode = useCallback(() => {
    setMode(APP_MODE.SAVED);
    setView(APP_VIEW.CONVERSATIONS);
  }, []);

  const switchToGhostMode = useCallback(() => {
    setMode(APP_MODE.GHOST);
    setView(APP_VIEW.LOBBY);
  }, []);

  const switchToPermanentMode = useCallback(() => {
    setMode(APP_MODE.PERMANENT);
    setView(APP_VIEW.PERMANENT_LOBBY);
  }, []);

  const openPermanentRoom = useCallback((room) => {
    setMode(APP_MODE.PERMANENT);
    setPermanentRoom(room);
    setView(APP_VIEW.PERMANENT_CHAT);
  }, []);

  const closePermanentRoom = useCallback(() => {
    setPermanentRoom(null);
    setView(APP_VIEW.PERMANENT_LOBBY);
  }, []);

  const openSavedChat = useCallback(({ handle, nickname, initialRoomCode = null }) => {
    setMode(APP_MODE.SAVED);
    setSavedChatContact({ handle, nickname, initialRoomCode });
    setView(APP_VIEW.SAVED_CHAT);
  }, []);

  return {
    mode,
    view,
    savedChatContact,
    permanentRoom,
    setView,
    switchToSavedMode,
    switchToGhostMode,
    switchToPermanentMode,
    openPermanentRoom,
    closePermanentRoom,
    openSavedChat,
  };
}
