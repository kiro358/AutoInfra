'use client';

import React from 'react';
import {
  ActivityIcon,
  DollarIcon,
  ManholeIcon,
  PipeIcon,
  WaterIcon,
} from '@/components/ui/Icons';

export type TakeoffTab =
  | 'summary'
  | 'storm'
  | 'sanitary'
  | 'structures'
  | 'watermain'
  | 'telemetry';

export interface TakeoffTabsProps {
  activeTab: TakeoffTab;
  onSelectTab: (tab: TakeoffTab) => void;
  counts: {
    stormRuns: number;
    sanitaryRuns: number;
    structures: number;
    watermainRuns: number;
    valves: number;
  };
}

export const TakeoffTabs: React.FC<TakeoffTabsProps> = ({
  activeTab,
  onSelectTab,
  counts,
}) => {
  const tabs: {
    id: TakeoffTab;
    label: string;
    icon: React.ReactNode;
    badgeCount?: number;
    badgeVariant?: 'storm' | 'sanitary' | 'structures' | 'water' | 'muted';
  }[] = [
    {
      id: 'summary',
      label: 'Cost Ledger',
      icon: <DollarIcon size={16} />,
    },
    {
      id: 'storm',
      label: 'Storm',
      icon: <PipeIcon size={16} />,
      badgeCount: counts.stormRuns,
      badgeVariant: 'storm',
    },
    {
      id: 'sanitary',
      label: 'Sanitary',
      icon: <PipeIcon size={16} />,
      badgeCount: counts.sanitaryRuns,
      badgeVariant: 'sanitary',
    },
    {
      id: 'structures',
      label: 'Structures',
      icon: <ManholeIcon size={16} />,
      badgeCount: counts.structures,
      badgeVariant: 'structures',
    },
    {
      id: 'watermain',
      label: 'Watermain',
      icon: <WaterIcon size={16} />,
      badgeCount: counts.watermainRuns + counts.valves,
      badgeVariant: 'water',
    },
    {
      id: 'telemetry',
      label: 'Telemetry',
      icon: <ActivityIcon size={16} />,
    },
  ];

  return (
    <nav className="studio-tabs-bar" aria-label="Takeoff Navigation Tabs">
      <div className="studio-tabs-list" role="tablist">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              className={`studio-tab-btn ${isActive ? 'is-active' : ''}`}
              onClick={() => onSelectTab(tab.id)}
            >
              <span className="tab-icon">{tab.icon}</span>
              <span className="tab-label">{tab.label}</span>
              {tab.badgeCount !== undefined && tab.badgeCount > 0 && (
                <span className="tab-count">{tab.badgeCount}</span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
};

export default TakeoffTabs;
