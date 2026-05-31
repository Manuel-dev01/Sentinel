import type { Metadata } from "next";
import { Anton, Newsreader, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { PaperGrain } from "@/components/PaperGrain";
import { Header } from "@/components/Header";

// Brand fonts — must match sentinel_landing_page (Editorial Technical v2).
const anton = Anton({ weight: "400", subsets: ["latin"], variable: "--font-display", display: "swap" });
const newsreader = Newsreader({
  weight: "400",
  style: "italic",
  subsets: ["latin"],
  variable: "--font-serif",
  display: "swap",
});
const mono = JetBrains_Mono({
  weight: ["400", "500"],
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Sentinel — Incident Desk",
  description:
    "Agent-native parametric depeg insurance on Somnia. Detect, investigate, pay — in the same block.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${anton.variable} ${newsreader.variable} ${mono.variable}`}>
      <body>
        <a href="#main" className="skip">
          Skip to content
        </a>
        <PaperGrain />
        <Providers>
          <Header />
          <main id="main" className="app-main frame">
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}
