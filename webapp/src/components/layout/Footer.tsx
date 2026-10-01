import React from 'react';
import Link from 'next/link';

export const Footer: React.FC = () => {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <span>
          © {new Date().getFullYear()} AutoInfra · Built for Ontario municipal servicing (OPSS / OPSD)
        </span>
        <div className="flex items-center gap-5">
          <Link href="/settings" className="footer-link">
            Unit rates
          </Link>
          <a
            href="https://www.ops.on.ca/"
            target="_blank"
            rel="noopener noreferrer"
            className="footer-link"
          >
            Ontario Provincial Standards ↗
          </a>
        </div>
      </div>
    </footer>
  );
};
