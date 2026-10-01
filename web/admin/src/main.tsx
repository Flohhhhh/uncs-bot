import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { App } from "./app/app";
import "./styles.css";
const router = createBrowserRouter([{ path: "/*", element: <App /> }], { basename: "/admin" });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
