'use strict';

// The map's symbols, drawn by the same code on the game screen and in the phone's onboarding, so
// what a student is shown on their phone is exactly what they then find on the big screen.
// Every function takes the 2D context to draw on; sizes are in map pixels.

const MARK = '#ffd23f';   // the yellow of the markers, the star and the action button

// The action button's icon, a pointing hand: '#' is the outline, 'o' the fill, '.' transparent.
const HAND = [
  '.....##.........',
  '....#oo#........',
  '....#oo#........',
  '....#oo#........',
  '....#oo###......',
  '....#oo#oo##....',
  '....#oo#oo#o##..',
  '.##.#oo#oo#oo#..',
  '#oo##oooooooo#..',
  '#ooo#oooooooo#..',
  '.#ooooooooooo#..',
  '..#oooooooooo#..',
  '..#ooooooooo#...',
  '...#oooooooo#...',
  '....#oooooo#....',
  '....########....',
];
// the same hand at map scale, for the hint that floats over a player's head
const HAND_SMALL = [
  '...##....',
  '..#oo#...',
  '..#oo#...',
  '..#oo###.',
  '.##oo#oo#',
  '#o#ooooo#',
  '#oooooo#.',
  '.#ooooo#.',
  '..#####..',
];

function drawBitmap(ctx, rows, x, y, s = 1, fill = '#fff') {
  for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r].length; c++) {
    const ch = rows[r][c];
    if (ch === '.') continue;
    ctx.fillStyle = ch === '#' ? '#000' : fill;
    ctx.fillRect(x + c * s, y + r * s, s, s);
  }
}
// a bitmap as an image URL, for <img> tags on the phone
function bitmapURL(rows, s = 1, fill = '#fff') {
  const c = document.createElement('canvas');
  c.width = rows[0].length * s; c.height = rows.length * s;
  drawBitmap(c.getContext('2d'), rows, 0, 0, s, fill);
  return c.toDataURL();
}

// "!" over every event; `by` is its bottom
function drawBang(ctx, cx, by, col = MARK) {
  ctx.fillStyle = '#000';
  ctx.fillRect(cx - 3, by - 13, 6, 13);
  ctx.fillStyle = col;
  ctx.fillRect(cx - 2, by - 12, 4, 7);
  ctx.fillRect(cx - 2, by - 3, 4, 2);
}
// the star by the tree, where the results are collected
function drawStar(ctx, cx, by) {
  ctx.fillStyle = '#000';
  ctx.fillRect(cx - 5, by - 12, 10, 12);
  ctx.fillStyle = MARK;
  ctx.fillRect(cx - 1, by - 11, 2, 10);
  ctx.fillRect(cx - 4, by - 7, 8, 2);
  ctx.fillRect(cx - 3, by - 9, 6, 6);
}
// a floor number, as the black-and-yellow display above each lift door
function drawFloorTag(ctx, cx, top, n) {
  ctx.fillStyle = '#000';
  ctx.fillRect(cx - 6, top, 13, 11);
  ctx.fillStyle = MARK;
  ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(String(n), cx + 0.5, top + 9);
}
// a lab's sign: its name on a plaque in the lab's colour
const SIGN_FONT = 'bold 9px monospace', SIGN_H = 11;
function labSignWidth(ctx, lab) { ctx.font = SIGN_FONT; return Math.ceil(ctx.measureText(lab.name).width) + 6; }
function drawLabSign(ctx, cx, top, lab) {
  const w = labSignWidth(ctx, lab), x = Math.round(cx - w / 2);
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#000';
  ctx.fillRect(x, top, w, SIGN_H);
  ctx.fillStyle = lab.color;
  ctx.fillRect(x + 1, top + 1, w - 2, SIGN_H - 2);
  ctx.fillStyle = '#000';
  ctx.fillText(lab.name, cx, top + 8);
}
// the action button in miniature, floated over a player who can use it right where they stand
function drawActButton(ctx, cx, cy) {
  ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = MARK;
  ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.fill();
  drawBitmap(ctx, HAND_SMALL, cx - 4, cy - 5);
}
