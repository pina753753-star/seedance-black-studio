import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#050506",
        panel: "#111216",
        panel2: "#181a20",
        line: "rgba(255,255,255,0.10)",
        gold: "#D7B86A",
        violet: "#7C3AED",
        cyan: "#6EE7F9"
      },
      boxShadow: {
        glow: "0 0 80px rgba(124, 58, 237, 0.24)",
        gold: "0 0 60px rgba(215, 184, 106, 0.14)"
      }
    }
  },
  plugins: []
};

export default config;
