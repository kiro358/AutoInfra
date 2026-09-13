import React from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SettingsIcon } from '@/components/ui/Icons';

export interface NavbarProps {
  activeMode?: string;
  onReset?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ activeMode, onReset }) => {
  return (
    <header className="navbar">
      <div className="navbar-inner">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            onClick={onReset}
            className="navbar-brand hover:opacity-90 transition-opacity"
          >
            <div className="navbar-logo" aria-label="AutoInfra CAD Logo">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="7" />
                <line x1="12" y1="2" x2="12" y2="22" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <circle cx="12" cy="12" r="2" fill="currentColor" />
              </svg>
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <span className="navbar-title">AutoInfra</span>
                <Badge variant="muted" size="sm" className="hidden sm:inline-flex">
                  Ontario Municipal
                </Badge>
              </div>
              <span className="navbar-subtitle">Ontario Municipal Takeoff Engine</span>
            </div>
          </Link>

          {activeMode && (
            <Badge variant="storm" size="sm" className="hidden md:inline-flex ml-2">
              <span className="text-[10px] text-muted mr-1">MODE:</span>
              {activeMode.toUpperCase()}
            </Badge>
          )}
        </div>

        <div className="navbar-actions">
          <Badge variant="success" size="sm" dot dotColor="var(--success)">
            Engine Live
          </Badge>

          <Link href="/settings">
            <Button
              variant="outline"
              size="sm"
              icon={<SettingsIcon size={13} />}
            >
              Rates &amp; Settings
            </Button>
          </Link>
        </div>
      </div>
    </header>
  );
};
