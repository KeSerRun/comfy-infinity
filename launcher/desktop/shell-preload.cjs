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
  onQuitRequest(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = () => callback();
    ipcRenderer.on("quit-confirm-request", listener);
    return () => ipcRenderer.removeListener("quit-confirm-request", listener);
  },
  confirmQuit() {
    ipcRenderer.send("quit-confirmed");
  },
  cancelQuit() {
    ipcRenderer.send("quit-cancelled");
  },
});
