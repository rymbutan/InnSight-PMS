// The two localStorage keys that carry per-user messaging data on this
// client: open chat-dock windows (ChatDock.jsx) and the notification feed,
// which stores message PREVIEWS and sender identity (lib/notifications.js).
//
// Pulled out into their own leaf module — rather than exported from ChatDock.jsx
// and notifications.js directly — so auth.jsx's logout() and api.js's 401
// handler can both purge them for the signing-out user without importing a
// React component into api.js (foundational enough that doing so risks a
// circular import: ChatDock.jsx already imports useAuth from ../auth).
export const chatDockStoreKey = (userId) => `innsight_chat_dock_${userId || 'anon'}`;
export const notifsStoreKey = (userId) => `innsight_notifs_${userId || 'anon'}`;
