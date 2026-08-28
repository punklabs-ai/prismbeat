let websocket;
let inspectorUUID = "";
let settings = { artworkLayout: "single", quarter: "auto" };

const positionSelect = document.querySelector("#artwork-position");

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

positionSelect.addEventListener("change", () => {
  const position = positionSelect.value;
  settings.artworkLayout = position === "single" ? "single" : "quarter";
  settings.quarter = position === "single" ? "auto" : position;
  saveSettings();
});

function applySettings(nextSettings = {}) {
  settings = {
    artworkLayout: nextSettings.artworkLayout === "quarter" ? "quarter" : "single",
    quarter: ["auto", "top-left", "top-right", "bottom-left", "bottom-right"].includes(
      nextSettings.quarter,
    )
      ? nextSettings.quarter
      : "auto",
  };
  positionSelect.value =
    settings.artworkLayout === "quarter" ? settings.quarter : "single";
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
