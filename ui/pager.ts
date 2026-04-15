// Bridge-side list pagination for the G2 ListContainer.
//
// Why pagination instead of scrolling: the G2's two lenses aren't perfectly
// synchronized, so one arm's display ticks a frame before the other during
// animated scrolls. The resulting mismatch is physically uncomfortable for
// some users (and a headache trigger) — paging with instant frame swaps
// skips the animation entirely and avoids the desync window.
//
// Technical side benefit: the firmware owns cursor + scrolling on-device,
// but SCROLL_TOP / SCROLL_BOTTOM events only fire reliably on real taps,
// not on user-driven scrolling, so even if the lenses were synced you
// couldn't react to scroll reliably. We inject explicit "▲ Prev" / "▼ Next"
// nav rows into the list we push and map tap viewport indices back to
// either a content row or one of those nav rows.
//
// This module is pure: it takes a full list of strings and an offset, and
// returns the rendered slice plus the viewport indices of the injected nav
// rows (or -1 if not present on this page).

export const LIST_PAGE_SIZE = 6;
export const NAV_PREV_LABEL = "▲ Prev page";
export const NAV_NEXT_LABEL = "▼ Next page";

export type PagerView = {
  /** Rows to actually push to the list container, nav rows included. */
  rendered: string[];
  /** Viewport index of the ▲ Prev row, or -1 if not present on this page. */
  upIdx: number;
  /** Viewport index of the ▼ Next row, or -1 if not present on this page. */
  downIdx: number;
  /** Offset (into the full items list) of the first content row on this page. */
  contentStart: number;
  /** Exclusive offset (into the full items list) of the last content row. */
  contentEnd: number;
};

export type PagerState = {
  items: string[];
  offset: number;
  history: number[];
  view: PagerView;
};

/**
 * Compute the view to render for a given full list + offset. Reserves nav-row
 * slots inside `pageSize`: ▼ takes one slot on every non-last page, ▲ takes
 * one slot on every non-first page.
 */
export function buildPagerView(
  fullItems: string[],
  offset: number,
  pageSize: number = LIST_PAGE_SIZE,
): PagerView {
  const total = fullItems.length;
  if (total <= pageSize) {
    return {
      rendered: fullItems.slice(),
      upIdx: -1,
      downIdx: -1,
      contentStart: 0,
      contentEnd: total,
    };
  }
  const hasUp = offset > 0;
  let contentBudget = pageSize - (hasUp ? 1 : 0) - 1;
  let contentEnd = Math.min(total, offset + contentBudget);
  let hasDown = contentEnd < total;
  if (!hasDown) {
    contentBudget = pageSize - (hasUp ? 1 : 0);
    contentEnd = Math.min(total, offset + contentBudget);
  }
  const rendered: string[] = [];
  let upIdx = -1;
  let downIdx = -1;
  if (hasUp) {
    upIdx = rendered.length;
    rendered.push(NAV_PREV_LABEL);
  }
  for (let i = offset; i < contentEnd; i++) rendered.push(fullItems[i]!);
  if (hasDown) {
    downIdx = rendered.length;
    rendered.push(NAV_NEXT_LABEL);
  }
  return { rendered, upIdx, downIdx, contentStart: offset, contentEnd };
}

/**
 * Create a fresh pager state for a new full item list. Starts at page 0.
 */
export function createPagerState(
  items: string[],
  pageSize: number = LIST_PAGE_SIZE,
): PagerState {
  return {
    items,
    offset: 0,
    history: [],
    view: buildPagerView(items, 0, pageSize),
  };
}

/**
 * Shift the pager one page forward or backward. "down" uses the current
 * view's contentEnd so it respects variable content-per-page caused by nav
 * slots. "up" pops the history stack so back navigation lands exactly where
 * we came from. Returns `true` if the pager moved.
 */
export function pagerScroll(
  state: PagerState,
  dir: "up" | "down",
  pageSize: number = LIST_PAGE_SIZE,
): boolean {
  if (state.items.length <= pageSize) return false;
  if (dir === "down") {
    if (state.view.downIdx === -1) return false;
    state.history.push(state.offset);
    state.offset = state.view.contentEnd;
  } else {
    if (state.view.upIdx === -1) return false;
    const prev = state.history.pop();
    state.offset = prev ?? 0;
  }
  state.view = buildPagerView(state.items, state.offset, pageSize);
  return true;
}

/**
 * Map a viewport-row index (what the firmware reports on a list-click) back
 * to either a full-list content index or one of the nav buttons. Returns
 * `{kind: "content", index: <full-list index>}`, `{kind: "prev"}`,
 * `{kind: "next"}`, or `null` if the viewport index is out of range.
 */
export function pagerResolveTap(
  view: PagerView,
  viewportIdx: number,
):
  | { kind: "content"; index: number }
  | { kind: "prev" }
  | { kind: "next" }
  | null {
  if (viewportIdx < 0 || viewportIdx >= view.rendered.length) return null;
  if (viewportIdx === view.upIdx) return { kind: "prev" };
  if (viewportIdx === view.downIdx) return { kind: "next" };
  // Content rows live between the nav rows. Subtract however many nav rows
  // came before this one.
  let contentOffset = viewportIdx;
  if (view.upIdx !== -1 && view.upIdx < viewportIdx) contentOffset -= 1;
  if (view.downIdx !== -1 && view.downIdx < viewportIdx) contentOffset -= 1;
  return { kind: "content", index: view.contentStart + contentOffset };
}
