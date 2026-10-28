import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { httpLibraryRepository } from "./library/http-repository";
import "./styles/index.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("CLIENT_ROOT_MISSING: Expected an element with id 'root'.");
}

createRoot(root).render(
  <StrictMode>
    <App repository={httpLibraryRepository} />
  </StrictMode>,
);
