// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Douglas P. Fields, Jr. <symbolics@lisp.engineer>
export class Detector {
  constructor({ minSpan = 240, minRepeats = 4, maxPhrase = 256, window = 4096 } = {}) {
    for (const [name, value, min, max] of [
      ['minSpan', minSpan, 32, 16384], ['minRepeats', minRepeats, 3, 100],
      ['maxPhrase', maxPhrase, 2, 1024], ['window', window, 256, 16384],
    ]) if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    if (minSpan > window) throw new Error('minSpan must not exceed window');
    Object.assign(this, { minSpan, minRepeats, maxPhrase, window });
    this.buffer = '';
    this.fenced = false;
    this.line = '';
  }
  push(delta) {
    // Parse fences across event boundaries; never inspect fenced code/art.
    let prose = '';
    for (const char of delta) {
      this.line = (this.line + char).slice(-512);
      if (char === '\n') {
        if (/^\s*(```|~~~)/.test(this.line)) this.fenced = !this.fenced;
        this.line = '';
      }
      if (!this.fenced) prose += char;
    }
    if (this.fenced || /^\s*(```|~~~)/.test(this.line)) { this.buffer = ''; return null; }
    this.buffer = (this.buffer + prose).slice(-this.window);
    const text = this.buffer.toLowerCase().replace(/\s+/g, ' ').trimEnd();
    for (let period = 2; period <= Math.min(this.maxPhrase, text.length / this.minRepeats); period++) {
      let matched = 0;
      for (let i = text.length - 1; i >= period && text[i] === text[i - period]; i--) matched++;
      const span = matched + period;
      const phrase = text.slice(-period);
      if (span >= this.minSpan && span >= period * this.minRepeats && /\p{L}|\p{N}/u.test(phrase)) {
        return { phrase, repeats: Math.floor(span / period), span };
      }
    }
    return null;
  }
}
