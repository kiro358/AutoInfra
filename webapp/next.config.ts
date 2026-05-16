import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output for Docker/Cloud Run deployment
  output: 'standalone',
  
  // Allow server-side modules that aren't compatible with webpack bundling
  serverExternalPackages: ['exceljs', 'pdfkit', 'sharp', 'pdf-lib'],
  
  // Increase API body size limit for PDF uploads
  experimental: {
    serverActions: {
      bodySizeLimit: '50mb',
    },
  },
};

export default nextConfig;
