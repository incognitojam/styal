import { closestCenter, type CollisionDetection, type Modifier } from "@dnd-kit/core";
import { verticalListSortingStrategy, type SortingStrategy } from "@dnd-kit/sortable";
import {
  resolveSidebarDropTarget,
  resolveSidebarProjectDrop,
  sidebarListItemId,
  sidebarMarkerId,
  type SidebarListItem,
  type SidebarListMarker,
  type SidebarSection,
} from "./Sidebar.logic";

const stationary = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
const hidden = { ...stationary, scaleY: 0 };
type ThreadItem = Extract<SidebarListItem, { kind: "thread" }>;
type Layout = Parameters<SortingStrategy>[0];
const isShelfHeader = (item: SidebarListItem | undefined) =>
  item?.kind === "marker" &&
  (item.marker === "working-header" ||
    item.marker === "snoozed-header" ||
    item.marker === "settled-header");

/** Keep the lifted card below the Pins label, including when Pins is empty.
 * The container rect follows scrolling; the offset is measured once at pickup. */
export function restrictBelowSidebarLabel(
  { transform, containerNodeRect, draggingNodeRect }: Parameters<Modifier>[0],
  offset: number,
) {
  if (!containerNodeRect || !draggingNodeRect) return transform;
  const minimumY = containerNodeRect.top + offset - draggingNodeRect.top;
  return transform.y < minimumY ? { ...transform, y: minimumY } : transform;
}

/** Place a lifted project header among the other projects. Its rows
 * collapse while it is lifted, so rest rects no longer match what is drawn:
 * compare the header's center with the other projects' midpoints as drawn
 * without the lifted project, and name the header whose slot it takes. */
export function createSidebarProjectCollisionDetection(
  items: readonly SidebarListItem[],
  activeGroup: string,
): CollisionDetection {
  return (args) => {
    const blocks: { group: string; top: number; bottom: number }[] = [];
    for (const item of items) {
      const rect = args.droppableRects.get(sidebarListItemId(item));
      if (!rect) continue;
      if (item.kind === "project-header") {
        blocks.push({ group: item.group, top: rect.top, bottom: rect.bottom });
      } else if (item.kind === "thread" && item.section === "active") {
        const block = blocks.at(-1);
        if (block && item.group === block.group) block.bottom = rect.bottom;
      }
    }
    const lifted = blocks.find((block) => block.group === activeGroup);
    if (!lifted) return [];
    // The list has a 1px gap between items.
    const liftedHeight = lifted.bottom - lifted.top + 1;
    const center = args.collisionRect.top + args.collisionRect.height / 2;
    let slot = 0;
    for (const block of blocks) {
      if (block === lifted) continue;
      const shift = block.top > lifted.top ? liftedHeight : 0;
      if (center > (block.top + block.bottom) / 2 - shift) slot += 1;
    }
    // resolveSidebarProjectDrop moves the lifted project into the slot of
    // the header it is dropped on.
    return [{ id: sidebarListItemId({ kind: "project-header", group: blocks[slot]!.group }) }];
  };
}

/** Reject the nearest unsupported target without selecting another section.
 * Recreate this detector when drop eligibility changes. */
export function createSidebarCollisionDetection(
  isValidTarget: (id: string) => boolean,
  options: {
    items?: readonly SidebarListItem[];
    activationY?: number | null;
    /** Space each visible drag label opens (see the sorting strategy). */
    labelHeight?: number;
  } = {},
): CollisionDetection {
  const validity = new Map<string, boolean>();
  const sections = new Map<string, SidebarSection | null>();
  let previousPointerY = options.activationY;
  let boundarySection: "pinned" | "active" | undefined;
  return (args) => {
    // Droppable rects are measured at rest, but the Pinned and Active labels
    // push every row below them down while dragging. The lifted card follows
    // the pointer, so compare it against rest rects shifted back by the
    // labels above it; otherwise the drop lands a slot below the gap.
    const rect = args.collisionRect;
    const center = rect.top + rect.height / 2;
    let labelShift = 0;
    for (const marker of ["pinned-header", "pinned-divider"] as const) {
      const label = args.droppableContainers
        .find((container) => container.id === sidebarMarkerId(marker))
        ?.node.current?.querySelector(".sidebar-drag-boundary-label")
        ?.getBoundingClientRect();
      if (label && center >= label.top) labelShift += options.labelHeight ?? 0;
    }
    let collisions = closestCenter(
      labelShift === 0
        ? args
        : {
            ...args,
            collisionRect: {
              ...rect,
              top: rect.top - labelShift,
              bottom: rect.bottom - labelShift,
            },
          },
    );
    const pointer = args.pointerCoordinates;
    const items = options.items;
    const source = items?.find((item) => item.kind === "thread" && item.key === args.active.id);
    const boundary = args.droppableContainers
      .find((container) => container.id === sidebarMarkerId("pinned-divider"))
      ?.node.current?.querySelector(".sidebar-drag-boundary-label")
      ?.getBoundingClientRect();
    if (items && boundary && source?.kind === "thread" && pointer) {
      boundarySection ??= source.section === "pinned" ? "pinned" : "active";
      // Use the visible divider row, including its sortable translation.
      // Only pointer movement can change sections: opening the destination
      // moves this row, but must not toggle a stationary gesture back.
      const previousY = previousPointerY ?? pointer.y;
      previousPointerY = pointer.y;
      if (pointer.x >= boundary.left && pointer.x <= boundary.right) {
        if (pointer.y < previousY && pointer.y <= boundary.bottom) boundarySection = "pinned";
        else if (pointer.y > previousY && pointer.y >= boundary.top) boundarySection = "active";
        const nextHeader = (["working-header", "snoozed-header", "settled-header"] as const)
          .map((marker) =>
            args.droppableContainers.find((container) => container.id === sidebarMarkerId(marker)),
          )
          .find((container) => container !== undefined);
        const activeBottom = nextHeader?.node.current?.getBoundingClientRect().top;
        if (boundarySection === "pinned" || (activeBottom != null && pointer.y < activeBottom)) {
          const target = collisions.find((collision) => {
            const id = String(collision.id);
            if (!sections.has(id)) {
              sections.set(
                id,
                resolveSidebarDropTarget(items, String(args.active.id), id)?.section ?? null,
              );
            }
            return sections.get(id) === boundarySection;
          });
          if (target)
            collisions = [target, ...collisions.filter((collision) => collision !== target)];
        }
      }
    }
    const nearest = collisions[0];
    if (!nearest || nearest.id === args.active.id) {
      return collisions;
    }
    const id = String(nearest.id);
    const valid = validity.get(id) ?? isValidTarget(id);
    validity.set(id, valid);
    return valid ? collisions : collisions.filter((collision) => collision.id === args.active.id);
  };
}

function isGroupedCard(item: SidebarListItem): boolean {
  return item.kind === "thread" && item.section === "active" && item.group !== undefined;
}

/** Preview the committed section layout without moving or mounting DOM nodes.
 * A zero scaleY marks rows/markers to hide while retaining their measured nodes. */
export function createSidebarSortingStrategy(input: {
  items: readonly SidebarListItem[];
  settledOrder: readonly string[];
  /** Time-ordered inbox (Working beta): where the lifted row would land. */
  activeOrder?: readonly string[];
  settledExpanded: boolean;
  settledVisibleCount?: number;
  routeThreadKey?: string | null;
  snoozedThreadCount?: number;
  cardHeight?: number;
  slimHeight?: number;
  /** Space each pinned boundary opens for its label while dragging. The
   * markers stay zero height at rest, so nothing is reserved until pickup. */
  boundaryLabelHeight?: number;
}): SortingStrategy {
  const { items } = input;
  const indices = new Map(items.map((item, index) => [sidebarListItemId(item), index]));
  let previous: Pick<Layout, "rects" | "activeIndex" | "overIndex"> | undefined;
  let transforms: ReturnType<SortingStrategy>[] | null = [];

  // A lifted project header leaves its rows behind, collapsed, and opens its
  // slot between the other projects. Everything outside the active rows
  // keeps its place.
  function projectHeaderDrag(
    { rects, activeIndex, overIndex }: Layout,
    active: Extract<SidebarListItem, { kind: "project-header" }>,
  ) {
    const over = items[overIndex] ?? active;
    const order = resolveSidebarProjectDrop(items, active.group, sidebarListItemId(over));
    if (!order || !rects[0]) return [];
    const rowsByGroup = new Map<string, SidebarListItem[]>();
    const before: SidebarListItem[] = [];
    const after: SidebarListItem[] = [];
    for (const item of items) {
      if (item.kind === "project-header") rowsByGroup.set(item.group, []);
      else if (item.kind === "thread" && item.section === "active" && item.group !== undefined)
        rowsByGroup.get(item.group)?.push(item);
      else (rowsByGroup.size === 0 ? before : after).push(item);
    }
    const projected = [
      ...before,
      ...order.flatMap((group): SidebarListItem[] => [
        { kind: "project-header", group },
        ...(group === active.group ? [] : (rowsByGroup.get(group) ?? [])),
      ]),
      ...after,
    ];
    const result = items.map(() => hidden);
    let top = rects[0].top;
    for (const item of projected) {
      const index = indices.get(sidebarListItemId(item));
      const rect = index === undefined ? undefined : rects[index];
      if (index === undefined || !rect) continue;
      result[index] = { ...stationary, y: top - rect.top };
      top += rect.height + 1;
    }
    result[activeIndex] = stationary;
    return result;
  }

  function project(layout: Layout) {
    const { rects, activeIndex, overIndex } = layout;
    const active = items[activeIndex];
    if (active?.kind === "project-header") return projectHeaderDrag(layout, active);
    const over = items[overIndex] ?? active;
    if (active?.kind !== "thread" || !over || !rects[0]) return [];
    const target = resolveSidebarDropTarget(items, active.key, sidebarListItemId(over));
    if (!target) return [];
    const groups: Record<SidebarSection, ThreadItem[]> = {
      pinned: [],
      active: [],
      working: [],
      snoozed: [],
      settled: [],
    };
    let cardHeight = input.cardHeight;
    // Active cards under a project header are two lines instead of three.
    let groupedCardHeight: number | undefined;
    let slimHeight = input.slimHeight;
    let headerScale: number | undefined;
    for (const [index, item] of items.entries()) {
      if (item.kind === "project-header") continue;
      if (item.kind === "marker") {
        if (isShelfHeader(item)) {
          const height = rects[index]?.height;
          if (height) headerScale ??= height / 32;
        }
        continue;
      }
      if (isGroupedCard(item)) groupedCardHeight ??= rects[index]?.height;
      else if (item.section === "pinned" || item.section === "active" || item.section === "working")
        cardHeight ??= rects[index]?.height;
      else slimHeight ??= rects[index]?.height;
      if (item.key !== active.key) groups[item.section].push(item);
    }
    // Cards are 4.875rem + 0.25rem padding; slim rows/placeholders are h-9.
    const scale =
      slimHeight !== undefined ? slimHeight / 36 : (headerScale ?? (cardHeight ?? 82) / 82);
    cardHeight ??= 82 * scale;
    groupedCardHeight ??= 60 * scale;
    slimHeight ??= 36 * scale;
    const labelHeight = (input.boundaryLabelHeight ?? 0) * scale;
    const group = groups[target.section];
    const order =
      target.section === "pinned"
        ? target.pinnedOrder
        : target.section === "settled"
          ? input.settledOrder
          : (input.activeOrder ?? target.activeOrder);
    const ranks = new Map(order.map((key, index) => [key, index]));
    const rank = ranks.get(active.key) ?? Number.POSITIVE_INFINITY;
    const index = group.findIndex(
      (item) => (ranks.get(item.key) ?? Number.POSITIVE_INFINITY) > rank,
    );
    group.splice(index < 0 ? group.length : index, 0, { ...active, section: target.section });
    const settledOrder = (
      input.settledOrder.length > 0 ? input.settledOrder : groups.settled.map((item) => item.key)
    ).filter((key) => key !== active.key || target.section === "settled");
    const visible = input.settledExpanded
      ? settledOrder.slice(0, input.settledVisibleCount ?? settledOrder.length)
      : [];
    const routeKey = input.routeThreadKey;
    if (routeKey && settledOrder.includes(routeKey) && !visible.includes(routeKey)) {
      visible.push(routeKey);
    }
    groups.settled = visible.map((key) => ({ kind: "thread", key, section: "settled" }));
    const projected: SidebarListItem[] = [];
    const marker = (name: SidebarListMarker) => projected.push({ kind: "marker", marker: name });
    // Grouped active rows follow the clustered drop order. Headers only exist
    // for groups that had rows at pickup: a row moving into a new group gets
    // its header once the drop lands.
    const withProjectHeaders = (rows: readonly ThreadItem[]) => {
      const activeRanks = new Map(target.activeOrder.map((key, index) => [key, index]));
      const rank = (row: ThreadItem) => activeRanks.get(row.key) ?? Number.POSITIVE_INFINITY;
      const result: SidebarListItem[] = [];
      let group: string | undefined;
      for (const row of rows.toSorted((left, right) => rank(left) - rank(right))) {
        if (row.group !== undefined && row.group !== group) {
          const header: SidebarListItem = { kind: "project-header", group: row.group };
          if (indices.has(sidebarListItemId(header))) result.push(header);
        }
        group = row.group;
        result.push(row);
      }
      return result;
    };
    const section = (name: "active" | "settled") => {
      if (groups[name].length === 0) marker(`${name}-placeholder`);
      else if (name === "active" && target.activeGroupOrder !== undefined)
        projected.push(...withProjectHeaders(groups.active));
      else projected.push(...groups[name]);
    };
    marker("pinned-header");
    projected.push(...groups.pinned);
    marker("pinned-divider");
    section("active");
    if (items.some((item) => item.kind === "marker" && item.marker === "working-header")) {
      marker("working-header");
      projected.push(...groups.working);
    }
    if (
      groups.snoozed.length > 0 ||
      ((active.section !== "snoozed" || (input.snoozedThreadCount ?? 0) > 1) &&
        items.some((item) => item.kind === "marker" && item.marker === "snoozed-header"))
    ) {
      marker("snoozed-header");
      projected.push(...groups.snoozed);
    }
    marker("settled-header");
    section("settled");
    const heights = projected.map((item) => {
      const index = indices.get(sidebarListItemId(item));
      const rect = index === undefined ? undefined : rects[index];
      const fallback = isGroupedCard(item)
        ? groupedCardHeight
        : item.kind === "thread" &&
            (item.section === "pinned" || item.section === "active" || item.section === "working")
          ? cardHeight
          : slimHeight;
      const moved = item.kind === "thread" && item.key === active.key;
      return item.kind === "marker" &&
        (item.marker === "pinned-header" || item.marker === "pinned-divider")
        ? labelHeight
        : item.kind === "marker" && item.marker.endsWith("placeholder")
          ? slimHeight
          : moved
            ? fallback
            : (rect?.height ?? fallback);
    });
    const firstShelf = items.findIndex(isShelfHeader);
    const shelfRect = rects[firstShelf];
    const beforeShelf = rects[firstShelf - 1];
    const lastRect = rects.at(-1);
    // Consume the shelf's auto margin as drag labels and resized rows need
    // room, keeping the combined shelves at their measured bottom.
    let shelfSpace =
      shelfRect && beforeShelf && lastRect && shelfRect.top > beforeShelf.bottom + 1
        ? Math.max(
            0,
            lastRect.bottom - rects[0].top - heights.reduce((sum, height) => sum + height + 1, -1),
          )
        : 0;
    const result = items.map(() => hidden);
    let top = rects[0].top;
    for (const [projectedIndex, item] of projected.entries()) {
      if (isShelfHeader(item)) {
        top += shelfSpace;
        shelfSpace = 0;
      }
      const index = indices.get(sidebarListItemId(item));
      const rect = index === undefined ? undefined : rects[index];
      if (index !== undefined && rect) result[index] = { ...stationary, y: top - rect.top };
      top += heights[projectedIndex]! + 1;
    }
    result[activeIndex] = stationary;
    return result;
  }

  return (args) => {
    if (
      previous?.rects !== args.rects ||
      previous.activeIndex !== args.activeIndex ||
      previous.overIndex !== args.overIndex
    ) {
      previous = args;
      transforms = project(args);
    }
    return transforms === null
      ? verticalListSortingStrategy(args)
      : (transforms[args.index] ?? stationary);
  };
}
