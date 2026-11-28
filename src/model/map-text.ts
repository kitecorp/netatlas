/**
 * The width of one of the map's small texts, an edge label or a namespace box's title. Both are set at
 * 12 px in JetBrains Mono (globals.css), whose every character is 0.6 em wide, so the width follows from
 * the count of characters. The layout sizes the namespace boxes with it on the server, where no text can
 * be measured, and the label spots use it for the same texts.
 */
export const textWidth = (text: string): number => text.length * 7.2;

/**
 * Where a namespace box's title sits in the box: 16 px in, 12 px down, on one line 16 px tall. The one place it
 * is written: the map places the title's node with it (`NamespaceTitle`), the layout makes the box as wide as the
 * title with the same room each side, and the label spots keep the labels off it.
 */
export const NAMESPACE_TITLE = { left: 16, top: 12, lineHeight: 16 } as const;

/** A namespace box's title in its box: its place, from the box's top left corner, and its size, one line of its text. */
export const namespaceTitleBox = (title: string) => ({ x: NAMESPACE_TITLE.left, y: NAMESPACE_TITLE.top, width: textWidth(title), height: NAMESPACE_TITLE.lineHeight }) as const;
