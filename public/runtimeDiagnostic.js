(() => {
  const show = (kind, value, details = []) => {
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
      ...details,
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

  window.setTimeout(async () => {
    if (document.querySelector("[data-pulsehft-runtime-error]")) return;
    const app = document.querySelector("#app");
    const topbar = app?.querySelector(".topbar");
    if (app?.classList.contains("app-shell") && topbar) return;

    let snapshotStatus = "확인 실패";
    try {
      const response = await fetch("/api/snapshot", { cache: "no-store" });
      snapshotStatus = `${response.status} ${response.statusText}`.trim();
    } catch (error) {
      snapshotStatus = error instanceof Error ? error.message : String(error);
    }

    show(
      "startup-timeout",
      new Error("4초 안에 앱 화면 초기화가 완료되지 않았습니다."),
      [
        `app 존재: ${Boolean(app)}`,
        `app class: ${app?.className ?? "없음"}`,
        `topbar 존재: ${Boolean(topbar)}`,
        `app child count: ${app?.children.length ?? 0}`,
        `snapshot 응답: ${snapshotStatus}`,
        `document readyState: ${document.readyState}`,
      ],
    );
  }, 4000);
})();
