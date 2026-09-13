import React from 'react';

export type CardVariant = 'default' | 'elevated' | 'interactive';

export interface CardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  headerBadge?: React.ReactNode;
  action?: React.ReactNode;
  variant?: CardVariant;
  noPadding?: boolean;
  headerClassName?: string;
  bodyClassName?: string;
  footer?: React.ReactNode;
  footerClassName?: string;
  children?: React.ReactNode;
}

export const Card: React.FC<CardProps> = ({
  title,
  subtitle,
  headerBadge,
  action,
  variant = 'default',
  noPadding = false,
  headerClassName = '',
  bodyClassName = '',
  footer,
  footerClassName = '',
  className = '',
  children,
  ...props
}) => {
  const variantClass =
    variant === 'elevated'
      ? 'card-elevated'
      : variant === 'interactive'
      ? 'card-interactive'
      : '';

  const hasHeader = title || subtitle || headerBadge || action;

  return (
    <div className={`card ${variantClass} ${className}`.trim()} {...props}>
      {hasHeader && (
        <div className={`card-header ${headerClassName}`.trim()}>
          <div className="flex items-center gap-2 min-w-0">
            {typeof title === 'string' ? (
              <h3 className="card-title truncate">{title}</h3>
            ) : (
              title
            )}
            {headerBadge && <div className="shrink-0">{headerBadge}</div>}
            {subtitle && (
              <span className="card-subtitle truncate hidden sm:inline">
                {subtitle}
              </span>
            )}
          </div>
          {action && <div className="flex items-center gap-2 shrink-0">{action}</div>}
        </div>
      )}

      {children && (
        <div className={`${noPadding ? '' : 'card-body'} ${bodyClassName}`.trim()}>
          {children}
        </div>
      )}

      {footer && (
        <div className={`card-footer ${footerClassName}`.trim()}>
          {footer}
        </div>
      )}
    </div>
  );
};
