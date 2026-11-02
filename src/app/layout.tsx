import type { Metadata } from "next";
import { Fraunces, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

/* The Vault typography:
 * - Fraunces  : heritage serif for display headlines — the banknote / treasure voice
 * - Inter     : UI body text, crisp and neutral
 * - JetBrains Mono : amounts, hashes, traces — the evidence voice
 */
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  style: ["normal", "italic"],
  axes: ["opsz"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jbMono = JetBrains_Mono({
  variable: "--font-jbmono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // metadataBase silences the Next.js warning AND makes OG/Twitter image URLs
  // resolve absolutely on every host (localhost preview, Vercel, custom domain).
  // Set NEXT_PUBLIC_SITE_URL to the canonical deployment URL when one exists.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: "Hazina Assist — Bank-Grade AI Assistant",
  description:
    "Bank-grade AI assistant: policy Q&A with citations, account tools, human-approved transfers, payslip intelligence, guardrails, hash-chained audit and evaluation. Built to CBK-aligned controls.",
  keywords: ["AI banking", "guardrails", "RAG", "audit trail", "HITL", "Kenya", "CBK", "evaluation"],
  authors: [{ name: "Hazina Assist" }],
  // Favicon is the local Hazina mark (src/app/icon.svg is served by the
  // Next.js app router automatically); no external CDN dependency.
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icon.svg" }],
  },
  openGraph: {
    title: "Hazina Assist",
    description: "Bank-grade AI assistant with guardrails, HITL and audit trails",
    type: "website",
    images: ["/icon.svg"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${fraunces.variable} ${inter.variable} ${jbMono.variable} font-sans antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
