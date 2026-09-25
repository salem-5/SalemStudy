import type { ReactNode } from 'react';

/** The title row at the top of a notebook section: what this is, one line on what it is for, and its actions. */
export function SectionHead({ title, blurb, actions }: { title: ReactNode; blurb?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="section-head">
      <div className="section-head-text">
        <h2 className="h-title">{title}</h2>
        {blurb && <p>{blurb}</p>}
      </div>
      {actions && <div className="section-actions">{actions}</div>}
    </div>
  );
}

/** What an empty section shows: what would be here, why you would want it, and the one button that gets you started. */
export function EmptyState({ icon, title, children, action, compact }: {
  icon: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state${compact ? ' compact' : ''}`}>
      <div className="empty-icon" aria-hidden>{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div className="empty-actions">{action}</div>}
    </div>
  );
}
