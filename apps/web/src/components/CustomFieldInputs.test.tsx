import type { CustomFieldView } from '@qa-flow-hub/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { CustomFieldInputs, CustomFieldSummary, draftForCreate } from './CustomFieldInputs';
import type { CustomFieldDraft } from './CustomFieldInputs';

const field = (overrides: Partial<CustomFieldView>): CustomFieldView => ({
  id: 'cf_1',
  projectId: 'proj_1',
  entityType: 'defect',
  key: 'browser',
  label: 'Browser',
  description: null,
  type: 'select',
  required: false,
  options: [
    { id: 'opt_a', label: 'Chrome', archived: false },
    { id: 'opt_b', label: 'Safari', archived: true },
  ],
  position: 0,
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

function Harness({
  fields,
  values,
}: {
  fields: CustomFieldView[];
  values: Record<string, string>;
}): React.JSX.Element {
  const [draft, setDraft] = useState<CustomFieldDraft>({});
  return (
    <>
      <CustomFieldInputs fields={fields} values={values} draft={draft} onChange={setDraft} />
      <output data-testid="draft">{JSON.stringify(draftForCreate(draft))}</output>
    </>
  );
}

describe('CustomFieldInputs', () => {
  it('offers only active options to a new value and marks required fields', async () => {
    render(<Harness fields={[field({ required: true })]} values={{}} />);
    const select = screen.getByLabelText('Browser *');
    expect(screen.queryByRole('option', { name: 'Safari' })).toBeNull();
    await userEvent.selectOptions(select, 'opt_a');
    expect(screen.getByTestId('draft').textContent).toBe('{"cf_1":"opt_a"}');
  });

  it('keeps an archived option that is already chosen', () => {
    render(<Harness fields={[field({})]} values={{ cf_1: 'opt_b' }} />);
    expect(screen.getByRole('option', { name: 'Safari' })).toBeTruthy();
  });

  it('renders nothing without fields and summarises labels, not ids', () => {
    const { container } = render(<Harness fields={[]} values={{}} />);
    expect(container.querySelector('fieldset')).toBeNull();
    render(<CustomFieldSummary fields={[field({})]} values={{ cf_1: 'opt_a' }} />);
    expect(screen.getByText('Browser: Chrome')).toBeTruthy();
  });
});
