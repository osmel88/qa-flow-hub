import { PROJECT_KEY_RULE } from '@qa-flow-hub/shared';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '../test/render';
import { ProjectsPage, projectKeyError } from './ProjectsPage';

const create = vi.fn();

vi.mock('../api/endpoints', () => ({
  projectsApi: {
    list: () => Promise.resolve({ data: [], page: 1, pageSize: 20, total: 0 }),
    create: (...args: unknown[]) => create(...args),
    archive: vi.fn(),
    restore: vi.fn(),
  },
}));

describe('project key validation', () => {
  it.each(['QA', 'WEB', 'WEB2', 'QA01'])('accepts %s', (key) => {
    expect(projectKeyError(key)).toBeUndefined();
  });

  it.each(['1QA', 'Q', 'WEB-2', 'WEB_2', 'ABCDEFGHI', 'W EB', 'QA ', 'QA!', 'Q$'])(
    'rejects %j',
    (key) => {
      expect(projectKeyError(key)).toBe(PROJECT_KEY_RULE);
    },
  );

  it('validates while typing and keeps Create project disabled until both fields are valid', async () => {
    const user = userEvent.setup();
    renderScreen(<ProjectsPage />);
    const button = screen.getByRole('button', { name: 'Create project' });
    expect(screen.getByText(new RegExp(PROJECT_KEY_RULE.replace('.', '\\.')))).toBeInTheDocument();
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText('Name'), 'Web shop');
    await user.type(screen.getByLabelText('Key'), '1qa');
    expect(screen.getByLabelText('Key')).toHaveValue('1QA');
    expect(screen.getByRole('alert')).toHaveTextContent(PROJECT_KEY_RULE);
    expect(screen.getByLabelText('Key')).toHaveAttribute('aria-invalid', 'true');
    expect(button).toBeDisabled();

    await user.clear(screen.getByLabelText('Key'));
    await user.type(screen.getByLabelText('Key'), 'web2');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(button).toBeEnabled();

    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'W');
    expect(button).toBeDisabled();
    expect(create).not.toHaveBeenCalled();
  });
});
