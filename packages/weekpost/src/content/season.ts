// Season of the year for an account's hemisphere. Meteorological seasons by month (north: Mar-May spring,
// Jun-Aug summer, Sep-Nov autumn, Dec-Feb winter), with no equinox or solstice dates: a post talks about the
// season of the whole month, not of the 21st. In the south the seasons are shifted by six months.
export const SEASONS = ["spring", "summer", "autumn", "winter"] as const;
export type Season = (typeof SEASONS)[number];
export type Hemisphere = "north" | "south";

// Index = month (0 = January) in the northern hemisphere.
const NORTH: Season[] = ["winter", "winter", "spring", "spring", "spring", "summer", "summer", "summer", "autumn", "autumn", "autumn", "winter"];

// The next season (spring -> summer -> autumn -> winter -> spring).
export const nextSeason = (s: Season): Season => SEASONS[(SEASONS.indexOf(s) + 1) % SEASONS.length];

// `date` is YYYY-MM-DD.
export function seasonFor(date: string, hemisphere: Hemisphere): Season {
  const month = Number(date.slice(5, 7)) - 1;
  return NORTH[hemisphere === "south" ? (month + 6) % 12 : month];
}
