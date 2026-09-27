import { choiceFromList, choiceToList, emptyChoiceErrors, toggleChoice } from "../src/lib/targeting-draft";

describe("targeting choices", () => {
  it("reads an empty stored list as All", () => {
    expect(choiceFromList([])).toEqual({ all: true, picked: [] });
    expect(choiceFromList(undefined)).toEqual({ all: true, picked: [] });
    expect(choiceFromList(["TR"])).toEqual({ all: false, picked: ["TR"] });
  });

  it("saves All as an empty list and keeps picks otherwise", () => {
    expect(choiceToList({ all: true, picked: ["TR"] })).toEqual([]);
    expect(choiceToList({ all: false, picked: ["TR", "GB"] })).toEqual(["TR", "GB"]);
  });

  it("toggles one item on and off", () => {
    expect(toggleChoice({ all: false, picked: ["TR"] }, "GB")).toEqual({ all: false, picked: ["TR", "GB"] });
    expect(toggleChoice({ all: false, picked: ["TR", "GB"] }, "TR")).toEqual({ all: false, picked: ["GB"] });
  });

  it("flags a section with All unticked and nothing picked", () => {
    const all = { all: true, picked: [] };
    const none = { all: false, picked: [] };
    expect(emptyChoiceErrors({ pageTypes: all, competitions: all, countries: all })).toEqual({});
    expect(emptyChoiceErrors({ pageTypes: none, competitions: all, countries: none })).toEqual({
      "targeting.pageTypes": "Pick at least one page, or tick All pages",
      "targeting.countries": "Pick at least one country, or tick All countries",
    });
  });
});
