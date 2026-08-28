let websocket;
let inspectorUUID = "";
let settings = { visualIndex: 0 };

const visualSelect = document.querySelector("#visual-index");

function connectElgatoStreamDeckSocket(
  port,
  propertyInspectorUUID,
  registerEvent,
  info,
  actionInfo,
) {
  inspectorUUID = propertyInspectorUUID;
  const parsedActionInfo = parseJson(actionInfo);
  applySettings(parsedActionInfo?.payload?.settings);

  websocket = new WebSocket(`ws://127.0.0.1:${port}`);
  websocket.addEventListener("open", () => {
    websocket.send(JSON.stringify({ event: registerEvent, uuid: inspectorUUID }));
  });
  websocket.addEventListener("message", ({ data }) => {
    const message = parseJson(data);
    if (message?.event === "didReceiveSettings") applySettings(message.payload?.settings);
  });
}

window.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;

visualSelect.addEventListener("change", () => {
  settings.visualIndex = Number(visualSelect.value);
  saveSettings();
});

function applySettings(nextSettings = {}) {
  const requestedIndex = Number(nextSettings.visualIndex);
  settings.visualIndex = Number.isInteger(requestedIndex)
    ? Math.max(0, Math.min(18, requestedIndex))
    : 0;
  visualSelect.value = String(settings.visualIndex);
}

function saveSettings() {
  if (websocket?.readyState !== WebSocket.OPEN) return;
  websocket.send(
    JSON.stringify({ event: "setSettings", context: inspectorUUID, payload: settings }),
  );
}

function parseJson(value) {
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return {};
  }
}
