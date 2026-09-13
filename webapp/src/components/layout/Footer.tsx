import React from 'react';
import Link from 'next/link';

export const Footer: React.FC = () => {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="font-semibold text-primary">AutoInfra Studio v2.4.0</span>
          <span className="text-muted">|</span>
          <span>
            Standard: <strong className="text-secondary">OPSS.MUNI / OPSD</strong>
          </span>
          <span className="text-muted">|</span>
          <span className="text-muted">Ontario Civil Infrastructure Takeoff Engine</span>
        </div>

        <div className="flex items-center gap-4 flex-wrap">
          <a
            href="https://www.ops.on.ca/"
            target="_blank"
            rel="noopener noreferrer"
            className="footer-link flex items-center gap-1"
          >
            <span>Ontario Provincial Standards (OPS)</span>
            <span aria-hidden="true">&nearr;</span>
          </a>
          <span className="text-muted">|</span>
          <Link href="/settings" className="footer-link">
            Unit Rate Tables
          </Link>
        </div>
      </div>
    </footer>
  );
};
