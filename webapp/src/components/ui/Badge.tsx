import React from 'react';

export type BadgeVariant =
  | 'storm'
  | 'sanitary'
  | 'water'
  | 'structures'
  | 'success'
  | 'alarm'
  | 'muted'
  | 'warning'
  | 'info'
  | 'default';

export type BadgeSize = 'sm' | 'md' | 'lg';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  dot?: boolean;
  dotColor?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export const Badge: React.FC<BadgeProps> = ({
  variant = 'default',
  size = 'md',
  dot = false,
  dotColor,
  icon,
  children,
  className = '',
  ...props
}) => {
  const variantClass = variant === 'default' ? 'badge-muted' : `badge-${variant}`;
  const sizeClass = size === 'sm' ? 'text-[10px] py-0.5 px-1.5' : size === 'lg' ? 'text-xs py-1 px-3' : '';

  return (
    <span
      className={`badge ${variantClass} ${sizeClass} ${className}`.trim()}
      {...props}
    >
      {dot && (
        <span
          className="badge-dot"
          style={dotColor ? { backgroundColor: dotColor } : undefined}
          aria-hidden="true"
        />
      )}
      {icon && <span className="inline-flex items-center shrink-0">{icon}</span>}
      <span>{children}</span>
    </span>
  );
};
