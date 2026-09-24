import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { echoes, evidenceFor, isTaught, repeats, taughtIn, toLabels, unionBox, withoutPictures, type Found } from './diagramLabels.ts';
import { readPipLine, type Step } from './pipProgress.ts';

const found: Found = {
  name: 'diagram-000.png',
  where: 3,
  lines: [
    { t: 'Compact bone', b: [0.20, 0.01, 0.40, 0.05] },
    { t: '-Periosteum', b: [0.21, 0.12, 0.37, 0.17] },
    { t: 'Compact', b: [0.67, 0.86, 0.80, 0.92] },
    { t: 'bone at', b: [0.67, 0.91, 0.78, 0.95] },
    { t: 'break site', b: [0.67, 0.95, 0.81, 0.99] },
    { t: '2. Callus formation', b: [0.20, 0.96, 0.49, 1.0] },
  ],
};

describe('labels chosen from the text on a diagram', () => {
  it('turns a label over several lines into one box around all of them', () => {
    const [label] = toLabels(found, { labels: [{ lines: [2, 3, 4], answer: 'Compact bone at break site' }] });
    assert.equal(label.answer, 'Compact bone at break site');
    const [x0, y0, x1, y1] = label.box;
    assert.ok(x0 < 0.67 && y0 < 0.86 && x1 > 0.81 && y1 > 0.98);
  });

  it('drops the marks a pointer line leaves on a label', () => {
    const [label] = toLabels(found, { labels: [{ lines: [1], answer: '-Periosteum' }] });
    assert.equal(label.answer, 'Periosteum');
  });

  it('ignores lines that do not exist or were already used, and keeps alternatives', () => {
    const labels = toLabels(found, { labels: [
      { lines: [0], answer: 'Compact bone', accept: ['cortical bone'] },
      { lines: [0, 99], answer: 'Again' },
      { lines: [], answer: 'Nothing' },
    ] });
    assert.equal(labels.length, 1);
    assert.deepEqual(labels[0].accept, ['cortical bone']);
  });

  it('keeps a box inside the picture', () => {
    assert.deepEqual(unionBox([{ t: 'x', b: [0, 0, 1, 1] }]), [0, 0, 1, 1]);
  });
});

describe('reading the download progress', () => {
  const start: Step = { stage: 'Starting…', file: null, files: 0, done: 0, total: 0, installing: false };

  it('follows each file and how much of it has come down', () => {
    let s = readPipLine(start, 'Downloading onnxruntime-1.30.0-cp314-cp314-macosx_14_0_arm64.whl (17.2 MB)');
    assert.equal(s.file, 'onnxruntime');
    assert.equal(s.files, 1);
    s = readPipLine(s, 'Progress 4194304 of 18034123');
    assert.equal(s.done, 4194304);
    assert.equal(s.total, 18034123);
    s = readPipLine(s, '  Downloading opencv_python-5.0.0.93-cp37-abi3-macosx_13_0_arm64.whl (40 MB)');
    assert.equal(s.file, 'opencv-python');
    assert.equal(s.done, 0);
  });

  it('notices when the packages are being installed', () => {
    const s = readPipLine(start, 'Installing collected packages: pyclipper, onnxruntime, rapidocr');
    assert.equal(s.installing, true);
  });
});

describe('one question per diagram', () => {
  const label = (answer: string) => ({ box: [0, 0, 0.1, 0.1] as [number, number, number, number], answer });
  const healing = ['Compact bone', 'Medullary cavity', 'Periosteum', 'Hematoma'].map(label);

  it('treats the same diagram used again as a repeat, even with a label read differently', () => {
    assert.equal(repeats(['Compact bone', 'Medullary cavity', 'Periosteum.', 'Haematoma'].map(label), [healing]), true);
  });

  it('keeps a different diagram that shares a label or two', () => {
    assert.equal(repeats(['Periosteum', 'Sequestrum', 'Involucrum', 'Sinus tract'].map(label), [healing]), false);
  });
});

describe('only labels the lecture teaches', () => {
  const lecture = taughtIn([
    'Fracture healing. A haematoma forms at the break. Osteoclasts remove the dead bone, then soft callus and hard callus form. Woven bone is later remodelled into lamellar bone.',
    'The periosteum supplies osteoprogenitor cells.\n\n[Figures on this page]\nThe diagram labels the femoral artery, the patella and compact bone.',
  ]);
  const label = (answer: string, accept?: string[]) => ({ answer, accept });

  it('accepts labels the text teaches, across spellings and plurals', () => {
    assert.equal(isTaught(label('Hematoma'), lecture), true);
    assert.equal(isTaught(label('Osteoclast'), lecture), true);
    assert.equal(isTaught(label('Woven bone'), lecture), true);
    assert.equal(isTaught(label('Periosteum'), lecture), true);
  });

  it('does not count what only the picture itself shows', () => {
    assert.equal(isTaught(label('Femoral artery'), lecture), false);
    assert.equal(isTaught(label('Patella'), lecture), false);
    assert.equal(isTaught(label('Compact bone'), lecture), false);
  });

  it('takes a synonym the lecture uses', () => {
    assert.equal(isTaught(label('Sequestrum', ['dead bone']), lecture), true);
  });

  it('needs the words of a longer label close together', () => {
    assert.equal(isTaught(label('Hard callus'), lecture), true);
    assert.equal(isTaught(label('Lamellar periosteum'), lecture), false);
    assert.equal(isTaught(label('Compact bone'), taughtIn(['The outer layer is compact\nbone, the inner layer spongy bone.'])), true);
  });

  it('drops the picture description at the end of a page', () => {
    assert.equal(withoutPictures('Text.\n\n[Picture on this slide]\nA heart.'), 'Text.');
  });
});

describe('a whole-system picture used for one part', () => {
  const skeleton = ['Skull', 'Clavicle', 'Humerus', 'Femur', 'Tibia'].map((t, i) => ({ t, b: [0.1, i / 10, 0.3, i / 10 + 0.05] as [number, number, number, number] }));
  const pages = [
    { sourceId: 1, unit: 3, text: 'Osteomyelitis most often affects the femur, at the metaphysis of the long bone.' },
    { sourceId: 1, unit: 4, text: 'Skull\nClavicle\nHumerus\nFemur\nTibia' },
    { sourceId: 1, unit: 5, text: 'Treatment of femoral osteomyelitis: antibiotics and drainage.' },
  ];
  const label = (answer: string) => ({ answer });

  it('sees that a slide only repeats the labels of its own picture', () => {
    assert.equal(echoes(skeleton, pages[1].text), true);
    assert.equal(echoes(skeleton, pages[0].text), false);
  });

  it('hides only the part the lecture teaches', () => {
    const taught = evidenceFor(pages, 1, 4, skeleton);
    assert.deepEqual(['Skull', 'Clavicle', 'Humerus', 'Femur', 'Tibia'].filter((t) => isTaught(label(t), taught)), ['Femur']);
  });

  it('still counts a page with real teaching of its own', () => {
    const own = [{ sourceId: 2, unit: 0, text: 'The tibia and fibula form the lower leg; the tibia bears the weight.' }];
    const legs = [{ t: 'Tibia', b: [0, 0, 0.1, 0.1] as [number, number, number, number] }, { t: 'Fibula', b: [0, 0.2, 0.1, 0.3] as [number, number, number, number] }, { t: 'Patella', b: [0, 0.4, 0.1, 0.5] as [number, number, number, number] }];
    const taught = evidenceFor(own, 2, 0, legs);
    assert.equal(isTaught(label('Tibia'), taught), true);
    assert.equal(isTaught(label('Patella'), taught), false);
  });
});
