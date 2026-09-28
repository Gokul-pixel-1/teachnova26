import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ToastProvider } from "@/components/ui/toast";
import { BehaviorTracker } from "@/components/ux/behavior-tracker";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "BuildHub — Build. Collaborate. Share.",
    template: "%s · BuildHub",
  },
  description:
    "A developer collaboration platform for building projects, sharing ideas, and working with teammates.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full bg-bh-bg text-bh-ink">
        <ToastProvider>{children}</ToastProvider>
        <BehaviorTracker />
      </body>
    </html>
  );
}
