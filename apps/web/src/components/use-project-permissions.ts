import type { Permission } from '@qa-flow-hub/shared';
import { useQuery } from '@tanstack/react-query';
import { permissionsApi } from '../api/endpoints';

/**
 * The caller's effective permissions in a project, for deciding which controls
 * to show. Hiding a button is convenience only: the API checks every request.
 * While loading, nothing is granted.
 */
export function useProjectPermissions(projectId: string | null): {
  can: (permission: Permission) => boolean;
  isPending: boolean;
} {
  const mine = useQuery({
    queryKey: ['permissions', 'me', projectId],
    queryFn: () => permissionsApi.mine(projectId ?? ''),
    enabled: projectId !== null,
  });
  const granted = new Set(
    (mine.data?.permissions ?? [])
      .filter((entry) => entry.granted)
      .map((entry) => entry.permission),
  );
  return { can: (permission) => granted.has(permission), isPending: mine.isPending };
}
