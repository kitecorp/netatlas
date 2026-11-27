import type { Locator } from '@playwright/test';

/**
 * Puts a token in a field without a step that names it. Playwright titles each action by its values
 * (`Fill "{value}"`, `Type "{text}"`, `Press "{key}"`), and the HTML report CI uploads keeps every step
 * title; an `Evaluate` step carries no argument in its title. React keeps the value it last set, so the
 * input's own setter is used and an input event tells React the field changed.
 */
export async function fillSecret(field: Locator, value: string): Promise<void> {
  await field.evaluate((element, secret) => {
    const input = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, secret);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

/** Whether a field is empty, as a boolean, so a failing check prints no token. */
export const isEmpty = async (field: Locator): Promise<boolean> => (await field.inputValue()) === '';
