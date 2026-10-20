import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        cream: "#f7f4eb",
        paper: "#fffdf7",
        leaf: "#365847",
        moss: "#65836d",
        clay: "#bd684c",
        amber: "#d5a247",
        ink: "#202b26",
        muted: "#738078",
        line: "#e5e0d5",
      },
      boxShadow: {
        card: "0 10px 30px rgba(42, 54, 45, 0.06)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "Arial", "sans-serif"],
        display: ["var(--font-display)", "Georgia", "serif"],
      },
    },
  },
  plugins: [],
};

export default config;
