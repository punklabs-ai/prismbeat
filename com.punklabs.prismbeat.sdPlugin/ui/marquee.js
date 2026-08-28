let websocket;
let inspectorUUID = "";
let settings = { role: "auto", visualRole: "visual" };

const roleSelect = document.querySelector("#dial-role");
const visualRoleSelect = document.querySelector("#visual-role");
const supportedRoles = ["auto", "track", "volume", "seek", "none"];
const supportedVisualRoles = ["visual", "track", "volume", "seek", "none"];

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

roleSelect.addEventListener("change", () => {
  settings.role = roleSelect.value;
  saveSettings();
});

visualRoleSelect.addEventListener("change", () => {
  settings.visualRole = visualRoleSelect.value;
  saveSettings();
});

function applySettings(nextSettings = {}) {
  settings = {
    role: supportedRoles.includes(nextSettings.role) ? nextSettings.role : "auto",
    visualRole: supportedVisualRoles.includes(nextSettings.visualRole)
      ? nextSettings.visualRole
      : "visual",
  };
  roleSelect.value = settings.role;
  visualRoleSelect.value = settings.visualRole;
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
