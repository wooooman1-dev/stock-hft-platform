(() => {
  const show = (kind, value) => {
    const error = value instanceof Error ? value : new Error(String(value ?? "알 수 없는 오류"));
    let panel = document.querySelector("[data-pulsehft-runtime-error]");
    if (!panel) {
      panel = document.createElement("pre");
      panel.dataset.pulsehftRuntimeError = "true";
      panel.style.cssText = [
        "position:fixed",
        "inset:16px",
        "z-index:2147483647",
        "margin:0",
        "padding:20px",
        "overflow:auto",
        "white-space:pre-wrap",
        "background:#190b0d",
        "color:#ffd7dc",
        "border:2px solid #ff5f70",
        "border-radius:12px",
        "font:14px/1.6 Consolas,monospace",
        "box-shadow:0 24px 80px rgba(0,0,0,.75)",
      ].join(";");
      document.body.append(panel);
    }
    panel.textContent = [
      "PulseHFT 브라우저 실행 오류",
      `종류: ${kind}`,
      `메시지: ${error.message}`,
      "",
      error.stack ?? "스택 정보 없음",
    ].join("\n");
  };

  window.addEventListener("error", (event) => {
    const detail = event.error instanceof Error
      ? event.error
      : new Error(`${event.message} (${event.filename}:${event.lineno}:${event.colno})`);
    show("error", detail);
  });

  window.addEventListener("unhandledrejection", (event) => {
    show("unhandledrejection", event.reason);
  });
})();
