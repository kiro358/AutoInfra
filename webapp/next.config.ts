import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output for Docker/Cloud Run deployment
  output: 'standalone',
  
  // Allow server-side modules that aren't compatible with bundling (native/CJS).
  serverExternalPackages: ['exceljs', 'pdfkit', 'sharp', 'pdf-lib', '@napi-rs/canvas', 'pdfjs-dist'],

  // pdfjs loads its worker by a runtime path the standalone tracer can't follow;
  // force it into the output so the Docker image always ships it.
  outputFileTracingIncludes: {
    '/api/**': ['./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'],
  },
  
  // Increase API body size limit for PDF uploads
  experimental: {
    serverActions: {
      bodySizeLimit: '50mb',
    },
  },
};

export default nextConfig;
