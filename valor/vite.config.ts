import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { padRelay } from "./scripts/padRelay";

export default defineConfig({
  plugins: [react(), padRelay()],
  server: {
    host: true, // expose on LAN so phones/laptops in the room can join by IP
    port: 5174,
    // Allow public Cloudflare quick-tunnel URLs (phones off the LAN can join).
    allowedHosts: [".trycloudflare.com"],
  },
  build: {
    target: "es2022",
    // Split the heavy, rarely-changing libs into their own cacheable chunks so
    // they download in parallel and survive app-code deploys in the browser cache.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@dimforge") || id.includes("@react-three/rapier")) return "physics";
          if (id.includes("/three/") || id.includes("three-mesh-bvh") || id.includes("three-stdlib")) return "three";
          if (id.includes("@react-three") || id.includes("postprocessing")) return "r3f";
          if (id.includes("@mediapipe")) return "mediapipe";
          if (id.includes("spacetimedb")) return "spacetimedb";
          return undefined;
        },
      },
    },
  },
});
