import type { Metadata } from "next";
import { Inter } from "next/font/google";
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

// One variable Inter file covers every weight. It is not preloaded, and
// `optional` never swaps it in mid-page: a first visit on a slow connection
// keeps the fallback font for that page, and later pages use the cached
// file. Monospace text uses the system stack (globals.css), so no second
// font downloads.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  preload: false,
  display: "optional",
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
  // The font variable goes on <html>, not <body>: globals.css resolves
  // --font-sans on :root, which cannot see a variable set on <body>. If
  // globals.css stops resolving the font there, revisit.
  return (
    <html lang={detectedLocale} className={inter.variable}>
      <body className="antialiased">
        <PublicRuntimeConfigProvider config={publicConfig}>
          <LocaleProvider locale={detectedLocale}>{children}</LocaleProvider>
        </PublicRuntimeConfigProvider>
      </body>
    </html>
  );
}
