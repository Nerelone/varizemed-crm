import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { Providers } from "./app/providers";
import "./app/app.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element #root not found");
}

ReactDOM.createRoot(root).render(
  <Providers>
    <App />
  </Providers>
);
