import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
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
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
