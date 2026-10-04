/**
 * Energy expenditure estimates.
 *   Active minutes: Keytel et al. (2005), J Sports Sci 23(3):289-297, HR-based
 *     male:   EE (kJ/min) = -55.0969 + 0.6309 HR + 0.1988 W + 0.2017 A
 *     female: EE (kJ/min) = -20.4022 + 0.4472 HR - 0.1263 W + 0.074 A
 *   Resting: Mifflin-St Jeor (1990) BMR, kcal/day
 *     10 W + 6.25 H - 5 A + 5 (male) / - 161 (female)
 * The Keytel equation is only valid during exercise, so it is applied when HR
 * is in the active range and BMR covers the rest of the day.
 */

export interface EnergyProfile {
  sex: 'male' | 'female';
  age: number;
  weightKg: number;
  heightCm: number;
}

export const KJ_PER_KCAL = 4.184;

export function keytelKcalPerMinute(hr: number, profile: EnergyProfile): number {
  const kj =
    profile.sex === 'male'
      ? -55.0969 + 0.6309 * hr + 0.1988 * profile.weightKg + 0.2017 * profile.age
      : -20.4022 + 0.4472 * hr - 0.1263 * profile.weightKg + 0.074 * profile.age;
  return Math.max(0, kj / KJ_PER_KCAL);
}

export function mifflinBmrKcalPerDay(profile: EnergyProfile): number {
  const base = 10 * profile.weightKg + 6.25 * profile.heightCm - 5 * profile.age;
  return base + (profile.sex === 'male' ? 5 : -161);
}

/**
 * Daily energy: BMR for the whole period plus, for each active sample
 * (HR >= activeThreshold), the Keytel rate in excess of BMR.
 */
export function energyKcal(
  samples: ReadonlyArray<{ t: number; hr: number }>,
  periodMs: number,
  profile: EnergyProfile,
  activeThresholdHr: number,
  maxGapMs = 10_000,
): number {
  const bmrPerMinute = mifflinBmrKcalPerDay(profile) / 1440;
  let kcal = bmrPerMinute * (periodMs / 60_000);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    if (s.hr < activeThresholdHr) continue;
    const next = samples[i + 1];
    const dtMin = Math.min(next ? next.t - s.t : 1000, maxGapMs) / 60_000;
    kcal += Math.max(0, keytelKcalPerMinute(s.hr, profile) - bmrPerMinute) * dtMin;
  }
  return kcal;
}
