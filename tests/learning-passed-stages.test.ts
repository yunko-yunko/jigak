import assert from 'node:assert/strict';
import test from 'node:test';
import { LearningReceipt } from '../src/modules/learning/domain/learning-receipt.js';
import {
  ETA_LEARNING_CONSENT_VERSION,
  type EtaLearningFeatures,
} from '../src/common/shared/intelligence/learning.js';
import {
  JOURNEY_MODES,
  journeyLabelsCoverRoute,
  type JourneyLearningFeatures,
} from '../src/common/shared/intelligence/journeyLearning.js';

const NOW = Date.UTC(2026, 9, 31, 0);
// Walk to the station, the gate to the platform, the wait, the train, the way out, the walk to the door.
const modes = ['walk', 'entry', 'wait', 'subway', 'entry', 'walk'] as const;
const seconds = [200, 12, 90, 900, 150, 200];

function feature(index: number): EtaLearningFeatures {
  return {
    mode: modes[index],
    predictedSeconds: seconds[index],
    distanceMeters: 300,
    startedAt: NOW,
    precipitationMm: null,
    temperatureC: null,
    windMetersPerSecond: null,
    congestionLevel: 'unknown',
    roadDelaySeconds: 0,
    precedingWaitSeconds: 0,
    transferIndex: 0,
    liveWait: false,
  };
}

function whole(): JourneyLearningFeatures {
  const modeSeconds = Object.fromEntries(
    JOURNEY_MODES.map((mode) => [
      mode,
      modes.reduce((sum, part, index) => sum + (part === mode ? seconds[index] : 0), 0),
    ]),
  ) as JourneyLearningFeatures['modeSeconds'];

  return {
    version: 1,
    startedAt: NOW,
    predictedSeconds: seconds.reduce((sum, value) => sum + value, 0),
    distanceMeters: 9000,
    modeSeconds,
    modeSequence: [...modes],
    transfers: 0,
    vehicleLegs: 1,
    precipitationMm: null,
    temperatureC: null,
    windMetersPerSecond: null,
    roadDelaySeconds: 0,
    legModelProfile: 'current-policy-v1',
  };
}

function setup() {
  let clock = NOW;
  const receipt = new LearningReceipt(Buffer.alloc(32, 7), () => clock);
  const ticket = receipt.issueTicket(
    modes.map((_, index) => feature(index)),
    {
      features: whole(),
      pathIdentity: 'route',
    },
  );

  clock = NOW + 1_300_000;

  return { receipt, ticket };
}

const sample = (segmentIndex: number, startedAt: number, endedAt: number) => ({
  segmentIndex,
  startedAt: NOW + startedAt,
  endedAt: NOW + endedAt,
  evidence: 'user-confirmed' as const,
});

test('a whole journey whose gate passages moved on by plan or position keeps its door-to-door time', () => {
  const { receipt, ticket } = setup();
  // The walk to the station and the train were seen at both ends; the gate passages, the wait that began at the end of
  // the first by plan and the last walk that began when the second was passed were not.
  const body = {
    ticket,
    consentVersion: ETA_LEARNING_CONSENT_VERSION,
    samples: [sample(0, 0, 200_000), sample(3, 320_000, 1_220_000)],
    journey: { startedAt: NOW, endedAt: NOW + 1_290_000, evidence: 'user-confirmed' as const },
  };

  assert.equal(receipt.validateSubmission(body).whole?.endedAt, NOW + 1_290_000);
  assert.throws(
    () => receipt.validateSubmission({ ...body, samples: body.samples.slice(0, 1) }),
    'the train ride must be labelled',
  );
  assert.throws(
    () =>
      receipt.validateSubmission({
        ...body,
        journey: { ...body.journey, endedAt: NOW + 1_220_000 },
      }),
    'the confirmed arrival comes after the last labelled stage',
  );
});

test('only a stage guidance passed, or the one such a pass moved the rider into, may go unlabelled', () => {
  const all = new Set([0, 1, 2, 3, 4, 5]);
  const without = (...missing: number[]) =>
    new Set([...all].filter((index) => !missing.includes(index)));

  assert.equal(journeyLabelsCoverRoute(modes, all), true);
  assert.equal(journeyLabelsCoverRoute(modes, without(1, 2, 4, 5)), true);
  assert.equal(journeyLabelsCoverRoute(modes, without(0)), true, 'a walk passed by position');
  assert.equal(
    journeyLabelsCoverRoute(modes, without(2)),
    false,
    'a wait after a labelled gate passage',
  );
  assert.equal(journeyLabelsCoverRoute(modes, without(3)), false, 'a ride after a labelled wait');
  assert.equal(
    journeyLabelsCoverRoute(modes, without(2, 3)),
    false,
    'a ride two stages after the pass',
  );
});
