import { describe, expect, it } from "vite-plus/test";
import { resolveChatCanvasLayout, type ChatCanvasPreview } from "./chatCanvasLayout";
import { resizePreviewMiniPlayer } from "../preview/previewMiniPlayerLayout";
import {
  resolveThreadDetailsCardDensity,
  resolveThreadDetailsCardLayout,
} from "./threadDetailsCardLayout";

const preview: ChatCanvasPreview = {
  key: "browser:one",
  width: 320,
  position: null,
  source: { width: 1600, height: 1000 },
};
const resolve = (width: number, player: ChatCanvasPreview | null = preview, height = 900) =>
  resolveChatCanvasLayout({ container: { width, height }, preview: player, composerHeight: 180 });
const expectClear = (result: ReturnType<typeof resolve>) => {
  const frame = result.frame!;
  const chat = result.chat;
  expect(frame.x + frame.width <= chat.left - 12 || frame.x >= chat.left + chat.width + 12).toBe(
    true,
  );
};

describe("chat canvas layout", () => {
  it("keeps a growing preview above the composer once it reaches the chat lane", () => {
    const centered = resolve(1344, null).chat;
    for (let width = 480; width <= 1100; width++) {
      const result = resolve(1344, {
        ...preview,
        width,
        lastInteraction: "resize",
        position: { x: 1332 - width, y: 888 - Math.round(width / 1.6) },
      });
      const frame = result.frame!;
      expect(result.chat).toEqual(centered);
      if (frame.x < centered.left + centered.width) {
        expect(frame.y + frame.height).toBeLessThanOrEqual(708);
      }
    }
  });

  it("centers chat in the whole container without a preview", () => {
    expect(resolve(1344, null).chat).toEqual({ left: 288, width: 768, insetStart: 0, insetEnd: 0 });
    expect(
      resolveChatCanvasLayout({
        container: { width: 390, height: 900 },
        preview: null,
        padding: 12,
      }).chat,
    ).toEqual({ left: 12, width: 366, insetStart: 0, insetEnd: 0 });
  });
  it("does not move chat when a bottom-right preview fits in its margin", () => {
    const result = resolve(1600);
    expect(result.chat.insetEnd).toBe(0);
    expect(result.frame!.y + result.frame!.height).toBe(888);
    expectClear(result);
  });
  it("never moves or narrows chat for a preview", () => {
    for (const width of [1000, 1200, 1344, 1800]) {
      const centered = resolve(width, null).chat;
      for (const player of [
        preview,
        { ...preview, width: 480 },
        { ...preview, position: { x: 12, y: 100 }, lastInteraction: "drag" as const },
        { ...preview, width: 600, position: { x: 300, y: 12 }, lastInteraction: "resize" as const },
      ]) {
        expect(resolve(width, player).chat).toEqual(centered);
      }
    }
  });
  it.each([900, 1000, 1004])("allows dragging across a %spx chat canvas", (width) => {
    const start = resolve(width, { ...preview, position: { x: width - 332, y: 200 } }).frame!;
    const moved = resolve(width, {
      ...preview,
      position: { x: start.x - 300, y: start.y },
      lastInteraction: "drag",
    });
    expect(moved.frame).toEqual({ ...start, x: start.x - 300 });
    const returned = resolve(width, {
      ...preview,
      position: { x: start.x, y: start.y },
      lastInteraction: "drag",
    });
    expect(returned.frame).toEqual(start);
  });
  it("drags over the messages to the canvas edge", () => {
    expect(resolve(1344, { ...preview, position: { x: 12, y: 100 } }).frame).toMatchObject({
      x: 12,
      y: 100,
    });
    expect(resolve(1344, { ...preview, position: { x: 500, y: 300 } }).frame).toMatchObject({
      x: 500,
      y: 300,
    });
  });
  it("keeps a dragged player above the composer when no readable lane fits beside it", () => {
    const result = resolve(1000, { ...preview, position: { x: 12, y: 700 } });
    expect(result.chat).toEqual(resolve(1000, null).chat);
    expect(result.frame!.x).toBe(12);
    expect(result.frame!.y + result.frame!.height).toBeLessThanOrEqual(708);
  });
  it("allows message overlap on narrow screens while excluding the composer", () => {
    const result = resolve(1000);
    expect(result.chat.insetStart).toBe(0);
    expect(result.chat.insetEnd).toBe(0);
    expect(result.frame!.y + result.frame!.height).toBeLessThanOrEqual(900 - 180 - 12);
    expect(result.frame!.width / result.frame!.height).toBeCloseTo(1.6);
  });
  it("follows the pointer over the composer while dragging and settles clear of it when dropped", () => {
    const position = { x: 500, y: 650 };
    const dragging = resolve(1344, {
      ...preview,
      position,
      lastInteraction: "drag",
      dragging: true,
    });
    expect(dragging.frame).toMatchObject(position);
    expect(dragging.overlapsDetailsCard).toBe(false);
    const dropped = resolve(1344, { ...preview, position, lastInteraction: "drag" }).frame!;
    expect(dropped.x).toBe(500);
    expect(dropped.y + dropped.height).toBe(900 - 180 - 12);
  });

  it("moves a dropped player continuously as it crosses the gap above the composer", () => {
    for (const x of [500, 1012]) {
      let previous: number | undefined;
      for (let y = 450; y <= 700; y++) {
        const frame = resolve(1344, { ...preview, position: { x, y } }).frame!;
        if (previous !== undefined) expect(Math.abs(frame.y - previous)).toBeLessThanOrEqual(1);
        previous = frame.y;
      }
    }
  });

  it("lifts a preview beside the composer only while it overlaps the composer", () => {
    const over = resolve(1344, { ...preview, position: { x: 900, y: 888 } });
    expect(over.frame!.y + over.frame!.height).toBe(900 - 180 - 12);
    const beside = resolve(1600, { ...preview, position: { x: 1268, y: 888 } });
    expect(beside.frame!.y + beside.frame!.height).toBe(888);
  });
  it("constrains a dragged preview below the full top-right card instead of folding it", () => {
    const result = resolveChatCanvasLayout({
      container: { width: 1584, height: 988 },
      maxChatWidth: 736,
      composerHeight: 180,
      detailsCard: { left: 1260, right: 1572, bottom: 339 },
      preview: {
        ...preview,
        width: 240,
        source: { width: 240, height: 365 },
        position: { x: 1260, y: 240 },
      },
    });
    expect(result.frame).toEqual({ x: 1260, y: 351, width: 240, height: 365 });
    expect(result.overlapsDetailsCard).toBe(false);
    expect(result.chat).toEqual({ left: 424, width: 736, insetStart: 0, insetEnd: 0 });
  });
  it("keeps a dragged or resized preview below the open find bar", () => {
    const findBar = { left: 1292, right: 1572, bottom: 48 };
    const layout = (lastInteraction: "drag" | "resize") =>
      resolveChatCanvasLayout({
        container: { width: 1584, height: 988 },
        maxChatWidth: 736,
        composerHeight: 180,
        findBar,
        preview: {
          ...preview,
          width: 240,
          source: { width: 240, height: 365 },
          position: { x: 1332, y: 12 },
          lastInteraction,
        },
      });
    for (const lastInteraction of ["drag", "resize"] as const) {
      const result = layout(lastInteraction);
      expect(result.frame).toEqual({ x: 1332, y: 60, width: 240, height: 365 });
      expect(result.overlapsDetailsCard).toBe(false);
      expect(result.chat).toEqual({ left: 424, width: 736, insetStart: 0, insetEnd: 0 });
    }
  });
  it("keeps a preview clear of a find bar wider than the inline details card", () => {
    const result = resolveChatCanvasLayout({
      container: { width: 1800, height: 1000 },
      findBar: { left: 1362, right: 1782, bottom: 72 },
      detailsCard: { left: 1508, right: 1788, bottom: 400 },
      preview: {
        ...preview,
        width: 240,
        source: { width: 240, height: 365 },
        position: { x: 1200, y: 12 },
        lastInteraction: "drag",
      },
    });
    const frame = result.frame!;
    expect(frame.x + frame.width <= 1362 || frame.y >= 84).toBe(true);
    expect(result.overlapsDetailsCard).toBe(false);
  });
  it("uses space beside the full card if a tall preview cannot fit below it", () => {
    const result = resolveChatCanvasLayout({
      container: { width: 1584, height: 988 },
      maxChatWidth: 736,
      composerHeight: 180,
      detailsCard: { left: 1260, right: 1572, bottom: 339 },
      preview: {
        ...preview,
        width: 240,
        source: { width: 240, height: 700 },
        position: { x: 1260, y: 100 },
      },
    });
    expect(result.frame).toMatchObject({ x: 1008, width: 240, height: 700 });
    expect(result.frame!.y + 700).toBeLessThanOrEqual(988 - 180 - 12);
    expect(result.overlapsDetailsCard).toBe(false);
  });
  describe("resizing beside the composer and the details card", () => {
    const container = { width: 1584, height: 988 };
    const source = { width: 1000, height: 1523 };
    const detailsCard = { left: 1260, right: 1572, bottom: 339 };
    const layout = (
      direction: "west" | "north",
      startY: number,
      width: number,
    ): ReturnType<typeof resolveChatCanvasLayout> => {
      const base = resolveChatCanvasLayout({
        container,
        maxChatWidth: 736,
        composerHeight: 206,
        detailsCard,
        preview: null,
      });
      const resized = resizePreviewMiniPlayer({
        start: { x: 1332, y: startY, width: 240, height: 365 },
        direction,
        delta: { x: 240 - width, y: ((240 - width) * source.height) / source.width },
        container,
        source,
        obstacles: base.resizeObstacles,
      });
      return resolveChatCanvasLayout({
        container,
        maxChatWidth: 736,
        composerHeight: 206,
        detailsCard,
        preview: {
          ...preview,
          width: resized.width,
          position: resized,
          source,
          lastInteraction: "resize",
        },
      });
    };
    const density = (result: ReturnType<typeof resolveChatCanvasLayout>) => {
      const card = resolveThreadDetailsCardLayout({
        container,
        lane: { padding: 48, minChatWidth: 640 },
        frame: result.frame,
        overlapsDetailsCard: result.overlapsDetailsCard,
      });
      return card
        ? resolveThreadDetailsCardDensity(card.height, { full: 327, compact: 182 })
        : "hidden";
    };

    it.each(["west", "north"] as const)(
      "stops a %s resize at the composer instead of lifting the player over it",
      (direction) => {
        const composerTop = 988 - 206;
        let previous = layout(direction, 611, 240);
        for (let width = 260; width <= 700; width += 20) {
          const result = layout(direction, 611, width);
          const frame = result.frame!;
          expect(frame.x).toBeGreaterThanOrEqual(1160 + 12);
          expect(frame.x + frame.width).toBe(1572);
          expect(frame.y + frame.height).toBeGreaterThan(composerTop);
          expect(Math.abs(frame.y - previous.frame!.y)).toBeLessThanOrEqual(40);
          expect(density(result)).toBe("full");
          previous = result;
        }
      },
    );

    it("folds the card as a resize above the composer grows into it", () => {
      const order = ["full", "compact", "essential", "hidden"];
      let previous = 0;
      for (let width = 240; width <= 420; width += 10) {
        const result = layout("north", 360, width);
        expect(Math.abs(result.frame!.y + result.frame!.height - 725)).toBeLessThanOrEqual(1);
        const rank = order.indexOf(density(result));
        expect(rank).toBeGreaterThanOrEqual(previous);
        previous = rank;
      }
      expect(density(layout("north", 360, 240))).toBe("full");
      expect(previous).toBe(order.indexOf("hidden"));
    });
  });
  it("requests card folding only when no full-card slot fits and keeps the composer clear", () => {
    const result = resolveChatCanvasLayout({
      container: { width: 1584, height: 988 },
      maxChatWidth: 736,
      composerHeight: 180,
      detailsCard: { left: 1260, right: 1572, bottom: 600 },
      preview: {
        ...preview,
        width: 1300,
        source: { width: 1300, height: 400 },
        position: { x: 12, y: 12 },
      },
    });
    expect(result.overlapsDetailsCard).toBe(true);
    expect(result.frame).toEqual({ x: 12, y: 396, width: 1300, height: 400 });
  });
});

describe("workspace card beside chat", () => {
  const withCard = (width: number, player: ChatCanvasPreview | null = null, maxChatWidth = 736) =>
    resolveChatCanvasLayout({
      container: { width, height: 900 },
      maxChatWidth,
      composerHeight: 180,
      detailsCard: { left: width - 292, right: width - 12, bottom: 400 },
      preview: player,
    });
  it("keeps chat centered while the card fits beside it", () => {
    expect(withCard(1384).chat).toEqual({ left: 324, width: 736, insetStart: 0, insetEnd: 0 });
  });
  it("moves chat left only as far as the card requires", () => {
    expect(withCard(1383).chat).toEqual({ left: 323, width: 736, insetStart: 0, insetEnd: 1 });
    expect(withCard(1147).chat).toEqual({ left: 87, width: 736, insetStart: 0, insetEnd: 237 });
  });
  it("narrows chat only after it reaches the left padding", () => {
    expect(withCard(1108).chat).toMatchObject({ left: 48, width: 736 });
    expect(withCard(1028).chat).toEqual({ left: 48, width: 656, insetStart: 0, insetEnd: 276 });
    expect(withCard(1012).chat).toMatchObject({ left: 48, width: 640 });
  });
  it("reserves the marker gutter across widths where the details card fits", () => {
    for (let width = 1012; width <= 1440; width++) {
      const container = { width, height: 900 };
      const card = resolveThreadDetailsCardLayout({
        container,
        lane: { padding: 48, minChatWidth: 640 },
        frame: null,
      })!;
      const chat = withCard(width).chat;
      expect(chat.left).toBeGreaterThanOrEqual(48);
      expect(chat.width).toBeGreaterThanOrEqual(640);
      expect(card.x - chat.left - chat.width).toBeGreaterThanOrEqual(32);
    }
  });
  it("keeps a full-width chat clear of the card", () => {
    expect(withCard(1147, null, 10_000).chat).toEqual({
      left: 48,
      width: 775,
      insetStart: 0,
      insetEnd: 276,
    });
  });
  it("keeps centered chat in place when a new preview opens below the card", () => {
    expect(withCard(1440, preview)).toEqual({
      chat: { left: 352, width: 736, insetStart: 0, insetEnd: 0 },
      frame: { x: 1108, y: 688, width: 320, height: 200 },
      overlapsDetailsCard: false,
      resizeObstacles: { composer: { left: 352, right: 1088, height: 180 }, detailsCard: null },
    });
  });
});
