import { Injectable } from '@nestjs/common';
import { WorkItem } from '@prisma/client';
import type { BoardCard, BoardRef, BoardSwimlane, BoardSwimlaneView } from '@qa-flow-hub/shared';
import { DevelopmentService } from '../development/development.service';
import { WorkItemsRepository, WorkItemSummary } from './work-items.repository';
import { toWorkItemView } from './work-items.service';

/** Filters shared by the Scrum (S4-F6) and Kanban (S4-F7) boards. */
export interface CardFilters {
  /** A user id, `me` or `none`. */
  assigneeId?: string | undefined;
  priority?: string | undefined;
  type?: string | undefined;
  /** Ids or `none`. */
  epicId?: string | undefined;
  featureId?: string | undefined;
  releaseId?: string | undefined;
  search?: string | undefined;
  developmentStatus?: string | undefined;
}

/** Turns work items into board cards: epic/feature, assignee name, requirements. */
@Injectable()
export class BoardCardsService {
  constructor(
    private readonly items: WorkItemsRepository,
    private readonly development: DevelopmentService,
  ) {}

  async cards(projectId: string, rows: readonly WorkItem[]): Promise<BoardCard[]> {
    const index = new Map(
      (await this.items.hierarchy(projectId)).map((row) => [row.id, row] as const),
    );
    const [requirements, names, development] = await Promise.all([
      this.items.requirementKeys(rows.map((row) => row.id)),
      this.items.userNames(
        [...new Set(rows.map((row) => row.assigneeId))].filter((id): id is string => id !== null),
      ),
      this.development.statusesOf(rows.map((row) => row.id)),
    ]);
    return rows.map((row) => {
      const keys = requirements.get(row.id) ?? [];
      return {
        ...toWorkItemView(row),
        epic: ancestorOf(row, 'epic', index),
        feature: ancestorOf(row, 'feature', index),
        assignee:
          row.assigneeId === null
            ? null
            : { id: row.assigneeId, fullName: names.get(row.assigneeId) ?? 'Unknown user' },
        requirements: { count: keys.length, keys },
        developmentStatus: development.get(row.id)?.status ?? 'no_development',
      };
    });
  }
}

/** The nearest epic or feature above an item (the item itself counts). */
export function ancestorOf(
  item: Pick<WorkItem, 'id'>,
  type: 'epic' | 'feature',
  index: ReadonlyMap<string, WorkItemSummary>,
): BoardRef | null {
  let cursor = index.get(item.id) ?? null;
  let depth = 0;
  while (cursor !== null && cursor.type !== type && depth < 8) {
    cursor = cursor.parentId === null ? null : (index.get(cursor.parentId) ?? null);
    depth += 1;
  }
  return cursor !== null && cursor.type === type
    ? { id: cursor.id, key: cursor.key, title: cursor.title }
    : null;
}

export function uniqueRefs(refs: ReadonlyArray<BoardRef | null>): BoardRef[] {
  const seen = new Map<string, BoardRef>();
  for (const ref of refs) {
    if (ref !== null && !seen.has(ref.id)) {
      seen.set(ref.id, ref);
    }
  }
  return [...seen.values()].sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }));
}

export function matchesCard(card: BoardCard, filters: CardFilters, userId: string): boolean {
  const ref = (value: string | undefined, actual: string | null): boolean =>
    value === undefined || (value === 'none' ? actual === null : actual === value);
  const assignee = filters.assigneeId === 'me' ? userId : filters.assigneeId;
  if (!ref(assignee, card.assigneeId) || !ref(filters.releaseId, card.releaseId)) {
    return false;
  }
  if (
    filters.developmentStatus !== undefined &&
    card.developmentStatus !== filters.developmentStatus
  ) {
    return false;
  }
  if (filters.priority !== undefined && card.priority !== filters.priority) {
    return false;
  }
  if (filters.type !== undefined && card.type !== filters.type) {
    return false;
  }
  if (
    !ref(filters.epicId, card.epic?.id ?? null) ||
    !ref(filters.featureId, card.feature?.id ?? null)
  ) {
    return false;
  }
  if (filters.search !== undefined) {
    const needle = filters.search.toLowerCase();
    return card.title.toLowerCase().includes(needle) || card.key.toLowerCase().includes(needle);
  }
  return true;
}

export function buildSwimlanes(
  cards: readonly BoardCard[],
  by: BoardSwimlane,
): BoardSwimlaneView[] {
  if (by === 'none') {
    return [];
  }
  const lanes = new Map<string | null, BoardSwimlaneView>();
  for (const card of cards) {
    const owner =
      by === 'assignee'
        ? card.assignee === null
          ? null
          : { id: card.assignee.id, title: card.assignee.fullName }
        : card.epic === null
          ? null
          : { id: card.epic.id, title: `${card.epic.key} ${card.epic.title}` };
    const id = owner?.id ?? null;
    let lane = lanes.get(id);
    if (lane === undefined) {
      lane = {
        id,
        title: owner?.title ?? (by === 'assignee' ? 'Unassigned' : 'No epic'),
        cardIds: [],
      };
      lanes.set(id, lane);
    }
    lane.cardIds.push(card.id);
  }
  const named = [...lanes.values()].filter((lane) => lane.id !== null);
  named.sort((a, b) => a.title.localeCompare(b.title, 'en', { numeric: true }));
  const rest = lanes.get(null);
  return rest === undefined ? named : [...named, rest];
}

export function roundEstimate(value: number): number {
  return Math.round(value * 100) / 100;
}
