import { Button, DataState, TextAreaField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { testDesignApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';

interface DraftStep {
  action: string;
  expectedResult: string;
}

const MAX_STEPS = 100;

/**
 * The step editor.
 *
 * Steps are saved as a whole ordered list, never one by one: positions come
 * from array order, so the client cannot produce a gap or a duplicate, and
 * there is no reorder endpoint that could disagree with the list.
 */
export function TestCaseEditorPage(): React.JSX.Element {
  const { caseId = '' } = useParams();
  const queryClient = useQueryClient();
  const [steps, setSteps] = useState<DraftStep[]>([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  // The version comes from the save response, not from the detail query: the
  // query may not have refetched yet, and a stale number here is exactly how a
  // display bug hides a real one.
  const [savedVersion, setSavedVersion] = useState<number | null>(null);

  const detail = useQuery({
    queryKey: ['case', caseId],
    queryFn: () => testDesignApi.case(caseId),
  });

  useEffect(() => {
    if (detail.data !== undefined) {
      setTitle(detail.data.title);
      setSteps(
        detail.data.steps.map((step) => ({
          action: step.action,
          expectedResult: step.expectedResult ?? '',
        })),
      );
    }
  }, [detail.data]);

  // Title and steps travel in the same request on purpose: two requests meant
  // two version bumps for one save, and the version is what run snapshots cite.
  const save = useMutation({
    mutationFn: () =>
      testDesignApi.updateCase(caseId, {
        title,
        steps: steps.map((step) => ({
          action: step.action,
          expectedResult: step.expectedResult === '' ? null : step.expectedResult,
        })),
      }),
    onSuccess: async (updated) => {
      setError(null);
      setSavedVersion(updated.version);
      await queryClient.invalidateQueries({ queryKey: ['case', caseId] });
      await queryClient.invalidateQueries({ queryKey: ['cases'] });
    },
    onError: (cause) => {
      setSavedVersion(null);
      setError(cause instanceof ApiError ? cause.message : 'Could not save the case.');
    },
  });

  const updateStep = (index: number, patch: Partial<DraftStep>) => {
    setSteps((current) =>
      current.map((step, position) => (position === index ? { ...step, ...patch } : step)),
    );
  };

  return (
    <>
      <PageHeader
        title={detail.data === undefined ? 'Test case' : `${detail.data.key} — editor`}
        description="Saving bumps the case version; runs already created keep their frozen copy."
        actions={<Link to="/test-cases">Back to cases</Link>}
      />

      <DataState isPending={detail.isPending} error={detail.error}>
        <section className="card">
          {error !== null && (
            <p className="ui-field__error" role="alert">
              {error}
            </p>
          )}
          {savedVersion !== null && (
            <p className="ui-state" role="status">
              Saved as version {savedVersion}.
            </p>
          )}

          <TextField
            label="Title"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setSavedVersion(null);
            }}
          />

          <h2>Steps</h2>
          {steps.length === 0 && <p className="muted">No steps yet. Add the first one.</p>}

          <ol className="step-list">
            {steps.map((step, index) => (
              // Steps have no stable id until saved, and the list is edited as
              // a whole, so the position is the identity here.
              <li key={index} className="step">
                <TextAreaField
                  label={`Step ${index + 1} action`}
                  value={step.action}
                  onChange={(event) => {
                    updateStep(index, { action: event.target.value });
                    setSavedVersion(null);
                  }}
                />
                <TextAreaField
                  label={`Step ${index + 1} expected result`}
                  value={step.expectedResult}
                  onChange={(event) => {
                    updateStep(index, { expectedResult: event.target.value });
                    setSavedVersion(null);
                  }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSteps((current) => current.filter((_, position) => position !== index));
                    setSavedVersion(null);
                  }}
                >
                  Remove step {index + 1}
                </Button>
              </li>
            ))}
          </ol>

          <div className="row-actions">
            <Button
              variant="secondary"
              disabled={steps.length >= MAX_STEPS}
              onClick={() => {
                setSteps((current) => [...current, { action: '', expectedResult: '' }]);
                setSavedVersion(null);
              }}
            >
              Add step
            </Button>
            <Button
              loading={save.isPending}
              disabled={steps.some((step) => step.action.trim() === '')}
              onClick={() => {
                save.mutate();
              }}
            >
              Save case
            </Button>
          </div>
          {steps.length >= MAX_STEPS && (
            <p className="muted">A case is capped at {MAX_STEPS} steps.</p>
          )}
        </section>
      </DataState>
    </>
  );
}
