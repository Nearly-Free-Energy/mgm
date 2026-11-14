import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import { connection } from "next/server";
import "./globals.css";
import { detectLocale } from "@/lib/locale";
import { LocaleProvider } from "@/components/format/locale-context";
import { getPublicRuntimeConfig } from "@/lib/config/public-runtime-config";
import { PublicRuntimeConfigProvider } from "@/lib/config/public-runtime-config-provider";
import { THEME_COLOR } from "@/lib/public-html/palette";

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
  title: { default: "Microgrid Manager", template: "%s · MGM" },
  description: "Run community microgrids: households, meters, tariffs, bills and payments.",
  applicationName: "MGM",
  // Files in public/, drawn by scripts/icons/render-icons.mjs. They load
  // without a session because the middleware matcher skips favicon.ico and
  // image extensions; app-icons.test.ts fails if it stops skipping them.
  // Declaring the ICO as 32x32 keeps Chrome from preferring it to icon.svg.
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  // The home-screen label on iOS. `capable: false` leaves out
  // mobile-web-app-capable, which Next.js adds by default and which would
  // open home-screen launches without browser controls; whether they do is
  // for the web app manifest's `display` to decide.
  appleWebApp: { title: "MGM", capable: false },
};

// Light only: globals.css applies its dark palette only under
// data-theme="dark", which nothing sets, so every page renders light and a
// dark browser bar would sit over a light page. When pages render dark, add
// THEME_COLOR.dark under the same condition that switches them.
// `viewportFit: "cover"` lets pages reach under a phone's home indicator,
// notch and rounded corners, so a bar fixed to the bottom pads itself with
// env(safe-area-inset-bottom) instead of stopping short of the edge. The
// GUI's shell pads the left and right insets (Gridtop's shell.tsx); a GUI
// or a page outside the shell that reaches the screen's sides must too.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: THEME_COLOR.light,
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
