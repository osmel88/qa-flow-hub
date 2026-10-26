import { computeImplementation } from '@qa-flow-hub/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ImplementationBadge } from './ImplementationBadge';

describe('ImplementationBadge', () => {
  it('shows the state and how many countable items are done', () => {
    render(<ImplementationBadge implementation={computeImplementation(['done', 'backlog'])} />);
    expect(screen.getByText('partially implemented · 1/2')).toBeInTheDocument();
  });

  it('shows the bare state without countable items and nothing without data', () => {
    const { container } = render(
      <>
        <ImplementationBadge implementation={computeImplementation([])} />
        <ImplementationBadge implementation={undefined} />
      </>,
    );
    expect(screen.getByText('not implemented')).toBeInTheDocument();
    expect(container.querySelectorAll('.ui-badge')).toHaveLength(1);
  });
});
