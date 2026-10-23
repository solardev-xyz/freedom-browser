'use strict';

// A deliberately bounded, interpreted subset. Website schemas must never feed
// code generation, remote $ref fetching, or unbounded regular expressions in
// the main process. Unsupported constraints keep that tool out of discovery;
// ordinary DOM interaction remains available.
const METADATA = new Set([
  'title',
  'description',
  'default',
  'examples',
  '$schema',
  '$id',
  'deprecated',
  'readOnly',
  'writeOnly',
  'format',
]);
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const LIMITS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
]);

// Only anchored, fixed-width tokens: no alternation, groups, backreferences or
// variable repetition. This covers IATA codes and date shapes without accepting
// attacker-controlled backtracking programs in the main process.
function safePattern(pattern) {
  if (
    typeof pattern !== 'string' ||
    pattern.length > 128 ||
    !pattern.startsWith('^') ||
    !pattern.endsWith('$')
  )
    return null;
  const body = pattern.slice(1, -1);
  for (let index = 0; index < body.length;) {
    if (body[index] === '[') {
      const end = body.indexOf(']', index + 1);
      if (end < 0 || !/^\^?[a-zA-Z0-9 _.,:/-]+$/.test(body.slice(index + 1, end))) return null;
      index = end + 1;
    } else if (body[index] === '\\') {
      if (!'dDwWsS.-_/:@ '.includes(body[index + 1] || '\0')) return null;
      index += 2;
    } else {
      if (!/[a-zA-Z0-9 _.,:/@-]/.test(body[index])) return null;
      index += 1;
    }
    if (body[index] === '{') {
      const end = body.indexOf('}', index);
      const count = body.slice(index + 1, end);
      if (end < 0 || !/^[1-9][0-9]?$/.test(count) || Number(count) > 64) return null;
      index = end + 1;
    }
  }
  try {
    return new RegExp(pattern, 'u');
  } catch {
    return null;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedJsonStructure(value) {
  const pending = [[value, 0]];
  let count = 0;
  while (pending.length) {
    const [entry, depth] = pending.pop();
    if (++count > 2048 || depth > 32) return false;
    if (entry && typeof entry === 'object')
      for (const child of Object.values(entry)) pending.push([child, depth + 1]);
  }
  return true;
}

function supportedPageToolSchema(schema) {
  if (!boundedJsonStructure(schema)) return false;
  let budget = 512;
  function visit(node, depth) {
    if (--budget < 0 || depth > 16) return false;
    if (typeof node === 'boolean') return true;
    if (!isObject(node)) return false;
    return Object.entries(node).every(([key, value]) => {
      if (METADATA.has(key)) return true;
      if (key === 'pattern') return Boolean(safePattern(value));
      if (key === 'type')
        return (Array.isArray(value) ? value : [value]).every((type) => TYPES.has(type));
      if (key === 'enum') return Array.isArray(value) && value.length > 0 && value.length <= 128;
      if (key === 'const') return true;
      if (key === 'required')
        return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
      if (key === 'properties')
        return isObject(value) && Object.values(value).every((child) => visit(child, depth + 1));
      if (key === 'additionalProperties' || key === 'items' || key === 'not')
        return visit(value, depth + 1);
      if (['anyOf', 'oneOf', 'allOf'].includes(key))
        return (
          Array.isArray(value) &&
          value.length > 0 &&
          value.length <= 16 &&
          value.every((child) => visit(child, depth + 1))
        );
      if (key === 'uniqueItems') return typeof value === 'boolean';
      if (key === 'multipleOf') return Number.isFinite(value) && value > 0;
      if (LIMITS.has(key))
        return (
          Number.isFinite(value) &&
          (key.includes('imum') || (Number.isInteger(value) && value >= 0))
        );
      return false;
    });
  }
  return visit(schema, 0);
}

function matchesPageToolArguments(schema, input) {
  if (!boundedJsonStructure(input)) return false;
  let budget = 10_000;
  const equal = (a, b) => {
    if (--budget < 0) return false;
    if (a === b) return true;
    if (
      !a ||
      !b ||
      typeof a !== 'object' ||
      typeof b !== 'object' ||
      Array.isArray(a) !== Array.isArray(b)
    )
      return false;
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
    );
  };
  const hasType = (value, type) =>
    type === 'null'
      ? value === null
      : type === 'object'
        ? isObject(value)
        : type === 'array'
          ? Array.isArray(value)
          : type === 'integer'
            ? Number.isInteger(value)
            : typeof value === type;
  function check(node, value, depth) {
    if (--budget < 0 || depth > 32) return false;
    if (typeof node === 'boolean') return node;
    if (
      node.type &&
      !(Array.isArray(node.type) ? node.type : [node.type]).some((type) => hasType(value, type))
    )
      return false;
    if (node.enum && !node.enum.some((entry) => equal(entry, value))) return false;
    if (Object.hasOwn(node, 'const') && !equal(node.const, value)) return false;
    if (node.allOf && !node.allOf.every((child) => check(child, value, depth + 1))) return false;
    if (node.anyOf && !node.anyOf.some((child) => check(child, value, depth + 1))) return false;
    if (node.oneOf && node.oneOf.filter((child) => check(child, value, depth + 1)).length !== 1)
      return false;
    if (node.not && check(node.not, value, depth + 1)) return false;
    if (typeof value === 'number') {
      if (
        value < node.minimum ||
        value > node.maximum ||
        value <= node.exclusiveMinimum ||
        value >= node.exclusiveMaximum
      )
        return false;
      if (
        node.multipleOf &&
        Math.abs(value / node.multipleOf - Math.round(value / node.multipleOf)) > 1e-9
      )
        return false;
    }
    if (typeof value === 'string') {
      const length = [...value].length;
      if (length < node.minLength || length > node.maxLength) return false;
      if (node.pattern && !safePattern(node.pattern).test(value)) return false;
    }
    if (Array.isArray(value)) {
      if (value.length < node.minItems || value.length > node.maxItems) return false;
      if (node.items !== undefined && !value.every((entry) => check(node.items, entry, depth + 1)))
        return false;
      if (
        node.uniqueItems &&
        value.some((entry, index) => value.slice(0, index).some((prior) => equal(prior, entry)))
      )
        return false;
    }
    if (isObject(value)) {
      const keys = Object.keys(value);
      if (keys.length < node.minProperties || keys.length > node.maxProperties) return false;
      if (node.required?.some((key) => !Object.hasOwn(value, key))) return false;
      for (const key of keys) {
        const child = Object.hasOwn(node.properties || {}, key)
          ? node.properties[key]
          : node.additionalProperties;
        if (child !== undefined && !check(child, value[key], depth + 1)) return false;
      }
    }
    return budget >= 0;
  }
  return supportedPageToolSchema(schema) && check(schema, input, 0) && budget >= 0;
}

module.exports = { boundedJsonStructure, supportedPageToolSchema, matchesPageToolArguments };
