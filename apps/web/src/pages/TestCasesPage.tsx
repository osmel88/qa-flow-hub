import { Badge, Button, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { testDesignApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize, toneFor } from '../components/status';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';

/**
 * Suites, sections and cases share one screen because they are one mental
 * model: the tree on the left is navigation, the table on the right is the
 * content of whatever is selected.
 */
export function TestCasesPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const [suiteId, setSuiteId] = useState<string | null>(null);
  const [suiteName, setSuiteName] = useState('');
  const [sectionName, setSectionName] = useState('');
  const [caseTitle, setCaseTitle] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);

  const suites = useQuery({
    queryKey: ['suites', activeProjectId],
    queryFn: () => testDesignApi.suites(activeProjectId ?? ''),
    enabled: activeProjectId !== null,
  });

  const selectedSuite = suiteId ?? suites.data?.[0]?.id ?? null;

  const sections = useQuery({
    queryKey: ['sections', selectedSuite],
    queryFn: () => testDesignApi.sections(selectedSuite ?? ''),
    enabled: selectedSuite !== null,
  });

  const cases = useQuery({
    queryKey: ['cases', activeProjectId, selectedSuite, includeArchived],
    queryFn: () =>
      testDesignApi.cases({
        projectId: activeProjectId ?? '',
        ...(selectedSuite === null ? {} : { suiteId: selectedSuite }),
        ...(includeArchived ? { includeArchived: 'true' as const } : {}),
      }),
    enabled: activeProjectId !== null,
  });

  /**
   * Archiving changes three answers at once, so all three queries go.
   *
   * The link survives but stops counting as coverage, which means the matrix on
   * another screen is now wrong, and the suite tree's count is too; leaving
   * either stale reads as a data bug rather than a stale cache.
   */
  const refreshAfterLifecycleChange = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['cases'] }),
      queryClient.invalidateQueries({ queryKey: ['suites'] }),
      queryClient.invalidateQueries({ queryKey: ['matrix'] }),
    ]);
  };

  const fail = (cause: unknown, fallback: string) => {
    setError(cause instanceof ApiError ? cause.message : fallback);
  };

  const createSuite = useMutation({
    mutationFn: () =>
      testDesignApi.createSuite({ projectId: activeProjectId ?? '', name: suiteName }),
    onSuccess: async () => {
      setSuiteName('');
      await queryClient.invalidateQueries({ queryKey: ['suites'] });
    },
    onError: (cause) => {
      fail(cause, 'Could not create the suite.');
    },
  });

  const createSection = useMutation({
    mutationFn: () =>
      testDesignApi.createSection({
        suiteId: selectedSuite ?? '',
        name: sectionName,
        ...(sectionId === '' ? {} : { parentId: sectionId }),
      }),
    onSuccess: async () => {
      setSectionName('');
      await queryClient.invalidateQueries({ queryKey: ['sections'] });
    },
    onError: (cause) => {
      // Sections are capped at five levels: deeper trees are a filing system
      // nobody navigates, and the API says so rather than the client guessing.
      fail(cause, 'Could not create the section.');
    },
  });

  const createCase = useMutation({
    mutationFn: () =>
      testDesignApi.createCase({
        suiteId: selectedSuite ?? '',
        title: caseTitle,
        ...(sectionId === '' ? {} : { sectionId }),
        type: 'functional',
        priority: 'medium',
        automationStatus: 'manual',
        tags: [],
        steps: [],
      }),
    onSuccess: async () => {
      setCaseTitle('');
      await queryClient.invalidateQueries({ queryKey: ['cases'] });
      await queryClient.invalidateQueries({ queryKey: ['suites'] });
    },
    onError: (cause) => {
      fail(cause, 'Could not create the test case.');
    },
  });

  const duplicate = useMutation({
    mutationFn: (id: string) => testDesignApi.duplicate(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['cases'] });
    },
  });

  const archive = useMutation({
    mutationFn: (id: string) => testDesignApi.archive(id),
    onSuccess: refreshAfterLifecycleChange,
    onError: (cause) => {
      fail(cause, 'Could not archive the case.');
    },
  });

  const restore = useMutation({
    mutationFn: (id: string) => testDesignApi.restore(id),
    onSuccess: refreshAfterLifecycleChange,
    onError: (cause) => {
      fail(cause, 'Could not restore the case.');
    },
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }

  const flatSections = (sections.data ?? []).flatMap(
    function flatten(
      section,
      _index,
      _all,
    ): Array<{ value: string; label: string; depth: number }> {
      const walk = (
        node: typeof section,
        depth: number,
      ): Array<{ value: string; label: string; depth: number }> => [
        { value: node.id, label: `${'— '.repeat(depth)}${node.name}`, depth },
        ...node.children.flatMap((child) => walk(child, depth + 1)),
      ];
      return walk(section, 0);
    },
  );

  return (
    <>
      <PageHeader title="Test cases" description="Suites hold sections; sections hold cases." />

      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}

      <div className="split">
        <aside className="card" aria-label="Suites and sections">
          <h2>Suites</h2>
          <DataState
            isPending={suites.isPending}
            error={suites.error}
            isEmpty={(suites.data?.length ?? 0) === 0}
            emptyMessage="No suite yet."
          >
            <ul className="plain-list">
              {suites.data?.map((suite) => (
                <li key={suite.id}>
                  <button
                    className="tree-item"
                    aria-current={suite.id === selectedSuite || undefined}
                    onClick={() => {
                      setSuiteId(suite.id);
                      setSectionId('');
                    }}
                  >
                    {suite.name} ({suite.caseCount})
                  </button>
                </li>
              ))}
            </ul>
          </DataState>

          <TextField
            label="New suite"
            value={suiteName}
            onChange={(event) => {
              setSuiteName(event.target.value);
            }}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={suiteName.trim() === ''}
            loading={createSuite.isPending}
            onClick={() => {
              createSuite.mutate();
            }}
          >
            Add suite
          </Button>

          {selectedSuite !== null && (
            <>
              <h2>Sections</h2>
              <SelectField
                label="Parent section"
                options={[{ value: '', label: 'Suite root' }, ...flatSections]}
                value={sectionId}
                onChange={(event) => {
                  setSectionId(event.target.value);
                }}
              />
              <TextField
                label="New section"
                value={sectionName}
                onChange={(event) => {
                  setSectionName(event.target.value);
                }}
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={sectionName.trim() === ''}
                loading={createSection.isPending}
                onClick={() => {
                  createSection.mutate();
                }}
              >
                Add section
              </Button>
            </>
          )}
        </aside>

        <div>
          <section className="card">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(event) => {
                  setIncludeArchived(event.target.checked);
                }}
              />
              Show archived cases
            </label>
          </section>

          <section className="card" aria-labelledby="new-case">
            <h2 id="new-case">New test case</h2>
            <TextField
              label="Title"
              value={caseTitle}
              onChange={(event) => {
                setCaseTitle(event.target.value);
              }}
            />
            <Button
              disabled={selectedSuite === null || caseTitle.trim().length < 3}
              loading={createCase.isPending}
              onClick={() => {
                createCase.mutate();
              }}
            >
              Create case
            </Button>
          </section>

          <DataState
            isPending={cases.isPending}
            error={cases.error}
            isEmpty={(cases.data?.data.length ?? 0) === 0}
            emptyMessage="This suite has no cases yet."
          >
            <table className="table card">
              <thead>
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">Title</th>
                  <th scope="col">Status</th>
                  <th scope="col">Version</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {cases.data?.data.map((testCase) => (
                  <tr key={testCase.id}>
                    <td>
                      <code>{testCase.key}</code>
                    </td>
                    <td>
                      <Link to={`/test-cases/${testCase.id}`}>{testCase.title}</Link>
                    </td>
                    <td>
                      <Badge tone={toneFor(testCase.status)}>{humanize(testCase.status)}</Badge>
                    </td>
                    <td>v{testCase.version}</td>
                    <td className="row-actions">
                      {testCase.archivedAt !== null && <Badge tone="neutral">Archived</Badge>}
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          duplicate.mutate(testCase.id);
                        }}
                      >
                        Duplicate
                      </Button>
                      {testCase.archivedAt === null ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            archive.mutate(testCase.id);
                          }}
                        >
                          Archive
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            restore.mutate(testCase.id);
                          }}
                        >
                          Restore
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataState>
        </div>
      </div>
    </>
  );
}
