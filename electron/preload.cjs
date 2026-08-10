const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dayline', {
  isDesktop: true,
  loadData: () => ipcRenderer.invoke('dayline:data-load'),
  saveData: (tasks) => ipcRenderer.invoke('dayline:data-save', tasks),
  openWidget: () => ipcRenderer.invoke('dayline:widget-open'),
  closeWidget: () => ipcRenderer.invoke('dayline:widget-close'),
  toggleWidgetPin: () => ipcRenderer.invoke('dayline:widget-toggle-pin'),
  toggleWidgetLock: () => ipcRenderer.invoke('dayline:widget-toggle-lock'),
  resetWidgetBounds: () => ipcRenderer.invoke('dayline:widget-reset-bounds'),
  openMainWindow: () => ipcRenderer.invoke('dayline:window-open-main'),
  getWidgetState: () => ipcRenderer.invoke('dayline:widget-state'),
  onDataChanged: (callback) => {
    const listener = (_event, store) => callback(store)
    ipcRenderer.on('dayline:data-changed', listener)
    return () => ipcRenderer.removeListener('dayline:data-changed', listener)
  },
})
