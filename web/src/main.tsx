// Apply the saved font before first paint so the page does not flash in the other font.
try { const f = localStorage.getItem("growthos-font"); if (f && f !== "urbanist") document.documentElement.dataset.font = f; } catch { /* storage unavailable */ }
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
