import type { Metadata } from "next";
import { Inter_Tight, JetBrains_Mono } from "next/font/google";
import { headers } from "next/headers";
import { connection } from "next/server";
import "./globals.css";
import { detectLocale } from "@/lib/locale";
import { LocaleProvider } from "@/components/format/locale-context";
import { getPublicRuntimeConfig } from "@/lib/config/public-runtime-config";
import { PublicRuntimeConfigProvider } from "@/lib/config/public-runtime-config-provider";

// The root layout carries per-installation configuration (#46): it must be
// rendered per request, never prerendered at build time or served from a
// shared cache across deployments.
export const dynamic = "force-dynamic";

const interTight = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-inter-tight",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  title: "Micro Grid Manager",
  description: "Pilot microgrid bill review",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Request-time boundary first, so build-time prerendering bails out before
  // the runtime configuration is read.
  await connection();
  const h = await headers();
  const detectedLocale = detectLocale(h.get("accept-language"));
  // Validated server-side; only the three public values reach the browser.
  // Missing or invalid settings throw an error naming the variable only.
  const publicConfig = getPublicRuntimeConfig();
  return (
    <html lang={detectedLocale}>
      <body className={`${interTight.variable} ${jetbrainsMono.variable} antialiased`}>
        <PublicRuntimeConfigProvider config={publicConfig}>
          <LocaleProvider locale={detectedLocale}>{children}</LocaleProvider>
        </PublicRuntimeConfigProvider>
      </body>
    </html>
  );
}
