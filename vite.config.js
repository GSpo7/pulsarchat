import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const appUrl = (env.VITE_APP_URL || "").replace(/\/+$/, "");
  const serverUrl = env.VITE_SERVER_URL || "http://localhost:9000";
  const proxyTarget = serverUrl
    .replace(/^wss:\/\//, "https://")
    .replace(/^ws:\/\//, "http://");

  return {
    plugins: [
      react(),
      basicSsl(),
      {
        // Fills the public URL into canonical/OG tags (vite's own %ENV% syntax
        // can't be used inside URL attributes).
        name: "app-url-html",
        transformIndexHtml: (html) => html.split("__APP_URL__").join(appUrl),
      },
    ],
    server: {
      host: true,
      proxy: {
        "/notify": {
          target: proxyTarget,
          changeOrigin: true,
          secure: false,
          ws: true,
        },
        "/peerjs": {
          target: proxyTarget,
          changeOrigin: true,
          secure: false,
          ws: true,
        },
        "/permanent": {
          target: proxyTarget,
          changeOrigin: true,
          secure: false,
          ws: true,
        },
        "/api": {
          target: proxyTarget,
          changeOrigin: true,
          secure: false,
        },
        "/stats": {
          target: proxyTarget,
          changeOrigin: true,
          secure: false,
        },
      },
    },
  };
});
