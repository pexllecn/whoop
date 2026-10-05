/**
 * OpenPulse Recovery (0-100 %), an estimate computed locally from overnight
 * autonomic markers relative to the user's own 30-day baselines. It is not
 * WHOOP's proprietary Recovery score.
 *
 *   Z_HRV = (lnRMSSD_today - mu_lnRMSSD) / sigma_lnRMSSD
 *   Z_RHR = (mu_RHR - RHR_today) / sigma_RHR          (inverted: lower RHR is better)
 *   core  = 0.65 Z_HRV + 0.35 Z_RHR                  (HRV only, weight 1, if RHR is missing)
 *   sleep = 0.4 * clamp((SleepPerformance - 85) / 15, -2, 1)
 *   resp  = 0.3 * max(0, Z_resp - 1.5)               capped at 1.0  (acute rise only)
 *   temp  = 1.2 * max(0, dTemp - 0.3 C)              capped at 1.5  (acute rise only)
 *   composite = core + sleep - resp - temp
 *   Recovery  = 100 / (1 + exp(-(a + b * composite)))
 *
 * a = ln(67/33) so a night exactly at baseline (composite 0) scores 67 %, the
 * bottom of the green band; b = 0.944 places composite -1.5 at 33 % (top of
 * red) and +1.5 at ~89 %. HRV is used in log form because RMSSD is log-normal
 * (Plews et al., 2012); the spec's z-score definition is otherwise unchanged.
 */
import { CALIBRATION_NIGHTS, type Baseline, zScore } from './baseline';
import { clamp } from './stats';

export const RECOVERY_SIGMOID_A = Math.log(67 / 33);
export const RECOVERY_SIGMOID_B = 0.944;
export const RECOVERY_WEIGHTS = { hrv: 0.65, rhr: 0.35, sleep: 0.4, resp: 0.3, temp: 1.2 } as const;

export type RecoveryBand = 'green' | 'yellow' | 'red';

export function recoveryBand(score: number): RecoveryBand {
  const rounded = Math.round(score);
  if (rounded >= 67) return 'green';
  if (rounded >= 34) return 'yellow';
  return 'red';
}

export interface RecoveryInputs {
  lnRmssd: number | null;
  restingHr: number | null;
  sleepPerformance: number | null;
  respRate: number | null;
  skinTempC: number | null;
}

export interface RecoveryBaselines {
  lnRmssd: Baseline | null;
  restingHr: Baseline | null;
  respRate: Baseline | null;
  skinTemp: Baseline | null;
}

export interface RecoveryResult {
  score: number;
  band: RecoveryBand;
  calibrating: boolean;
  zHrv: number;
  zRhr: number | null;
  zResp: number | null;
  skinTempDevC: number | null;
  core: number;
  sleepTerm: number;
  respPenalty: number;
  tempPenalty: number;
  composite: number;
  sigmoid: { a: number; b: number };
}

export function sigmoidRecovery(composite: number): number {
  return 100 / (1 + Math.exp(-(RECOVERY_SIGMOID_A + RECOVERY_SIGMOID_B * composite)));
}

/** Returns null when overnight HRV or its baseline is unavailable. */
export function computeRecovery(inputs: RecoveryInputs, baselines: RecoveryBaselines): RecoveryResult | null {
  if (inputs.lnRmssd === null || !baselines.lnRmssd) return null;
  const zHrv = zScore(inputs.lnRmssd, baselines.lnRmssd);
  const zRhr = inputs.restingHr !== null && baselines.restingHr ? -zScore(inputs.restingHr, baselines.restingHr) : null;
  const core = zRhr === null ? zHrv : RECOVERY_WEIGHTS.hrv * zHrv + RECOVERY_WEIGHTS.rhr * zRhr;

  const sleepTerm = inputs.sleepPerformance === null ? 0 : RECOVERY_WEIGHTS.sleep * clamp((inputs.sleepPerformance - 85) / 15, -2, 1);
  const zResp = inputs.respRate !== null && baselines.respRate ? zScore(inputs.respRate, baselines.respRate) : null;
  const respPenalty = zResp === null ? 0 : Math.min(1, RECOVERY_WEIGHTS.resp * Math.max(0, zResp - 1.5));
  const skinTempDevC = inputs.skinTempC !== null && baselines.skinTemp ? inputs.skinTempC - baselines.skinTemp.mean : null;
  const tempPenalty = skinTempDevC === null ? 0 : Math.min(1.5, RECOVERY_WEIGHTS.temp * Math.max(0, skinTempDevC - 0.3));

  const composite = core + sleepTerm - respPenalty - tempPenalty;
  const score = sigmoidRecovery(composite);
  return {
    score,
    band: recoveryBand(score),
    calibrating: baselines.lnRmssd.n < CALIBRATION_NIGHTS,
    zHrv,
    zRhr,
    zResp,
    skinTempDevC,
    core,
    sleepTerm,
    respPenalty,
    tempPenalty,
    composite,
    sigmoid: { a: RECOVERY_SIGMOID_A, b: RECOVERY_SIGMOID_B },
  };
}
