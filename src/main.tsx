import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";

// The overlay and the settings window share this page. Each window loads only
// its own view, so their styles don't mix.
const view = getCurrentWindow().label === "settings" ? import("./Settings") : import("./App");

void view.then(({ default: View }) => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <View />
    </React.StrictMode>,
  );
});
