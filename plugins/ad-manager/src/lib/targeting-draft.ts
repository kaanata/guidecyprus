/**
 * Editor state for one targeting list. Stored ads use an empty list for "everywhere";
 * the editor keeps `all` separately so an admin can untick All before picking items.
 */
export interface Choice<T extends string = string> {
  all: boolean;
  picked: T[];
}

export const choiceFromList = <T extends string>(list: T[] | undefined): Choice<T> =>
  list && list.length > 0 ? { all: false, picked: list } : { all: true, picked: [] };

export const choiceToList = <T extends string>(choice: Choice<T>): T[] => (choice.all ? [] : choice.picked);

export const toggleChoice = <T extends string>(choice: Choice<T>, item: T): Choice<T> => ({
  all: false,
  picked: choice.picked.includes(item) ? choice.picked.filter((x) => x !== item) : [...choice.picked, item],
});

const EMPTY_MESSAGES = {
  pageTypes: "Pick at least one page, or tick All pages",
  competitions: "Pick at least one competition, or tick All competitions",
  countries: "Pick at least one country, or tick All countries",
} as const;

export function emptyChoiceErrors(choices: Record<keyof typeof EMPTY_MESSAGES, Choice>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const key of Object.keys(EMPTY_MESSAGES) as Array<keyof typeof EMPTY_MESSAGES>) {
    if (!choices[key].all && choices[key].picked.length === 0) errors[`targeting.${key}`] = EMPTY_MESSAGES[key];
  }
  return errors;
}
