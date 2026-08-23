import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ToastHost } from "./ui";
import "./theme.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastHost>
      <App />
    </ToastHost>
  </React.StrictMode>,
);
