import { Button, DataState, TextAreaField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { testDesignApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { CoverageLinks } from '../components/CoverageLinks';
import { PageHeader } from '../components/PageHeader';
import { CustomFieldInputs, useCustomFields } from '../components/CustomFieldInputs';
import type { CustomFieldDraft } from '../components/CustomFieldInputs';
import { useProjectPermissions } from '../components/use-project-permissions';
import { TestCaseHistory } from './TestCaseHistory';
import { TestCaseParameters } from './TestCaseParameters';
import { t } from '../i18n/i18n';

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
  const [customDraft, setCustomDraft] = useState<CustomFieldDraft>({});
  const [changeReason, setChangeReason] = useState('');

  const detail = useQuery({
    queryKey: ['case', caseId],
    queryFn: () => testDesignApi.case(caseId),
  });

  const { can } = useProjectPermissions(detail.data?.projectId ?? null);
  const customFields = useCustomFields(detail.data?.projectId ?? null, 'test_case');

  useEffect(() => {
    if (detail.data !== undefined) {
      setCustomDraft({});
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
        ...(Object.keys(customDraft).length === 0 ? {} : { customFields: customDraft }),
        // Optimistic lock: a case edited elsewhere since it loaded answers 409.
        ...(detail.data === undefined ? {} : { version: detail.data.version }),
        ...(changeReason.trim() === '' ? {} : { changeReason: changeReason.trim() }),
      }),
    onSuccess: async (updated) => {
      setError(null);
      setChangeReason('');
      setSavedVersion(updated.version);
      await queryClient.invalidateQueries({ queryKey: ['case', caseId] });
      await queryClient.invalidateQueries({ queryKey: ['cases'] });
    },
    onError: (cause) => {
      setSavedVersion(null);
      setError(cause instanceof ApiError ? cause.message : t('testCaseEditor.couldNotSaveTheCase'));
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
        title={
          detail.data === undefined
            ? t('testCaseEditor.testCase')
            : t('testCaseEditor.editor', { key: detail.data.key })
        }
        description={t('testCaseEditor.savingAContentChangeCreates')}
        actions={<Link to="/test-cases">{t('testCaseEditor.backToCases')}</Link>}
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
              {t('testCaseEditor.savedAsVersion')} {savedVersion}.
            </p>
          )}

          <TextField
            label={t('testCaseEditor.title')}
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setSavedVersion(null);
            }}
          />

          <h2>{t('testCaseEditor.steps')}</h2>
          {steps.length === 0 && <p className="muted">{t('testCaseEditor.noStepsYetAddThe')}</p>}

          <ol className="step-list">
            {steps.map((step, index) => (
              // Steps have no stable id until saved, and the list is edited as
              // a whole, so the position is the identity here.
              <li key={index} className="step">
                <TextAreaField
                  label={t('testCaseEditor.stepAction', { value: index + 1 })}
                  value={step.action}
                  onChange={(event) => {
                    updateStep(index, { action: event.target.value });
                    setSavedVersion(null);
                  }}
                />
                <TextAreaField
                  label={t('testCaseEditor.stepExpectedResult', { value: index + 1 })}
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
                  {t('testCaseEditor.removeStep')} {index + 1}
                </Button>
              </li>
            ))}
          </ol>

          <CustomFieldInputs
            fields={customFields}
            values={detail.data?.customFields ?? {}}
            draft={customDraft}
            onChange={(draft) => {
              setCustomDraft(draft);
              setSavedVersion(null);
            }}
          />

          <TextField
            label={t('testCaseEditor.changeReasonOptional')}
            value={changeReason}
            onChange={(event) => {
              setChangeReason(event.target.value);
            }}
          />

          <div className="row-actions">
            <Button
              variant="secondary"
              disabled={steps.length >= MAX_STEPS}
              onClick={() => {
                setSteps((current) => [...current, { action: '', expectedResult: '' }]);
                setSavedVersion(null);
              }}
            >
              {t('testCaseEditor.addStep')}
            </Button>
            <Button
              loading={save.isPending}
              disabled={steps.some((step) => step.action.trim() === '')}
              onClick={() => {
                save.mutate();
              }}
            >
              {t('testCaseEditor.saveCase')}
            </Button>
          </div>
          {steps.length >= MAX_STEPS && (
            <p className="muted">
              {t('testCaseEditor.aCaseIsCappedAt')} {MAX_STEPS} {t('testCaseEditor.steps2')}
            </p>
          )}
        </section>

        {detail.data !== undefined && (
          <TestCaseParameters
            detail={detail.data}
            canImport={can('test_design.import')}
            canExport={can('data.export')}
          />
        )}

        {detail.data !== undefined && (
          <TestCaseHistory detail={detail.data} canWrite={can('test_design.write')} />
        )}

        {detail.data !== undefined && (
          <CoverageLinks side="test_case" entityId={caseId} projectId={detail.data.projectId} />
        )}
      </DataState>
    </>
  );
}
