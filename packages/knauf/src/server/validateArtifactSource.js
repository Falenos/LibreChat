'use strict';

const { parse } = require('@babel/parser');

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

module.exports = { validateReactArtifactSource };
