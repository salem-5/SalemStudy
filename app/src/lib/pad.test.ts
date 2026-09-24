import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { htmlToMarkdown, restoreNoteImages } from './pad.ts';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const jpg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD';
const note = `<h1>Cells</h1><p>A diagram:</p><img src="${png}" alt="mitosis"><p>And a photo:</p><img src="${jpg}" alt="slide" width="320">`;

describe('pictures in notes, as the AI reads and rewrites them', () => {
  it('shows each picture as a short placeholder instead of its data', () => {
    const md = htmlToMarkdown(note);
    assert.match(md, /!\[mitosis\]\(note-image:1\)/);
    assert.match(md, /!\[slide\]\(note-image:2\)/);
    assert.doesNotMatch(md, /base64/);
  });

  it('numbers the pictures afresh every time a note is read', () => {
    htmlToMarkdown(note);
    assert.match(htmlToMarkdown(note), /note-image:1\)/);
  });

  it('puts the pictures back when the note is written again', () => {
    const rewritten = '# Cells, revised\n\n![mitosis](note-image:1)\n\nNew text.\n\n![slide](note-image:2)';
    const restored = restoreNoteImages(rewritten, note);
    assert.ok(restored.includes(`(${png})`));
    assert.ok(restored.includes(`(${jpg})`));
    assert.doesNotMatch(restored, /note-image:/);
  });

  it('leaves a placeholder alone when there is no picture for it', () => {
    assert.equal(restoreNoteImages('![x](note-image:5)', note), '![x](note-image:5)');
  });
});
