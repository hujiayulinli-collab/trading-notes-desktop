// eslint-disable-next-line typescript/no-require-imports -- Electron sandbox preloads use CommonJS.
const { contextBridge, ipcRenderer } = require('electron');
// No channel names, raw events, filesystem access, or general IPC reach the page.
contextBridge.exposeInMainWorld(
  'journalAuth',
  Object.freeze({
    state: () => ipcRenderer.invoke('journal:auth', { action: 'state' }),
    unlock: (password) =>
      ipcRenderer.invoke('journal:auth', { action: 'unlock', password }),
    save: (currentPassword, newPassword) =>
      ipcRenderer.invoke('journal:auth', {
        action: 'save',
        currentPassword,
        newPassword,
      }),
    cancel: () => ipcRenderer.invoke('journal:auth', { action: 'cancel' }),
  }),
);
