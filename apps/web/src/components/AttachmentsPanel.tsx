import { ALLOWED_EXTENSIONS, ALLOWED_FILE_TYPES } from '@qa-flow-hub/shared';
import type { AttachableEntity, AttachmentView } from '@qa-flow-hub/shared';
import { Button, DataState } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { attachmentsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';

interface AttachmentsPanelProps {
  entityType: AttachableEntity;
  entityId: string;
  /** Hides the upload form (e.g. a closed run or a viewer-only screen). */
  readOnly?: boolean;
  title?: string;
}

const ACCEPT = ALLOWED_EXTENSIONS.map((extension) => `.${extension}`).join(',');

/**
 * Evidence for one entity: list, upload, view/download, delete.
 *
 * Bytes always go through the API with the session token: there is no public
 * URL, so a preview is a blob fetched on demand and revoked when it closes.
 * Type and size are checked client-side first only to give a faster message;
 * the server is the one that decides.
 */
export function AttachmentsPanel({
  entityType,
  entityId,
  readOnly = false,
  title = 'Evidence',
}: AttachmentsPanelProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const queryKey = ['attachments', entityType, entityId];
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ attachment: AttachmentView; url: string } | null>(null);

  const limits = useQuery({ queryKey: ['attachment-limits'], queryFn: attachmentsApi.limits });
  const list = useQuery({
    queryKey,
    queryFn: () => attachmentsApi.list(entityType, entityId),
  });

  const upload = useMutation({
    mutationFn: (file: File) => attachmentsApi.upload(entityType, entityId, file),
    onSuccess: async () => {
      setError(null);
      if (fileInput.current !== null) {
        fileInput.current.value = '';
      }
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (cause) => {
      setError(describeUploadError(cause));
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => attachmentsApi.remove(id),
    onSuccess: async (_, id) => {
      setError(null);
      if (preview?.attachment.id === id) {
        setPreview(null);
      }
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not delete the file.');
    },
  });

  const download = useMutation({
    mutationFn: async (attachment: AttachmentView) => {
      const { blob, fileName } = await attachmentsApi.download(attachment.id);
      saveBlob(blob, fileName ?? attachment.fileName);
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not download the file.');
    },
  });

  const open = useMutation({
    mutationFn: async (attachment: AttachmentView) => {
      const { blob } = await attachmentsApi.download(attachment.id, 'inline');
      return { attachment, url: URL.createObjectURL(blob) };
    },
    onSuccess: (next) => {
      setPreview((current) => {
        if (current !== null) {
          URL.revokeObjectURL(current.url);
        }
        return next;
      });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not open the file.');
    },
  });

  useEffect(
    () => () => {
      if (preview !== null) {
        URL.revokeObjectURL(preview.url);
      }
    },
    [preview],
  );

  const maxSizeBytes = limits.data?.maxSizeBytes;

  const onFileChosen = (file: File | undefined) => {
    if (file === undefined) {
      return;
    }
    if (!isAllowedName(file.name)) {
      setError(
        `Unsupported file type. Allowed: ${ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(', ')}.`,
      );
      return;
    }
    if (maxSizeBytes !== undefined && file.size > maxSizeBytes) {
      setError(
        `File too large: ${formatBytes(file.size)} exceeds the ${formatBytes(maxSizeBytes)} limit.`,
      );
      return;
    }
    setError(null);
    upload.mutate(file);
  };

  return (
    <section className="card attachments" aria-label={title}>
      <h3 className="attachments__title">{title}</h3>

      {!readOnly && (
        <div className="row-actions">
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            aria-label={`Choose a file for ${title.toLowerCase()}`}
            disabled={upload.isPending}
            onChange={(event) => {
              onFileChosen(event.target.files?.[0]);
            }}
          />
          {upload.isPending && (
            <span className="muted" role="status">
              Uploading…
            </span>
          )}
          {maxSizeBytes !== undefined && (
            <span className="muted">
              Images, .txt/.log, .json or .pdf up to {formatBytes(maxSizeBytes)}.
            </span>
          )}
        </div>
      )}

      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}

      <DataState
        isPending={list.isPending}
        error={list.error}
        isEmpty={(list.data?.data.length ?? 0) === 0}
        emptyMessage="No evidence attached yet."
      >
        <ul className="plain-list attachments__list">
          {list.data?.data.map((attachment) => {
            const kind = kindOf(attachment.contentType);
            return (
              <li key={attachment.id} className="attachments__item">
                <div className="attachments__meta">
                  <strong>{attachment.fileName}</strong>
                  <span className="muted">
                    {attachment.contentType} · {formatBytes(attachment.sizeBytes)}
                    {attachment.uploadedByName !== null && ` · ${attachment.uploadedByName}`}
                    {' · '}
                    {new Date(attachment.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="row-actions">
                  {kind !== 'text' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={open.isPending && open.variables?.id === attachment.id}
                      onClick={() => {
                        open.mutate(attachment);
                      }}
                    >
                      {kind === 'image' ? 'Preview' : 'Open'}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={download.isPending && download.variables?.id === attachment.id}
                    onClick={() => {
                      download.mutate(attachment);
                    }}
                  >
                    Download
                  </Button>
                  {!readOnly && (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={remove.isPending && remove.variables === attachment.id}
                      onClick={() => {
                        remove.mutate(attachment.id);
                      }}
                    >
                      Delete
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </DataState>

      {preview !== null && (
        <figure className="attachments__preview">
          {kindOf(preview.attachment.contentType) === 'image' ? (
            <img src={preview.url} alt={preview.attachment.fileName} />
          ) : (
            <iframe
              src={preview.url}
              title={preview.attachment.fileName}
              sandbox=""
              className="attachments__document"
            />
          )}
          <figcaption className="row-actions">
            <span className="muted">{preview.attachment.fileName}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setPreview(null);
              }}
            >
              Close preview
            </Button>
          </figcaption>
        </figure>
      )}
    </section>
  );
}

function kindOf(contentType: string): 'image' | 'text' | 'document' {
  return ALLOWED_FILE_TYPES.find((type) => type.mimeType === contentType)?.kind ?? 'document';
}

function isAllowedName(fileName: string): boolean {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  return fileName.includes('.') && (ALLOWED_EXTENSIONS as readonly string[]).includes(extension);
}

function describeUploadError(cause: unknown): string {
  if (!(cause instanceof ApiError)) {
    return 'Could not upload the file.';
  }
  switch (cause.code) {
    case 'UNSUPPORTED_FILE_TYPE':
      return `Unsupported file type: ${cause.message}`;
    case 'FILE_TOO_LARGE':
      return `File too large: ${cause.message}`;
    case 'STORAGE_ERROR':
      return 'Storage is unavailable right now. Try again in a moment.';
    default:
      return cause.message;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a tick to start the download before the URL disappears.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}
