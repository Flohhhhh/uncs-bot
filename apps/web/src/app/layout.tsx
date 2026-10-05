import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Providers } from "~/components/providers";

import "./globals.css";

export const metadata: Metadata = {
  title: "The UNCs",
  description: "Good games. Older knees. The UNCs gaming community.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
