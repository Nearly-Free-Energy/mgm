import type { MetadataRoute } from "next";
import { THEME_COLOR } from "@/lib/public-html/palette";

/**
 * The web app manifest, served at /manifest.webmanifest; Next.js links it
 * from every page. It lets a phone add MGM to its home screen with the MGM
 * icon and open it without the browser's address bar. The icons are the
 * files scripts/icons/render-icons.mjs writes into public/icons.
 *
 * A manifest takes one colour for each field, so both are the light page
 * background, as in the root layout's viewport while pages render only the
 * light palette. If pages start following the device's dark setting,
 * revisit both.
 *
 * The shortcuts open navigation entries by id through /go/<nav>
 * (src/lib/gui/host/server/go.ts), which picks the microgrid when there is
 * only one and lists them otherwise. A page that moves keeps its nav id;
 * manifest.test.ts checks each id is still contributed.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Microgrid Manager",
    short_name: "MGM",
    description: "Run community microgrids: households, meters, tariffs, bills and payments.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: THEME_COLOR.light,
    theme_color: THEME_COLOR.light,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      { name: "Billing", url: "/go/billing.periods" },
      { name: "Operations", url: "/go/metering.operations" },
    ],
  };
}
