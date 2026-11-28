import type { Locator } from '@playwright/test';

/**
 * How many lines each element's text is set on, as `[text, lines]` sorted by text. The lines are counted from
 * the boxes the browser set the text in (a Range's client rectangles, one or more on each line), so the count
 * reads the page as drawn rather than any style rule. It waits for the page's fonts first: until they load, a
 * fallback face sets the text at other widths.
 */
export async function linesOf(texts: Locator): Promise<(readonly [string, number])[]> {
  const counted = await texts.evaluateAll(async (els) => {
    await document.fonts.ready;
    return els.map((e): [string, number] => {
      const range = document.createRange();
      range.selectNodeContents(e);
      const placed = [...range.getClientRects()].filter((r) => r.width > 0).sort((a, b) => a.top - b.top);
      // Boxes on one line share their top; a box that starts below the middle of the line before starts a new line.
      let lines = 0;
      let nextLineFrom = -Infinity;
      for (const r of placed) {
        if (r.top >= nextLineFrom) {
          lines += 1;
          nextLineFrom = r.top + r.height / 2;
        }
      }
      return [e.textContent ?? '', lines];
    });
  });
  return counted.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
