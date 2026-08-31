import type { ReactNode } from 'react';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {description !== undefined && <p className="muted">{description}</p>}
      </div>
      {actions !== undefined && <div className="page-header__actions">{actions}</div>}
    </div>
  );
}
