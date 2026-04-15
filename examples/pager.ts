#!/usr/bin/env bun
// Paginated list — drive a long list through the pager utility.
//
// Why paging instead of scrolling: the G2's two lenses aren't perfectly
// synced, so animated scrolls tick one arm a frame before the other and
// the mismatch is physically uncomfortable (headache trigger for some
// users). Instant page swaps skip the animation entirely.
//
// Side benefit: the firmware owns scrolling on-device but SCROLL_TOP /
// SCROLL_BOTTOM events don't fire on user-driven scroll, only on taps,
// so even with synced lenses we'd still need nav rows to react to it.
// g2-kit/ui/pager.ts injects "▲ Prev page" / "▼ Next page" rows and
// tells you the viewport indices so you can map taps back.
//
//     bun examples/pager.ts
//
// Tap a content row to print it. Tap ▲/▼ to change page. Tap "exit" to quit.

import {
  G2Session,
  buildCreateStartUpPageContainer,
  buildUpdateListContainer,
} from "g2-kit/ble";
import {
  startHeartbeat,
  buildPagerView,
  pagerResolveTap,
  pagerScroll,
  createPagerState,
  type PagerState,
} from "g2-kit/ui";

// A long list that won't fit on one page.
const ITEMS = [
  ...Array.from({ length: 20 }, (_, i) => `item ${i + 1}`),
  "exit",
];

const NAME = "pager-demo";

let magic = 100;
const nextMagic = () => (magic = magic >= 255 ? 100 : magic + 1);

const session = await G2Session.open();
const state: PagerState = createPagerState(ITEMS);

async function pushPage(): Promise<void> {
  state.view = buildPagerView(state.items, state.offset);
  const rendered = state.view.rendered;
  if (!firstCreateDone) {
    const create = buildCreateStartUpPageContainer({
      name: NAME,
      items: rendered,
      magic: nextMagic(),
    });
    await session.sendPb(0xe0, create.pb, create.magic);
    firstCreateDone = true;
  }
  const rebuild = buildUpdateListContainer({
    name: NAME,
    items: rendered,
    width: 576,
    height: 288,
    magic: nextMagic(),
  });
  await session.sendPb(0xe0, rebuild.pb, rebuild.magic);
  console.log(
    `rendered ${rendered.length} rows (offset=${state.offset})  up=${state.view.upIdx} down=${state.view.downIdx}`,
  );
}

let firstCreateDone = false;
await pushPage();
const hb = startHeartbeat({ session, nextMagic });

session.onEvent(async (ev) => {
  if (ev.kind !== "list-click") return;
  if (ev.containerName !== NAME) return;
  const action = pagerResolveTap(state.view, ev.itemIndex);
  if (!action) return;
  switch (action.kind) {
    case "prev":
      pagerScroll(state, "up");
      await pushPage();
      return;
    case "next":
      pagerScroll(state, "down");
      await pushPage();
      return;
    case "content": {
      const label = state.items[action.index] ?? "?";
      console.log(`→ picked "${label}" (full-list index ${action.index})`);
      if (label === "exit") {
        hb.stop();
        await session.close();
        process.exit(0);
      }
    }
  }
});

await new Promise(() => {});
