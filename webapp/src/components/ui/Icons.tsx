import React from 'react';

export type IconName =
  | 'ruler'
  | 'pipe'
  | 'manhole'
  | 'water'
  | 'download'
  | 'upload'
  | 'search'
  | 'check'
  | 'alert'
  | 'alert-circle'
  | 'chevron'
  | 'chevron-down'
  | 'chevron-up'
  | 'chevron-right'
  | 'chevron-left'
  | 'refresh'
  | 'settings'
  | 'close'
  | 'copy'
  | 'sparkles'
  | 'filter'
  | 'arrow-up'
  | 'arrow-down'
  | 'arrow-right'
  | 'arrow-left'
  | 'file-text'
  | 'file-spreadsheet'
  | 'layers'
  | 'box'
  | 'dollar'
  | 'activity'
  | 'help'
  | 'info'
  | 'trash'
  | 'eye'
  | 'spinner'
  | 'plus'
  | 'database'
  | 'cpu'
  | 'terminal';

export interface IconProps extends React.SVGAttributes<SVGElement> {
  name?: IconName;
  size?: number | string;
  className?: string;
  strokeWidth?: number | string;
}

const renderPath = (name: IconName) => {
  switch (name) {
    case 'ruler':
      return (
        <>
          <path d="M21.3 8.7 8.7 21.3a2.12 2.12 0 0 1-3 0L2.7 18.3a2.12 2.12 0 0 1 0-3L15.3 2.7a2.12 2.12 0 0 1 3 0l3 3a2.12 2.12 0 0 1 0 3Z" />
          <path d="m14.5 3.5 2 2" />
          <path d="m11.5 6.5 3 3" />
          <path d="m8.5 9.5 2 2" />
          <path d="m5.5 12.5 3 3" />
          <path d="m2.5 15.5 2 2" />
        </>
      );
    case 'pipe':
      return (
        <>
          <ellipse cx="6" cy="12" rx="3" ry="7" />
          <path d="M6 5h12c1.66 0 3 3.13 3 7s-1.34 7-3 7H6" />
          <path d="M18 5c1.66 0 3 3.13 3 7s-1.34 7-3 7" />
        </>
      );
    case 'manhole':
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="5" />
          <path d="M12 3v4" />
          <path d="M12 17v4" />
          <path d="M3 12h4" />
          <path d="M17 12h4" />
          <circle cx="12" cy="12" r="1.5" />
        </>
      );
    case 'water':
      return (
        <>
          <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
          <path d="M12 18.5a4.5 4.5 0 0 0 4.5-4.5" />
        </>
      );
    case 'download':
      return (
        <>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </>
      );
    case 'upload':
      return (
        <>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </>
      );
    case 'search':
      return (
        <>
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </>
      );
    case 'check':
      return <polyline points="20 6 9 17 4 12" />;
    case 'alert':
      return (
        <>
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </>
      );
    case 'alert-circle':
      return (
        <>
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </>
      );
    case 'chevron':
    case 'chevron-down':
      return <polyline points="6 9 12 15 18 9" />;
    case 'chevron-up':
      return <polyline points="18 15 12 9 6 15" />;
    case 'chevron-right':
      return <polyline points="9 18 15 12 9 6" />;
    case 'chevron-left':
      return <polyline points="15 18 9 12 15 6" />;
    case 'refresh':
      return (
        <>
          <path d="M21 2v6h-6" />
          <path d="M3 12a9 9 0 0 1 15.5-6.36L21 8" />
          <path d="M3 22v-6h6" />
          <path d="M21 12a9 9 0 0 1-15.5 6.36L3 16" />
        </>
      );
    case 'settings':
      return (
        <>
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </>
      );
    case 'close':
      return (
        <>
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </>
      );
    case 'copy':
      return (
        <>
          <rect width="13" height="13" x="9" y="9" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </>
      );
    case 'sparkles':
      return (
        <>
          <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" />
          <path d="M5 3v4" />
          <path d="M19 17v4" />
          <path d="M3 5h4" />
          <path d="M17 19h4" />
        </>
      );
    case 'filter':
      return <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />;
    case 'arrow-up':
      return (
        <>
          <line x1="12" y1="19" x2="12" y2="5" />
          <polyline points="5 12 12 5 19 12" />
        </>
      );
    case 'arrow-down':
      return (
        <>
          <line x1="12" y1="5" x2="12" y2="19" />
          <polyline points="19 12 12 19 5 12" />
        </>
      );
    case 'arrow-right':
      return (
        <>
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </>
      );
    case 'arrow-left':
      return (
        <>
          <line x1="19" y1="12" x2="5" y2="12" />
          <polyline points="12 19 5 12 12 5" />
        </>
      );
    case 'file-text':
      return (
        <>
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <line x1="10" y1="9" x2="8" y2="9" />
        </>
      );
    case 'file-spreadsheet':
      return (
        <>
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
          <polyline points="14 2 14 8 20 8" />
          <path d="M8 13h8" />
          <path d="M8 17h8" />
          <path d="M12 13v8" />
        </>
      );
    case 'layers':
      return (
        <>
          <polygon points="12 2 2 7 12 12 22 7 12 2" />
          <polyline points="2 17 12 22 22 17" />
          <polyline points="2 12 12 17 22 12" />
        </>
      );
    case 'box':
      return (
        <>
          <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
          <path d="m3.3 7 8.7 5 8.7-5" />
          <path d="M12 22V12" />
        </>
      );
    case 'dollar':
      return (
        <>
          <line x1="12" y1="1" x2="12" y2="23" />
          <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
        </>
      );
    case 'activity':
      return <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />;
    case 'help':
      return (
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </>
      );
    case 'info':
      return (
        <>
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </>
      );
    case 'trash':
      return (
        <>
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </>
      );
    case 'eye':
      return (
        <>
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </>
      );
    case 'spinner':
      return (
        <>
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </>
      );
    case 'plus':
      return (
        <>
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </>
      );
    case 'database':
      return (
        <>
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
        </>
      );
    case 'cpu':
      return (
        <>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <rect x="9" y="9" width="6" height="6" />
          <line x1="9" y1="1" x2="9" y2="4" />
          <line x1="15" y1="1" x2="15" y2="4" />
          <line x1="9" y1="20" x2="9" y2="23" />
          <line x1="15" y1="20" x2="15" y2="23" />
          <line x1="20" y1="9" x2="23" y2="9" />
          <line x1="20" y1="14" x2="23" y2="14" />
          <line x1="1" y1="9" x2="4" y2="9" />
          <line x1="1" y1="14" x2="4" y2="14" />
        </>
      );
    case 'terminal':
      return (
        <>
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </>
      );
    default:
      return null;
  }
};

export const Icon: React.FC<IconProps> = ({
  name = 'ruler',
  size = 16,
  className = '',
  strokeWidth = 2,
  style,
  ...props
}) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      {...props}
    >
      {renderPath(name)}
    </svg>
  );
};

// Convenience component exports
export const RulerIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="ruler" {...props} />;
export const PipeIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="pipe" {...props} />;
export const ManholeIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="manhole" {...props} />;
export const WaterIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="water" {...props} />;
export const DownloadIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="download" {...props} />;
export const UploadIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="upload" {...props} />;
export const SearchIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="search" {...props} />;
export const CheckIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="check" {...props} />;
export const AlertIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="alert" {...props} />;
export const ChevronDownIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="chevron-down" {...props} />;
export const ChevronUpIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="chevron-up" {...props} />;
export const ChevronRightIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="chevron-right" {...props} />;
export const ChevronLeftIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="chevron-left" {...props} />;
export const RefreshIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="refresh" {...props} />;
export const SettingsIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="settings" {...props} />;
export const CloseIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="close" {...props} />;
export const CopyIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="copy" {...props} />;
export const SparklesIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="sparkles" {...props} />;
export const FilterIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="filter" {...props} />;
export const ArrowUpIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="arrow-up" {...props} />;
export const ArrowDownIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="arrow-down" {...props} />;
export const ArrowRightIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="arrow-right" {...props} />;
export const ArrowLeftIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="arrow-left" {...props} />;
export const FileTextIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="file-text" {...props} />;
export const FileSpreadsheetIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="file-spreadsheet" {...props} />;
export const LayersIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="layers" {...props} />;
export const BoxIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="box" {...props} />;
export const DollarIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="dollar" {...props} />;
export const ActivityIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="activity" {...props} />;
export const SpinnerIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="spinner" {...props} />;
export const TrashIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="trash" {...props} />;
export const CpuIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="cpu" {...props} />;
export const TerminalIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="terminal" {...props} />;
export const InfoIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="info" {...props} />;
export const HelpIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="help" {...props} />;
export const EyeIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="eye" {...props} />;
export const PlusIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="plus" {...props} />;
export const DatabaseIcon: React.FC<Omit<IconProps, 'name'>> = (props) => <Icon name="database" {...props} />;

