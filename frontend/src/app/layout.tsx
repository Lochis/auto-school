import type { Metadata } from "next";
import "./globals.css";
import AutoRefresh from "./auto-refresh";
import Navbar from "./navbar";
import BackendBar from "./backend-bar";
import { RecorderProvider } from "@/lib/use-recorder";

export const metadata: Metadata = { title: "auto-school", description: "Class recordings & notes" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="app-shell">
        <RecorderProvider>
          <AutoRefresh />
          <Navbar />
          <div className="site-main">{children}</div>
          <BackendBar />
        </RecorderProvider>
      </body>
    </html>
  );
}
