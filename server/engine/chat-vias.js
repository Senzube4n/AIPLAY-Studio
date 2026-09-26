/** Brief chat work does not reserve the card for Collab lending decisions. */
export const isBriefChatVia = (via) => ["chat", "chat.turn", "chat.tools"].includes(String(via || ""));
