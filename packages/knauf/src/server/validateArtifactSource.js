'use strict';

const { parse } = require('@babel/parser');
const { JSDOM } = require('jsdom');

const MAX_SVG_ARTIFACT_BYTES = 8 * 1024 * 1024;
const FORBIDDEN_SVG_ELEMENTS = new Set([
  'script',
  'foreignObject',
  'image',
  'iframe',
  'object',
  'embed',
]);
const FORBIDDEN_URI = /(?:javascript|data|https?|file):|\/\//i;

function validateReactArtifactSource(source) {
  try {
    parse(source, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    });
    return null;
  } catch (error) {
    return {
      line: error?.loc?.line,
      column: error?.loc?.column,
    };
  }
}

function validateSvgArtifactSource(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_SVG_ARTIFACT_BYTES) {
    return { message: 'SVG source must be text no larger than 8 MB' };
  }

  let document;
  try {
    document = new JSDOM(source, { contentType: 'image/svg+xml' }).window.document;
  } catch {
    return { message: 'SVG must be well-formed XML with one root element' };
  }

  const root = document.documentElement;
  if (
    document.doctype ||
    root?.localName !== 'svg' ||
    root.namespaceURI !== 'http://www.w3.org/2000/svg'
  ) {
    return { message: 'SVG must have one <svg> root in the SVG namespace and no doctype' };
  }

  const viewBox = root
    .getAttribute('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    viewBox?.length !== 4 ||
    viewBox.some((value) => !Number.isFinite(value)) ||
    viewBox[2] <= 0 ||
    viewBox[3] <= 0
  ) {
    return { message: 'SVG needs a finite, positive four-number viewBox' };
  }

  const ids = new Set();
  const references = [];
  for (const element of document.querySelectorAll('*')) {
    if (FORBIDDEN_SVG_ELEMENTS.has(element.localName)) {
      return { message: `<${element.localName}> is not allowed in SVG artifacts` };
    }

    const id = element.getAttribute('id');
    if (id) {
      if (ids.has(id)) {
        return { message: `Duplicate SVG id: ${id}` };
      }
      ids.add(id);
    }

    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith('on') || name === 'xml:base') {
        return { message: `SVG attribute ${attribute.name} is not allowed` };
      }
      if (/(?:^|[\s,(])-?Infinity(?:$|[\s,)])|(?:^|[\s,(])NaN(?:$|[\s,)])/i.test(value)) {
        return { message: 'SVG coordinates must be finite' };
      }
      if (name !== 'xmlns' && name !== 'xmlns:xlink' && FORBIDDEN_URI.test(value)) {
        return { message: 'External, data, and executable SVG references are not allowed' };
      }
      if (name === 'href' || name === 'xlink:href') {
        if (!value.startsWith('#')) {
          return { message: 'SVG href references must be internal fragments' };
        }
        references.push(value.slice(1));
      }
      for (const match of value.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/gi)) {
        if (!match[1].startsWith('#')) {
          return { message: 'SVG url() references must be internal fragments' };
        }
        references.push(match[1].slice(1));
      }
    }

    if (element.localName === 'style') {
      const css = element.textContent ?? '';
      if (/@import|@font-face|(?:javascript|data|https?|file):|\/\//i.test(css)) {
        return { message: 'SVG styles must be self-contained and cannot embed fonts or URLs' };
      }
      for (const match of css.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/gi)) {
        if (!match[1].startsWith('#')) {
          return { message: 'SVG style url() references must be internal fragments' };
        }
        references.push(match[1].slice(1));
      }
    }
  }

  const missing = references.find((id) => !ids.has(id));
  return missing ? { message: `Unresolved SVG reference: #${missing}` } : null;
}

module.exports = { MAX_SVG_ARTIFACT_BYTES, validateReactArtifactSource, validateSvgArtifactSource };
