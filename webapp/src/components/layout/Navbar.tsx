'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SettingsIcon, UploadIcon } from '@/components/ui/Icons';

export const BrandMark: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {/* A manhole (circle) on a pipe run — the two things this tool measures. */}
    <path d="M2 16h5" />
    <path d="M17 16h5" />
    <circle cx="12" cy="16" r="5" />
    <path d="M12 3v8" />
    <path d="M9 6l3-3 3 3" />
  </svg>
);

const NAV_ITEMS = [
  { href: '/', label: 'New takeoff', icon: <UploadIcon size={15} /> },
  { href: '/settings', label: 'Unit rates', icon: <SettingsIcon size={15} /> },
];

export const Navbar: React.FC = () => {
  const pathname = usePathname();

  return (
    <header className="navbar">
      <div className="navbar-inner">
        <Link href="/" className="navbar-brand" aria-label="AutoInfra home">
          <span className="navbar-logo">
            <BrandMark />
          </span>
          <span className="flex flex-col">
            <span className="navbar-title">AutoInfra</span>
            <span className="navbar-subtitle">Site servicing takeoff</span>
          </span>
        </Link>

        <nav className="navbar-actions" aria-label="Primary">
          <span className="status-pill hidden md:inline-flex" title="Extraction engine is online">
            <span className="status-pill-dot" aria-hidden="true" />
            Engine online
          </span>
          {NAV_ITEMS.map((item) => {
            const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-link ${active ? 'is-active' : ''}`.trim()}
                aria-current={active ? 'page' : undefined}
              >
                {item.icon}
                <span className="hidden sm:inline">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
};
