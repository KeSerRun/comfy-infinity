const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("comfyWindow", {
  setTheme(theme) {
    if (theme === "light" || theme === "dark") {
      ipcRenderer.send("window-theme", theme);
    }
  },
  openExternal(url) {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      ipcRenderer.send("open-external", url);
    }
  },
});
