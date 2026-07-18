const { ipcRenderer } = require('electron');

// Expose safe IPC methods
window.electronAPI = {
  send: (channel, data) => ipcRenderer.send(channel, data),
  on: (channel, callback) => ipcRenderer.on(channel, (event, ...args) => callback(...args)),
  invoke: (channel, data) => ipcRenderer.invoke(channel, data)
};
