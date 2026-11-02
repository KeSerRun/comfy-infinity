const { ipcRenderer } = require("electron");

// 页面里的 target="_blank" 链接在 webview 中会走独立弹窗，
// 统一交给外壳处理，避免被 Electron 静默拦截。
window.addEventListener("DOMContentLoaded", () => {
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      const link = target && target.closest ? target.closest("a[href]") : null;
      if (!link || link.target !== "_blank") return;
      const href = link.href;
      if (!/^https?:\/\//i.test(href)) return;
      event.preventDefault();
      ipcRenderer.sendToHost("open-url", href);
    },
    true,
  );
});
