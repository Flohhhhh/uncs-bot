import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app/app";
import "./styles.css";
createRoot(document.getElementById("root")!).render(
  <BrowserRouter basename="/admin">
    <App />
  </BrowserRouter>,
);
