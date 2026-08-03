// Shared htm-bound-to-preact tag, so every component file can just
// `const { html } = require('../html');` and write JSX-like markup with
// zero build step (htm parses tagged templates at runtime).
const { h, render, Fragment } = require('preact');
const htm = require('htm');

const html = htm.bind(h);

module.exports = { html, h, render, Fragment };
