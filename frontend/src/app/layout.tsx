import type { Metadata } from "next";
import "./globals.css";
import AutoRefresh from "./auto-refresh";
import Navbar from "./navbar";
import BackendBar from "./backend-bar";

export const metadata: Metadata = { title: "auto-school", description: "Class recordings & notes" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="app-shell">
        <AutoRefresh />
        <Navbar />
        <div className="site-main">{children}</div>
        <BackendBar />
      </body>
    </html>
  );
}
