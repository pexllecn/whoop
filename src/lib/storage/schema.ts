/**
 * OpenPulse SQLite schema (Drizzle ORM). Generate migrations with
 * `npm run db:generate`; they are applied automatically on open.
 *
 * Conventions: instants are epoch milliseconds (INTEGER), calendar days are
 * 'YYYY-MM-DD' TEXT in the user's configured time zone, durations are ms.
 * Every derived or imported row records its `source`.
 */
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Every notification exactly as received, stored before decoding (raw-first rule). */
export const rawPackets = sqliteTable(
  'raw_packets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    receivedAt: integer('received_at').notNull(),
    deviceId: text('device_id'),
    characteristicUuid: text('characteristic_uuid').notNull(),
    payloadHex: text('payload_hex').notNull(),
    /** pending | decoded | partial | fragment | unsynced | unmapped | crc_error | malformed | ignored | error */
    decodedStatus: text('decoded_status').notNull().default('pending'),
    packetType: integer('packet_type'),
    frameCount: integer('frame_count').notNull().default(0),
    decodeError: text('decode_error'),
    parserVersion: integer('parser_version'),
    /** Transport that captured it: noble | web-bluetooth | simulator */
    source: text('source').notNull(),
  },
  (t) => [
    index('raw_packets_received_idx').on(t.receivedAt),
    index('raw_packets_status_idx').on(t.decodedStatus),
    index('raw_packets_device_idx').on(t.deviceId, t.id),
  ],
);

/** One row per heart-rate report (a 0x2A37 notification or a proprietary HR record). */
export const hrRrSamples = sqliteTable(
  'hr_rr_samples',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Epoch ms; the last R-R interval in `rrMs` ends at this instant. */
    ts: integer('ts').notNull(),
    bpm: real('bpm'),
    /** JSON array of R-R intervals in ms, chronological. */
    rrMs: text('rr_ms').notNull().default('[]'),
    rrCount: integer('rr_count').notNull().default(0),
    /** Unverified u16 from compact realtime records; never used for HRV. */
    rrCandidateMs: real('rr_candidate_ms'),
    /** sig_hrm | proprietary_realtime | proprietary_historical | simulated | apple_health */
    source: text('source').notNull(),
    sensorContact: text('sensor_contact'),
    rawPacketId: integer('raw_packet_id').references(() => rawPackets.id, { onDelete: 'cascade' }),
  },
  (t) => [
    index('hr_rr_samples_ts_idx').on(t.ts),
    index('hr_rr_samples_raw_idx').on(t.rawPacketId),
  ],
);

/** Accelerometer activity, one row per decoded IMU batch (mean |‖a‖ - 1 g|). */
export const motionSamples = sqliteTable(
  'motion_samples',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    activityG: real('activity_g').notNull(),
    sampleCount: integer('sample_count').notNull().default(0),
    source: text('source').notNull(),
    rawPacketId: integer('raw_packet_id').references(() => rawPackets.id, { onDelete: 'cascade' }),
  },
  (t) => [index('motion_samples_ts_idx').on(t.ts), index('motion_samples_raw_idx').on(t.rawPacketId)],
);

/** 30-second epochs derived from samples. Rebuilt by the daily processor. */
export const biometricEpochs = sqliteTable(
  'biometric_epochs',
  {
    epochStart: integer('epoch_start').primaryKey(),
    meanHr: real('mean_hr'),
    minHr: real('min_hr'),
    maxHr: real('max_hr'),
    hrSd: real('hr_sd'),
    rrCount: integer('rr_count').notNull().default(0),
    validRrCount: integer('valid_rr_count').notNull().default(0),
    rmssd: real('rmssd'),
    motion: real('motion'),
    worn: integer('worn', { mode: 'boolean' }).notNull().default(false),
    /** awake | light | deep | rem (null outside sleep) */
    stage: text('stage'),
    sleepSessionId: integer('sleep_session_id'),
    /** 0.0 - 3.0, null while moving / exercising / asleep */
    stress: real('stress'),
  },
);

export const sleepSessions = sqliteTable(
  'sleep_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** openpulse | whoop_csv | apple_health */
    source: text('source').notNull(),
    externalId: text('external_id'),
    /** Local date the sleep ended on. */
    date: text('date').notNull(),
    startTs: integer('start_ts').notNull(),
    endTs: integer('end_ts').notNull(),
    isNap: integer('is_nap', { mode: 'boolean' }).notNull().default(false),
    inBedMs: integer('in_bed_ms'),
    awakeMs: integer('awake_ms'),
    lightMs: integer('light_ms'),
    deepMs: integer('deep_ms'),
    remMs: integer('rem_ms'),
    noDataMs: integer('no_data_ms'),
    efficiency: real('efficiency'),
    disturbances: integer('disturbances'),
    respRate: real('resp_rate'),
    overnightRmssd: real('overnight_rmssd'),
    restingHr: real('resting_hr'),
    performance: real('performance'),
    consistency: real('consistency'),
    needMs: integer('need_ms'),
    needBaselineMs: integer('need_baseline_ms'),
    needStrainMs: integer('need_strain_ms'),
    needDebtMs: integer('need_debt_ms'),
    /** JSON [{start, end, stage}] for imported sessions without epochs. */
    stagesJson: text('stages_json'),
    computedAt: integer('computed_at').notNull(),
  },
  (t) => [
    index('sleep_sessions_date_idx').on(t.date),
    index('sleep_sessions_start_idx').on(t.startTs),
    uniqueIndex('sleep_sessions_external_idx').on(t.source, t.externalId),
  ],
);

export const workouts = sqliteTable(
  'workouts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** openpulse (detected) | whoop_csv | apple_health */
    source: text('source').notNull(),
    externalId: text('external_id'),
    date: text('date').notNull(),
    startTs: integer('start_ts').notNull(),
    endTs: integer('end_ts').notNull(),
    sport: text('sport').notNull(),
    strain: real('strain'),
    avgHr: real('avg_hr'),
    maxHr: real('max_hr'),
    kcal: real('kcal'),
    trimp: real('trimp'),
    edwardsLoad: real('edwards_load'),
    zone0Ms: integer('zone0_ms'),
    zone1Ms: integer('zone1_ms'),
    zone2Ms: integer('zone2_ms'),
    zone3Ms: integer('zone3_ms'),
    zone4Ms: integer('zone4_ms'),
    zone5Ms: integer('zone5_ms'),
    distanceM: real('distance_m'),
    computedAt: integer('computed_at').notNull(),
  },
  (t) => [
    index('workouts_date_idx').on(t.date),
    index('workouts_start_idx').on(t.startTs),
    uniqueIndex('workouts_external_idx').on(t.source, t.externalId),
  ],
);

export const dailySummaries = sqliteTable(
  'daily_summaries',
  {
    date: text('date').notNull(),
    /** openpulse (computed locally) | whoop_csv | apple_health (imported, shown as-is) */
    source: text('source').notNull(),
    recovery: real('recovery'),
    /** JSON with z-scores, weights and inputs so every score is explainable. */
    recoveryInputs: text('recovery_inputs'),
    hrvRmssd: real('hrv_rmssd'),
    hrvSdnn: real('hrv_sdnn'),
    restingHr: real('resting_hr'),
    respRate: real('resp_rate'),
    skinTempC: real('skin_temp_c'),
    skinTempDevC: real('skin_temp_dev_c'),
    spo2: real('spo2'),
    dayStrain: real('day_strain'),
    dayTrimp: real('day_trimp'),
    dayEdwards: real('day_edwards'),
    kcal: real('kcal'),
    sleepPerformance: real('sleep_performance'),
    sleepNeedMs: integer('sleep_need_ms'),
    sleepActualMs: integer('sleep_actual_ms'),
    sleepDebtMs: integer('sleep_debt_ms'),
    sleepConsistency: real('sleep_consistency'),
    sleepEfficiency: real('sleep_efficiency'),
    stressAvg: real('stress_avg'),
    stressMax: real('stress_max'),
    stressHighMinutes: real('stress_high_minutes'),
    wornMinutes: real('worn_minutes'),
    calibrating: integer('calibrating', { mode: 'boolean' }).notNull().default(false),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.date, t.source] })],
);

/** EWMA baseline state at the end of each day, per metric. */
export const userBaseline = sqliteTable(
  'user_baseline',
  {
    date: text('date').notNull(),
    /** ln_rmssd | resting_hr | resp_rate | skin_temp */
    metric: text('metric').notNull(),
    mean: real('mean').notNull(),
    sd: real('sd').notNull(),
    /** Number of daily observations folded in so far. */
    n: integer('n').notNull(),
    /** Where the observations came from: openpulse | whoop_csv | mixed */
    source: text('source').notNull(),
  },
  (t) => [primaryKey({ columns: [t.date, t.metric] })],
);

export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  name: text('name'),
  transport: text('transport').notNull(),
  serviceVariant: text('service_variant'),
  model: text('model'),
  serial: text('serial'),
  firmware: text('firmware'),
  hardware: text('hardware'),
  batteryPct: integer('battery_pct'),
  batteryAt: integer('battery_at'),
  lastConnectedAt: integer('last_connected_at'),
  lastSeenAt: integer('last_seen_at'),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const importRuns = sqliteTable('import_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(),
  filename: text('filename').notNull(),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'),
  status: text('status').notNull(),
  counts: text('counts'),
  error: text('error'),
});

export const coachMessages = sqliteTable(
  'coach_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(),
    provider: text('provider'),
    model: text('model'),
  },
  (t) => [index('coach_messages_ts_idx').on(t.ts)],
);

export type RawPacketRow = typeof rawPackets.$inferSelect;
export type HrRrSampleRow = typeof hrRrSamples.$inferSelect;
export type MotionSampleRow = typeof motionSamples.$inferSelect;
export type BiometricEpochRow = typeof biometricEpochs.$inferSelect;
export type SleepSessionRow = typeof sleepSessions.$inferSelect;
export type WorkoutRow = typeof workouts.$inferSelect;
export type DailySummaryRow = typeof dailySummaries.$inferSelect;
export type UserBaselineRow = typeof userBaseline.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;
