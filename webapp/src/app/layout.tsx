import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AutoInfra | Civil Engineering Estimation AI",
  description: "AI-powered site servicing estimation from civil engineering drawings. Upload PDF drawings and get populated cost estimation spreadsheets instantly.",
  keywords: "civil engineering, estimation, AI, site servicing, manholes, sewers, watermain, cost estimation",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <nav className="navbar">
          <div className="navbar-inner">
            <a href="/" className="navbar-brand">
              <div className="navbar-logo">AI</div>
              <div>
                <div className="navbar-title">AutoInfra</div>
                <div className="navbar-subtitle">Civil Engineering Estimation AI</div>
              </div>
            </a>
            <div className="navbar-actions">
              <a href="/settings" className="btn btn-secondary btn-sm">⚙ Settings</a>
            </div>
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
