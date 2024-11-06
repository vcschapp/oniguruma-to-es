import {compile, toRegExp} from '../dist/index.mjs';
import {r} from '../src/utils.js';
import {maxTestTargetForPatternMods} from './helpers/features.js';
import {matchers} from './helpers/matchers.js';

beforeEach(() => {
  jasmine.addMatchers(matchers);
});

describe('Assertion', () => {
  // [Note] For kinds `lookahead` and `lookbehind`, see `match-lookaround.spec.js`

  describe('line_end', () => {
    it('should match at the end of the string', () => {
      expect('ba').toFindMatch('a$');
    });

    it('should match before a line feed', () => {
      expect('ba\nb').toFindMatch('a$');
    });

    it('should not match before line breaks other than line feed', () => {
      expect([
        'ba\rb', 'ba\r\nb', 'ba\u{2028}b', 'ba\u{2029}b',
      ]).not.toFindMatch('a$');
    });

    it('should not match at positions other than the end of the string or before a line feed', () => {
      expect('ab').not.toFindMatch('a$');
    });
  });

  describe('line_start', () => {
    it('should match at the start of the string', () => {
      expect('ab').toFindMatch('^a');
    });

    it('should match after a line feed', () => {
      expect([
        'b\nab', 'b\r\nab',
      ]).toFindMatch('^a');
    });

    it('should not match after line breaks other than line feed', () => {
      expect([
        'b\rab', 'b\u{2028}ab', 'b\u{2029}ab',
      ]).not.toFindMatch('^a');
    });

    it('should not match at positions other than the start of the string or after a line feed', () => {
      expect('ba').not.toFindMatch('^a');
    });
  });

  describe('search_start', () => {
    // TODO: Consider enabling `avoidSubclass` for all of these except when specifically testing
    // subclass strategies

    it('should match at the start of the search', () => {
      expect('a').toExactlyMatch(r`\Ga`);
      expect([
        'a', 'b', 'hello',
      ]).toExactlyMatch(r`\Ga|\Gb|\G\w+`);
    });

    it('should not match at positions other than the start of the search', () => {
      expect('ba').not.toFindMatch(r`\Ga`);
    });

    it('should match only at the start of the search when applied repeatedly', () => {
      expect('abbcbb'.match(toRegExp(r`\G[ab]`, '', {global: true}))).toEqual(['a', 'b', 'b']);
    });

    // Unsupported; not emulatable without a subclass
    it('should throw if not used at the start of every top-level alternative', () => {
      expect(() => compile(r`a\G`)).toThrow();
      expect(() => compile(r`\Ga|b`)).toThrow();
      expect(() => compile(r`a|\Gb`)).toThrow();
    });

    it('should allow if following a directive', () => {
      expect('a').toExactlyMatch(r`\K\Ga`);
      expect('a').toExactlyMatch({
        pattern: r`(?i)\Ga`,
        maxTestTarget: maxTestTargetForPatternMods,
      });
      expect('a').toExactlyMatch({
        pattern: r`(?i)(?m)\Ga`,
        maxTestTarget: maxTestTargetForPatternMods,
      });
    });

    it('should allow if following an assertion', () => {
      expect('a').toExactlyMatch(r`\A\Ga`);
      expect('a').toExactlyMatch(r`\b\Ga`);
      expect('a').toExactlyMatch(r`(?=a)\Ga`);
      expect('a').toExactlyMatch(r`(?<=\A)\Ga`);
      expect('a').toExactlyMatch(r`(?<!a)\Ga`);
      expect('a').toExactlyMatch(r`(?<!a)(?=a)\Ga`);
    });

    it('should allow if following a 0-min quantified token', () => {
      expect('a').toExactlyMatch(r`a*\Ga`);
      expect('a').toExactlyMatch(r`(a)*\Ga`);
      expect('a').toExactlyMatch(r`[a]*\Ga`);
    });

    it('should throw if following a non-0-min quantified token', () => {
      expect(() => compile(r`a+\G`)).toThrow();
      expect(() => compile(r`a+?\G`)).toThrow();
      expect(() => compile(r`(a)+\G`)).toThrow();
    });

    it('should check within groups to determine validity', () => {
      expect('a').toExactlyMatch(r`(\Ga)`);
      expect('a').toExactlyMatch(r`(?:(?>^(?<n>\Ga)))`);
      expect(() => compile(r`(?:(?>a(?<n>\Gb)))`)).toThrow();
      expect('a').toExactlyMatch(r`\Ga|(((\Gb)))`);
      expect(() => compile(r`\Ga|(((b\Gc)))`)).toThrow();
      expect(['ac', 'bc']).toExactlyMatch(r`((\Ga|\Gb)c)`);
      expect(() => compile(r`((\Ga|b)c)`)).toThrow();
    });

    it('should throw if leading in a non-0-min quantified group', () => {
      expect(() => compile(r`(\Ga)+`)).toThrow();
      expect(() => compile(r`(\Ga)+\G`)).toThrow();
    });

    it('should allow if leading in a leading positive lookahead', () => {
      expect('a').toExactlyMatch(r`(?=\G)a`);
      expect('a').toExactlyMatch(r`(?=\Ga)a`);
      expect('aaba'.match(toRegExp(r`(?=\Ga)a`, '', {global: true}))).toEqual(['a', 'a']);
      expect(['a', 'b']).toExactlyMatch(r`(?=\G)a|\Gb`);
      // Similar but not covered
      [ r`(?=\G|)a`,
        r`(?:(?=\G))?a`,
        r`(?=\G)a|b`,
      ].forEach(pattern => {
        expect(() => compile(pattern, '', {avoidSubclass: true})).toThrow();
      });
    });

    it('should allow if trailing in a leading positive lookbehind', () => {
      expect('a').toExactlyMatch(r`(?<=\G)a`);
      expect(['aa', 'abaa']).not.toFindMatch(r`(?<=a\G)a`);
      let re = toRegExp(r`(?<=a\G)a`);
      re.lastIndex = 3;
      expect(re.exec('abaa')?.index).toBe(3);
      expect(['a', 'b']).toExactlyMatch(r`(?<=\G)a|\Gb`);
      // Similar but not covered
      [ r`(?<=\G|)a`,
        r`(?:(?<=\G))?a`,
        r`(?<=\G)a|b`,
      ].forEach(pattern => {
        expect(() => compile(pattern, '', {avoidSubclass: true})).toThrow();
      });
    });

    it('should throw if leading in a leading positive lookbehind', () => {
      // [Oniguruma] Matches at index 3 within `abc`, but doesn't match within `aabc`
      // [TODO] Emulatable by replacing `\G` with `^`, slicing the string to `lastIndex`, and doing
      // a non-sticky search
      expect(() => compile(r`(?<=\Gabc)`)).toThrow();
    });

    it('should throw if leading in a leading negative lookaround', () => {
      expect(() => compile(r`(?!\G)a`, '', {avoidSubclass: true})).toThrow();
      expect(() => compile(r`(?<!\G)a`, '', {avoidSubclass: true})).toThrow();
    });

    // Just documenting current behavior
    it('should throw for redundant but otherwise supportable assertions', () => {
      expect(() => compile(r`\G\Ga`)).toThrow();
      expect(() => compile(r`\Ga|\G\Gb`)).toThrow();
    });

    // Note: Could support by replacing `\G` with `(?!)`, but these forms aren't useful
    it('should throw at unmatchable positions', () => {
      expect(() => compile(r`a\Gb`)).toThrow();
      expect(() => compile(r`(?<=a\Gb)`)).toThrow();
      expect(() => compile(r`(?=a\Gb)`)).toThrow();
      expect(() => compile(r`(?=ab\G)`)).toThrow();
    });

    it('should allow unsupported forms if using loose accuracy', () => {
      const patterns = [
        r`a\G`,
        r`\G|`,
      ];
      patterns.forEach(pattern => {
        expect(() => compile(pattern)).toThrow();
        expect(toRegExp(pattern, '', {accuracy: 'loose'}).sticky).toBe(true);
      });
    });

    describe('subclass strategies', () => {
      // Leading `(^|\G)` and similar
      it('should apply line_or_search_start', () => {
        // Matches with `^` since not global
        expect(toRegExp(r`(^|\G)a`).exec('b\na')?.index).toBe(2);
        // Match the first 3 and last 1
        expect('aaabaaacaa\na'.match(toRegExp(
          r`(^|\G)a`, '', {global: true}
        ))).toEqual(['a', 'a', 'a', 'a']);
        expect(toRegExp(r`(?:^|\G)a`).exec('b\na')?.index).toBe(2);
        expect(toRegExp(r`(\G|^)a`).exec('b\na')?.index).toBe(2);
        expect(toRegExp(r`(?:(\G|^)a)`).exec('b\na')?.index).toBe(2);
        expect(toRegExp(r`((\G|^)a)`).exec('b\na')?.index).toBe(2);
      });

      // Leading `(?!\G)` and similar
      it('should apply not_search_start', () => {
        // Leading
        expect(toRegExp(r`(?!\G)a`).exec('aba')?.index).toBe(2);
        expect(toRegExp(r`(?<!\G)a`).exec('aba')?.index).toBe(2);
        expect(toRegExp(r`(?:(?!\G)a)`).exec('aba')?.index).toBe(2);
        expect(toRegExp(r`((?!\G)a)`).exec('aba')?.index).toBe(2);
        // Only assertions
        expect(toRegExp(r`(?<=;)(?!\G)`).exec(';;')?.index).toBe(1);
        expect(toRegExp(r`(?!\G)(?=;)^`).exec(';;\n;')?.index).toBe(3);
        expect(toRegExp(r`(?=;)(?!\G)^`).exec(';;\n;')?.index).toBe(3);
        expect(toRegExp(r`(?=;)^(?!\G)`).exec(';;\n;')?.index).toBe(3);
      });

      // Leading `(?<=\G|…)` and similar
      it('should apply after_search_start_or_subpattern', () => {
        expect(toRegExp(r`(?<=\G|a)b`).exec('ba')?.index).toBe(0);
        expect(toRegExp(r`(?<=\G|a)b`).exec('aba')?.index).toBe(1);
        expect(toRegExp(r`(?<=\G|a)b`).exec('aaba')?.index).toBe(2);
        expect(toRegExp(r`(?<=\G|a)b`).exec('cbbab')?.index).toBe(4);
        expect(toRegExp(r`((?<=xy?|\G|a)b)`).exec('cbbab')?.index).toBe(4);
        expect(toRegExp(r`(?<=\G|a)b`).exec('cbba')).toBeNull();
      });
    });
  });

  describe('string_end', () => {
    it('should match at the end of the string', () => {
      expect('ba').toFindMatch(r`a\z`);
    });

    it('should not match before line breaks', () => {
      expect([
        'ba\nb', 'ba\rb', 'ba\r\nb', 'ba\u{2028}b', 'ba\u{2029}b',
      ]).not.toFindMatch(r`a\z`);
    });

    it('should not match at positions other than the end of the string', () => {
      expect('ab').not.toFindMatch(r`a\z`);
    });
  });

  describe('string_end_newline', () => {
    it('should match at the end of the string', () => {
      expect('ba').toFindMatch(r`a\Z`);
    });

    it('should match before a string-terminating line feed', () => {
      expect('ba\n').toFindMatch(r`a\Z`);
    });

    it('should not match before a non-string-terminating line feed', () => {
      expect('ba\nb').not.toFindMatch(r`a\Z`);
    });

    it('should not match before string-terminating line breaks other than line feed', () => {
      expect([
        'ba\r', 'ba\r\n', 'ba\u{2028}', 'ba\u{2029}',
      ]).not.toFindMatch(r`a\Z`);
    });

    it('should not match at positions other than the end of the string or string-terminating line feed', () => {
      expect('ab').not.toFindMatch(r`a\Z`);
    });
  });

  describe('string_start', () => {
    it('should match at the start of the string', () => {
      expect('ab').toFindMatch(r`\Aa`);
    });

    it('should not match after line breaks', () => {
      expect([
        'b\nab', 'b\rab', 'b\r\nab', 'b\u{2028}ab', 'b\u{2029}ab',
      ]).not.toFindMatch(r`\Aa`);
    });

    it('should not match at positions other than the start of the string', () => {
      expect('ba').not.toFindMatch(r`\Aa`);
    });
  });

  describe('word_boundary', () => {
    describe('positive', () => {
      it('should match at ASCII word boundaries', () => {
        expect([
          'a', 'Is a.',
        ]).toFindMatch(r`\ba\b`);
      });

      it('should not match at ASCII word non-boundaries', () => {
        expect([
          'ba', '0a', '_a',
        ]).not.toFindMatch(r`\ba\b`);
      });

      it('should match at Unicode word boundaries', () => {
        expect([
          '日本語', '！日本語。',
        ]).toFindMatch(r`\b日本語\b`);
      });

      it('should not match at Unicode word non-boundaries', () => {
        expect([
          '日本語です', '0日本語',
        ]).not.toFindMatch(r`\b日本語\b`);
      });
    });

    describe('negative', () => {
      it('should not match at ASCII word boundaries', () => {
        expect([
          'a', 'Is a.',
        ]).not.toFindMatch(r`\Ba\B`);
      });

      it('should match at ASCII word non-boundaries', () => {
        expect([
          'bab', '0a0', '_a_',
        ]).toFindMatch(r`\Ba\B`);
      });

      it('should not match at Unicode word boundaries', () => {
        expect([
          '日本語', '！日本語。',
        ]).not.toFindMatch(r`\B日本語\B`);
      });

      it('should match at Unicode word non-boundaries', () => {
        expect([
          'これは日本語です', '0日本語0',
        ]).toFindMatch(r`\B日本語\B`);
      });
    });
  });
});
