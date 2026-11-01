/**
 * Every assumed number of the demo micromobility simulator (시연용 가상 데이터: kick-scooters and
 * shared PAS e-bikes of one fictional operator), in one place.
 * Section numbers refer to docs/2026-11-01-scooter-simulation.md. Nothing here describes a real
 * operator: depots, lots, crews, tariffs and penalties are fictional, and every rate is an
 * assumption unless its comment names a source. The model version hashes this object, so any
 * change here changes `modelVersion` (§11.1).
 *
 * The top-level vehicle keys (battery, faults, repair, money, police, cruise speeds) are the
 * kick-scooter's; `ebike` holds the e-bike's, and `VEHICLE_TYPES` below gives both one shape.
 * "R §n" cites the 2026-11-01 e-bike research sheet (sources named inline); every other e-bike
 * number is 가정값.
 */

/** Bump when model code changes behaviour without changing a number below. */
export const SIM_MODEL_REVISION = 'micromobility-sim-2026-11-02.3';

export const ASSUMPTIONS = {
  /**
   * §12, §19.2, §21 fleet bounds. The defaults are Seoul's registered fleet, one simulated device
   * per real one: 14,933 kick-scooters (2025, 서울시 운영 현황, 데일리안 2026-03-23) and 52,605
   * shared e-bikes (2026-06, 6 operators, 서울시 자료, 투어코리아 2026-09-14); 67,538 in all. A
   * scooter-only run uses `default`. Newer counts exist, 16,055 scooters and 54,842 e-bikes
   * (2026-06, 세계일보 2026-07-05); they are references only, and `max`/`ebikeMax` leave room for
   * them (70,897). How many can be rented at a moment comes from the states (riding, charging,
   * repair, depot shelf, night collection, hidden, towed), never from a smaller fleet. Cloud Run
   * runs the whole default too (`cloudRunMax`).
   */
  fleet: {
    default: 14_933,
    min: 3_000,
    max: 72_000,
    scooterDefault: 14_933,
    ebikeDefault: 52_605,
    ebikeMin: 1_000,
    ebikeMax: 60_000,
    cloudRunMax: 72_000,
  },

  /** §4, §11.2 service day and window. */
  /**
   * §11.2 windows start from a steady-state template at an anchor every `anchorDays` days (04:00
   * KST), at least `warmupHours` before the served day; windows sharing an anchor are one
   * continuous simulation, so their 04:00 seam is exact. 48 hours of warm-up keep the template's
   * first day (lost demand about 7%) out of every served day.
   */
  clock: { serviceDayStartHour: 4, warmupHours: 48, anchorDays: 3, checkpointMinutes: 5 },

  /**
   * §5.2, §22 arrivals. Riders a day are fixed for Seoul, not drawn from the fleet size (§22.1):
   * June riders (= rentals × 1.01 for about 1% lost demand) triangulated from 4 sources, ±30%
   * (추정, R-DEMAND §1.2, §5.1), split by type. A type's riders scale down linearly when its fleet
   * is below the real one (`min(1, fleet / default)`, so a 6,000-scooter test keeps the real
   * per-vehicle demand) and never up above it.
   */
  demand: {
    ridersPerDay: { weekday: 96_000, weekend: 77_600 },
    /** [scooter, e-bike] share of the riders (추정, R-DEMAND §1.2: 27k / 68k, weekend 0.83 / 0.80). */
    typeShare: { weekday: [0.284, 0.716], weekend: [0.292, 0.708] },
    /**
     * Documentation only since §22: the riders a scooter gets a day at the real fleet in June
     * (1.83 / 1.52; e-bike 1.31 / 1.04 under `ebike`), derived from `ridersPerDay`.
     */
    arrivalsPerVehicle: { weekday: 1.83, weekend: 1.52 },
    /**
     * January..December, June = 1.00: mean of three June-normalised 따릉이 years of daily rentals
     * (OA-14994, 2023-07..2026-06, R-DEMAND §2). November 0.79 (0.71–0.87).
     */
    seasonByMonth: [0.4, 0.44, 0.67, 0.93, 0.94, 1.0, 0.84, 0.86, 0.99, 1.0, 0.79, 0.48],
    /**
     * Hour weights on the 따릉이 rental shape, renormalised to the same day total (가정값, R-DEMAND
     * §3.2): the commute hours 7, 8, 17 and 18 carry 27.5% of a weekday instead of 35.2% (빔 2024:
     * about a quarter), late evening more (빔 2025 survey, 더스윙 2023 figure 2).
     */
    hourWeights: {
      weekday: [
        1.4521, 1.4521, 1.3484, 1.0372, 1.0372, 1.0372, 1.0372, 0.7336, 0.7336, 1.0372, 1.0372,
        1.0372, 1.0372, 1.0372, 1.0372, 1.0372, 1.0372, 0.9521, 0.7217, 1.0372, 1.0372, 1.2446,
        1.4521, 1.4521,
      ],
      weekend: [
        1.3092, 1.3092, 1.2157, 0.9351, 0.9351, 0.9351, 0.9351, 0.9351, 0.9351, 0.9351, 0.9351,
        0.9351, 0.9351, 0.9351, 0.9351, 0.9351, 0.9351, 0.9351, 0.9351, 0.9351, 0.9351, 1.1222,
        1.3092, 1.3092,
      ],
    },
    riderJitterMeters: 100,
    destinationJitterMeters: 80,
    /** Template placement (§11.2): 04–09 rentals plus half an average dock-hour as a floor. */
    placementHours: [4, 9],
    placementFloorShare: 0.5,
    /**
     * Destination search around a drawn point, and its return weighting floor. The floor was 0.1
     * a dock-hour and sent half the non-pair trips to the quietest docks (U-SPACE §2.6); 0.015
     * and a pull fading as exp(-metres / `returnDecayMeters`) from the drawn point (가정값, §22).
     */
    destinationSearchMeters: 600,
    returnWeightFloor: 0.015,
    returnDecayMeters: 400,
    maxDestinationRedraws: 2,
  },

  /**
   * §22 foot traffic (유동인구, `shared-mobility-foot-weights-osm-v1.json`, U-FOOT): where people
   * are, on 250 m cells, from 서울 생활인구 (OA-14991), subway boardings (OA-12914) and OSM buildings
   * (MOBILITY_FOOT_WEIGHTS_PATH can load the NGII-based file of the same schema from outside git).
   * Trip starts and ends at a dock blend the 따릉이 table with the foot mass of the 250 m cells
   * nearest that dock, `blend` of it per type [scooter, e-bike] (가정값, U-FOOT §4.2: scooters
   * follow 따릉이 less). Crews aim `targetBlend` of the fleet they place at the foot share
   * `w^targetGamma` over cells and the rest at the demand share (가정값; U-FOOT §4.1 suggests γ
   * 0.6–0.7 and U-SPACE §3.2 a 50/50 blend; 0.75 and 0.6 are those raised until tier-A spots kept
   * 120 e-bikes in 500 m in the real-scale runs, §22; §22.9 γ 0.9: with 10% of the fleet now
   * hidden for its battery or on the shelf, 0.75 left 강남역–을지로 short again).
   * Cells at or above `cellMin` (weekday day index, mean 1) count as urban (U-FOOT: 5,959 cells,
   * ≈ 372 km²). Scooter riders are first shared over the 자치구 by `scooterGuShare` (추정 +
   * 가정값, R-DEMAND §4.2: half 더스윙 2023 trips, half 2025-12 operator supply; 강남 14.2%, the
   * 강남3구 34%), and only then over docks inside each 구; e-bikes have no 구 weight (no source).
   */
  foot: {
    blend: [0.65, 0.5],
    targetBlend: 0.6,
    targetGamma: 0.9,
    /**
     * Share of the scooter's foot target that follows `scooterGuShare` (가정값): the 구 table is
     * one operator's 2023 trips and the 2025-12 supply list, which leaves 중구, 종로 and 영등포
     * almost without scooters, so half the target follows the people alone.
     */
    scooterGuTargetShare: 0.5,
    /**
     * §22.9 (가정값) the scooter's foot target is w^γ with this γ inside each 구, steeper than the
     * e-bike's `targetGamma`: short scooter trips start at stations and shopping streets, and
     * the 구 table left 명동, 성수 and 영등포 with 13–25 scooters in 500 m.
     */
    scooterTargetGamma: 1.5,
    cellMin: 0.25,
    scooterGuShare: {
      강남구: 0.1424,
      서초구: 0.1097,
      송파구: 0.091,
      마포구: 0.0822,
      관악구: 0.0652,
      강서구: 0.0584,
      서대문구: 0.0429,
      동대문구: 0.0371,
      동작구: 0.0357,
      성북구: 0.0342,
      노원구: 0.0329,
      광진구: 0.0294,
      양천구: 0.0239,
      강동구: 0.0233,
      중구: 0.0222,
      성동구: 0.0198,
      종로구: 0.0184,
      중랑구: 0.0182,
      금천구: 0.0175,
      용산구: 0.017,
      구로구: 0.015,
      도봉구: 0.0138,
      강북구: 0.013,
      은평구: 0.0127,
      영등포구: 0.0241,
    },
  },

  /** §5.1 rider types. Distances are log-normal medians in km, speeds are cruise km/h. */
  riderTypes: [
    {
      name: 'commuter',
      medianKm: 1.8,
      rangeKm: [0.5, 6],
      cruiseKmh: [16, 20],
      compliance: 0.94,
      helmet: 0.2,
      loopFactor: 0.3,
    },
    {
      name: 'student',
      medianKm: 1.2,
      rangeKm: [0.4, 4],
      cruiseKmh: [14, 19],
      compliance: 0.85,
      helmet: 0.1,
      loopFactor: 0.6,
    },
    {
      name: 'casual',
      medianKm: 2.0,
      rangeKm: [0.5, 6],
      cruiseKmh: [13, 17],
      compliance: 0.9,
      helmet: 0.15,
      loopFactor: 2.0,
    },
    {
      name: 'late-night',
      medianKm: 2.5,
      rangeKm: [0.6, 7],
      cruiseKmh: [15, 20],
      compliance: 0.8,
      helmet: 0.05,
      loopFactor: 0.5,
    },
  ],
  riderDistanceSigma: 0.5,
  /**
   * §5.1 hourly rider-type mix [commuter, student, casual, late-night] per KST hour band; a band
   * is [first hour, last hour] and 22–04 wraps midnight.
   */
  riderMix: {
    weekday: [
      [5, 6, [0.6, 0.05, 0.25, 0.1]],
      [7, 9, [0.7, 0.2, 0.1, 0]],
      [10, 14, [0.2, 0.15, 0.65, 0]],
      [15, 16, [0.2, 0.4, 0.4, 0]],
      [17, 19, [0.55, 0.2, 0.25, 0]],
      [20, 21, [0.3, 0.15, 0.45, 0.1]],
      [22, 4, [0.1, 0.05, 0.15, 0.7]],
    ],
    weekend: [
      [5, 6, [0.3, 0.05, 0.45, 0.2]],
      [7, 9, [0.25, 0.1, 0.65, 0]],
      [10, 14, [0.1, 0.15, 0.75, 0]],
      [15, 16, [0.1, 0.2, 0.7, 0]],
      [17, 19, [0.15, 0.15, 0.7, 0]],
      [20, 21, [0.1, 0.15, 0.6, 0.15]],
      [22, 4, [0.05, 0.05, 0.2, 0.7]],
    ],
  },

  /** §5.4 finding and choosing a vehicle. */
  choice: {
    pickupMeters: 300,
    /** Half the riders walk up to 450 m (about 6 minutes) when nothing is within 300 m. */
    extendedPickupMeters: 450,
    extendedShare: 0.5,
    reserveMinWalkMeters: 40,
    reserveShare: 0.85,
    walkMetersPerSecond: 1.2,
    abandonShare: 0.03,
    notFoundShare: 0.025,
    hiddenVisibleShare: 0.2,
    fallenSkipShare: 0.5,
    maxRetries: 2,
    rangeMargin: 0.1,
    batteryEstimateSigma: 3,
    estimateReservePercent: 1,
  },

  /** §5.5 unlocking. */
  unlock: { transientFailure: 0.02, retryShare: 0.7, persistentFailuresToFlag: 2 },

  /** §5.6 the ride. */
  ride: {
    detour: 1.3,
    effectiveSpeedFactor: 0.7,
    lowBatterySpeedPercent: 10,
    lowBatteryCruiseKmh: 15,
    earlyEndJitterMeters: 20,
    minPathMeters: 60,
    forgetShare: 0.004,
    autoEndMinutes: 120,
    paymentFailedShare: 0.007,
    paymentRecoveredShare: 0.8,
    paymentRecoveryHours: [24, 72],
    /** Fictional operator refund rules: share of the fare refunded per early end. */
    refundShare: { fault: 1, accident: 1, battery: 0.5 },
  },

  /** §3.7 battery. 300 m per percent is a real-riding assumption, not a vendor figure. */
  battery: {
    metersPerPercent: 300,
    winterMonths: [12, 1, 2],
    winterRideFactor: 1.25,
    winterIdleFactor: 1.5,
    idlePercentPerDay: 1,
    /**
     * 가정값. The operator hides a scooter below this charge, and routing uses exactly the
     * vehicles the operator shows (§21): no Korean operator publishes its threshold; Swing is
     * reported at 15–20%, a fleet tool warns below 30% and Türkiye requires 20% (U-REALDATA).
     */
    lowPercent: 20,
    deadPercent: 3,
    /** The controller cuts power here, so a ride that drains the pack ends battery-dead. */
    cutoffPercent: 1,
    maxRangeMeters: 30_000,
    preemptiveSwapPercent: 25,
    depotChargeBelowPercent: 90,
    /**
     * §22.9 (가정값) outside the busiest cells a hidden low pack waits for the next swap round,
     * this many hours after it went low; in a busy cell (§9.4 p5) the crew comes at once. With
     * every crew sent the moment a pack crossed the line, 0.2% of the fleet was ever hidden for
     * its battery, against about 6.7% unavailable for energy in a measured e-scooter fleet
     * (Chalmers, Transportation Research Part D 2024, U-REALDATA §2.3).
     */
    swapDelayHours: 30,
  },

  /** §3.6 faults. Shares sum to 1 over the hidden-fault types (frame comes from falls/accidents). */
  faults: {
    hazardPerKm: 0.001,
    kmScale: 300,
    revealPerKm: 0.3,
    reportShare: 0.8,
    revealedBoost: 0.3,
    maxDiscovery: 0.95,
    accidentPerRide: 1 / 15_000,
    theftPerRide: 0.00003,
    initialKmMean: 150,
    initialKmMax: 600,
    types: [
      { code: 'unlock-iot', share: 0.14, preRide: 0, midRide: 'none', midRideReport: 0 },
      { code: 'brake', share: 0.21, preRide: 0.6, midRide: 'stop', midRideReport: 0.9 },
      { code: 'tyre', share: 0.26, preRide: 0.7, midRide: 'stop', midRideReport: 0.9 },
      { code: 'throttle-motor', share: 0.17, preRide: 0.4, midRide: 'stop', midRideReport: 1 },
      { code: 'display-qr', share: 0.17, preRide: 0.9, midRide: 'continue', midRideReport: 0.6 },
      { code: 'battery-bms', share: 0.05, preRide: 0, midRide: 'stop', midRideReport: 1 },
      { code: 'frame', share: 0, preRide: 0.85, midRide: 'stop', midRideReport: 0.9 },
    ],
  },

  /** §3.6 falls: per parked vehicle-hour; 22–04 is the night band. */
  falls: { perHour: 0.0008, nightFactor: 2.5, obstructionFactor: 1.5, damagedShare: 0.12 },

  /** §3.5 T24, T28, T31 parked hazards; the night band is 00–05. */
  parkedHazards: {
    gpsLostPerHour: 0.00002,
    batteryTheftPerHour: 0.00001,
    nightFactor: 3,
    vandalismPerHour: 0.000002,
    vandalismParkFactor: 5,
  },

  /** §3.5 T25, T26, T32. */
  missing: {
    recoverShare: 0.7,
    stolenRecoverShare: 0.1,
    recoverHours: [1, 72],
    movedShare: 0.4,
    movedMaxMeters: 1_000,
    writeOffDays: 7,
    commissionHours: 72,
  },

  /**
   * §5.7 service area: within this distance of a 따릉이 dock, or (§22) inside a 250 m foot-traffic
   * cell at or above `foot.cellMin`, so busy blocks far from a dock are served too.
   */
  serviceArea: {
    dockBufferMeters: 700,
    outOfAreaShare: 0.0025,
    extraKm: [1, 3],
    center: [37.5665, 126.978],
    gyeonggiComplaintsPerHour: 0.02,
  },

  /** §5.8 late-night hiding. */
  hiding: {
    share: 0.03,
    endHours: [22, 23, 0, 1],
    rerideShare: 0.7,
    rerideWindowHours: [7, 9],
    releaseHour: 10,
    operatorNotFoundShare: 0.5,
  },

  /**
   * §5.9 police enforcement of riders: violation share per ride and catch probability per
   * violating ride. Rates are assumptions aimed at tens of fines a day.
   */
  police: {
    helmet: { catch: 0.0008, hours: [7, 22] },
    twoRiders: { student: 0.01, lateNight: 0.015, other: 0.003, catch: 0.02 },
    unlicensed: { student: 0.006, other: 0.002, catch: 0.01 },
    drunk: { lateNight: 0.015, other: 0.001, catch: 0.02, nightHours: [20, 4], nightFactor: 2 },
    drunkRefusalShare: 0.05,
    sidewalk: { share: 0.05, catch: 0.0005 },
    signal: { share: 0.03, catch: 0.001 },
  },

  /**
   * §6 parking. Buffers: bus stop 10 m and subway exit 5 m follow a 2021 Seoul announcement (확인
   * 필요); the crosswalk's 3 m is R07 (§20.3).
   */
  parking: {
    /**
     * Immediate-tow buffers. The crosswalk was 20 m around one point per crosswalk; the 2026-11-01
     * rule table (§20.3, R07) tows within 3 m and discourages 3–10 m (R08, 도로교통법 10 m).
     */
    bufferMeters: { busStop: 10, subwayExit: 5, crosswalk: 3 },
    searchMeters: 40,
    pushExtraMeters: 5,
    pushTries: 3,
    dockFallbackMeters: 10,
    weights: {
      busStop: 2.0,
      taxi: 0.3,
      subwayExit: 3.0,
      crosswalk: 1.5,
      sidewalk: 4.0,
      roadway: 1.0,
      tactile: 1.0,
      tactileNear: 2.0,
      tactileNearMeters: 30,
      private: 2.0,
      restricted: 0.3,
      restrictedInBox: 4,
      restrictedOutBox: 0.25,
      stationGuess: 0.5,
      stationGuessDockMeters: 150,
    },
    /** Weights when a geometry layer is empty: the average chance a feature is near. */
    fallbackWeights: { busStop: 0.8, subwayExit: 0.5, crosswalk: 0.8 },
    centroids: { searchMeters: 60, immediateShare: 0.3 },
    geometricPlacementShare: 0.8,
    jitterMeters: [1, 5],
    designated: { topDockShare: 0.1, withinMeters: 30, share: 0.3 },
    refused: { moveShare: 0.7, moveMeters: [100, 300], extraMinutes: [2, 4] },
    /** §6.4 fictional operator photo check: rejection probability per category. */
    photoReject: {
      proper: 0.015,
      'sidewalk-obstruction': 0.4,
      roadway: 0.7,
      'subway-exit': 0.5,
      'bus-taxi-stop': 0.5,
      crosswalk: 0.5,
      'tactile-island': 0.6,
      'private-entrance': 0.3,
      'restricted-park-river': 0,
    },
    photoReparkShare: 0.8,
    photoReparkMeters: 30,
    photoReparkExtraMinutes: 2,
    gpsSigmaMeters: 8,
    gpsDetectShare: 0.25,
    landCellMeters: 50,
    landSnapRingMeters: 300,
    landSnapMeters: [5, 15],
    reparkMaxMeters: 50,
    /** 가정값. Lifting a vehicle off the road or a doorway onto the kerb moves it this far at most. */
    reparkNudgeMeters: 8,
    tidyMaxMeters: 20,
    deployJitterMeters: 30,
  },

  /**
   * §20.1 door placement (가정값): riders start and end at door points of the 따릉이 dock that drew
   * them (§21: its own doors, else those within `dockMeters`), and crews set vehicles down the
   * same way. 400 m reaches nine in
   * ten door points (door to nearest dock: median 160 m, p90 385 m); at 250 m a school 320 m from
   * its nearest dock (선린인터넷고) was never a destination. A door weighs its occupant share to
   * the power `weightPower`, so one large complex does not take every trip. Two independent draws
   * can land side by side, so a destination door closer to the origin door than `minTripShare` of
   * the dock-to-dock distance (at most `minTripMeters`) is drawn again, up to `redraws` times.
   * A crew setting a vehicle down for a cell draws up to `dropTries` doors and keeps the first
   * inside that cell (§9.5); with none, the old jitter around the drop point.
   */
  doors: {
    dockMeters: 400,
    weightPower: 0.5,
    /**
     * §21 (가정값). A door belongs to its nearest dock within the service area (700 m); a dock
     * with none of its own draws from the doors within `dockMeters`, their pull fading as
     * exp(-metres / `decayMeters`). Occupant weights count up to `weightCap` (about the 90th
     * percentile), so a few huge complexes no longer swallow a district's returns.
     */
    weightCap: 1_000,
    decayMeters: 150,
    minTripMeters: 200,
    minTripShare: 0.5,
    redraws: 4,
    dropTries: 8,
    /**
     * §21 (가정값). Vehicles left at a door stand `spreadMeters` aside, farther the more already
     * stand there (× √(1 + load / `cap`)); a door holding `cap` rentable vehicles is drawn again
     * up to `capRedraws` times; a crew sets vehicles down within `dropMeters` of its dock. §22:
     * cap 3 → 6 and 8 redraws (가정값): 250 vehicles in 500 m over 80 doors is 3.1 a door at
     * 대치, 8.9 at 석촌 (U-SPACE §2.7).
     */
    spreadMeters: [4, 15],
    cap: 6,
    capRedraws: 8,
    dropMeters: 150,
    /**
     * §22 (가정값, CONTRACT4 D6): about one vehicle a metre of kerb, so no two rentable vehicles
     * end within `coordinateMeters`, at most `spotMeters5Cap` within 5 m, and a spot already
     * holding `pileCap` within 15 m sends the next rider on to the next legal spot.
     */
    coordinateMeters: 1,
    spotMeters5Cap: 6,
    pileCap: 12,
    /**
     * §22.9 (가정값): when no spot within 15 m is free, a rider or crew walks on along the kerb,
     * rings `farRingMeters` apart out to `spreadFarMeters` (half a short block), before stacking
     * on a full spot; a rider leaving a vehicle anywhere (a violation, or every legal spot full)
     * does the same. Before, the full spot took them all and piles reached 18–24 within 15 m.
     */
    farRingMeters: 5,
    spreadFarMeters: 45,
  },

  /**
   * §20.3 return rules. A compliant rider parks at the closest spot no rule forbids, searched on
   * rings `ringMeters` apart up to `rings` rings with `bearings` points each; a discouraged spot
   * counts `discouragedPenaltyMeters` more (CONTRACT3: avoided when an allowed spot is within
   * 30 m). Inside a school or complex (R22, R24) a return is allowed within `doorGraceMeters` of a
   * gate, exit, station side or edge point that is itself within `doorGraceMeters` of the zone's
   * outside; building entrances and gates marked access=no never count. A spot-only zone (용산구
   * R21) binds within `spotSearchMeters` of a zone and beyond that only discourages (§20.3, §22:
   * the file now holds all five official zones, data.go.kr 15112113, but most of the district lies
   * beyond a walk of them, where the district enforces by report); a rider bound by it rides on to
   * the zones within
   * `spotRideMeters`, nearest first, up to `walkTries` of them (a spot can itself sit in a tow
   * buffer, so the next one may lie beyond the binding reach). A rider deep inside a school or
   * complex walks out by its open gates within `spotSearchMeters` the same way, and with nothing
   * allowed the nearest docks are tried. A discouraged spot draws complaints
   * `discouragedComplaintFactor` times the proper rate. All 가정값 except the 30 m.
   */
  returns: {
    ringMeters: 1.5,
    rings: 30,
    bearings: 16,
    discouragedPenaltyMeters: 30,
    doorGraceMeters: 20,
    spotSearchMeters: 400,
    spotRideMeters: 800,
    walkTries: 4,
    discouragedComplaintFactor: 5,
  },

  /** §6.1 park and river boxes from SEOUL_TRAFFIC_AREAS (POI100 서울대공원 is outside Seoul). */
  parkBoxes: [
    'POI085',
    'POI087',
    'POI089',
    'POI090',
    'POI091',
    'POI093',
    'POI094',
    'POI095',
    'POI096',
    'POI098',
    'POI101',
    'POI103',
    'POI104',
    'POI105',
    'POI106',
    'POI108',
    'POI110',
    'POI111',
    'POI123',
    'POI124',
    'POI125',
    'POI127',
  ],

  /**
   * §7.1 complaints per vehicle-hour by category. The base rates were tuned after measuring
   * against 5–40 tows a day per 6,000 vehicles (§16.7, §18).
   */
  complaints: {
    perHour: {
      proper: 0.0002,
      'sidewalk-obstruction': 0.004,
      roadway: 0.0065,
      'subway-exit': 0.009,
      'bus-taxi-stop': 0.008,
      crosswalk: 0.0065,
      'tactile-island': 0.008,
      'private-entrance': 0.005,
      'restricted-park-river': 0.0015,
    },
    fallenFactor: 2,
    busyClip: [0.2, 5],
    busyDockMeters: 500,
    busyDefault: 0.5,
    /** [first hour, last hour, factor]. */
    hourFactors: [
      [0, 6, 0.2],
      [7, 9, 1.3],
      [10, 17, 1.0],
      [18, 21, 1.2],
      [22, 23, 0.5],
    ],
    districtPatrolPerHour: 0.003,
    districtHours: [7, 22],
  },

  /** §7.2 towing. */
  towing: {
    hours: [7, 22],
    delayMinutes: { mean: 30, min: 10, max: 90, shape: 3 },
    graceMinutes: 60,
    trucksPer6000: 2,
    loadMinutes: 25,
    toLotMinutes: [20, 40],
    /** Per lot region; 0 would mean that region does not tow (자치구 대신 권역, §17-8). */
    regionFactor: [1, 1, 1, 1],
    patrolMarginMinutes: 15,
  },

  /** §7.3 fictional impound lots. */
  lots: [
    { id: 'L1', name: '가상 보관소 1 (강서)', latitude: 37.561, longitude: 126.832 },
    { id: 'L2', name: '가상 보관소 2 (은평)', latitude: 37.602, longitude: 126.92 },
    { id: 'L3', name: '가상 보관소 3 (노원)', latitude: 37.639, longitude: 127.071 },
    { id: 'L4', name: '가상 보관소 4 (송파)', latitude: 37.479, longitude: 127.127 },
  ],
  lotHours: { weekday: [9, 18], weekend: [10, 16], visitMinutes: 10, perVehicleMinutes: 5 },

  /** §9.1 fictional depots near light-industrial areas. */
  depots: [
    { id: 'A', name: '가상 거점 A (성수)', latitude: 37.544, longitude: 127.057 },
    { id: 'B', name: '가상 거점 B (문래)', latitude: 37.5155, longitude: 126.893 },
    { id: 'C', name: '가상 거점 C (가산)', latitude: 37.48, longitude: 126.882 },
    { id: 'D', name: '가상 거점 D (문정)', latitude: 37.485, longitude: 127.122 },
    { id: 'E', name: '가상 거점 E (창동)', latitude: 37.654, longitude: 127.047 },
  ],
  depot: {
    sparesPerVehicle: 0.4,
    slotsPerSpare: 0.5,
    chargeHours: 4,
    chargedPercent: 95,
    storagePerVehicle: 0.25,
    swapMinutes: 5,
    inspectionMinutes: 10,
    hiddenFaultFindShare: 0.7,
    preventiveKm: 500,
    preventiveHours: 1,
    topupStockShare: 0.01,
    /**
     * Seasonal reserve, January..December: the share of the fleet kept on the depot shelves
     * instead of the street (winter lay-up, spares). 가정값; it follows `seasonByMonth` so that
     * a quiet month does not leave nearly the whole fleet idle outside (§9.7, §16.7). Two thirds
     * of the 6,000-scooter values since the real-size fleet (§21): the shelf stays under 6%.
     * November 0.04 → 0.02 (§22, 가정값; the audit found no source for 4%, F12).
     */
    reserveByMonth: [
      0.08, 0.075, 0.045, 0.035, 0.025, 0.035, 0.04, 0.04, 0.025, 0.025, 0.02, 0.075,
    ],
  },

  /**
   * §9.2 shifts and crews per 1,000 vehicles. The night shift ends 07:00 the next day. Vans are
   * 7.8 per 1,000: in a 14-day continuous November run 6.0 left lost demand at 16–20% of
   * arrivals and 7.8 holds it at 13–15%, because rebalancing toward the next two hours' demand
   * is what keeps vehicles where riders start (measured in §18.6). The night shift has 3.5 vans
   * (was 2.5) for the overnight collection (§21; job postings show 20–04 and 21–04 shifts with
   * 1-ton trucks, U-REALDATA; 가정값). §22: rides fell to 0.37 of the old demand (F1), so swap
   * and patrol crews, whose work follows the rides (battery use, parking), are 0.4 and 0.5 of the
   * old rates (가정값, F14); vans stay, as rebalancing toward the foot targets keeps them busy.
   * §22.9 (가정값) day and evening 1.5 vans (was 2.0) and the night shift back to 2.5 (was 3.5):
   * the overnight collection is a third of what it was (`overnight`), and neither cut changed a
   * spot count beyond the run-to-run noise (rebalancing is bound by the cells' shortfalls, not by
   * the vans); 1.2 by day emptied 을지로입구 on a Sunday (weekend factor 0.7).
   */
  shifts: [
    { name: 'early', start: 5, end: 14, van: 1.3, swap: 0.4, patrol: 0.25 },
    { name: 'day', start: 7, end: 16, van: 1.5, swap: 1.4, patrol: 1.0 },
    { name: 'evening', start: 15, end: 24, van: 1.5, swap: 1.2, patrol: 0.5 },
    { name: 'night', start: 22, end: 31, van: 2.5, swap: 0.6, patrol: 0.25 },
  ],
  weekendShiftFactor: { early: 1, day: 0.7, evening: 0.7, night: 1 },
  /**
   * Depot mechanics. 150 vehicles each and 0.8 at weekends keep repairs level with the 70–100
   * faults and the preventive services a day; at 250 and 0.5 the repair queue grew without end.
   */
  mechanics: { vehiclesPerMechanic: 150, hours: [8, 18], weekendFactor: 0.8 },
  /** A crew at its meal leaves only for a nearby priority-1 job whose deadline is close. */
  meal: {
    afterHours: 4,
    staggerMinutes: 20,
    staggerGroups: 3,
    minutes: 60,
    interruptTravelMinutes: 10,
    interruptDeadlineMinutes: 30,
  },
  capacity: { vanVehicles: 20, swapSlots: 30, restockAtCharged: 3 },

  /** §9.3 travel: straight line × detour at the hour's speed. [first hour, last hour, km/h]. */
  travel: {
    detour: 1.35,
    vanKmh: [
      [7, 9, 14],
      [10, 16, 18],
      [17, 19, 14],
      [20, 22, 22],
      [23, 6, 28],
    ],
    patrolKmh: { day: 18, night: 22, nightHours: [22, 6] },
    weekendFactor: 1.15,
    maxKmh: 28,
  },
  /** §9.3 handling minutes; each is drawn ×0.8–1.2. */
  handling: {
    vanLoad: 2,
    vanUnload: 1.5,
    impoundVisit: 10,
    impoundPerVehicle: 5,
    swap: 3,
    swapStop: 2,
    repark: 3,
    right: 3,
    restock: 10,
    jitter: [0.8, 1.2],
  },

  /** §9.4–9.5 dispatch. */
  dispatch: {
    tickMinutes: 5,
    gridMeters: 500,
    candidates: 8,
    maxTravelMinutes: 25,
    batchTravelMinutes: 10,
    patrolFallbackMinutes: 20,
    staleSwapHours: 12,
    returnMarginMinutes: 2,
  },
  taskFailure: {
    notFound: 0.03,
    inaccessible: 0.01,
    reopenHours: [6, 12],
    missingAfter: 2,
  },
  inspection: { swapFindShare: 0.3, patrolFindShare: 0.3, tidyShare: 0.4 },

  /**
   * §9.5-7, §21 rebalancing every 30 minutes on 500 m cells (가정값). Each type's street fleet is
   * shared over the cells by the next `targetHours` of expected rentals (overnight: the morning
   * peak), `floorShare` of it evenly; a cell under `deficitFactor` × its share gets vehicles from
   * the nearest cell over `surplusFactor` × its share + `surplusBase`, `minPerSpot`..`maxPerCell`
   * a move (an e-bike van holds 10). Depot stock tops up `topupHours` toward the same shares.
   */
  rebalance: {
    tickMinutes: 30,
    horizonHours: 2,
    targetHours: 6,
    floorShare: 0.15,
    deficitFactor: 0.8,
    surplusFactor: 1.25,
    surplusBase: 3,
    maxPerCell: 10,
    minPerSpot: 2,
    /** A cell short by one vehicle is worth a drop of two: riders give up beyond 300 m. */
    minDeficit: 1,
    /**
     * §22 day rebalancing runs to 23:00 (was 21:00, 가정값): 홍대, 잠실 and 강남역 stay busy at night
     * (U-FOOT §4.5) and 목동 emptied by 23:00 (F11). From 20:00 the targets follow the night
     * foot layer.
     */
    hours: [7, 23],
    /**
     * §22 (가정값): a cell under half its target may take up to this many open moves of a type at
     * once (was one); a van still carries at most `maxPerCell`.
     */
    openPerShortCell: 2,
    shortShare: 0.5,
    /** First and last KST hour of the depot top-up. */
    topupHours: [9, 19],
    maxPairMeters: 5_000,
    maxOpenPerVan: 6,
    preemptiveTopShare: 0.2,
  },
  /**
   * §9.7 morning deployment from 04:00 (the night vans start it, 가정값), and §9.4 overnight
   * collection.
   */
  morning: { planHour: 4, endHour: 8, forecastHours: [7, 9] },
  /**
   * Overnight sweep from 20:00 (§21, 가정값; 20–04 and 21–04 collection shifts in job postings,
   * U-REALDATA): packs under `chargeBelowPercent` to charge, vehicles idle a day or more,
   * stranded in quiet cells, or due for routine maintenance go to the depot, up to `maxShare` of
   * the fleet and `loadsPerVan` van loads per night van; it goes before night rebalancing
   * (`priority`). The 04:00 deployment puts them where the morning demand is, so fewer stand on
   * the street at night than by day. §22: vehicles in the busiest `keepTopNightShare` of cells by
   * the night foot layer stay out (가정값, F11), unless their pack needs a charge. §22.9 (가정값,
   * scaled to rides at 0.37 of the old demand, F1/F14): idle 72 hours (was 24: at about one ride
   * a day a vehicle idle a day is ordinary), quiet below 0.02 rentals an hour (0.05 × 0.37), packs
   * under 15% (was 30%: the field swap rounds charge the rest, `battery.swapDelayHours`), at
   * most 5% of the fleet (was 15%). The sweep fell from about 8,500 vehicles a night to 3,100.
   */
  overnight: {
    planHour: 20,
    keepTopNightShare: 0.2,
    priority: 56,
    minParkedHours: 72,
    lowDemandPerHour: 0.02,
    chargeBelowPercent: 15,
    maxShare: 0.05,
    vehiclesPerVan: 20,
    loadsPerVan: 3,
  },

  /** §9.8 repairs: work hours, parts wait (share, max hours) and write-off rate per fault. */
  repair: {
    'unlock-iot': { hours: [1, 4], partsShare: 0.2, partsHours: 48, writeOff: 0.02 },
    brake: { hours: [1, 3], partsShare: 0.15, partsHours: 24, writeOff: 0.02 },
    tyre: { hours: [1, 2], partsShare: 0.1, partsHours: 24, writeOff: 0.01 },
    'throttle-motor': { hours: [2, 6], partsShare: 0.3, partsHours: 48, writeOff: 0.03 },
    'display-qr': { hours: [0.5, 2], partsShare: 0, partsHours: 0, writeOff: 0.01 },
    'battery-bms': { hours: [0.5, 1], partsShare: 0.1, partsHours: 24, writeOff: 0.01 },
    frame: { hours: [2, 8], partsShare: 0.25, partsHours: 48, writeOff: 0.08 },
  },

  /**
   * §11.2 steady-state template at the warm-up start. Shares of the fleet; the rest is available.
   * Measured at 04:00 over a 14-day continuous run (2026-11-12..25, 6,000 vehicles, §18.6); the
   * seasonal reserve (`depot.reserveByMonth`) is added to `ready`. §22.9 measured again at 04:05
   * on 2026-11-04 after 14 days run on from the template (real fleet, the §22 demand and the
   * swap rounds): hidden low packs 5.9%, the shelf 4.3% above the reserve (deploying included).
   */
  template: {
    lowBattery: 0.059,
    broken: 0.0001,
    outOfArea: 0.0001,
    missing: 0.0064,
    impounded: 0.0002,
    charging: 0.0001,
    repair: 0.006,
    /** §21 the overnight collection waits on the shelf at 04:00 (§22.9: 4.3%, was 11.5%). */
    ready: 0.043,
    writtenOff: 0.0027,
    availableBattery: [25, 100],
    lowBatteryRange: [4, 14],
    impoundedHours: [0, 12],
    missingWriteOffHours: [0, 168],
    writtenOffHours: [0, 72],
  },

  /**
   * §8 money, whole won. 가정값. 서울시 조례(견인료·보관료)와 도로교통법(개인형 이동장치 범칙금)의
   * 항목 구분을 참고했으며 현행 금액과 다를 수 있다. 이용 요금·패널티는 가상 운영사의 것이다.
   * "확인 필요"로 표시한 값은 보도 기준이며 법령 원문으로 확인하지 않았다.
   */
  money: {
    unlockFeeWon: 1_000,
    perMinuteWon: 150,
    autoEndCapWon: 30_000,
    designatedDiscountWon: 200,
    photoPenaltyWon: 10_000,
    refusedPenaltyWon: 10_000,
    outOfAreaFeeWon: 20_000,
    /** 견인료: 서울시 보도 금액과 같음(확인 필요). */
    towFeeWon: 40_000,
    /** 보관료 30분당: 서울시 보도 금액과 같음(확인 필요). 가정: 상한 없음. */
    storageWonPer30Minutes: 700,
    /** 범칙금: helmet·two-riders·unlicensed·drunk는 보도 금액(확인 필요), 나머지도 확인 필요. */
    fines: {
      helmet: 20_000,
      'two-riders': 40_000,
      unlicensed: 100_000,
      drunk: 100_000,
      'drunk-refusal': 130_000,
      sidewalk: 30_000,
      signal: 30_000,
    },
  },

  /**
   * Shared dockless PAS e-bikes (공유 전기자전거). A pedal-assist e-bike that cuts assist at
   * 25 km/h and weighs under 30 kg is a 자전거 under 자전거 이용 활성화에 관한 법률 §2-1의2, not a
   * personal mobility device (R §1), so no licence, no helmet fine and no PM towing apply.
   */
  ebike: {
    /**
     * Documentation only since §22: riders an e-bike gets a day at the real fleet in June (추정,
     * R-DEMAND §5.2); the riders come from `demand.ridersPerDay`.
     */
    arrivalsPerVehicle: { weekday: 1.31, weekend: 1.04 },
    /**
     * Cruise km/h per rider type [commuter, student, casual, late-night] (가정값): German
     * naturalistic riding saw pedelecs near 17 km/h, about 2 km/h above bicycles (R §3).
     */
    cruiseKmh: [
      [17, 21],
      [15, 19],
      [15, 18],
      [16, 20],
    ],
    /** Assist stops at 25 km/h by law (R §1); nobody cruises above it. */
    maxKmh: 25,
    /** After the battery's assist cut-off the rider pedals on unassisted (가정값); no refund. */
    pedalKmh: [12, 14],
    /** No throttle: a low battery does not slow the ride before the cut-off. */
    lowBatterySpeedPercent: 0,
    /**
     * 가정값. A rider takes an e-bike whose charge assists at least this share of the trip; the
     * rest can be pedalled. A scooter's charge must cover the whole trip (share 1).
     */
    rangeCoverShare: 0.6,
    /**
     * 가정값: about 45 km a charge (450 m per percent), a slower idle drain than a scooter's
     * IoT lock, swap at 25 %. Hidden below 12 % (§21, was 8 %): lower than a scooter's 20 %
     * because it can be pedalled, and routing takes exactly what the map shows. §22.9 (가정값):
     * 15 %, with no pre-emptive swap above it; at 12 % and 25 % pre-emptive swaps in busy cells
     * kept 99% of the e-bikes rentable, above the 75–93% measured abroad (U-REALDATA §2.3). The battery is
     * locked to the frame, so battery theft is rarer.
     */
    battery: {
      metersPerPercent: 450,
      winterMonths: [12, 1, 2],
      winterRideFactor: 1.25,
      winterIdleFactor: 1.5,
      idlePercentPerDay: 0.7,
      lowPercent: 15,
      deadPercent: 3,
      /** Assist cut-off; the ride continues on the pedals (§19). */
      cutoffPercent: 1,
      maxRangeMeters: 45_000,
      /** §22.9 (가정값) no pre-emptive e-bike swap above the hiding line: the round takes them. */
      preemptiveSwapPercent: 15,
      depotChargeBelowPercent: 90,
      /** §22.9 (가정값) a pedallable e-bike waits longer for its round than a scooter. */
      swapDelayHours: 48,
      theftFactor: 0.2,
    },
    /**
     * 가정값. A chain, crank and saddle add mechanical faults; the hub motor and torque sensor
     * replace the throttle; tyres take a larger share (heavier bike, rear hub wheel). A motor,
     * sensor or battery fault leaves the bike rideable on the pedals; a missing or broken saddle
     * does not. Shares sum to 1 over the hidden-fault types.
     */
    faults: {
      hazardPerKm: 0.001,
      kmScale: 300,
      revealPerKm: 0.3,
      accidentPerRide: 1 / 20_000,
      theftPerRide: 0.00003,
      types: [
        { code: 'unlock-iot', share: 0.12, preRide: 0, midRide: 'none', midRideReport: 0 },
        { code: 'brake', share: 0.15, preRide: 0.6, midRide: 'stop', midRideReport: 0.9 },
        { code: 'tyre', share: 0.28, preRide: 0.7, midRide: 'stop', midRideReport: 0.9 },
        { code: 'display-qr', share: 0.08, preRide: 0.9, midRide: 'continue', midRideReport: 0.6 },
        { code: 'battery-bms', share: 0.04, preRide: 0, midRide: 'continue', midRideReport: 0.8 },
        { code: 'frame', share: 0, preRide: 0.85, midRide: 'stop', midRideReport: 0.9 },
        {
          code: 'chain-drivetrain',
          share: 0.13,
          preRide: 0.5,
          midRide: 'stop',
          midRideReport: 0.9,
        },
        { code: 'pedal-crank', share: 0.07, preRide: 0.6, midRide: 'stop', midRideReport: 0.9 },
        {
          code: 'saddle-seatpost',
          share: 0.06,
          preRide: 0.95,
          midRide: 'stop',
          midRideReport: 0.9,
        },
        {
          code: 'motor-sensor',
          share: 0.07,
          preRide: 0.3,
          midRide: 'continue',
          midRideReport: 0.7,
        },
      ],
    },
    /** 가정값. Repair hours, parts wait and write-off per fault, as the scooter table. */
    repair: {
      'unlock-iot': { hours: [1, 4], partsShare: 0.2, partsHours: 48, writeOff: 0.02 },
      brake: { hours: [1, 3], partsShare: 0.15, partsHours: 24, writeOff: 0.01 },
      tyre: { hours: [1, 2.5], partsShare: 0.1, partsHours: 24, writeOff: 0.005 },
      'throttle-motor': { hours: [2, 6], partsShare: 0.3, partsHours: 48, writeOff: 0.03 },
      'display-qr': { hours: [0.5, 2], partsShare: 0, partsHours: 0, writeOff: 0.01 },
      'battery-bms': { hours: [0.5, 1], partsShare: 0.1, partsHours: 24, writeOff: 0.01 },
      frame: { hours: [2, 8], partsShare: 0.25, partsHours: 48, writeOff: 0.06 },
      'chain-drivetrain': { hours: [0.5, 2], partsShare: 0.15, partsHours: 24, writeOff: 0.005 },
      'pedal-crank': { hours: [0.5, 1.5], partsShare: 0.1, partsHours: 24, writeOff: 0.005 },
      'saddle-seatpost': { hours: [0.25, 1], partsShare: 0.3, partsHours: 24, writeOff: 0 },
      'motor-sensor': { hours: [1, 4], partsShare: 0.3, partsHours: 48, writeOff: 0.02 },
    },
    /**
     * Fares of one fictional operator: unlock 600원 06:00–23:59, 1,000원 at night, 160원 a
     * started minute (R §4: 카카오T바이크 500/900원·170원, 지쿠 800/1,200원·180원, 일레클 600원·150원,
     * 2026-07). Discounts, penalties and fees are the scooter's.
     */
    fares: { unlockDayWon: 600, unlockNightWon: 1_000, dayHours: [6, 23], perMinuteWon: 160 },
    /**
     * Police (R §1). Bicycle rules: helmets are mandatory without a fine, no licence exists to
     * lack, and a second rider breaks only the operator's terms (가정값: no police fine). The
     * violation shares and catch rates are the scooter's.
     */
    police: { helmetFined: false, unlicensedFined: false, twoRidersFined: false },
    /**
     * 범칙금 for bicycles: drunk 30,000원, refusal 100,000원 (R §1, 시행령 별표); sidewalk 30,000원
     * (R §1 unverified, 가정값); signal 30,000원 (확인 필요). Helmet, two riders and unlicensed are 0:
     * never fined.
     */
    fines: {
      helmet: 0,
      'two-riders': 0,
      unlicensed: 0,
      drunk: 30_000,
      'drunk-refusal': 100_000,
      sidewalk: 30_000,
      signal: 30_000,
    },
    /**
     * Operations (가정값): an e-bike takes two van places of 20, loading and unloading take 1.5×,
     * a battery is 1.5 swap-slot units and a swap 4 minutes, a depot charge 5–6 hours.
     */
    ops: {
      vanUnits: 2,
      handlingFactor: 1.5,
      batteryUnits: 1.5,
      swapMinutes: 4,
      chargeHours: [5, 6],
      /** Spare packs per e-bike, as the scooter's `depot.sparesPerVehicle` (가정값). */
      sparesPerVehicle: 0.4,
      /**
       * Crew workload of one e-bike against one scooter, for the crew roster (가정값). Vans: two
       * places and 1.5× handling, but 3.6 against 4.6 rides a day to rebalance (≈ 1.3). Swaps:
       * 450 against 300 m per percent and fewer rides give about half the swaps, each a little
       * longer (≈ 0.7). Patrols: the same parking behaviour per ride, fewer rides (≈ 0.8).
       */
      crewWeight: { van: 1.3, swap: 0.7, patrol: 0.8 },
    },
    /**
     * §11.2 the e-bike's steady-state template, shares of the e-bike fleet. Measured at 04:00
     * over a mixed 14-day continuous run (2026-11-12..25, 4,000 scooters + 8,000 e-bikes, the
     * same method as the scooter's, §18.6). §22.9 measured again as the scooter's: hidden low
     * packs 5.4%, the shelf 5.7% above the reserve.
     */
    template: {
      lowBattery: 0.054,
      broken: 0.0002,
      outOfArea: 0.0001,
      missing: 0.0052,
      // 서초구 removals are rare (the operator re-parks first), so no e-bike starts in a lot.
      impounded: 0,
      charging: 0.0002,
      repair: 0.0056,
      /** §21 the overnight collection waits on the shelf at 04:00 (§22.9: 5.7%, was 11.6%). */
      ready: 0.057,
      writtenOff: 0.0026,
      /**
       * §22.9 from 18% (was 25%): the steady state has 5–10% of rentable e-bikes between the
       * 15% hiding line and 28%; without them the first swap rounds after the template ran dry
       * and the hidden count jumped by 3% of the fleet at a new anchor.
       */
      availableBattery: [18, 100],
      lowBatteryRange: [4, 14],
      impoundedHours: [0, 12],
      missingWriteOffHours: [0, 168],
      writtenOffHours: [0, 72],
    },
    /** Unlock 30 s, park + lock + photo 30 s: one minute a rental (user rule 2026-11-01). */
    policy: { hireSeconds: 30, returnSeconds: 30 },
    /**
     * Parking enforcement (R §2). Seoul's PM towing ordinance does not cover e-bikes today: a
     * complaint goes to the operator, who must re-park by a deadline (가정값 120 minutes).
     * 서초구 removes shared e-bikes from five zone kinds within 3 hours since 2026-04-27, with no
     * fee; the operator fetches them. The ordinance pending for 2027 (견인료 40,000원, 보관료
     * 700원 a 30 minutes, cap 500,000원) stays off unless enabled.
     */
    towing: {
      operatorReparkMinutes: 120,
      /**
       * 서초구's five zones are 점자블록·보도 중앙, 지하철 출구 5 m, 버스정류장 5 m, 횡단보도 3 m and
       * 자전거도로 (R §2); they map onto the six sim categories below (보도 중앙 = sidewalk
       * obstruction, 자전거도로 = roadway). The district crew comes 1–3 hours after the report
       * (가정값 inside "3시간 이내") during its working hours (가정값: the towing hours), and its own
       * sweep finds a zone e-bike at the PM district-patrol rate (가정값). Its 5 m and 3 m are
       * read as the sim's 10 m and 20 m buffers. The district outline is `SEOCHO_OUTLINE` in
       * parking-rules.ts. Measured in November: 1–2 서초구 notices a day for 8,000 e-bikes, and
       * patrols re-park nearly all of them before the removal (§19).
       */
      district: {
        name: '서초구',
        removalHours: [1, 3],
        hours: [7, 22],
        categories: [
          'sidewalk-obstruction',
          'roadway',
          'subway-exit',
          'bus-taxi-stop',
          'crosswalk',
          'tactile-island',
        ],
        patrolPerHour: 0.003,
      },
      ordinance2027: {
        enabled: false,
        towFeeWon: 40_000,
        storageWonPer30Minutes: 700,
        storageCapWon: 500_000,
      },
    },
  },

  /**
   * Which type an arriving rider wants when both stand on the street (가정값). A share takes
   * either; the rest lean by the types' arrival shares, students (no licence needed) and longer
   * trips toward the e-bike. `seek` ranks walking metres plus a penalty for an unwanted type, so
   * a rider still takes the other type when it is much closer, and gives up otherwise.
   */
  preference: {
    eitherShare: 0.45,
    /** [commuter, student, casual, late-night] multipliers on the e-bike lean. */
    ebikeLean: [1, 1.6, 1.1, 0.8],
    longTripKm: 2.5,
    longTripLean: 1.3,
    leanClip: [0.05, 0.95],
    unwantedPenaltyMeters: 150,
  },

  /** §15.4–15.5 feeds and the route policy. */
  feed: { lastReportedJitterSeconds: 90 },
  policy: {
    holdMinutes: 60,
    /** Unlock 30 s, park + lock + photo 30 s, as for e-bikes (user rule 2026-11-01). */
    hireSeconds: 30,
    returnSeconds: 30,
    rangeDetour: 1.3,
    rangeMargin: 1.1,
  },
} as const;

export type Assumptions = typeof ASSUMPTIONS;

export type FaultCodeName =
  | 'unlock-iot'
  | 'brake'
  | 'tyre'
  | 'throttle-motor'
  | 'display-qr'
  | 'battery-bms'
  | 'frame'
  | 'chain-drivetrain'
  | 'pedal-crank'
  | 'saddle-seatpost'
  | 'motor-sensor';

export interface FaultTypeSpec {
  code: FaultCodeName;
  share: number;
  preRide: number;
  midRide: 'none' | 'stop' | 'continue';
  midRideReport: number;
}

export interface RepairSpec {
  hours: readonly [number, number] | readonly number[];
  partsShare: number;
  partsHours: number;
  writeOff: number;
}

/** One vehicle type's numbers in one shape; index = the `vType` code (sim-codes VTYPE). */
export interface VehicleTypeSpec {
  name: 'kick-scooter' | 'e-bike';
  label: string;
  arrivalsPerVehicle: { weekday: number; weekend: number };
  /** Cruise km/h range per rider type. */
  cruiseKmh: readonly (readonly number[])[];
  maxKmh: number;
  /** Unassisted pedalling after the assist cut-off; null when the cut-off ends the ride. */
  pedalKmh: readonly number[] | null;
  lowBatterySpeedPercent: number;
  lowBatteryCruiseKmh: number;
  /** Share of the trip the charge must cover before a rider takes the vehicle. */
  rangeCoverShare: number;
  battery: {
    metersPerPercent: number;
    winterRideFactor: number;
    winterIdleFactor: number;
    idlePercentPerDay: number;
    lowPercent: number;
    deadPercent: number;
    cutoffPercent: number;
    maxRangeMeters: number;
    preemptiveSwapPercent: number;
    depotChargeBelowPercent: number;
    swapDelayHours: number;
    theftFactor: number;
  };
  faults: {
    hazardPerKm: number;
    kmScale: number;
    revealPerKm: number;
    accidentPerRide: number;
    theftPerRide: number;
    types: readonly FaultTypeSpec[];
  };
  repair: Readonly<Partial<Record<FaultCodeName, RepairSpec>>>;
  fares: {
    unlockDayWon: number;
    unlockNightWon: number;
    /** [first, last] KST hour of the day fare. */
    dayHours: readonly number[];
    perMinuteWon: number;
  };
  police: { helmetFined: boolean; unlicensedFined: boolean; twoRidersFined: boolean };
  fines: Readonly<Record<keyof Assumptions['money']['fines'], number>>;
  ops: {
    /** Van places one vehicle takes (a van holds `capacity.vanVehicles` places). */
    vanUnits: number;
    /** Loading and unloading time against a scooter's. */
    handlingFactor: number;
    /** Swap-crew slots one battery takes (a crew carries `capacity.swapSlots`). */
    batteryUnits: number;
    swapMinutes: number;
    chargeHours: readonly number[];
    sparesPerVehicle: number;
    crewWeight: { van: number; swap: number; patrol: number };
  };
  policy: { hireSeconds: number; returnSeconds: number };
  template: TemplateSpec;
}

export type TemplateSpec = {
  readonly [
    K in keyof Assumptions['template']
  ]: Assumptions['template'][K] extends readonly number[] ? readonly [number, number] : number;
};

const A = ASSUMPTIONS;

/** [scooter, e-bike]. The scooter entry is built from the top-level keys, value for value. */
export const VEHICLE_TYPES: readonly [VehicleTypeSpec, VehicleTypeSpec] = [
  {
    name: 'kick-scooter',
    label: '시연용 가상 킥보드',
    arrivalsPerVehicle: A.demand.arrivalsPerVehicle,
    cruiseKmh: A.riderTypes.map((type) => type.cruiseKmh),
    maxKmh: Infinity,
    pedalKmh: null,
    lowBatterySpeedPercent: A.ride.lowBatterySpeedPercent,
    lowBatteryCruiseKmh: A.ride.lowBatteryCruiseKmh,
    rangeCoverShare: 1,
    battery: { ...A.battery, theftFactor: 1 },
    faults: A.faults,
    repair: A.repair,
    fares: {
      unlockDayWon: A.money.unlockFeeWon,
      unlockNightWon: A.money.unlockFeeWon,
      dayHours: [0, 23],
      perMinuteWon: A.money.perMinuteWon,
    },
    police: { helmetFined: true, unlicensedFined: true, twoRidersFined: true },
    fines: A.money.fines,
    ops: {
      vanUnits: 1,
      handlingFactor: 1,
      batteryUnits: 1,
      swapMinutes: A.handling.swap,
      chargeHours: [A.depot.chargeHours, A.depot.chargeHours],
      sparesPerVehicle: A.depot.sparesPerVehicle,
      crewWeight: { van: 1, swap: 1, patrol: 1 },
    },
    policy: { hireSeconds: A.policy.hireSeconds, returnSeconds: A.policy.returnSeconds },
    template: A.template,
  },
  {
    name: 'e-bike',
    label: '시연용 가상 전기자전거',
    arrivalsPerVehicle: A.ebike.arrivalsPerVehicle,
    cruiseKmh: A.ebike.cruiseKmh,
    maxKmh: A.ebike.maxKmh,
    pedalKmh: A.ebike.pedalKmh,
    lowBatterySpeedPercent: A.ebike.lowBatterySpeedPercent,
    lowBatteryCruiseKmh: A.ride.lowBatteryCruiseKmh,
    rangeCoverShare: A.ebike.rangeCoverShare,
    battery: A.ebike.battery,
    faults: A.ebike.faults,
    repair: A.ebike.repair,
    fares: A.ebike.fares,
    police: A.ebike.police,
    fines: A.ebike.fines,
    ops: A.ebike.ops,
    policy: A.ebike.policy,
    template: A.ebike.template,
  },
];
