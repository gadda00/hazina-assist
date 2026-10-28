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
  title: "Hazina Assist — Bank-Grade AI Assistant",
  description:
    "Bank-grade AI assistant: policy Q&A with citations, account tools, human-approved transfers, payslip intelligence, guardrails, hash-chained audit and evaluation. Built to CBK-aligned controls.",
  keywords: ["AI banking", "guardrails", "RAG", "audit trail", "HITL", "Kenya", "CBK", "evaluation"],
  authors: [{ name: "Hazina Assist" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Hazina Assist",
    description: "Bank-grade AI assistant with guardrails, HITL and audit trails",
    type: "website",
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
