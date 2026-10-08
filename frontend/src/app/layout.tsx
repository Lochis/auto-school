import type { Metadata } from "next";
import "./globals.css";
import AutoRefresh from "./auto-refresh";
import Navbar from "./navbar";
import BackendBar from "./backend-bar";

export const metadata: Metadata = { title: "auto-school", description: "Class recordings & notes" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AutoRefresh />
        <Navbar />
        {children}
        <BackendBar />
      </body>
    </html>
  );
}
