import {TokenCharacterSetKinds, TokenDirectiveKinds, TokenGroupKinds, TokenTypes} from './tokenizer.js';
import {JsUnicodePropertiesMap, normalize, PosixProperties} from './unicode.js';

const AstTypes = {
  Alternative: 'Alternative',
  Assertion: 'Assertion',
  Backreference: 'Backreference',
  CapturingGroup: 'CapturingGroup',
  Character: 'Character',
  CharacterClass: 'CharacterClass',
  CharacterClassIntersection: 'CharacterClassIntersection',
  CharacterClassRange: 'CharacterClassRange',
  CharacterSet: 'CharacterSet',
  Directive: 'Directive',
  Flags: 'Flags',
  Group: 'Group',
  Pattern: 'Pattern',
  Quantifier: 'Quantifier',
  RegExp: 'RegExp',
  Subroutine: 'Subroutine',
  VariableLengthCharacterSet: 'VariableLengthCharacterSet',
};

const AstAssertionKinds = {
  line_end: 'line_end',
  line_start: 'line_start',
  lookahead: 'lookahead',
  lookbehind: 'lookbehind',
  search_start: 'search_start',
  string_end: 'string_end',
  string_end_newline: 'string_end_newline',
  string_start: 'string_start',
  word_boundary: 'word_boundary',
};

// Identical values
const AstCharacterSetKinds = TokenCharacterSetKinds;
const AstDirectiveKinds = TokenDirectiveKinds;

const AstVariableLengthCharacterSetKinds = {
  newline: 'newline',
  grapheme: 'grapheme',
};

function parse({tokens, flags}, {optimize} = {}) {
  const context = {
    current: 0,
    namedGroups: new Map(),
    capturingGroups: [],
    subroutines: [],
    hasNumberedGroupRef: false,
    walk: parent => {
      let token = tokens[context.current];
      // Advance for the next iteration
      context.current++;
      switch (token.type) {
        case TokenTypes.Alternator:
          // Only handles top-level alternation; groups handle their own alternators
          return createAlternative(parent.parent);
        case TokenTypes.Assertion:
          return createAssertionFromToken(parent, token);
        case TokenTypes.Backreference:
          return parseBackreference(context, parent, token);
        case TokenTypes.Character:
          return createCharacter(parent, token.value);
        case TokenTypes.CharacterClassHyphen:
          return parseCharacterClassHyphen(context, parent, tokens[context.current]);
        case TokenTypes.CharacterClassOpen:
          return parseCharacterClassOpen(context, parent, token.negate, tokens, optimize);
        case TokenTypes.CharacterSet:
          return createCharacterSetFromToken(parent, token);
        case TokenTypes.Directive:
          return createDirectiveFromToken(parent, token);
        case TokenTypes.GroupOpen:
          return parseGroupOpen(context, parent, token, tokens, optimize);
        case TokenTypes.Quantifier:
          return parseQuantifier(parent, token);
        case TokenTypes.Subroutine:
          return parseSubroutine(context, parent, token);
        case TokenTypes.VariableLengthCharacterSet:
          return createVariableLengthCharacterSet(parent, token.kind);
        default:
          throw new Error(`Unexpected token type "${token.type}"`);
      }
    },
  };

  const ast = createRegExp(null, flags);
  let top = ast.pattern.alternatives[0];
  while (context.current < tokens.length) {
    const node = context.walk(top);
    if (node.type === AstTypes.Alternative) {
      ast.pattern.alternatives.push(node);
      top = node;
    } else {
      top.elements.push(node);
    }
  }

  if (context.hasNumberedGroupRef && context.namedGroups.size) {
    throw new Error('Numbered backref/subroutine not allowed when using named capture');
  }
  for (const {ref} of context.subroutines) {
    if (typeof ref === 'number') {
      // Relative nums are already resolved
      if (ref < 1 || ref > context.capturingGroups.length) {
        throw new Error('Subroutine uses a group number that is not defined');
      }
    } else if (!context.namedGroups.has(ref)) {
      throw new Error(`Subroutine uses a group name that is not defined "\\g<${ref}>"`);
    } else if (context.namedGroups.get(ref).length > 1) {
      throw new Error(`Subroutine uses a non-unique group name "\\g<${ref}>"`);
    }
  }
  return ast;
}

// Supported (if the backref appears to the right of the reffed capture's opening paren):
// - `\k<name>`, `\k'name'`
// - When named capture not used:
//   - `\n`, `\nn`, `\nnn`
//   - `\k<n>`, `\k'n'
//   - `\k<-n>`, `\k'-n'`
// Unsupported:
// - `\k<+n>`, `\k'+n'` - Note that, Unlike Oniguruma, Onigmo doesn't support this as special
//   syntax and therefore considers it a valid group name.
// - Backref with recursion level (with num or name): `\k<n+level>`, `\k<n-level>`, etc.
//   (Onigmo also supports `\k<-n+level>`, `\k<-n-level>`, etc.)
// Backrefs in Onig use multiplexing for duplicate group names (the rules can be complicated when
// overlapping with subroutines), but a `Backreference`'s simple `ref` prop doesn't capture these
// details so multiplexed ref pointers need to derived when working with the AST
function parseBackreference(context, parent, token) {
  const {raw} = token;
  const hasKWrapper = /^\\k[<']/.test(raw);
  const ref = hasKWrapper ? raw.slice(3, -1) : raw.slice(1);
  const fromNum = (num, isRelative = false) => {
    const numCapsToLeft = context.capturingGroups.length;
    if (num > numCapsToLeft) {
      throw new Error(`Not enough capturing groups defined to the left "${raw}"`);
    }
    context.hasNumberedGroupRef = true;
    return createBackreference(parent, isRelative ? numCapsToLeft + 1 - num : num);
  };
  if (hasKWrapper) {
    const numberedRef = /^(?<sign>-?)0*(?<num>[1-9]\d*)$/.exec(ref);
    if (numberedRef) {
      return fromNum(+numberedRef.groups.num, !!numberedRef.groups.sign);
    }
    // Invalid in a backref name even when valid in a group name
    if (/[-+]/.test(ref)) {
      throw new Error(`Invalid backref name "${raw}"`);
    }
    if (!context.namedGroups.has(ref)) {
      throw new Error(`Group name not defined to the left "${raw}"`);
    }
    return createBackreference(parent, ref);
  }
  return fromNum(+ref);
}

function parseCharacterClassHyphen(context, parent, nextToken) {
  const prevNode = parent.elements.at(-1);
  if (
    prevNode &&
    prevNode.type !== AstTypes.CharacterClass &&
    nextToken &&
    nextToken.type !== TokenTypes.CharacterClassOpen &&
    nextToken.type !== TokenTypes.CharacterClassClose &&
    nextToken.type !== TokenTypes.CharacterClassIntersector
  ) {
    const nextNode = context.walk(parent);
    if (prevNode.type === AstTypes.Character && nextNode.type === AstTypes.Character) {
      parent.elements.pop();
      const node = createCharacterClassRange(parent, prevNode, nextNode);
      prevNode.parent = node;
      nextNode.parent = node;
      return node;
    }
    throw new Error('Invalid character class range');
  }
  // Literal hyphen
  return createCharacter(parent, 45);
}

function parseCharacterClassOpen(context, parent, negate, tokens, optimize) {
  let node = createCharacterClass(parent, negate);
  const intersection = node.elements[0];
  let nextToken = throwIfUnclosedCharacterClass(tokens[context.current]);
  while (nextToken.type !== TokenTypes.CharacterClassClose) {
    if (nextToken.type === TokenTypes.CharacterClassIntersector) {
      intersection.classes.push(createCharacterClassBase(intersection));
      // Skip the intersector
      context.current++;
    } else {
      const cc = intersection.classes.at(-1);
      cc.elements.push(context.walk(cc));
    }
    nextToken = throwIfUnclosedCharacterClass(tokens[context.current]);
  }
  if (optimize) {
    optimizeCharacterClassIntersection(intersection);
  }
  // Simplify tree if we don't need the intersection wrapper
  if (intersection.classes.length === 1) {
    const cc = intersection.classes[0];
    cc.parent = parent;
    // Only needed if `optimize` is on; otherwise an intersection's direct kids are never negated
    cc.negate = node.negate !== cc.negate;
    node = cc;
  }
  // Skip the closing square bracket
  context.current++;
  return node;
}

function parseGroupOpen(context, parent, token, tokens, optimize) {
  let node = createByGroupKind(parent, token);
  // Track capturing group details for backrefs and subroutines. Track before parsing the group's
  // contents so that nested groups with the same name are tracked in order
  if (node.type === AstTypes.CapturingGroup) {
    context.capturingGroups.push(node);
    if (node.name) {
      if (!context.namedGroups.has(node.name)) {
        context.namedGroups.set(node.name, []);
      }
      context.namedGroups.get(node.name).push(node);
    }
  }
  let nextToken = throwIfUnclosedGroup(tokens[context.current]);
  while (nextToken.type !== TokenTypes.GroupClose) {
    if (nextToken.type === TokenTypes.Alternator) {
      node.alternatives.push(createAlternative(node));
      // Skip the alternator
      context.current++;
    } else {
      const alt = node.alternatives.at(-1);
      alt.elements.push(context.walk(alt));
    }
    nextToken = throwIfUnclosedGroup(tokens[context.current]);
  }
  if (optimize) {
    node = getOptimizedGroup(node);
  }
  // Skip the closing parenthesis
  context.current++;
  return node;
}

function parseQuantifier(parent, token) {
  if (!parent.elements.length) {
    // First child in `Alternative`
    throw new Error('Nothing to repeat');
  }
  const node = createQuantifier(
    parent,
    parent.elements.at(-1),
    token.min,
    token.max,
    token.greedy,
    token.possessive
  );
  node.element.parent = node;
  parent.elements.pop();
  return node;
}

// Onig subroutine behavior:
// - Subroutines can appear before the groups they reference; ex: `\g<1>(a)` is valid.
// - Multiple subroutines can reference the same group.
// - Subroutines can use relative references (backward or forward); ex: `\g<+1>(.)\g<-1>`.
// - Subroutines don't get their own capturing group numbers; ex: `(.)\g<1>\2` is invalid.
// - Subroutines use the flags that apply to their referenced group, so e.g.
//   `(?-i)(?<a>a)(?i)\g<a>` is fully case sensitive.
// - Differences from PCRE/Perl/regex subroutines:
//   - Subroutines can't reference duplicate group names (though duplicate names are valid if no
//     subroutines reference them).
//   - Subroutines can't use absolute or relative numbers if named capture is used anywhere.
//   - Backrefs must be to the right of their group definition, so the backref in
//     `\g<a>\k<a>(?<a>)` is invalid (not directly related to subroutines).
//   - Subroutines don't restore capturing group match values (for backrefs) upon exit, so e.g.
//     `(?<a>(?<b>[ab]))\g<a>\k<b>` matches `abb` but not `aba`; same for numbered.
// The interaction of backref multiplexing (an Onig-specific feature) and subroutines is complex:
// - Only the most recent value matched by a capturing group and its subroutines is considered for
//   backref multiplexing, and this also applies to capturing groups nested within a group that is
//   referenced by a subroutine.
// - Although a subroutine can't reference a group with a duplicate name, it can reference a group
//   with a nested capture whose name is duplicated (e.g. outside of the referenced group).
//   - These duplicate names can then multiplex; but only the most recent value matched from within
//     the outer group and the subroutines that reference it is available for multiplexing.
//   - Ex: With `(?<a>(?<b>[123]))\g<a>\g<a>(?<b>0)\k<b>`, the backref `\k<b>` can only match `0`
//     or whatever was matched by the most recently matched subroutine. If you took out `(?<b>0)`,
//     no multiplexing would occur.
function parseSubroutine(context, parent, token) {
  let ref = token.raw.slice(3, -1);
  const numberedRef = /^(?<sign>[-+]?)0*(?<num>[1-9]\d*)$/.exec(ref);
  if (numberedRef) {
    const num = +numberedRef.groups.num;
    const numCapsToLeft = context.capturingGroups.length;
    context.hasNumberedGroupRef = true;
    ref = {
      '': num,
      '+': numCapsToLeft + num,
      '-': numCapsToLeft + 1 - num,
    }[numberedRef.groups.sign];
  }
  const node = createSubroutine(parent, ref);
  context.subroutines.push(node);
  return node;
}

function createAlternative(parent) {
  return {
    ...getNodeBase(parent, AstTypes.Alternative),
    elements: [],
  };
}

function createAssertionFromToken(parent, token) {
  const base = getNodeBase(parent, AstTypes.Assertion);
  if (token.type === TokenTypes.GroupOpen) {
    return withInitialAlternative({
      ...base,
      kind: token.kind === TokenGroupKinds.lookbehind ?
        AstAssertionKinds.lookbehind :
        AstAssertionKinds.lookahead,
      negate: token.negate,
    });
  }
  const kind = throwIfNot({
    '^': AstAssertionKinds.line_start,
    '$': AstAssertionKinds.line_end,
    '\\A': AstAssertionKinds.string_start,
    '\\b': AstAssertionKinds.word_boundary,
    '\\B': AstAssertionKinds.word_boundary,
    '\\G': AstAssertionKinds.search_start,
    '\\z': AstAssertionKinds.string_end,
    '\\Z': AstAssertionKinds.string_end_newline,
  }[token.kind], `Unexpected assertion kind "${token.kind}"`);
  const node = {
    ...base,
    kind,
  };
  if (kind === AstAssertionKinds.word_boundary) {
    node.negate = token.kind === '\\B';
  }
  return node;
}

function createBackreference(parent, ref) {
  return {
    ...getNodeBase(parent, AstTypes.Backreference),
    ref,
  };
}

function createByGroupKind(parent, token) {
  const {kind, number, name, flags} = token;
  switch (kind) {
    case TokenGroupKinds.atomic:
      return createGroup(parent, {atomic: true});
    case TokenGroupKinds.capturing:
      return createCapturingGroup(parent, number, name);
    case TokenGroupKinds.group:
      return createGroup(parent, {flags});
    case TokenGroupKinds.lookahead:
    case TokenGroupKinds.lookbehind:
      return createAssertionFromToken(parent, token);
    default:
      throw new Error(`Unexpected group kind "${kind}"`);
  }
}

function createCapturingGroup(parent, number, name) {
  const node = {
    ...getNodeBase(parent, AstTypes.CapturingGroup),
    number,
  };
  if (name !== undefined) {
    if (!isValidJsGroupName(name)) {
      throw new Error(`Invalid group name "${name}"`);
    }
    node.name = name;
  }
  return withInitialAlternative(node);
}

function createCharacter(parent, charCode) {
  return {
    ...getNodeBase(parent, AstTypes.Character),
    value: charCode,
  };
}

function createCharacterClass(parent, negate) {
  return withInitialIntersection(createCharacterClassBase(parent, negate));
}

function createCharacterClassBase(parent, negate = false) {
  return {
    ...getNodeBase(parent, AstTypes.CharacterClass),
    negate,
    elements: [],
  };
}

function createCharacterClassIntersection(parent) {
  const node = getNodeBase(parent, AstTypes.CharacterClassIntersection);
  node.classes = [createCharacterClassBase(node)];
  return node;
}

function createCharacterClassRange(parent, min, max) {
  if (max.value < min.value) {
    throw new Error('Character class range out of order');
  }
  return {
    ...getNodeBase(parent, AstTypes.CharacterClassRange),
    min,
    max,
  };
}

function createCharacterSetFromToken(parent, token) {
  let {kind, negate, property} = token;
  if (kind === TokenCharacterSetKinds.property) {
    const normalized = normalize(property);
    if (PosixProperties.has(normalized)) {
      kind = TokenCharacterSetKinds.posix;
      property = normalized;
    }
  }
  const node = {
    ...getNodeBase(parent, AstTypes.CharacterSet),
    kind: throwIfNot(AstCharacterSetKinds[kind], `Unexpected character set kind "${kind}"`),
  };
  if (
    kind === TokenCharacterSetKinds.digit ||
    kind === TokenCharacterSetKinds.hex ||
    kind === TokenCharacterSetKinds.posix ||
    kind === TokenCharacterSetKinds.property ||
    kind === TokenCharacterSetKinds.space ||
    kind === TokenCharacterSetKinds.word
  ) {
    node.negate = negate;
    if (kind === TokenCharacterSetKinds.posix) {
      node.property = property;
    } else if (kind === TokenCharacterSetKinds.property) {
      node.property = getJsUnicodePropertyName(property);
    }
  }
  return node;
}

function createDirectiveFromToken(parent, token) {
  const {kind, flags} = token;
  const node = {
    ...getNodeBase(parent, AstTypes.Directive),
    kind: throwIfNot(AstDirectiveKinds[kind], `Unexpected directive kind "${kind}"`),
  };
  // Can't simply create a `Group` with a `flags` prop and wrap the remainder of the open group or
  // pattern in it, because the flag modifier might extend across alternation; i.e. `a(?i)b|c` is
  // equivalent to `a(?i:b)|(?i:c)`, not `a(?i:b|c)`
  if (node.kind === AstDirectiveKinds.flags) {
    node.flags = flags;
  }
  return node;
}

function createFlags(parent, {ignoreCase, dotAll, extended}) {
  return {
    ...getNodeBase(parent, AstTypes.Flags),
    ignoreCase,
    dotAll,
    extended,
  };
}

function createGroup(parent, {atomic, flags} = {}) {
  const node = getNodeBase(parent, AstTypes.Group);
  if (atomic) {
    node.atomic = true;
  } else if (flags) {
    node.flags = flags;
  }
  return withInitialAlternative(node);
}

function createPattern(parent) {
  return withInitialAlternative(getNodeBase(parent, AstTypes.Pattern));
}

function createQuantifier(parent, element, min, max, greedy, possessive) {
  if (max < min) {
    throw new Error('Quantifier range out of order');
  }
  const node = {
    ...getNodeBase(parent, AstTypes.Quantifier),
    min,
    max,
    greedy,
    possessive,
    element,
  };
  if (min !== max && isWithin(node, AstTypes.Assertion, AstAssertionKinds.lookbehind)) {
    // JS supports this but Onig doesn't
    throw new Error('Unsupported variable repetition within lookbehind');
    // Additionally, Onig only supports variable-length alternation at the top level of lookbehind,
    // but this isn't currently enforced. Ex: `(?<=a|bc)` and `(?<=a|b(c|d))` are valid, but not
    // `(?<=a(b|cd))`
  }
  return node;
}

function createRegExp(parent, flags) {
  const node = getNodeBase(parent, AstTypes.RegExp);
  node.pattern = createPattern(node);
  node.flags = createFlags(node, flags)
  return node;
}

function createSubroutine(parent, ref) {
  return {
    ...getNodeBase(parent, AstTypes.Subroutine),
    ref,
  };
}

function createVariableLengthCharacterSet(parent, kind) {
  return {
    ...getNodeBase(parent, AstTypes.VariableLengthCharacterSet),
    kind: throwIfNot({
      '\\R': AstVariableLengthCharacterSetKinds.newline,
      '\\X': AstVariableLengthCharacterSetKinds.grapheme,
    }[kind], `Unexpected varchar set kind "${kind}"`),
  };
}

// Unlike Onig, JS Unicode property names are case sensitive, don't ignore whitespace and
// underscores, and require underscores in specific positions
function getJsUnicodePropertyName(property) {
  const jsName = JsUnicodePropertiesMap.get(normalize(property));
  if (jsName) {
    return jsName;
  }
  // Assume it's a script name; JS requires formatting 'Like_This', so use a best effort to
  // reformat the name (doesn't find a mapping for all possible formatting differences)
  return property.
    trim().
    replace(/\s+/g, '_').
    // Change `PropertyName` to `Property_Name`
    replace(/[A-Z][a-z]+(?=[A-Z])/g, '$&_').
    replace(/[a-z]+/ig, m => m[0].toUpperCase() + m.slice(1).toLowerCase());
}

function getNodeBase(parent, type) {
  return {
    type,
    parent,
  };
}

// If a direct child group is needlessly nested, return it instead (after modifying it)
function getOptimizedGroup(node) {
  const firstAlt = node.alternatives[0];
  const firstAltFirstEl = firstAlt.elements[0];
  if (
    node.type === AstTypes.Group &&
    node.alternatives.length === 1 &&
    firstAlt.elements.length === 1 &&
    firstAltFirstEl.type === AstTypes.Group &&
    !(node.atomic && firstAltFirstEl.flags) &&
    !(node.flags && (firstAltFirstEl.atomic || firstAltFirstEl.flags))
  ) {
    firstAltFirstEl.parent = node.parent;
    if (node.atomic) {
      firstAltFirstEl.atomic = true;
    } else if (node.flags) {
      firstAltFirstEl.flags = node.flags;
    }
    return firstAltFirstEl;
  }
  return node;
}

function isValidJsGroupName(name) {
  // Oniguruma group name rules are much more permissive than JS, with invalid names seemingly only
  // being those matched by `/^(?:[-\d]|$)/`. All of these are also invalid by JS rules
  // See <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Lexical_grammar#identifiers>
  return /^[$_\p{IDS}][$\u200C\u200D\p{IDC}]*$/u.test(name);
}

function isWithin(node, type, kind) {
  while (node = node.parent) {
    if (node.type === type && (!kind || node.kind === kind)) {
      return true;
    }
  }
  return false;
}

// For any intersection classes that contain only a class, swap the parent with its (modded) child
function optimizeCharacterClassIntersection(intersection) {
  for (let i = 0; i < intersection.classes.length; i++) {
    const cc = intersection.classes[i];
    const firstChild = cc.elements[0];
    if (cc.elements.length === 1 && firstChild.type === AstTypes.CharacterClass) {
      intersection.classes[i] = firstChild;
      firstChild.parent = intersection;
      firstChild.negate = cc.negate !== firstChild.negate;
    }
  }
}

function throwIfNot(value, msg) {
  if (!value) {
    throw new Error(msg ?? 'Value expected');
  }
  return value;
}

function throwIfUnclosedCharacterClass(token) {
  return throwIfNot(token, 'Unclosed character class');
}

function throwIfUnclosedGroup(token) {
  return throwIfNot(token, 'Unclosed group');
}

function withInitialAlternative(node) {
  const alt = createAlternative(node);
  node.alternatives = [alt];
  return node;
}

function withInitialIntersection(node) {
  const intersection = createCharacterClassIntersection(node);
  node.elements = [intersection];
  return node;
}

export {
  AstAssertionKinds,
  AstTypes,
  parse,
};
