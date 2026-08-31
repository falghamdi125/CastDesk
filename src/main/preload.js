'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('castdesk', {
  // app / settings
  appInfo: () => invoke('app:info'),
  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),
  openExternal: (url) => invoke('app:openExternal', url),

  // devices
  listDevices: () => invoke('devices:list'),
  refreshDevices: () => invoke('devices:refresh'),
  addDevice: (host, name) => invoke('devices:add', host, name),
  removeDevice: (host) => invoke('devices:remove', host),
  connectDevice: (id) => invoke('device:connect', id),
  disconnectDevice: () => invoke('device:disconnect'),
  castState: () => invoke('cast:state'),

  // files
  openFile: (kind) => invoke('file:open', kind),
  inspectFile: (file, opts) => invoke('file:inspect', file, opts),
  castFile: (file, opts) => invoke('cast:file', file, opts),
  pathFor: (file) => webUtils.getPathForFile(file),

  // mirroring
  listSources: (types) => invoke('sources:list', types),
  liveSelect: (sel) => invoke('live:select', sel),
  liveStart: (opts) => invoke('live:start', opts),
  liveStop: () => invoke('live:stop'),
  liveStats: () => invoke('live:stats'),
  liveChunk: (u8) => ipcRenderer.send('live:chunk', u8),

  // player
  player: (cmd, value) => invoke('player:cmd', cmd, value),

  // events from main
  on: (channel, fn) => {
    const handler = (_event, ...args) => fn(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
