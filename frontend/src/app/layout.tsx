import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RGIT Timetable Management",
  description: "A warm, reliable workspace for academic scheduling at Rajiv Gandhi Institute of Technology, Mumbai.",
  icons: { icon: "/rgit-mark.svg" },
};

export const dynamic = "force-dynamic";

const runtimeConfigScript = `window.__RGIT_PUBLIC_CONFIG__=${JSON.stringify({
  supabaseUrl: process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "",
  supabaseAnonKey: process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] ?? "",
  cookieSecure: process.env["NEXT_PUBLIC_COOKIE_SECURE"] !== "false",
}).replace(/</g, "\\u003c")};`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body><script dangerouslySetInnerHTML={{ __html: runtimeConfigScript }} />{children}</body>
    </html>
  );
}
