#!/usr/bin/env node
// Clean tool JSON Schemas so Gemini/Antigravity will accept them.
//
// Google rejects `properties` / `required` on any node whose type is not
// OBJECT. Notion (and other MCP servers) describe rich_text as an array whose
// `items` have `properties` but no `type: "object"`. Claude accepts that;
// Gemini returns 400 and the local proxy may then park the login.
//
// This walk is idempotent and safe on Claude-shaped tools too: it only adds
// `type: "object"` where properties already exist, and strips properties from
// true primitive/array nodes.
'use strict';

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function declaredTypes(node) {
  if (!isPlainObject(node) || node.type == null) return [];
  if (typeof node.type === 'string') return [node.type];
  if (Array.isArray(node.type)) return node.type.filter((t) => typeof t === 'string');
  return [];
}

function looksLikeObjectSchema(node) {
  if (!isPlainObject(node)) return false;
  return isPlainObject(node.properties)
    || Array.isArray(node.allOf)
    || Array.isArray(node.anyOf)
    || Array.isArray(node.oneOf)
    || typeof node.$ref === 'string';
}

function markObject(node) {
  const types = declaredTypes(node);
  if (types.includes('array') && !types.includes('object')) return;
  if (types.includes('object')) return;
  node.type = 'object';
}

function mergeAllOf(node) {
  if (!isPlainObject(node) || !Array.isArray(node.allOf)) return;
  const parts = node.allOf;
  delete node.allOf;
  for (const part of parts) {
    if (!isPlainObject(part)) continue;
    sanitizeSchema(part);
    if (isPlainObject(part.properties)) {
      node.properties = { ...(node.properties || {}), ...part.properties };
    }
    if (Array.isArray(part.required)) {
      const have = new Set(Array.isArray(node.required) ? node.required : []);
      for (const name of part.required) have.add(name);
      node.required = [...have];
    }
    for (const key of ['anyOf', 'oneOf']) {
      if (Array.isArray(part[key]) && !Array.isArray(node[key])) node[key] = part[key];
    }
    if (part.type && !node.type) node.type = part.type;
  }
  if (isPlainObject(node.properties) || Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) {
    markObject(node);
  }
}

function sanitizeSchema(node) {
  if (Array.isArray(node)) {
    for (const item of node) sanitizeSchema(item);
    return node;
  }
  if (!isPlainObject(node)) return node;

  mergeAllOf(node);

  const types = declaredTypes(node);
  const isArray = types.includes('array') && !types.includes('object');
  const isPrimitive = types.some((t) => t === 'string' || t === 'number' || t === 'integer' || t === 'boolean' || t === 'null')
    && !types.includes('object') && !types.includes('array');

  if (isPlainObject(node.properties)) {
    if (isArray || isPrimitive) {
      delete node.properties;
      delete node.required;
    } else {
      markObject(node);
      for (const value of Object.values(node.properties)) sanitizeSchema(value);
    }
  }

  if (node.required != null && !isPlainObject(node.properties)) {
    delete node.required;
  }

  if (isPlainObject(node.items)) {
    if (looksLikeObjectSchema(node.items)) markObject(node.items);
    sanitizeSchema(node.items);
    if (isPlainObject(node.items.properties)) markObject(node.items);
  } else if (Array.isArray(node.items)) {
    for (const item of node.items) sanitizeSchema(item);
  }

  for (const key of ['anyOf', 'oneOf', 'prefixItems']) {
    if (Array.isArray(node[key])) {
      for (const item of node[key]) sanitizeSchema(item);
    }
  }

  if (isPlainObject(node.additionalProperties)) sanitizeSchema(node.additionalProperties);
  if (isPlainObject(node.$defs)) {
    for (const value of Object.values(node.$defs)) sanitizeSchema(value);
  }
  if (isPlainObject(node.definitions)) {
    for (const value of Object.values(node.definitions)) sanitizeSchema(value);
  }

  return node;
}

function toolSchema(tool) {
  if (!isPlainObject(tool)) return null;
  if (isPlainObject(tool.input_schema)) return tool.input_schema;
  if (isPlainObject(tool.parameters)) return tool.parameters;
  if (isPlainObject(tool.function) && isPlainObject(tool.function.parameters)) {
    return tool.function.parameters;
  }
  return null;
}

function sanitizeTools(tools) {
  if (!Array.isArray(tools)) return tools;
  for (const tool of tools) {
    const schema = toolSchema(tool);
    if (schema) sanitizeSchema(schema);
  }
  return tools;
}

function sanitizeRequestBody(body) {
  if (!isPlainObject(body)) return body;
  if (Array.isArray(body.tools)) sanitizeTools(body.tools);
  if (Array.isArray(body.function_declarations)) {
    for (const decl of body.function_declarations) {
      if (isPlainObject(decl) && isPlainObject(decl.parameters)) sanitizeSchema(decl.parameters);
    }
  }
  return body;
}

module.exports = { sanitizeSchema, sanitizeTools, sanitizeRequestBody };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    const parsed = JSON.parse(raw);
    process.stdout.write(`${JSON.stringify(sanitizeRequestBody(parsed))}\n`);
  });
}
