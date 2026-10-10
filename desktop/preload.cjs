/* Sandboxed Electron preload only supports CommonJS. */
/* oxlint-disable typescript/no-require-imports */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld(
  'journalDesktop',
  Object.freeze({
    localOnly: true,
    onBeforeClose: (callback) => {
      const handler = () => {
        void Promise.resolve()
          .then(callback)
          .then(() => ipcRenderer.invoke('journal:close-ready', true))
          .catch(() => ipcRenderer.invoke('journal:close-ready', false));
      };
      ipcRenderer.on('journal:prepare-close', handler);
      return () => ipcRenderer.removeListener('journal:prepare-close', handler);
    },
    lock: () => ipcRenderer.invoke('journal:lock'),
    settings: () => ipcRenderer.invoke('journal:lock-settings'),
    chooseDirectory: () => ipcRenderer.invoke('journal:choose-directory'),
  }),
);
