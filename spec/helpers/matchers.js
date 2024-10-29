import {toRegExp} from '../../dist/index.mjs';
import {EsVersion} from '../../src/utils.js';

function getArgs(actual, expected) {
  const opts = {
    pattern: typeof expected === 'string' ? expected : expected.pattern,
    flags: expected.flags ?? '',
    maxTarget: expected.maxTarget ?? null,
  };
  const targets = ['ES2018', 'ES2024', 'ESNext'];
  const targeted = opts.maxTarget ?
    targets.filter(target => EsVersion[target] <= EsVersion[opts.maxTarget]) :
    targets;
  return {
    pattern: opts.pattern,
    flags: opts.flags,
    strings: Array.isArray(actual) ? actual : [actual],
    targets: targeted,
  };
}

function matchedFullStr(match, str) {
  return !!match && match.index === 0 && match[0].length === str.length;
}

// Expects `negate` to be set by `negativeCompare` and doesn't rely on Jasmine's automatic matcher
// negation because when negated we don't want to early return `true` when looping over the array
// of strings and one is found to not match; they all need to not match
function matchWithAllTargets({pattern, flags, strings, targets}, {exact, negate}) {
  for (const target of targets) {
    const re = toRegExp(pattern, flags, {target});
    for (const str of strings) {
      // In case `flags` included `y`
      re.lastIndex = 0;
      const match = re.exec(str);
      const failed = negate ?
        ((exact && matchedFullStr(match, str)) || (!exact && match)) :
        ((exact && !matchedFullStr(match, str)) || (!exact && !match));
      if (failed) {
        return {
          pass: false,
          message: `Expected "${pattern}" ${flags ? `(flags ${flags}) ` : ''}${negate ? 'not ' : ''}to ${exact ? 'exactly match' : 'match within'} "${str}" (${target})`,
        };
      }
    }
  }
  return {pass: true};
}

export const matchers = {
  toFindMatch() {
    return {
      compare(actual, expected) {
        return matchWithAllTargets(getArgs(actual, expected), {exact: false});
      },
      negativeCompare(actual, expected) {
        return matchWithAllTargets(getArgs(actual, expected), {exact: false, negate: true});
      },
    };
  },
  toExactlyMatch() {
    return {
      compare(actual, expected) {
        return matchWithAllTargets(getArgs(actual, expected), {exact: true});
      },
      negativeCompare(actual, expected) {
        return matchWithAllTargets(getArgs(actual, expected), {exact: true, negate: true});
      },
    };
  },
};