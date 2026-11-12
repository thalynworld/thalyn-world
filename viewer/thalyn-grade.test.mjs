// ★ A15440 bench: node viewer/thalyn-grade.test.mjs → ALL PASS. Pure: thalyn-grade.js only.
import { gradeFromBlock, describeGrade } from './thalyn-grade.js';

let fails = 0, passes = 0;
const check = (name, ok, detail = '') => { ok ? passes++ : fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// no block / present false / an older export → null (the viewer's table, unchanged)
check('no tx', gradeFromBlock(null) === null);
check('no grade key', gradeFromBlock({ tone: 'Serene' }) === null);
check('present false (client gate OFF)', gradeFromBlock({ grade: { present: false, saturation: 50 } }) === null);
check('describe null', describeGrade(null).includes("per-tone table"));

// a typical day walk: ACES, EV 0, sat 10, con 5, vignette 0.25, threshold 1.1
const day = gradeFromBlock({ grade: { present: true, postOn: true, tonemapper: 'ACES', postExposure: 0, contrast: 5, saturation: 10, hueShift: 0,
  colorFilter: [1, 1, 1], temperature: 0, tint: 0, bloomIntensity: 0.3, bloomThreshold: 1.1, bloomScatter: 0.7, vignetteIntensity: 0.25, vignetteSmoothness: 0.4 } });
check('day: aces', day.toneMapping === 'aces');
check('day: exposure 1', near(day.exposure, 1));
check('day: sat 1.10', near(day.grade.sat, 1.10));
check('day: con 1.05', near(day.grade.con, 1.05));
check('day: vig 0.25', near(day.grade.vig, 0.25));
check('day: tint white', day.grade.tint.every(x => near(x, 1)));
check('day: threshold 1.1', near(day.threshold, 1.1));
check('day: no bloom strength override', day.grade.bloom === undefined);
check('day: no notes', day.notes.length === 0, JSON.stringify(day.notes));

// night: EV -0.8 → 2^-0.8
const night = gradeFromBlock({ grade: { present: true, postOn: true, tonemapper: 'ACES', postExposure: -0.8, saturation: -20, contrast: 0, colorFilter: [0.9, 0.95, 1.1] } });
check('night: exposure 2^-0.8', near(night.exposure, Math.pow(2, -0.8)));
check('night: sat 0.8', near(night.grade.sat, 0.8));
check('night: colour filter rides the tint', near(night.grade.tint[0], 0.9) && near(night.grade.tint[2], 1.1));
check('night: no threshold = viewer', night.threshold === null);

// clamps + edge words
check('exposure clamped high', near(gradeFromBlock({ grade: { present: true, postExposure: 5 } }).exposure, 2.5));
check('exposure clamped low', near(gradeFromBlock({ grade: { present: true, postExposure: -5 } }).exposure, 0.3));
check('sat -100 = grey, never negative', near(gradeFromBlock({ grade: { present: true, saturation: -150 } }).grade.sat, 0));
check('neutral kept', gradeFromBlock({ grade: { present: true, tonemapper: 'Neutral' } }).toneMapping === 'neutral');
check('none kept', gradeFromBlock({ grade: { present: true, tonemapper: 'None' } }).toneMapping === 'none');
const odd = gradeFromBlock({ grade: { present: true, tonemapper: 'Custom', hueShift: 12 } });
check('unknown tonemapper → aces + note', odd.toneMapping === 'aces' && odd.notes.some(n => n.includes('unknown')));
check('hue shift named', odd.notes.some(n => n.includes('hue shift')));
const warm = gradeFromBlock({ grade: { present: true, temperature: 50, tint: 0 } });
check('warm WB: red up, blue down', warm.grade.tint[0] > 1 && warm.grade.tint[2] < 1 && warm.notes.some(n => n.includes('white balance')));

// post OFF in the walk → identity grade, no bloom, no tone mapping
const off = gradeFromBlock({ grade: { present: true, postOn: false, saturation: 40 } });
check('post off: identity', off.grade.sat === 1 && off.grade.con === 1 && off.grade.vig === 0 && off.grade.bloom === 0 && off.toneMapping === 'none');
check('describe line', describeGrade(day).startsWith("[grade] A15440 the walk's grade: tonemap aces"), describeGrade(day));

console.log(fails === 0 ? `ALL PASS (${passes})` : `${fails} FAIL / ${passes} pass`);
process.exit(fails === 0 ? 0 : 1);
